// ===== 全量聚合：潮汐数据 + 龙虎榜 + 板块 =====
// 输出 tide-data.json（供合并页 v3 使用）。收盘后(18:30)跑一次即可。
const fs = require('fs');
const { getJSON } = require('../lib/em');
const j = (u, tries = 3) => getJSON(u, { tries });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pool(tasks, limit, delay = 0) {
  const out = new Array(tasks.length); let idx = 0;
  const worker = async () => { while (idx < tasks.length) { const i = idx++; try { out[i] = await tasks[i](); } catch (e) { out[i] = null; } if (delay) await sleep(delay); } };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}
const compact = d => d.replace(/-/g, '');
const ZT = d => `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt%3Aasc&date=${compact(d)}`;
const ZB = d => `https://push2ex.eastmoney.com/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt%3Aasc&date=${compact(d)}`;

(async () => {
  const fund = JSON.parse(fs.readFileSync(__dirname + '/fund-daily.json', 'utf8'));
  const dates = fund.map(r => r.date);
  const kdir = __dirname + '/kline-cache';
  const kcache = {};
  if (fs.existsSync(kdir)) for (const f of fs.readdirSync(kdir)) kcache[f.replace('.json', '')] = JSON.parse(fs.readFileSync(kdir + '/' + f, 'utf8'));

  console.log('拉涨停池/炸板池…');
  const zt = await pool(dates.map(d => () => j(ZT(d)).then(x => (x.data && x.data.pool) || [])), 5, 60);
  const zb = await pool(dates.map(d => () => j(ZB(d)).then(x => (x.data && x.data.pool) || [])), 5, 60);

  console.log('拉龙虎榜…');
  const start = dates[0], end = dates[dates.length - 1];
  const f = encodeURIComponent(`(TRADE_DATE>='${start}') and (TRADE_DATE<='${end}')`);
  let lhbRows = [], page = 1, pages = 1;
  do {
    const u = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL&filter=${f}&pageSize=500&pageNumber=${page}&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB`;
    const d = await j(u); const res = d.result || {}; pages = res.pages || 1;
    const data = res.data || []; lhbRows.push(...data);
    if (data.length < 500) break; page++;
  } while (page <= pages);
  const lhbByDate = {}; lhbRows.forEach(r => { const d = (r.TRADE_DATE || '').slice(0, 10); (lhbByDate[d] = lhbByDate[d] || []).push(r); });
  console.log('龙虎榜 ' + lhbRows.length + ' 行，' + Object.keys(lhbByDate).length + ' 天');

  const rows = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i], p = zt[i] || [], b = zb[i] || [];
    const lbcs = p.map(x => x.lbc || 0);
    const maxLbc = lbcs.length ? Math.max(...lbcs) : 0;
    const lianban = p.filter(x => (x.lbc || 0) >= 2).length;
    const first = p.filter(x => (x.lbc || 0) === 1).length;
    let avg = null, red = null, damian = null, nPrev = null;
    if (i > 0) {
      const prev = zt[i - 1] || [];
      const ex = prev.filter(x => !(x.fbt === 92500 && (x.zbc || 0) === 0));
      const chgs = ex.map(x => (kcache[x.c] || {})[d]).filter(v => v != null);
      if (chgs.length) { nPrev = prev.length; avg = +(chgs.reduce((a, c) => a + c, 0) / chgs.length).toFixed(2); red = +(chgs.filter(x => x > 0).length / chgs.length * 100).toFixed(0); damian = chgs.filter(x => x <= -4).length; }
    }
    const zbRate = (p.length + b.length) ? +(b.length / (p.length + b.length) * 100).toFixed(0) : 0;

    // 龙虎榜明细
    const lhb = lhbByDate[d] || [];
    const lhbNet = lhb.reduce((s, r) => s + (r.BILLBOARD_NET_AMT || 0), 0) / 1e8;
    const lhbTop = [...lhb].sort((a, c) => (c.BILLBOARD_NET_AMT || 0) - (a.BILLBOARD_NET_AMT || 0)).slice(0, 20).map(r => ({
      code: r.SECURITY_CODE, name: r.SECURITY_NAME_ABBR, chg: +(r.CHANGE_RATE || 0).toFixed(2),
      net: +((r.BILLBOARD_NET_AMT || 0) / 1e8).toFixed(2), reason: (r.EXPLANATION || '').slice(0, 16)
    }));
    // 连板梯队
    const lbGroup = {}; p.forEach(x => { (lbGroup[x.lbc || 0] = lbGroup[x.lbc || 0] || []).push({ code: x.c, name: x.n, theme: x.hybk || '未分类' }); });
    // 高标断板
    const failHigh = [];
    if (i > 0) { const prev = zt[i - 1] || [], cur = new Set(p.map(x => x.c)); prev.forEach(x => { if ((x.lbc || 0) >= 3 && !cur.has(x.c)) failHigh.push({ code: x.c, name: x.n, prev_lbc: x.lbc, theme: x.hybk || '未分类' }); }); }
    // 板块净买入聚合（涨停股按行业，净买入取龙虎榜）
    const lhbMap = {}; lhb.forEach(r => lhbMap[r.SECURITY_CODE] = r);
    const tmap = {}; const seen = new Set();
    p.forEach(x => {
      const t = x.hybk || '未分类';
      const tm = tmap[t] = tmap[t] || { net: 0, zt: 0, max_lbc: 0, core: [], follow: [] };
      tm.zt++; tm.max_lbc = Math.max(tm.max_lbc, x.lbc || 0);
      if (!seen.has(x.c)) { seen.add(x.c); tm.follow.push({ code: x.c, name: x.n, lbc: x.lbc || 0 }); }
      const r = lhbMap[x.c]; if (r) tm.net += (r.BILLBOARD_NET_AMT || 0);
    });
    const themes = Object.keys(tmap).map(t => { const v = tmap[t]; v.follow.sort((a, c) => c.lbc - a.lbc); const core = v.follow.slice(0, v.max_lbc >= 2 ? 1 : 2); const follow = v.follow.filter(s => !core.some(c => c.code === s.code)).slice(0, 8); return { theme: t, net: +(v.net / 1e8).toFixed(2), zt: v.zt, max_lbc: v.max_lbc, core, follow }; }).sort((a, c) => c.net - a.net || c.zt - a.zt);
    // 板块晋级（昨日热门板块 → 今日）
    let themeFlow = null;
    if (i > 0 && rows[i - 1].themes) {
      const prevTop = [...rows[i - 1].themes].sort((a, c) => c.net - a.net || c.zt - a.zt).slice(0, 5);
      const curByTheme = {}; themes.forEach(t => curByTheme[t.theme] = t);
      const curTop5 = [...themes].slice(0, 5).map(t => t.theme);
      themeFlow = prevTop.map(pt => {
        const cur = curByTheme[pt.theme];
        if (!cur) return { theme: pt.theme, prev_net: pt.net, cur_net: 0, cur_rank: null, fund_ok: false, height_ok: false, status: '退潮' };
        const cr = curTop5.indexOf(pt.theme); const fundOk = cur.net > 0 && cr >= 0; const heightOk = cur.max_lbc > pt.max_lbc;
        return { theme: pt.theme, prev_net: pt.net, cur_net: cur.net, cur_rank: cr >= 0 ? cr + 1 : null, fund_ok: fundOk, height_ok: heightOk, status: (fundOk && heightOk) ? '晋级' : ((fundOk || heightOk) ? '分歧' : '退潮') };
      });
    }

    rows.push({ date: d, zt: p.length, zt_lianban: lianban, zt_first: first, max_lbc: maxLbc, zb: b.length, zb_rate: zbRate,
      prem_avg: avg, prem_red: red, damian, n_prev: nPrev, lhb_net: +lhbNet.toFixed(2), lhb_top: lhbTop,
      lianban: lbGroup, fail_high: failHigh, themes: themes.slice(0, 12), theme_flow: themeFlow });
  }
  // 温度/六态
  const W = 60;
  fund.forEach((r, i) => { const win = fund.slice(Math.max(0, i - W), i + 1).map(x => x.main);
    Object.assign(rows[i], { main_yi: +(r.main / 1e8).toFixed(1), huge_yi: +(r.huge / 1e8).toFixed(1), big_yi: +(r.big / 1e8).toFixed(1), mid_yi: +(r.mid / 1e8).toFixed(1), small_yi: +(r.small / 1e8).toFixed(1), temp: +(win.filter(x => x <= r.main).length / win.length * 100).toFixed(0) }); });
  const band = t => t >= 85 ? '沸点' : t >= 70 ? '过热' : t >= 55 ? '微热' : t >= 40 ? '微冷' : t >= 25 ? '过冷' : '冰点';
  rows.forEach((r, i) => { r.state6 = band(r.temp); if (i >= 5) { const th = r.temp >= Math.max(...rows.slice(i - 5, i).map(x => x.temp)); const lh = r.max_lbc > Math.max(...rows.slice(i - 5, i).map(x => x.max_lbc)); r.diverge = th && !lh; } });

  // 用 BK0815（昨日涨停·不含一字）成分精确覆盖最后一天
  try {
    let list = [], pn = 1;
    while (true) {
      const d = await j(`https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=200&fs=b:BK0815&fields=f12,f14,f3`);
      const diff = d.data && d.data.diff; if (!diff) break;
      const arr = Array.isArray(diff) ? diff : Object.values(diff); list.push(...arr); if (arr.length < 200) break; pn++;
    }
    const chgs = list.map(x => (x.f3 == null ? null : x.f3 / 100)).filter(v => v != null);
    if (chgs.length) { const L = rows[rows.length - 1]; L.n_prev = list.length; L.prem_avg = +(chgs.reduce((a, c) => a + c, 0) / chgs.length).toFixed(2); L.prem_red = +(chgs.filter(x => x > 0).length / chgs.length * 100).toFixed(0); L.damian = chgs.filter(x => x <= -4).length; console.log('BK0815 覆盖最后一天: ' + L.date + ' 均' + L.prem_avg + '% 红' + L.prem_red + '% 大面' + L.damian); }
  } catch (e) { console.log('BK0815 覆盖失败: ' + e.message); }

  fs.writeFileSync(__dirname + '/tide-data.json', JSON.stringify({ generated: new Date().toISOString(), window: { start: dates[0], end: dates[dates.length - 1], days: dates.length }, rows }));
  console.log('已写 tide-data.json；rows=' + rows.length);
})();
