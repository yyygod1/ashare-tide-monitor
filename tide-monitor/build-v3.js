// 用 template.html + tide-data.json 生成 v3 页面（内联数据版 + 实时拉取版）
const fs = require('fs');
const tpl = fs.readFileSync(__dirname + '/template.html', 'utf8');
const data = fs.readFileSync(__dirname + '/tide-data.json', 'utf8');
const dataObj = JSON.parse(data);
// 内联版（可直接双击打开，file:// 也能用）
fs.writeFileSync(__dirname + '/v3.html', tpl.replace('/*__BOOT__*/', 'boot(' + JSON.stringify(dataObj) + ');'));
// 实时版（读取同目录 tide-data.json，60s/5min 轮询刷新）
fs.writeFileSync(__dirname + '/v3-live.html', tpl.replace('/*__BOOT__*/', 'bootLive();'));
console.log('v3.html / v3-live.html 生成完成');
