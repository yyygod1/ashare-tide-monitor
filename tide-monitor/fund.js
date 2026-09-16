// 用东财公开接口拉沪深大盘资金流(日线,分层)，构造候选"温度分"，验证是否能对上 100→40
const { getJSON } = require('../lib/em');
const j = (url, tries = 3) => getJSON(url, { tries });
async function fflow(secid, klt) {
  const u = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=0&klt=${klt}&secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56`;
  const d = await j(u);
  return (d.data && d.data.klines) || [];
}
// 解析: 日期,主力净额,小单,中单,大单,超大单
function parse(lines) {
  return lines.map(l => {
    const p = l.split(',');
    return { date: p[0].slice(0, 10), main: +p[1], small: +p[2], mid: +p[3], big: +p[4], huge: +p[5] };
  });
}
const pctRank = (arr, v) => arr.length ? arr.filter(x => x <= v).length / arr.length * 100 : 50;

(async () => {
  const [sh, sz] = [await fflow('1.000001', 101), await fflow('0.399001', 101)];
  const shA = parse(sh), szA = parse(sz);
  const byDate = {};
  for (const r of shA) { byDate[r.date] = { date: r.date, huge: r.huge, big: r.big, mid: r.mid, small: r.small, main: r.main }; }
  for (const r of szA) {
    const b = byDate[r.date] || (byDate[r.date] = { date: r.date, huge: 0, big: 0, mid: 0, small: 0, main: 0 });
    b.huge += r.huge; b.big += r.big; b.mid += r.mid; b.small += r.small; b.main += r.main;
  }
  const rows = Object.values(byDate).sort((a, b) => a.date < b.date ? -1 : 1);
  const W = 60;
  rows.forEach((r, i) => {
    const s = Math.max(0, i - W), win = rows.slice(s, i + 1);
    const mainArr = win.map(x => x.main / 1e8);
    const hugeArr = win.map(x => x.huge / 1e8);
    const net2Arr = win.map(x => (x.huge + x.big - x.mid - x.small) / 1e8);
    r.mainYi = +(r.main / 1e8).toFixed(1); r.hugeYi = +(r.huge / 1e8).toFixed(1);
    r.bigYi = +(r.big / 1e8).toFixed(1); r.midYi = +(r.mid / 1e8).toFixed(1); r.smallYi = +(r.small / 1e8).toFixed(1);
    r.net2Yi = +((r.huge + r.big - r.mid - r.small) / 1e8).toFixed(1);
    r.T_main = +pctRank(mainArr, r.mainYi).toFixed(0);
    r.T_huge = +pctRank(hugeArr, r.hugeYi).toFixed(0);
    r.T_net2 = +pctRank(net2Arr, r.net2Yi).toFixed(0);
    r.idx = i;
  });
  const last = rows.slice(-45);
  console.log('date        主力(亿) 超大 大   中   小  净2   T_main T_huge T_net2');
  for (const r of last) {
    console.log(`${r.date}  ${String(r.mainYi).padStart(7)} ${String(r.hugeYi).padStart(6)} ${String(r.bigYi).padStart(5)} ${String(r.midYi).padStart(5)} ${String(r.smallYi).padStart(5)} ${String(r.net2Yi).padStart(6)}   ${String(r.T_main).padStart(3)}    ${String(r.T_huge).padStart(3)}    ${String(r.T_net2).padStart(3)}`);
  }
  const fs = require('fs');
  fs.writeFileSync(__dirname + '/fund-daily.json', JSON.stringify(rows, null, 0));
  console.log('\nsaved fund-daily.json, days=' + rows.length + ', range ' + rows[0].date + ' ~ ' + rows[rows.length - 1].date);
})();
