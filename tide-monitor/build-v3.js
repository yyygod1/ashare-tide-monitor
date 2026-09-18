// 用 template.html + tide-data.json 生成 v3 页面（内联数据版 + 实时拉取版）
const fs = require('fs');
const tpl = fs.readFileSync(__dirname + '/template.html', 'utf8');
const data = fs.readFileSync(__dirname + '/tide-data.json', 'utf8');
const dataObj = JSON.parse(data);
// 内联版（可直接双击打开，file:// 也能用）
fs.writeFileSync(__dirname + '/v3.html', tpl.replace('/*__BOOT__*/', 'boot(' + JSON.stringify(dataObj) + ');'));
// 实时版（本地页默认用它）：数据源降级链 远程 netlify -> 远程 GP Pages -> 本地文件
const LOCAL_SOURCES = [
  'https://elaborate-palmier-65e62f.netlify.app/tide-data.json',
  'https://yyygod1.github.io/ashare-tide-monitor/tide-data.json',
  './tide-data.json',
];
fs.writeFileSync(__dirname + '/v3-live.html', tpl.replace('/*__BOOT__*/', 'bootLive(' + JSON.stringify(LOCAL_SOURCES) + ');'));
console.log('v3.html / v3-live.html 生成完成');
