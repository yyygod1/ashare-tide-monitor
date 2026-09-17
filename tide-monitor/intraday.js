// intraday.js - build "today so far" (盘中) row from live East Money endpoints.
// Reuses completed-day history in fund-daily.json only for the fund temperature percentile / prior-day compare.
// 盘中进度修正(方案#2)：资金温度与「涨停家数」按当日已交易时间进度折算为「全天当量」后再取分位，
//   避免早盘把半天的数据直接和历史全天比 → 系统性偏低/偏高。
// 情绪态(方案#1/#4)：由 sentiment.js 多因子合成(含大面)得出，不再由单一资金温度决定。
// Output: tide-today.json  { generated, date, intraday:true, asof, row:{...} }
// Usage: node intraday.js [--force]   (--force skips the trading-hours guard)
const fs = require('fs');
const path = require('path');
const { getJSON, getJSONMulti, push2 } = require('../lib/em');
const { computeSentiment } = require('./sentiment');
const j = (u) => getJSON(u, { tries: 2 });

const compact = d => d.replace(/-/g, '');
const ZT = d => `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt%3Aasc&date=${compact(d)}`;
const ZB = d => `https://push2ex.eastmoney.com/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt%3Aasc&date=${compact(d)}`;
const FFLOW = secid => push2([`/api/qt/stock/fflow/kline/get?lmt=0&klt=1&secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56`]);

function cstNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function inTradingHours(force) {
  if (force) return true;
  const c = cstNow(); const dow = c.getUTCDay(); const mins = c.getUTCHours() * 60 + c.getUTCMinutes();
  if (dow < 1 || dow > 5) return false;
  return (mins >= 9 * 60 + 25 && mins <= 11 * 60 + 30) || (mins >= 13 * 60 && mins <= 15 * 60 + 10);
}
// 当日已交易时间占全天(240分钟)的比例：09:30-11:30 + 13:00-15:00
function tradingProgress(asof) {
  const [h, m] = asof.split(':').map(Number); const t = h * 60 + m;
  const o = 9 * 60 + 30, a = 11 * 60 + 30, p = 13 * 60, c = 15 * 60;
  let el;
  if (t < o) el = 0; else if (t <= a) el = t - o; else if (t <= p) el = a - o; else if (t <= c) el = (a - o) + (t - p); else el = (a - o) + (c - p);
  return Math.min(1, Math.max(0, el / 240));
}

