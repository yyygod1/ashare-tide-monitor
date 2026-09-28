(async () => {
  const UA = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' };
  const j = async u => { const r = await fetch(u, { headers: UA }); return r.json(); };
  const fs = require('fs');
  // BK0815 昨日涨停 板块日线
  const d = await j('https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.BK0815&klt=101&fqt=1&lmt=200&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61');
  const kl = (d.data && d.data.klines) || [];
  console.log('BK0815 klines:', kl.length, 'range', kl[0] && kl[0].split(',')[0], '~', kl[kl.length - 1] && kl[kl.length - 1].split(',')[0]);
  const bk = {}; kl.forEach(r => { const p = r.split(','); bk[p[0]] = +p[8]; });
  const T = JSON.parse(fs.readFileSync('docs/tide-data.json', 'utf8'));
  console.log('date        tide.prem   BK0815.chg');
  T.rows.filter(r => r.prem_avg != null).slice(-16).forEach(r => console.log(r.date, '  ', String(r.prem_avg).padStart(6), '   ', bk[r.date] !== undefined ? bk[r.date] : '(no)'));
  const old = await j('https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=5&sort=fbt%3Aasc&date=20260401');
  console.log('2026-04-01 ZT池:', JSON.stringify(old.data && old.data.pool));
})().catch(e => console.log('ERR', e.message));
