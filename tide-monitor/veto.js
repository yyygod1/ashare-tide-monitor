// veto.js — 情绪态「硬约束层」：一票否决 / 强制降档（纯函数，可单测）
// 方案见 PLAN-veto-v5.md。灰度期：TREND_MODE='conservative' + T7 只预警；上线 20 个交易日后切 'standard' 并启用 T7 硬降。
//
// 口径速记：
//   维度贡献  梯队{T1,T2,T4}[1, 同维≥2→+0.5] / 亏钱{T3,T5}[1, 同维≥2→+0.5] / 资金{T6}[0.5, 需梯队或亏钱命中] / 系统性{T7}[1, 非灰度]
//   分级      total>=3→至少冰点 / >=2→至少过冷 / >0→降一档且不超过过冷 / =0→不变
//   终态      基础态、day_state、trend_state 三者最冷者（只降不升）
//   T7 独立计 1，不要求其他维度命中（它是「跌停≥20 且指数破位」的合取强信号）；
//   T6 只是资金流出，需其他维度确认 → 单独命中不计（dims.资金=0，raw_dims.资金=true 留档）。

const ORDER = ['冰点', '过冷', '微冷', '微热', '过热', '沸点']; // 0=最冷 ... 5=最热
const COLD = '过冷', ICE = '冰点';

function idx(s) { const i = ORDER.indexOf(s); if (i < 0) throw new Error('veto: unknown state "' + s + '"'); return i; }
const colderOf = (a, b) => idx(a) <= idx(b) ? a : b;          // 取更冷（索引更小）
const atLeast = (s, cap) => idx(s) <= idx(cap) ? s : cap;     // 至少降到 cap（已更冷则保持）
const atMost = (s, cap) => idx(s) >= idx(cap) ? s : cap;      // 不超过 cap（已更暖则保持）
const down1 = s => ORDER[Math.max(0, idx(s) - 1)];            // 降一档（更冷 = 索引-1）

const CFG = {
  T1: { p: 0.20, k: 5, staticK: 0.6 },                         // 涨停 < min(P20, 近5日均*k)
  T2: { minBase2: 5, minBaseLbTot: 8, r2: 0.5, rlb: 0.7 },      // 最小基数 + 梯队瓦解
  T3: { p: 0.80, floor: 10, static: 15 },                      // 大面 > max(P80, floor)
  T4: { p: 0.80, floor: 35, static: 40 },                      // 炸板率 > max(P80, floor)
  T5: { prem: -1, red: 40 },                                   // 溢价<=-1 且 全市场红盘率<40
  T6: { p: 0.80, static: 2, abs: -350 },                       // 净流出/成交额 > P80；回退 比分>2% 且 有其它命中
  T7: { dt: 20, idxChg: -0.8 },                                // 跌停>=20 且 (沪指<=-0.8% 或 新破MA20)
  sampleMin: 20,
  trend: { h3: 2, h4: 3, mode: 'conservative' },               // 'conservative' | 'standard'
  gray: { t7_warn_only: true }
};

const hasData = r => r && r.zt > 0;
const P = (a, q) => { a = a.filter(x => x != null && isFinite(x)).slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : null; };
const winVals = (rows, i, f, k) => rows.slice(Math.max(0, i - k), i).filter(hasData).map(f).filter(x => x != null && isFinite(x));
const cnt2 = r => (r.lianban && r.lianban['2'] ? r.lianban['2'].length : 0);
const lbTot = r => Object.keys(r.lianban || {}).reduce((s, k) => s + (+k >= 2 ? (r.lianban[k] || []).length : 0), 0); // 连板总数 = lbc>=2

