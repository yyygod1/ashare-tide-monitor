(async () => {
  const b = 'https://elaborate-palmier-65e62f.netlify.app';
  const h = await fetch(b + '/?t=' + Date.now());
  const t = await h.text();
  console.log('netlify index HTTP', h.status, '| has 估算*:', t.includes('估算*'), '| has dashed:', t.indexOf('borderType') >= 0 && t.indexOf('dashed') >= 0);
  const r = await fetch(b + '/tide-data.json?t=' + Date.now());
  const d = await r.json();
  console.log('data rows', d.rows.length, '| prem_est days', d.rows.filter(x => x.prem_est).length);
  console.log('last 8:', d.rows.slice(-8).map(x => x.date + (x.prem_est ? '(估)' : '')).join('  '));
})().catch(e => console.log('ERR', e.message));
