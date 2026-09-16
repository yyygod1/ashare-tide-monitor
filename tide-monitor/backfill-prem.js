// Backfill historical premium (prem_avg) using the 昨日涨停 board index (BK0815) daily change.
// The ZT-pool API only goes back ~20 trading days, so older days have no exact premium.
// Validated: mean|diff| vs exact premium ~= 0.3 percentage points (on 14 overlapping days) -> usable as an ESTIMATE.
// Rows filled this way are flagged prem_est = true.
const fs = require('fs');
const path = require('path');
const { getJSON } = require('../lib/em');

(async () => {
  const file = path.join(__dirname, 'tide-data.json');
  const T = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = T.rows || [];
  const missing = rows.filter(r => r.prem_avg == null).length;
  if (!missing) { console.log('backfill-prem: nothing to fill'); return; }
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.BK0815&ut=fa5fd1943c7b386f172d6893dbfba10b&klt=101&fqt=1&lmt=600&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
  const d = await getJSON(url, { tries: 3 });
  const kl = (d.data && d.data.klines) || [];
  if (!kl.length) throw new Error('no BK0815 kline');
  const bk = {}; kl.forEach(x => { const p = x.split(','); bk[p[0]] = +p[8]; });
  let n = 0;
  rows.forEach(r => { if (r.prem_avg == null && bk[r.date] != null) { r.prem_avg = +bk[r.date].toFixed(2); r.prem_est = true; n++; } });
  T.prem_backfill = { method: 'BK0815 昨日涨停板块指数', filled: n, asof: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(T));
  console.log('backfill-prem: filled ' + n + ' / ' + missing + ' missing days (BK0815 proxy)');
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