// 从 rows[i]（与 rows[i-1]）提取触发器布尔 + 明细 + 质量
function triggersFor(rows, i, cfg = CFG) {
  const r = rows[i], p = i > 0 ? rows[i - 1] : null;
  const q = { threshold_mode: {}, t5_proxy: false, t6_proxy: false, t7_data: false };
  const reasons = [], skipped = [];
  // T1
  const zW = winVals(rows, i, x => x.zt, cfg.sampleMin), n = zW.length;
  const prev5 = rows.slice(Math.max(0, i - 5), i).filter(hasData);
  const z5 = prev5.length ? prev5.reduce((a, x) => a + x.zt, 0) / prev5.length : null;
  const stat1 = z5 != null ? z5 * cfg.T1.staticK : null;
  let thr1 = stat1;
  if (n >= cfg.sampleMin) { thr1 = Math.min(P(zW, cfg.T1.p), stat1); q.threshold_mode.T1 = 'quantile'; } else q.threshold_mode.T1 = 'static';
  const T1 = thr1 != null && r.zt < thr1;
  if (T1) reasons.push({ code: 'T1', text: `涨停 ${r.zt} < ${thr1.toFixed(0)}（${q.threshold_mode.T1 === 'quantile' ? 'P20∧均×0.6' : '近5日均×0.6'}）` });
  // T2
  const p2 = p ? cnt2(p) : 0, plbT = p ? lbTot(p) : 0;
  const baseOk = !!(p && p.max_lbc > 2 && (p2 >= cfg.T2.minBase2 || plbT >= cfg.T2.minBaseLbTot));
  let T2 = false;
  if (!baseOk) skipped.push('T2:min_base');
  else T2 = !!(((r.max_lbc <= p.max_lbc) && cnt2(r) <= p2 * cfg.T2.r2) || ((r.max_lbc <= p.max_lbc - 1) && lbTot(r) <= plbT * cfg.T2.rlb));
  if (T2) reasons.push({ code: 'T2', text: `梯队瓦解（高板 ${p.max_lbc}→${r.max_lbc}，2板 ${p2}→${cnt2(r)}，连板 ${plbT}→${lbTot(r)}）` });
  // T3
  const dW = winVals(rows, i, x => x.damian, cfg.sampleMin);
  let thr3 = cfg.T3.static;
  if (dW.length >= cfg.sampleMin) { thr3 = Math.max(P(dW, cfg.T3.p), cfg.T3.floor); q.threshold_mode.T3 = 'quantile'; } else q.threshold_mode.T3 = 'static';
  const T3 = r.damian != null && r.damian > (q.threshold_mode.T3 === 'quantile' ? thr3 : cfg.T3.static - 1) && r.damian >= cfg.T3.floor;
  if (T3) reasons.push({ code: 'T3', text: `大面 ${r.damian}（${q.threshold_mode.T3} 阈值 ${thr3}）` });
  // T4
  const zrW = winVals(rows, i, x => x.zb_rate, cfg.sampleMin);
  let thr4 = cfg.T4.static;
  if (zrW.length >= cfg.sampleMin) { thr4 = Math.max(P(zrW, cfg.T4.p), cfg.T4.floor); q.threshold_mode.T4 = 'quantile'; } else q.threshold_mode.T4 = 'static';
  const T4 = r.zb_rate != null && r.zb_rate > (q.threshold_mode.T4 === 'quantile' ? thr4 : cfg.T4.static - 1) && r.zb_rate >= cfg.T4.floor;
  if (T4) reasons.push({ code: 'T4', text: `炸板率 ${r.zb_rate}%（${q.threshold_mode.T4} 阈值 ${thr4}）` });
  // T5
  let red = r.market_red;
  if (red == null) { red = r.prem_red; q.t5_proxy = true; }
  const T5 = r.prem_avg != null && r.prem_avg <= cfg.T5.prem && red != null && red < cfg.T5.red;
  if (T5) reasons.push({ code: 'T5', text: `承接转负（溢价 ${r.prem_avg}% 且 ${q.t5_proxy ? '昨涨停红盘率' : '全市场红盘率'} ${red}%）` });
  if (q.t5_proxy) skipped.push('T5:market_red_missing(用prem_red代理)');
  // T6
  let T6 = false;
  if (r.main_yi != null) {
    if (r.market_amt_yi && r.market_amt_yi > 0) { q.t6_proxy = false; /* 分位需序列，见 evaluateSeries 覆盖 */ T6 = null; }
    else { q.t6_proxy = true; T6 = r.main_yi <= cfg.T6.abs; }
  }
  if (T6 === true) reasons.push({ code: 'T6', text: `资金失血（主力 ${r.main_yi}亿）` });
  // T7
  let T7 = false;
  if (r.dt != null && (r.idx_chg != null || r.idx_break_ma20 != null)) {
    q.t7_data = true;
    T7 = r.dt >= cfg.T7.dt && ((r.idx_chg != null && r.idx_chg <= cfg.T7.idxChg) || r.idx_break_ma20 === true);
  }
  if (T7) reasons.push({ code: 'T7', text: `双杀（跌停 ${r.dt}；${r.idx_break_ma20 ? '新破MA20' : '沪指 ' + r.idx_chg + '%'}）` });
  return { r, T1, T2, T3, T4, T5, T6: T6 === true, T6pending: T6 === null, T7, reasons, skipped, q };
}

