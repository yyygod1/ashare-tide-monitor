(async () => {
  const b = 'https://elaborate-palmier-65e62f.netlify.app';
  const h = await fetch(b + '/');
  const ht = await h.text();
  console.log('netlify index HTTP', h.status, '| cachebust in html:', ht.includes('tide-data.json?t='), '| size', ht.length);
  const r = await fetch(b + '/tide-data.json?x=' + Date.now());
  console.log('netlify /tide-data.json HTTP', r.status, 'ct=' + r.headers.get('content-type'), 'cache=' + r.headers.get('cache-control'));
  const t = await r.text();
  try { const d = JSON.parse(t); const l = d.rows[d.rows.length - 1]; console.log('  parsed OK: rows', d.rows.length, 'asof', d.intraday && d.intraday.asof, '| last', l.date, l.temp, l.state6, '| zt', l.zt, '| prem', l.prem_avg); }
  catch (e) { console.log('  NOT JSON:', t.slice(0, 150)); }
  // github pages
  const g = await fetch('https://yyygod1.github.io/ashare-tide-monitor/');
  console.log('github pages index HTTP', g.status);
})().catch(e => console.log('ERR', e.message));
