// Build the static site into ./docs
//  - docs/index.html   : CDN ECharts (CN-friendly + fallback) + data fetched from ./tide-data.json
//  - docs/offline.html : fully inlined single file (no network)
//  - docs/tide-data.json : history + (if present) today's intraday row merged in
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'tide-monitor');
const tpl = fs.readFileSync(path.join(dir, 'template.html'), 'utf8')
  // public site: the screenshot-inbox card is a LOCAL-only feature (needs the local vision service) -> strip it
  .replace(/<!--INBOX_START-->[\s\S]*?<!--INBOX_END-->/g, '')
  .replace(/<!--INBOXJ_START-->[\s\S]*?<!--INBOXJ_END-->/g, '');
const ed = fs.readFileSync(path.join(dir, 'echarts.min.js'), 'utf8');

const CDN_TAG = '<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>';
const CN_CDN =
  '<script src="https://cdn.bootcdn.net/ajax/libs/echarts/5.5.0/echarts.min.js"></script>' +
  '<script>window.echarts||document.write(\'<script src="https://cdn.staticfile.org/echarts/5.5.0/echarts.min.js"><\\/script>\');</script>' +
  '<script>window.echarts||document.write(\'<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"><\\/script>\');</script>';

// ---- merge today's intraday row (if any) into the history ----
const dataObj = JSON.parse(fs.readFileSync(path.join(dir, 'tide-data.json'), 'utf8'));
try {
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'tide-today.json'), 'utf8'));
  if (t && t.row && t.intraday) {
    const last = dataObj.rows[dataObj.rows.length - 1];
    if (!last || t.row.date > last.date) {          // only if today is newer than the last completed day
      dataObj.rows.push(t.row);
      dataObj.intraday = { date: t.row.date, asof: t.row.asof, generated: t.generated };
      console.log('merged intraday row ' + t.row.date + ' ' + t.row.asof);
    } else {
      console.log('intraday row is not newer than history last (' + last.date + '), ignored');
    }
  }
} catch (e) { /* no intraday file */ }
const data = JSON.stringify(dataObj);

const out = path.join(__dirname, 'docs');
if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });

const LIVE_BOOT =
  "fetch('./tide-data.json?t='+Date.now()).then(function(r){return r.json()}).then(boot).catch(function(e){" +
  "document.querySelector('.wrap').innerHTML='<p style=\"color:#f6465d\">\u6570\u636e\u52a0\u8f7d\u5931\u8d25\uff1a'+e+'</p>'});";

function emit(html, name) { fs.writeFileSync(path.join(out, name), html); console.log(name + ' -> ' + fs.statSync(path.join(out, name)).size + ' bytes'); }

emit(tpl.replace(CDN_TAG, CN_CDN).replace('/*__BOOT__*/', LIVE_BOOT), 'index.html');            // online: CDN echarts + fetch json
emit(tpl.replace(CDN_TAG, '<script>' + ed + '</script>').replace('/*__BOOT__*/', 'boot(' + data + ');'), 'offline.html');  // offline single-file
fs.writeFileSync(path.join(out, 'tide-data.json'), data);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('docs/ built.');