// 计数（纯）：tr = {T1..T7}
function countTotal(tr, t7WarnOnly) {
  const other = !!(tr.T1 || tr.T2 || tr.T3 || tr.T4 || tr.T5);
  const nJ = [tr.T1, tr.T2, tr.T4].filter(Boolean).length;
  const nK = [tr.T3, tr.T5].filter(Boolean).length;
  const dims = { 梯队: 0, 亏钱: 0, 资金: 0, 系统性: 0 };
  if (nJ) dims.梯队 = 1 + (nJ >= 2 ? 0.5 : 0);
  if (nK) dims.亏钱 = 1 + (nK >= 2 ? 0.5 : 0);
  if (tr.T6 && other) dims.资金 = 0.5;
  if (tr.T7 && !t7WarnOnly) dims.系统性 = 1;
  const raw_dims = { 梯队: nJ > 0, 亏钱: nK > 0, 资金: !!tr.T6, 系统性: !!tr.T7 };
  const total = +(dims.梯队 + dims.亏钱 + dims.资金 + dims.系统性).toFixed(2);
  return { total, dims, raw_dims };
}
function dayState(base, total) {
  if (total >= 3) return atLeast(base, ICE);
  if (total >= 2) return atLeast(base, COLD);
  if (total > 0) return atMost(down1(base), COLD);
  return base;
}

// 序列评估：给每行（有基础态的行）写入 .veto
function evaluateSeries(rows, opts = {}) {
  const cfg = Object.assign({}, CFG, opts.cfg || {});
  const mode = opts.mode || cfg.trend.mode;
  const t7WarnOnly = opts.t7_warn_only != null ? opts.t7_warn_only : cfg.gray.t7_warn_only;
  // 1) triggers + total
  const meta = new Map();
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].state6) continue;
    const t = triggersFor(rows, i, cfg);
    // T6 分位模式：净流出比分序列
    if (t.T6pending) {
      const ratios = winVals(rows, i, x => (x.market_amt_yi && x.main_yi != null) ? (-x.main_yi / x.market_amt_yi) : null, cfg.sampleMin);
      const cur = (-rows[i].main_yi / rows[i].market_amt_yi);
      if (ratios.length >= cfg.sampleMin) { t.T6 = cur > Math.max(P(ratios, cfg.T6.p), cfg.T6.static / 100); t.q.threshold_mode.T6 = 'quantile'; }
      else { t.T6 = cur > cfg.T6.static / 100; t.q.threshold_mode.T6 = 'static'; }
      if (t.T6) t.reasons.push({ code: 'T6', text: `资金失血（净流出占比 ${(cur * 100).toFixed(2)}%）` });
      t.q.t6_proxy = false;
    }
    const ct = countTotal(t, t7WarnOnly);
    meta.set(i, { t, ct });
  }
  // 2) day_state + trend_state + final
  rows.forEach((r, i) => { r.veto_available = meta.has(i); });   // 明确区分「判定为不变」与「未运行」
  const stateRows = rows.map((r, i) => meta.has(i) ? i : -1).filter(i => i >= 0);
  stateRows.forEach((i, k) => {
    const { t, ct } = meta.get(i);
    const base = rows[i].state6;
    const ds = dayState(base, ct.total);
    // 趋势窗口：命中日 = total>0（含今日）
    const prevIdx = stateRows.slice(Math.max(0, k - 3), k + 1);           // 含今日最多4个
    const h3 = prevIdx.slice(-3).filter(j => meta.get(j).ct.total > 0).length;
    const h4 = prevIdx.slice(-4).filter(j => meta.get(j).ct.total > 0).length;
    const low3 = stateRows.slice(Math.max(0, k - 3), k);                   // 不含今日前3个
    const newLow = low3.length ? (idx(base) <= Math.min(...low3.map(j => idx(rows[j].state6)))) : false;
    const anchor = ct.total > 0 || newLow;
    let tr = base, trReasons = [];
    if (anchor && h3 >= cfg.trend.h3) { tr = atLeastCold(tr, COLD); trReasons.push(`3日≥${cfg.trend.h3}`); }
    if (anchor && mode === 'standard' && h4 >= cfg.trend.h4) { tr = colderOf(tr, atLeastCold(base, ICE)); trReasons.push(`4日≥${cfg.trend.h4}`); }
    const fin = colderOf(colderOf(base, ds), tr);
    rows[i].veto = {
      base_state: base, total: ct.total, hits: { T1: t.T1, T2: t.T2, T3: t.T3, T4: t.T4, T5: t.T5, T6: t.T6, T7: t.T7 },
      raw_dims: ct.raw_dims, dims: ct.dims, skipped: t.skipped,
      day_state: ds, trend_state: tr, trend_reasons: trReasons, final_state: fin, reasons: t.reasons,
      data_quality: Object.assign({ sample_size: winVals(rows, i, x => x.zt, cfg.sampleMin).length, t7_warn_only: t7WarnOnly, anchors: { hit_window_3: h3, hit_window_4: h4, newLow } }, t.q)
    };
  });
  return rows;
}
function atLeastCold(s, cap) { return atLeast(s, cap); }

