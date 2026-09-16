// intraday.js - build "today so far" (盘中) row from live East Money endpoints.
// Reuses completed-day history in fund-daily.json only for the temperature percentile / prior-day compare.
// Output: tide-today.json  { generated, date, intraday:true, asof, row:{...} }
// Usage: node intraday.js [--force]   (--force skips the trading-hours guard)
const fs = require('fs');
const path = require('path');
const { getJSON } = require('../lib/em');
const j = (u) => getJSON(u, { tries: 2 });

const compact = d => d.replace(/-/g, '');
const ZT = d => `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt%3Aasc&date=${compact(d)}`;
const ZB = d => `https://push2ex.eastmoney.com/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt%3Aasc&date=${compact(d)}`;
const FFLOW = secid => `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=0&klt=1&secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56`;
const BAND = t => t >= 85 ? '沸点' : t >= 70 ? '过热' : t >= 55 ? '微热' : t >= 40 ? '微冷' : t >= 25 ? '过冷' : '冰点';

function cstNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function inTradingHours(force) {
  if (force) return true;
  const c = cstNow(); const dow = c.getUTCDay(); const mins = c.getUTCHours() * 60 + c.getUTCMinutes();
  if (dow < 1 || dow > 5) return false;
  return (mins >= 9 * 60 + 25 && mins <= 11 * 60 + 30) || (mins >= 13 * 60 && mins <= 15 * 60 + 10);
}

