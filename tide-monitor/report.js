// D13 收盘复盘报告：大面名单 / 高标 / 断板 / 溢价，并落盘 daily-report.txt
const fs = require('fs');
const path = require('path');
const { getJSON } = require('../lib/em');
const T = JSON.parse(fs.readFileSync(path.join(__dirname, 'tide-data.json'), 'utf8'));
const rows = T.rows;
const last = rows.filter(r => r.zt > 0).slice(-1)[0] || rows[rows.length - 1];
const lines = [];
const P = s => { lines.push(s); console.log(s); };

(async () => {
  P(`===== 收盘复盘 ${last.date} =====`);
  P(`情绪: 温度 ${last.temp}(${last.state6})  主力净额 ${last.main_yi}亿  ${last.diverge ? '⚠背离' : '无背离'}`);
  P(`涨停 ${last.zt} / 连板 ${last.zt_lianban} / 首板 ${last.zt_first}  最高 ${last.max_lbc}板  炸板率 ${last.zb_rate}%`);
  P(`昨日涨停今日溢价 ${last.prem_avg}%  红盘率 ${last.prem_red}%  大面 ${last.damian}`);
  // 高标
  const lb = last.lianban || {};
  const top = Object.keys(lb).map(Number).sort((a, b) => b - a)[0] || 0;
  const maxs = lb[String(top)] || [];
  P(`\n高标(${top}板): ${maxs.map(x => x.name + '/' + x.theme).join('、') || '无'}`);
  // 断板
  const fh = last.fail_high || [];
  P(`\n昨日高标断板: ${fh.map(x => `${x.name}(昨${x.prev_lbc}板)`).join('、') || '无'}`);
  // 大面名单（BK0815 成分，一请求）
  try {
    let list = [], pn = 1;
    while (true) {
      const d = await getJSON(`https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=200&fs=b:BK0815&fields=f12,f14,f3`);
      const diff = d.data && d.data.diff; if (!diff) break;
      const arr = Array.isArray(diff) ? diff : Object.values(diff); list.push(...arr); if (arr.length < 200) break; pn++;
    }
    const big = list.map(x => ({ n: x.f14, c: x.f12, chg: +(x.f3 / 100).toFixed(2) })).filter(x => x.chg <= -4).sort((a, b) => a.chg - b.chg);
    P(`\n大面名单(昨涨停今跌>4%, ${big.length}只): ${big.map(x => `${x.n}(${x.chg}%)`).join('、')}`);
  } catch (e) { P('\n大面名单: 拉取失败 ' + e.message); }
  fs.writeFileSync(path.join(__dirname, 'daily-report.txt'), lines.join('\n'));
})();