// 盘中预检：放宽阈值，T1 不参与计数，不改 state6
function prewarnFor(rows, i) {
  const r = rows[i]; const tr = triggersFor(rows, i); const triggers = [];
  if (tr.T3 && r.damian >= 20) triggers.push('T3');
  if (tr.T4 && r.zb_rate >= 50) triggers.push('T4');
  const red = r.market_red != null ? r.market_red : r.prem_red;
  if (r.prem_avg != null && r.prem_avg <= -2 && red != null && red < 35) triggers.push('T5');
  if (r.dt != null && r.dt >= 25) triggers.push('T7');
  return { on: triggers.length > 0, point: r.asof || null, triggers, note: '盘中预检（放宽阈值），待收盘确认' };
}

module.exports = { ORDER, CFG, countTotal, dayState, triggersFor, evaluateSeries, prewarnFor, idx, colderOf, atLeast, atMost, down1 };

// ---------------- self-test: node veto.js --test ----------------
if (require.main === module && process.argv.includes('--test')) {
  let pass = 0, fail = 0;
  const chk = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`)); ok ? pass++ : fail++; };
  const mk = (b, tr, t7gray = true) => { const ct = countTotal(Object.assign({ T1: 0, T2: 0, T3: 0, T4: 0, T5: 0, T6: 0, T7: 0 }, tr), t7gray); return { total: ct.total, day: dayState(b, ct.total), dims: ct.dims }; };
  console.log('fixtures:');
  let x;
  x = mk('微冷', { T3: 1 }); chk('微冷,T3', [x.total, x.day], [1, '过冷']);
  x = mk('过冷', { T1: 1, T4: 1 }); chk('过冷,T1,T4', [x.total, x.day], [1.5, '过冷']);
  x = mk('冰点', { T3: 1, T5: 1, T6: 1 }); chk('冰点,T3,T5,T6', [x.total, x.day], [2, '冰点']);
  x = mk('过冷', { T1: 1, T2: 1, T3: 1, T4: 1, T6: 1 }); chk('过冷,T1,T2,T3,T4,T6', [x.total, x.day], [3, '冰点']);
  x = mk('过冷', { T6: 1 }); chk('过冷,T6(单独)', [x.total, x.day, x.dims.资金], [0, '过冷', 0]);
  x = mk('沸点', {}); chk('沸点,无', [x.total, x.day], [0, '沸点']);
  x = mk('冰点', { T1: 1, T2: 1, T3: 1, T4: 1, T6: 1, T7: 1 }, true); chk('冰点+全触发(T7灰度)', [x.total, x.day, x.dims.系统性], [3, '冰点', 0]);
  x = mk('沸点', { T1: 1, T3: 1, T6: 1 }); chk('沸点,T1,T3,T6', [x.total, x.day], [2.5, '过冷']);
  x = mk('微热', { T1: 1, T2: 1, T3: 1, T4: 1, T5: 1, T6: 1 }); chk('微热+全触发', [x.total, x.day], [3.5, '冰点']);
  // fixture 3a/3b：趋势层两模式（合成长序列）
  function synth(mode) {
    const rows = [];
    // 3 天都是「过冷」基础态，且每天都命中 T3（大面 30）→ h3=3, h4=3
    const base = '过冷';
    for (let n = 0; n < 3; n++) rows.push({ zt: 40, max_lbc: 4, lianban: { '2': [1, 2, 3, 4, 5, 6] }, state6: base, damian: 30, zb_rate: 10, prem_avg: 1, prem_red: 50, main_yi: 0 });
    evaluateSeries(rows, { mode, t7_warn_only: true });
    return rows[rows.length - 1].veto.final_state;
  }
  chk('fixture3a standard', synth('standard'), '冰点');
  chk('fixture3b conservative', synth('conservative'), '过冷');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
