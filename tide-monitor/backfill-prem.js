// Backfill historical premium (prem_avg) using the 昨日涨停 board index (BK0815) daily change.
// ZT-pool API only goes back ~20 trading days; older days get an ESTIMATE from the board index.
// Validated: mean|diff| ~= 0.3 percentage points on 14 overlapping days. Filled rows flagged prem_est=true.
// Non-fatal: if the API is rate-limited / unreachable it just logs and exits 0.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REF = 'https://quote.eastmoney.com/';
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const P = 'api/qt/stock/kline/get?secid=90.BK0815&ut=fa5fd1943c7b386f172d6893dbfba10b&klt=101&fqt=1&lmt=600&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
const URLS = ['https://push2his.eastmoney.com/' + P, 'https://push2.eastmoney.com/' + P];

async function fetchKlines(url) {
  try { const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': REF } }); const j = await r.json(); const kl = (j.data && j.data.klines) || []; if (kl.length) return kl; } catch (e) {}
  try { const b = execFileSync(CURL, ['-s', '--max-time', '25', '-A', UA, '-e', REF, url], { maxBuffer: 1e8 }); const j = JSON.parse(b.toString('utf8')); const kl = (j.data && j.data.klines) || []; if (kl.length) return kl; } catch (e) {}
  return null;
}

(async () => {
  const file = path.join(__dirname, 'tide-data.json');
  const T = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = T.rows || [];
  const missing = rows.filter(r => r.prem_avg == null).length;
  if (!missing) { console.log('backfill-prem: nothing to fill'); return; }
  let kl = null;
  for (let a = 0; a < 8 && !kl; a++) {
    for (const u of URLS) { kl = await fetchKlines(u); if (kl) break; }
    if (!kl && a < 7) { console.log('backfill-prem: attempt ' + (a + 1) + ' failed, retrying...'); await sleep(20000); }
  }
  if (!kl) { console.log('backfill-prem: WARN could not fetch BK0815 (rate-limited?) after retries - skipped (non-fatal)'); return; }
  const bk = {}; kl.forEach(x => { const p = x.split(','); bk[p[0]] = +p[8]; });
  let n = 0;
  rows.forEach(r => { if (r.prem_avg == null && bk[r.date] != null) { r.prem_avg = +bk[r.date].toFixed(2); r.prem_est = true; n++; } });
  T.prem_backfill = { method: 'BK0815 昨日涨停板块指数', filled: n, asof: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(T));
  console.log('backfill-prem: filled ' + n + ' / ' + missing + ' missing days (BK0815 proxy)');
})().catch(e => { console.error('backfill-prem: ERR ' + e.message + ' (non-fatal)'); });
