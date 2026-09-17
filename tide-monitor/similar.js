// C7 相似日检索：把今天的状态向量(温度/溢价/大面/炸板率/连板高度)与历史日比对，找最像的几天，看它们"次日"怎么走。
const fs = require('fs');
const path = require('path');
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'tide-data.json'), 'utf8')).rows;
const valid = rows.filter(r => r.prem_avg != null && r.zt > 0);
if (valid.length < 8) { console.log('历史样本不足'); process.exit(0); }
const tgt = valid[valid.length - 1];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const feats = r => [(r.sent != null ? r.sent : r.temp) / 100, clamp((r.prem_avg + 8) / 16, 0, 1), clamp(r.damian / 30, 0, 1), r.zb_rate / 100, clamp(r.max_lbc / 8, 0, 1)];
const F = feats(tgt);
const withDist = valid.filter(r => r.date !== tgt.date).map(r => { const f = feats(r); const d = Math.sqrt(f.reduce((s, x, i) => s + (x - F[i]) ** 2, 0)); return { r, d }; });
withDist.sort((a, b) => a.d - b.d);
const K = parseInt(process.argv[2] || '6', 10);
const near = withDist.slice(0, K);
const nextOf = date => { const i = rows.findIndex(r => r.date === date); return i >= 0 && i + 1 < rows.length ? rows[i + 1] : null; };
const mean = a => a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : null;
console.log(`今日 ${tgt.date}: 情绪分 ${tgt.sent}(${tgt.state6}) 资金温度 ${tgt.temp} | 溢价 ${tgt.prem_avg}% 红盘 ${tgt.prem_red}% 大面 ${tgt.damian} | 炸板率 ${tgt.zb_rate}% 高度 ${tgt.max_lbc}板`);
console.log(`\n最相似的 ${K} 天及其"次日"表现：`);
for (const x of near) { const n = nextOf(x.r.date); console.log(`  ${x.r.date}  距离${x.d.toFixed(2)}  情绪分${x.r.sent} 溢价${x.r.prem_avg}% 大面${x.r.damian}  →  次日 情绪分${n ? n.sent : '—'} 溢价${n ? n.prem_avg : '—'}% 红盘${n ? n.prem_red : '—'}% 大面${n ? n.damian : '—'}`); }
const nxt = near.map(x => nextOf(x.r.date)).filter(Boolean);
const dm = k => mean(nxt.map(n => n[k]).filter(v => v != null));
console.log(`\n相似日「次日」均值：溢价 ${dm('prem_avg')}% | 红盘 ${dm('prem_red')}% | 大面 ${dm('damian')} | 情绪分 ${dm('sent')}`);
console.log('提示：样本小、非预测，仅作历史参照。');
