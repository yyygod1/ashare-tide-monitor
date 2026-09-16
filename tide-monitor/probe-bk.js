// Probe: does the 昨日涨停 board index (BK0815) daily change approximate our premium?
// Run in CI (runner can reach push2his). Compare overlapping dates and print diffs.
const fs = require('fs');
const UA = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' };
(async () => {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.BK0815&klt=101&fqt=1&lmt=300&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
  const r = await fetch(url, { headers: UA });
  const j = await r.json();
  const kl = (j.data && j.data.klines) || [];
  console.log('BK0815 klines:', kl.length, 'range', kl[0] && kl[0].split(',')[0], '~', kl[kl.length - 1] && kl[kl.length - 1].split(',')[0]);
  const bk = {}; kl.forEach(x => { const p = x.split(','); bk[p[0]] = +p[8]; });
  const T = JSON.parse(fs.readFileSync('docs/tide-data.json', 'utf8'));
  let diffs = [];
  console.log('date        prem    bk0815    diff');
  T.rows.filter(x => x.prem_avg != null).forEach(x => {
    const b = bk[x.date];
    if (b !== undefined) { const d = x.prem_avg - b; diffs.push(Math.abs(d)); console.log(x.date, String(x.prem_avg).padStart(7), String(b).padStart(7), String(d.toFixed(2)).padStart(7)); }
  });
  if (diffs.length) { const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length; console.log('n=' + diffs.length, 'mean|diff|=' + mean.toFixed(3)); }
  // also show recent BK0815 values for reference
  console.log('recent BK0815:', kl.slice(-6).map(x => { const p = x.split(','); return p[0] + '=' + p[8]; }).join('  '));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
