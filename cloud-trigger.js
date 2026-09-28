// cloud-trigger.js — 兜底触发 GitHub Actions
// 背景：GitHub 自带的 schedule 对本仓库触发极不稳定（延迟数小时/整段漏跑），
//       本脚本由本机计划任务每 15 分钟跑一次：在 A 股交易时段/收盘后，主动 workflow_dispatch，
//       并在目标工作流已排队/正在跑、或 12 分钟内刚跑过时跳过，避免重复触发。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const REPO = 'yyygod1/ashare-tide-monitor';
const LOG = path.join(__dirname, 'cloud-trigger.log');
const MIN_GAP_MIN = 12;   // 距上次触发(或上次运行创建)不足该分钟数则跳过

function log(s) { const line = new Date().toISOString() + '  ' + s; try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {} console.log(line); }
function cst() { return new Date(Date.now() + 8 * 3600e3); }
function lastRun(wf) {
  try {
    const out = execFileSync(GH, ['run', 'list', '--workflow', wf, '--repo', REPO, '--limit', '5', '--json', 'status,createdAt'], { encoding: 'utf8' });
    const arr = JSON.parse(out || '[]');
    const busy = arr.some(r => ['queued', 'in_progress', 'requested', 'waiting', 'pending'].includes(r.status));
    const newest = arr.length ? new Date(arr[0].createdAt).getTime() : 0;
    return { busy, newest };
  } catch (e) { log('run list fail: ' + (e.stderr || e.message).toString().slice(0, 120)); return { busy: false, newest: 0 }; }
}
function maybe(wf) {
  const { busy, newest } = lastRun(wf);
  const gapMin = (Date.now() - newest) / 60000;
  if (busy) { log('SKIP ' + wf + ' (运行中/排队中)'); return; }
  if (gapMin < MIN_GAP_MIN) { log('SKIP ' + wf + ' (上次运行 ' + gapMin.toFixed(0) + ' 分钟前)'); return; }
  try {
    execFileSync(GH, ['workflow', 'run', wf, '--repo', REPO], { encoding: 'utf8' });
    log('DISPATCH ' + wf + ' ok');
  } catch (e) { log('DISPATCH ' + wf + ' FAIL ' + (e.stderr || e.message).toString().slice(0, 200)); }
}

const c = cst(); const dow = c.getUTCDay(); const mins = c.getUTCHours() * 60 + c.getUTCMinutes();
if (dow < 1 || dow > 5) { log('skip: weekend'); process.exit(0); }
const inAM = mins >= 9 * 60 + 25 && mins <= 11 * 60 + 30;
const inPM = mins >= 13 * 60 && mins <= 15 * 60 + 10;
if (inAM || inPM) { maybe('intraday.yml'); }
else if (mins >= 18 * 60 + 35 && mins <= 19 * 60 + 10) { maybe('update.yml'); }
else { log('skip: off-window ' + String(c.getUTCHours()).padStart(2, '0') + ':' + String(c.getUTCMinutes()).padStart(2, '0') + ' CST'); }
