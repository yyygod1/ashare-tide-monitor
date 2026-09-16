// Probe: does 昨日涨停 board index (BK0815) daily change approximate our premium?
const fs = require('fs');
const { execFileSync } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const REF = 'https://quote.eastmoney.com/';
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';

async function tryGet(url) {
  try { const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': REF } }); const t = await r.text(); return { via: 'fetch', status: r.status, text: t }; }
  catch (e) {
    try { const b = execFileSync(CURL, ['-s', '--max-time', '25', '-A', UA, '-e', REF, url], { maxBuffer: 1e8 }); return { via: 'curl', status: 0, text: b.toString('utf8') }; }
    catch (e2) { return { via: 'none', status: -1, text: 'ERR ' + e.message + ' / ' + e2.message }; }
  }
}

(async () => {
  const hosts = ['push2his.eastmoney.com', 'push2.eastmoney.com', 'push2delay.eastmoney.com'];
  const variants = [
    h => `https://${h}/api/qt/stock/kline/get?secid=90.BK0815&ut=fa5fd1943c7b386f172d6893dbfba10b&klt=101&fqt=1&lmt=300&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`,
    h => `https://${h}/api/qt/stock/kline/get?secid=90.BK0815&klt=101&lmt=300&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`,
  ];
  let kl = null, used = '';
  for (const v of variants) for (const h of hosts) {
    const res = await tryGet(v(h));
    const head = (res.text || '').slice(0, 120).replace(/\n/g, ' ');
    const n = (res.text || '').includes('klines') ? JSON.parse(res.text).data.klines.length : -1;
    console.log(`[${res.via}] ${h} -> status=${res.status} klines=${n} :: ${head}`);
    if (n > 10) { kl = JSON.parse(res.text).data.klines; used = h; break; }
    if (kl) break;
  }
  if (!kl) { console.log('no usable board kline found'); return; }
  console.log('USING', used, 'klines', kl.length, kl[0].split(',')[0], '~', kl[kl.length - 1].split(',')[0]);
  const bk = {}; kl.forEach(x => { const p = x.split(','); bk[p[0]] = +p[8]; });
  const T = JSON.parse(fs.readFileSync('docs/tide-data.json', 'utf8'));
  const diffs = [];
  console.log('date        prem    bk0815    diff');
  T.rows.filter(x => x.prem_avg != null).forEach(x => { const b = bk[x.date]; if (b !== undefined) { const d = x.prem_avg - b; diffs.push(Math.abs(d)); console.log(x.date, String(x.prem_avg).padStart(7), String(b).padStart(7), String(d.toFixed(2)).padStart(7)); } });
  if (diffs.length) console.log('n=' + diffs.length, 'mean|diff|=' + (diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(3));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
