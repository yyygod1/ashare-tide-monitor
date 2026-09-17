// breadth.js — 市场宽度取数（供 veto 硬约束层用）
//   market_red : 全市场红盘率 = 上涨/(上涨+下跌+平盘)（沪深合计，f104/f105/f106）
//   dt         : 跌停家数（东财跌停池实时 tc；注意该接口 date 被忽略，只给当日）
//   idx_chg    : 沪指涨跌幅%；idx_close/ma20/idx_break_ma20 : 新破 MA20（昨收≥昨MA20 且 今收<今MA20）
//   market_amt_yi : 沪深成交额（亿），供 T6「净流出/成交额」口径
// Usage: node breadth.js   （打印一次）
const { getJSON, getJSONMulti, push2 } = require('../lib/em');
const UA = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' };

async function fetchBreadth() {
  const out = { up: null, down: null, flat: null, market_red: null, flat_ratio: null, dt: null, idx_chg: null, idx_close: null, ma20: null, idx_break_ma20: null, market_amt_yi: null };
  const cst = new Date(Date.now() + 8 * 3600e3);
  const dcm = `${cst.getUTCFullYear()}${String(cst.getUTCMonth() + 1).padStart(2, '0')}${String(cst.getUTCDate()).padStart(2, '0')}`;

  // 1) 涨跌家数（沪深）
  try {
    const d = await getJSONMulti(push2(['/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001&fields=f104,f105,f106']));
    const diff = (d.data && d.data.diff) || [];
    const arr = Array.isArray(diff) ? diff : Object.values(diff);
    let up = 0, down = 0, flat = 0;
    arr.forEach(x => { up += x.f104 || 0; down += x.f105 || 0; flat += x.f106 || 0; });
    const tot = up + down + flat;
    Object.assign(out, { up, down, flat, market_red: tot ? +(up / tot * 100).toFixed(1) : null, flat_ratio: tot ? +(flat / tot * 100).toFixed(1) : null });
  } catch (e) { /* keep null */ }

  // 2) 跌停家数（实时；历史不可回补）
  try {
    const z = await getJSON(`https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=5&sort=fund%3Aasc&date=${dcm}`, { tries: 1 });
    if (z.data && z.data.tc != null) out.dt = z.data.tc;
  } catch (e) { /* keep null */ }

  // 3) 沪指：MA20 / 新破 / 成交额（沪深）
  try {
    let closes = null;
    try {
      const k = await getJSON('https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&klt=101&fqt=1&lmt=25&end=20500101&fields1=f1,f2,f3&fields2=f51,f53', { tries: 3 });
      const kl = (k.data && k.data.klines) || [];
      if (kl.length) closes = kl.map(x => +x.split(',')[1]);
    } catch (e) {}
    if (!closes || closes.length < 21) {   // 腾讯兜底
      try {
        const t = await getJSON('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,40,qfq', { tries: 2 });
        const node = (t.data && t.data.sh000001) || {};
        const rows = node.qfqday || node.day || [];
        if (rows.length) closes = rows.map(x => +x[2]);
      } catch (e) {}
    }
    if (closes && closes.length >= 21) {
      const n = closes.length;
      const ma20_today = closes.slice(n - 20).reduce((a, b) => a + b, 0) / 20;
      const ma20_yest = closes.slice(n - 21, n - 1).reduce((a, b) => a + b, 0) / 20;
      const close_today = closes[n - 1], close_yest = closes[n - 2];
      out.idx_close = +close_today.toFixed(1); out.ma20 = +ma20_today.toFixed(1);
      out.idx_chg = +((close_today / close_yest - 1) * 100).toFixed(2);
      out.idx_break_ma20 = close_yest >= ma20_yest && close_today < ma20_today;
    }
  } catch (e) { /* keep null */ }
  try {
    let amt = 0;
    for (const s of ['1.000001', '0.399001']) {
      const q = await getJSONMulti(push2([`/api/qt/stock/get?fltt=2&secid=${s}&fields=f48`]));
      const v = q.data && q.data.f48; if (v) amt += (+v || 0);
    }
    if (amt) out.market_amt_yi = +(amt / 1e8).toFixed(0);
  } catch (e) { /* keep null */ }

  return out;
}

module.exports = { fetchBreadth };

if (require.main === module) {
  fetchBreadth().then(b => console.log(JSON.stringify(b, null, 0))).catch(e => { console.error('ERR ' + e.message); process.exit(1); });
}
