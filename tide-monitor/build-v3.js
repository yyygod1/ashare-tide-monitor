// 鐢?template.html + tide-data.json 鐢熸垚 v2 椤甸潰锛堝唴鑱旀暟鎹増 + 瀹炴椂鎷夊彇鐗堬級
const fs = require('fs');
const tpl = fs.readFileSync(__dirname + '/template.html', 'utf8');
const data = fs.readFileSync(__dirname + '/tide-data.json', 'utf8');
const dataObj = JSON.parse(data);
// 鍐呰仈鐗堬紙鍙洿鎺ュ弻鍑绘墦寮€锛宖ile:// 涔熻兘鐢級
fs.writeFileSync(__dirname + '/v3.html', tpl.replace('/*__BOOT__*/', 'boot(' + JSON.stringify(dataObj) + ');'));
// 瀹炴椂鐗堬紙璇诲彇鍚岀洰褰?tide-data.json锛屾柟渚挎瘡澶╅璁＄畻鍚庡埛鏂帮級
fs.writeFileSync(__dirname + '/v3-live.html', tpl.replace('/*__BOOT__*/',
  "fetch('./tide-data.json').then(function(r){return r.json()}).then(boot).catch(function(e){document.querySelector('.wrap').innerHTML='<p style=\"color:#f6465d\">鏁版嵁鍔犺浇澶辫触锛堥渶閫氳繃鏈湴鏈嶅姟鍣ㄦ墦寮€锛屾垨鎶?tide-data.json 鏀惧悓鐩綍锛夛細'+e+'</p>'});"));
console.log('v3.html / v3-live.html 鐢熸垚瀹屾垚');

