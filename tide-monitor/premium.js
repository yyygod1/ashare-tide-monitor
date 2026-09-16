// 计算每日「昨日涨停股 → 今日溢价」：平均涨幅、红盘率、大面数（不含一字板）
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://quote.eastmoney.com/' };
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CACHE = __dirname + '/kline-cache';
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

async function j(url, retry = 3) {
  for (let i = 0; i <= retry; i++) {
    try { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    catch (e) { if (i === retry) throw e; await sleep(300 * (i + 1)); }
  }
}
async function pool(tasks, limit) {
  const out = new Array(tasks.length); let idx = 0;
  const worker = async () => { while (idx < tasks.length) { const i = idx++; try { out[i] = await tasks[i](); } catch (e) { out[i] = null; } } };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}
const secid = c => (c[0] === '6' || c[0] === '5' || c[0] === '9') ? '1.' + c : '0.' + c;
const compact = d => d.replace(/-/g, '');

async function fetchPool(date) {
  const u = `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt%3Aasc&date=${compact(date)}`;
  const d = await j(u);
  return ((d.data && d.data.pool) || []).map(p => ({ code: p.c, name: p.n, lbc: p.lbc || 0, fbt: p.fbt, zbc: p.zbc || 0 }));
}
async function kline(code) {
  const f = CACHE + '/' + code + '.json';
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const u = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid(code)}&klt=101&fqt=1&lmt=320&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
  const d = await j(u);
  const kl = (d.data && d.data.klines) || [];
  const map = {};
  for (const row of kl) { const p = row.split(','); map[p[0]] = +p[8]; } // 涨跌幅%
  fs.writeFileSync(f, JSON.stringify(map));
  return map;
}

(async () => {
  const fund = JSON.parse(fs.readFileSync(__dirname + '/fund-daily.json', 'utf8'));
  const dates = fund.map(r => r.date);
  console.log('trading days:', dates.length, dates[0], '~', dates[dates.length - 1]);

  const pools = await pool(dates.map(d => () => fetchPool(d).catch(() => [])), 8);
  const poolByDate = {}; dates.forEach((d, i) => poolByDate[d] = pools[i] || []);
  const codes = [...new Set(pools.flat().filter(Boolean).map(p => p.code))];
  console.log('distinct 涨停股:', codes.length, '开始拉K线…');

  let done = 0;
  const klines = {};
  await pool(codes.map(c => async () => { klines[c] = await kline(c); done++; if (done % 100 === 0) console.log('  kline', done + '/' + codes.length); }), 6);

  const rows = [];
  for (let i = 1; i < dates.length; i++) {
    const prev = poolByDate[dates[i - 1]], today = dates[i];
    const ex = prev.filter(p => !(p.fbt === 92500 && p.zbc === 0)); // 剔除一字板
    const chgs = ex.map(p => (klines[p.code] || {})[today]).filter(v => v != null);
    if (!chgs.length) continue;
    const avg = chgs.reduce((a, b) => a + b, 0) / chgs.length;
    const red = chgs.filter(x => x > 0).length / chgs.length;
    const damian = chgs.filter(x => x <= -5).length;
    rows.push({ date: today, n_prev: prev.length, n_excl: chgs.length, avg_chg: +avg.toFixed(2), red_rate: +(red * 100).toFixed(0), damian });
  }
  fs.writeFileSync(__dirname + '/premium-daily.json', JSON.stringify(rows, null, 0));
  console.log('\ndate       昨涨停 样本 平均涨幅 红盘率% 大面');
  for (const r of rows.slice(-45)) console.log(`${r.date}  ${String(r.n_prev).padStart(4)} ${String(r.n_excl).padStart(4)}  ${String(r.avg_chg).padStart(6)}  ${String(r.red_rate).padStart(4)}  ${String(r.damian).padStart(3)}`);
  console.log('\nsaved premium-daily.json');
})();