(async () => {
  const force = process.argv.includes('--force');
  if (!inTradingHours(force)) { console.log('outside trading hours (CST), skip.'); return; }

  const c = cstNow();
  const date = `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, '0')}-${String(c.getUTCDate()).padStart(2, '0')}`;
  const asof = `${String(c.getUTCHours()).padStart(2, '0')}:${String(c.getUTCMinutes()).padStart(2, '0')}`;
  const progress = tradingProgress(asof);
  const pEff = Math.max(progress, 0.10);   // 早盘进度太小时防止放得过大
  console.log(`intraday build ${date} ${asof} (CST)  progress=${(progress * 100).toFixed(0)}%`);

  const fund = JSON.parse(fs.readFileSync(path.join(__dirname, 'fund-daily.json'), 'utf8'));

  // --- live fund flow (cumulative for today) ---
  const day0 = await getJSONMulti(FFLOW('1.000001')); const day1 = await getJSONMulti(FFLOW('0.399001'));
  const k0 = (day0.data && day0.data.klines || []); const k1 = (day1.data && day1.data.klines || []);
  if (!k0.length || !k1.length) throw new Error('no minute fund-flow data');
  const p0 = k0[k0.length - 1].split(',').map(Number); const p1 = k1[k1.length - 1].split(',').map(Number);
  // fields: time, main, small, mid, big, huge
  const main = p0[1] + p1[1], small = p0[2] + p1[2], mid = p0[3] + p1[3], big = p0[4] + p1[4], huge = p0[5] + p1[5];

  // --- 资金温度：按进度折算「全天当量」后再取过去~60日百分位 ---
  const mainEq = main / pEff;
  const hist = fund.map(r => r.main);
  const arr = hist.slice(-59).concat([mainEq]);
  const temp = Math.round(arr.filter(x => x <= mainEq).length / arr.length * 100);
  const temp_raw = Math.round(hist.slice(-59).concat([main]).filter(x => x <= main).length / (hist.slice(-59).length + 1) * 100);

  // --- today's limit-up / broken pools ---
  const ztd = await j(ZT(date)); const zbd = await j(ZB(date));
  const pool = (ztd.data && ztd.data.pool) || [];
  const broken = (zbd.data && zbd.data.pool) || [];
  const lbcs = pool.map(x => x.lbc || 0);
  const max_lbc = lbcs.length ? Math.max(...lbcs) : 0;
  const zt_lianban = pool.filter(x => (x.lbc || 0) >= 2).length;
  const zt_first = pool.filter(x => (x.lbc || 0) === 1).length;
  const zb_rate = (pool.length + broken.length) ? Math.round(broken.length / (pool.length + broken.length) * 100) : 0;
  const zt_eff = Math.round(pool.length / pEff);   // 全天当量涨停家数（仅用于情绪分取分位）

  // lianban groups
  const lianban = {}; pool.forEach(x => { (lianban[x.lbc || 0] = lianban[x.lbc || 0] || []).push({ code: x.c, name: x.n, theme: x.hybk || '未分类' }); });

  // fail_high: yesterday's >=3板 not in today's pool
  const todays = new Set(pool.map(x => x.c));
  const fail_high = [];
  let T = null;
  try { T = JSON.parse(fs.readFileSync(path.join(__dirname, 'tide-data.json'), 'utf8')); } catch (e) { /* no history file */ }
  try {
    const pr = T.rows[T.rows.length - 1];
    const plb = (pr && pr.lianban) || {};
    Object.keys(plb).forEach(k => { if (+k >= 3) plb[k].forEach(s => { if (!todays.has(s.code)) fail_high.push({ code: s.code, name: s.name, prev_lbc: +k, theme: s.theme }); }); });
  } catch (e) { /* skip */ }

  // themes (no LHB intraday -> net unknown, use 0)
  const tmap = {};
  pool.forEach(x => { const t = x.hybk || '未分类'; const tm = tmap[t] = tmap[t] || { zt: 0, max_lbc: 0, follow: [] }; tm.zt++; tm.max_lbc = Math.max(tm.max_lbc, x.lbc || 0); tm.follow.push({ code: x.c, name: x.n, lbc: x.lbc || 0 }); });
  const themes = Object.keys(tmap).map(t => { const v = tmap[t]; v.follow.sort((a, b) => b.lbc - a.lbc); const core = v.follow.slice(0, v.max_lbc >= 2 ? 1 : 2); return { theme: t, net: 0, zt: v.zt, max_lbc: v.max_lbc, core, follow: v.follow.filter(s => !core.some(cc => cc.code === s.code)).slice(0, 8) }; }).sort((a, b) => b.zt - a.zt || b.max_lbc - a.max_lbc);

  // premium: yesterday's limit-ups performance today (BK0815 board live)
  let prem_avg = null, prem_red = null, damian = null, n_prev = null;
  try {
    let list = [], pn = 1;
    while (true) { const d = await getJSONMulti(push2([`/api/qt/clist/get?pn=${pn}&pz=200&fs=b:BK0815&fields=f12,f14,f3`])); const diff = d.data && d.data.diff; if (!diff) break; const a = Array.isArray(diff) ? diff : Object.values(diff); list.push(...a); if (a.length < 200) break; pn++; }
    const chgs = list.map(x => x.f3 == null ? null : x.f3 / 100).filter(v => v != null);
    if (chgs.length) { n_prev = list.length; prem_avg = +(chgs.reduce((a, c) => a + c, 0) / chgs.length).toFixed(2); prem_red = Math.round(chgs.filter(x => x > 0).length / chgs.length * 100); damian = chgs.filter(x => x <= -4).length; }
  } catch (e) { console.log('premium(BK0815) failed: ' + e.message); }

  const row = {
    date, intraday: true, asof, progress: +(progress * 100).toFixed(0),
    zt: pool.length, zt_eff, zt_lianban, zt_first, max_lbc, zb: broken.length, zb_rate,
    prem_avg, prem_red, damian, n_prev,
    lhb_net: 0, lhb_top: [],
    lianban, fail_high, themes: themes.slice(0, 12), theme_flow: null,
    main_yi: +(main / 1e8).toFixed(1), huge_yi: +(huge / 1e8).toFixed(1), big_yi: +(big / 1e8).toFixed(1),
    mid_yi: +(mid / 1e8).toFixed(1), small_yi: +(small / 1e8).toFixed(1),
    temp, temp_raw, state6: null, sent: null
  };

  // --- 情绪分（多因子，含大面）→ 六态：用历史行 + 今日行一起算，取今日这一行 ---
  if (T && T.rows && T.rows.length) {
    const seq = T.rows.slice(-120).concat([row]);
    computeSentiment(seq, 60);
    const l = seq[seq.length - 1];
    row.sent = l.sent; row.sent_factors = l.sent_factors; row.state6 = l.state6;
  }

  // diverge: 资金温度创5日新高但连板高度未新高
  let diverge = false;
  try {
    const last5 = T.rows.slice(-5);
    if (last5.length >= 5) diverge = temp >= Math.max(...last5.map(r => r.temp)) && max_lbc <= Math.max(...last5.map(r => r.max_lbc));
  } catch (e) {}
  row.diverge = diverge;

  fs.writeFileSync(path.join(__dirname, 'tide-today.json'), JSON.stringify({ generated: new Date().toISOString(), date, intraday: true, asof, row }, null, 0));

  // --- 记录盘中快照，供后续做「同一时刻」分位（渐进式） ---
  try {
    const hf = path.join(__dirname, 'intraday-hist.json');
    let H = { days: {} }; try { H = JSON.parse(fs.readFileSync(hf, 'utf8')); } catch (e) {}
    H.days = H.days || {}; H.days[date] = H.days[date] || {};
    H.days[date][asof] = { main: +(main / 1e8).toFixed(1), progress: +(progress * 100).toFixed(0) };
    fs.writeFileSync(hf, JSON.stringify(H));
  } catch (e) {}

  console.log(`tide-today.json -> ${date} ${asof} | 情绪分 ${row.sent}(${row.state6}) 资金温度 ${temp}(原始${temp_raw}) 涨停 ${row.zt}(当量${zt_eff})/炸板${row.zb} 最高${max_lbc}板 溢价 ${prem_avg}% 红盘 ${prem_red}% 大面 ${damian} | 主力 ${row.main_yi}亿`);
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
