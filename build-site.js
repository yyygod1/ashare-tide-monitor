// Build the static site into ./docs
//  - docs/index.html   : CDN ECharts (CN-friendly + fallback) + inlined data  -> fast, small (~25KB)
//  - docs/offline.html : fully inlined single file (no network)               -> download & open anywhere
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'tide-monitor');
const tpl = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
const ed = fs.readFileSync(path.join(dir, 'echarts.min.js'), 'utf8');
const data = fs.readFileSync(path.join(dir, 'tide-data.json'), 'utf8');

const CDN_TAG = '<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>';
const CN_CDN =
  '<script src="https://cdn.bootcdn.net/ajax/libs/echarts/5.5.0/echarts.min.js"></script>' +
  '<script>window.echarts||document.write(\'<script src="https://cdn.staticfile.org/echarts/5.5.0/echarts.min.js"><\\/script>\');</script>' +
  '<script>window.echarts||document.write(\'<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"><\\/script>\');</script>';

function emit(html, name) { fs.writeFileSync(path.join(out, name), html); console.log(name + ' -> ' + fs.statSync(path.join(out, name)).size + ' bytes'); }

const out = path.join(__dirname, 'docs');
if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });

// online build: echarts from CDN (CN first), data fetched from ./tide-data.json (small + cacheable)
const LIVE_BOOT =
  "fetch('./tide-data.json').then(function(r){return r.json()}).then(boot).catch(function(e){" +
  "document.querySelector('.wrap').innerHTML='<p style=\"color:#f6465d\">\u6570\u636e\u52a0\u8f7d\u5931\u8d25\uff1a'+e+'</p>'});";
const onlineTpl = tpl.replace(CDN_TAG, CN_CDN);
emit(onlineTpl.replace('/*__BOOT__*/', LIVE_BOOT), 'index.html');
// offline build: echarts inlined
const offlineTpl = tpl.replace(CDN_TAG, '<script>' + ed + '</script>');
emit(offlineTpl.replace('/*__BOOT__*/', 'boot(' + data + ');'), 'offline.html');
// raw data (optional consumers)
fs.writeFileSync(path.join(out, 'tide-data.json'), data);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('docs/ built.');
