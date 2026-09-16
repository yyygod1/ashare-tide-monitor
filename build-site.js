// Build the static site into ./docs  (single self-contained index.html + tide-data.json).
// index.html inlines ECharts + the data snapshot -> works on any browser, no server, offline OK.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'tide-monitor');
let tpl = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
const ed = fs.readFileSync(path.join(dir, 'echarts.min.js'), 'utf8');
const data = fs.readFileSync(path.join(dir, 'tide-data.json'), 'utf8');

tpl = tpl.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/echarts@5\.5\.0\/dist\/echarts\.min\.js"><\/script>/,
  '<script>' + ed + '</script>');

const out = path.join(__dirname, 'docs');
if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), tpl.replace('/*__BOOT__*/', 'boot(' + data + ');'));
fs.writeFileSync(path.join(out, 'tide-data.json'), data);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('docs/index.html built (' + fs.statSync(path.join(out, 'index.html')).size + ' bytes)');
