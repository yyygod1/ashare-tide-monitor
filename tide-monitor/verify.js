// verify.js - 校验产数是否真的落库；没落库就让 CI 失败（红叉 + GitHub 自动邮件），避免静默提交旧数据。
// usage: node tide-monitor/verify.js intraday   # 盘中：要求 tide-today.json 是今天的、且够新
//        node tide-monitor/verify.js daily      # 盘后：要求 tide-data.json 刚被重建且非空
//        node tide-monitor/verify.js auto       # 按当前时段自动选
const fs = require('fs');
const path = require('path');
const dir = __dirname;

function cstNow() { return new Date(Date.now() + 8 * 3600e3); }
function fail(msg) { console.error('VERIFY FAIL: ' + msg); process.exit(1); }
const c = cstNow();
const dow = c.getUTCDay();
const mins = c.getUTCHours() * 60 + c.getUTCMinutes();
const inSession = dow >= 1 && dow <= 5 && ((mins >= 9 * 60 + 25 && mins <= 11 * 60 + 30) || (mins >= 13 * 60 && mins <= 15 * 60 + 10));
const today = `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, '0')}-${String(c.getUTCDate()).padStart(2, '0')}`;
const mode = process.argv[2] || 'auto';

function checkIntraday() {
  if (!inSession) { console.log('verify(intraday): 非交易时段，跳过'); return; }
  let t;
  try { t = JSON.parse(fs.readFileSync(path.join(dir, 'tide-today.json'), 'utf8')); }
  catch (e) { fail('tide-today.json 缺失或损坏：' + e.message); }
  if (t.date !== today) fail(`tide-today.json 日期 ${t.date} != 今日 ${today}（盘中数据未落库）`);
  if (!t.row || t.row.zt == null) fail('tide-today.json 今日行无有效数据');
  const ageMin = (Date.now() - new Date(t.generated).getTime()) / 60000;
  if (ageMin > 20) fail(`盘中数据 ${ageMin.toFixed(0)} 分钟未更新`);
  console.log(`verify(intraday) ok: ${t.date} ${t.asof}`);
}
function checkDaily() {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(dir, 'tide-data.json'), 'utf8')); }
  catch (e) { fail('tide-data.json 缺失或损坏：' + e.message); }
  if (!d.rows || !d.rows.length) fail('tide-data.json rows 为空');
  const ageH = (Date.now() - new Date(d.generated).getTime()) / 3600000;
  if (ageH > 2) fail(`tide-data.json ${ageH.toFixed(1)} 小时未重建（今日产数未落库）`);
  console.log(`verify(daily) ok: rows=${d.rows.length} last=${d.rows[d.rows.length - 1].date}`);
}
if (mode === 'intraday') checkIntraday();
else if (mode === 'daily') checkDaily();
else { if (inSession) checkIntraday(); checkDaily(); }