(async () => {
  const force = process.argv.includes('--force');
  if (!inTradingHours(force)) { console.log('outside trading hours (CST), skip.'); return; }

  const c = cstNow();
  const date = `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, '0')}-${String(c.getUTCDate()).padStart(2, '0')}`;
  const asof = `${String(c.getUTCHours()).padStart(2, '0')}:${String(c.getUTCMinutes()).padStart(2, '0')}`;
  console.log(`intraday build ${date} ${asof} (CST)`);

  const fund = JSON.parse(fs.readFileSync(path.join(__dirname, 'fund-daily.json'), 'utf8'));
  const prevDate = fund[fund.length - 1].date;   // last completed trading day

  // --- live fund flow (cumulative for today) ---
  const day0 = await j(FFLOW('1.000001')); const day1 = await j(FFLOW('0.399001'));
  const k0 = (day0.data && day0.data.klines || []); const k1 = (day1.data && day1.data.klines || []);
  if (!k0.length || !k1.length) throw new Error('no minute fund-flow data');
  const p0 = k0[k0.length - 1].split(',').map(Number); const p1 = k1[k1.length - 1].split(',').map(Number);
  // fields: time, main, small, mid, big, huge
  const main = p0[1] + p1[1], small = p0[2] + p1[2], mid = p0[3] + p1[3], big = p0[4] + p1[4], huge = p0[5] + p1[5];

  // --- temperature percentile over last ~60 incl today ---
  const hist = fund.map(r => r.main);
  const arr = hist.slice(-59).concat([main]);
  const temp = Math.round(arr.filter(x => x <= main).length / arr.length * 100);
  const state6 = BAND(temp);

  // --- today's limit-up / broken pools ---
  const ztd = await j(ZT(date)); const zbd = await j(ZB(date));
  const pool = (ztd.data && ztd.data.pool) || [];
  const broken = (zbd.data && zbd.data.pool) || [];
  const lbcs = pool.map(x => x.lbc || 0);
  const max_lbc = lbcs.length ? Math.max(...lbcs) : 0;
  const zt_lianban = pool.filter(x => (x.lbc || 0) >= 2).length;
  const zt_first = pool.filter(x => (x.lbc || 0) === 1).length;
  const zb_rate = (pool.length + broken.length) ? Math.round(broken.length / (pool.length + broken.length) * 100) : 0;

  // lianban groups
  const lianban = {}; pool.forEach(x => { (lianban[x.lbc || 0] = lianban[x.lbc || 0] || []).push({ code: x.c, name: x.n, theme: x.hybk || '未分类' }); });

  // fail_high: yesterday's >=3板 not in today's pool
  const todays = new Set(pool.map(x => x.c));
  const fail_high = [];
  try {
    const T = JSON.parse(fs.readFileSync(path.join(__dirname, 'tide-data.json'), 'utf8'));
    const pr = T.rows[T.rows.length - 1];
    const plb = (pr && pr.lianban) || {};
    Object.keys(plb).forEach(k => { if (+k >= 3) plb[k].forEach(s => { if (!todays.has(s.code)) fail_high.push({ code: s.code, name: s.name, prev_lbc: +k, theme: s.theme }); }); });
  } catch (e) { /* no history file, skip */ }

  // themes (no LHB intraday -> net unknown, use 0)
  const tmap = {};
  pool.forEach(x => { const t = x.hybk || '未分类'; const tm = tmap[t] = tmap[t] || { zt: 0, max_lbc: 0, follow: [] }; tm.zt++; tm.max_lbc = Math.max(tm.max_lbc, x.lbc || 0); tm.follow.push({ code: x.c, name: x.n, lbc: x.lbc || 0 }); });
  const themes = Object.keys(tmap).map(t => { const v = tmap[t]; v.follow.sort((a, b) => b.lbc - a.lbc); const core = v.follow.slice(0, v.max_lbc >= 2 ? 1 : 2); return { theme: t, net: 0, zt: v.zt, max_lbc: v.max_lbc, core, follow: v.follow.filter(s => !core.some(cc => cc.code === s.code)).slice(0, 8) }; }).sort((a, b) => b.zt - a.zt || b.max_lbc - a.max_lbc);

  // premium: yesterday's limit-ups performance today (BK0815 board live)
  let prem_avg = null, prem_red = null, damian = null, n_prev = null;
  try {
    let list = [], pn = 1;
    while (true) { const d = await j(`https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=200&fs=b:BK0815&fields=f12,f14,f3`); const diff = d.data && d.data.diff; if (!diff) break; const a = Array.isArray(diff) ? diff : Object.values(diff); list.push(...a); if (a.length < 200) break; pn++; }
    const chgs = list.map(x => x.f3 == null ? null : x.f3 / 100).filter(v => v != null);
    if (chgs.length) { n_prev = list.length; prem_avg = +(chgs.reduce((a, c) => a + c, 0) / chgs.length).toFixed(2); prem_red = Math.round(chgs.filter(x => x > 0).length / chgs.length * 100); damian = chgs.filter(x => x <= -4).length; }
  } catch (e) { console.log('premium(BK0815) failed: ' + e.message); }

  // diverge: temp makes 5d high but max_lbc does not
  let diverge = false;
  try {
    const T = JSON.parse(fs.readFileSync(path.join(__dirname, 'tide-data.json'), 'utf8'));
    const last5 = T.rows.slice(-5);
    if (last5.length >= 5) diverge = temp >= Math.max(...last5.map(r => r.temp)) && max_lbc <= Math.max(...last5.map(r => r.max_lbc));
  } catch (e) {}

  const row = {
    date, intraday: true, asof,
    zt: pool.length, zt_lianban, zt_first, max_lbc, zb: broken.length, zb_rate,
    prem_avg, prem_red, damian, n_prev,
    lhb_net: 0, lhb_top: [],
    lianban, fail_high, themes: themes.slice(0, 12), theme_flow: null,
    main_yi: +(main / 1e8).toFixed(1), huge_yi: +(huge / 1e8).toFixed(1), big_yi: +(big / 1e8).toFixed(1),
    mid_yi: +(mid / 1e8).toFixed(1), small_yi: +(small / 1e8).toFixed(1),
    temp, state6, diverge
  };

  fs.writeFileSync(path.join(__dirname, 'tide-today.json'), JSON.stringify({ generated: new Date().toISOString(), date, intraday: true, asof, row }, null, 0));
  console.log(`tide-today.json -> ${date} ${asof} | 温度 ${temp}(${state6}) 涨停 ${row.zt}/炸板${row.zb} 最高${max_lbc}板 溢价 ${prem_avg}% 红盘 ${prem_red}% 大面 ${damian} | 主力 ${row.main_yi}亿`);
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
