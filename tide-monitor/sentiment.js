// sentiment.js — 情绪分（多因子合成分）与六态分档
// 目的：把「情绪态」从单一资金指标(温度)解耦出来，改由打板生态多因子合成；
//      「资金温度」仅保留为资金冷暖的参考项。
//
// 因子(权重)：涨停家数 .24 / 连板高度 .18 / 大面(反向) .17 / 溢价 .16 / 炸板率(反向) .15 / 红盘率 .10
// 每个因子取「自身在过去 window 个交易日中的百分位(0-100)」；缺省因子自动剔除并重归一权重。
// 盘中(临时行)可传 zt_eff(按交易进度折算的「全天当量涨停数」)参与分位，避免早盘系统性偏低。

// 注意：zt / max_lbc / zb_rate 为 0 通常代表「该日涨停池接口无数据」，而非真的 0 → 视为缺失(null)不参与分位。
const FACTORS = [
  { key: 'zt',       w: 0.24, invert: false, get: r => { const v = (r.zt_eff != null ? r.zt_eff : r.zt); return v ? v : null; } },
  { key: 'max_lbc',  w: 0.18, invert: false, get: r => (r.max_lbc ? r.max_lbc : null) },
  { key: 'damian',   w: 0.17, invert: true,  get: r => r.damian },
  { key: 'prem_avg', w: 0.16, invert: false, get: r => r.prem_avg },
  { key: 'zb_rate',  w: 0.15, invert: true,  get: r => ((r.zt || r.zb) ? r.zb_rate : null) },
  { key: 'prem_red', w: 0.10, invert: false, get: r => r.prem_red },
];

function pctRank(nums, v) {
  const a = nums.filter(x => x != null && isFinite(x));
  if (!a.length || v == null || !isFinite(v)) return null;
  return a.filter(x => x <= v).length / a.length * 100;
}

function band6(p) {
  return p == null ? null : p >= 85 ? '沸点' : p >= 70 ? '过热' : p >= 55 ? '微热' : p >= 40 ? '微冷' : p >= 25 ? '过冷' : '冰点';
}

// 就地给每行写入 sent(0-100) / sent_factors / state6
function computeSentiment(rows, window = 60) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const win = rows.slice(Math.max(0, i - window), i + 1);
    let sum = 0, wsum = 0; const fs = {};
    for (const F of FACTORS) {
      let p = pctRank(win.map(F.get), F.get(r));
      if (p == null) continue;
      if (F.invert) p = 100 - p;
      fs[F.key] = +p.toFixed(1);
      sum += F.w * p; wsum += F.w;
    }
    r.sent = wsum ? Math.round(sum / wsum) : null;
    r.sent_factors = fs;
    r.state6 = band6(r.sent);
  }
  return rows;
}

const STATE_NAMES = ['沸点', '过热', '微热', '微冷', '过冷', '冰点'];
module.exports = { computeSentiment, band6, STATE_NAMES, FACTORS };
