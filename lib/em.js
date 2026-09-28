// em.js - throttled request layer for East Money public APIs
// features: global concurrency cap + min gap + exponential backoff retry + curl fallback + optional disk cache
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REF = 'https://quote.eastmoney.com/';
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const MAX_CONCURRENCY = 3;
const MIN_GAP_MS = 160;
let active = 0; const waiters = []; let lastStart = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function acquire() { return new Promise(res => { if (active < MAX_CONCURRENCY) { active++; res(); } else waiters.push(res); }); }
function release() { active--; const n = waiters.shift(); if (n) n(); }
async function gate() { await acquire(); const w = lastStart + MIN_GAP_MS - Date.now(); if (w > 0) await sleep(w); lastStart = Date.now(); }

function secidToSina(secid) {
  const parts = String(secid || '').split('.');
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return null;
  const code = parts[1].padStart(6, '0');
  if (parts[0] === '1') return 'sh' + code;
  if (parts[0] === '0') return 'sz' + code;
  return null;
}

// 新浪日 K -> 东财 klines 同构行（第 9 个字段 = 涨跌幅，premium.js 依赖）
async function sinaKline(secid, lmt) {
  const sym = secidToSina(secid);
  if (!sym) return null;
  const url = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'
    + '?symbol=' + sym + '&scale=240&ma=no&datalen=' + Math.max(1, lmt);
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn' } });
  if (!r.ok) return null;
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  const klines = [];
  let prev = null;
  for (const it of rows) {
    const open = +it.open, close = +it.close, high = +it.high, low = +it.low, vol = +it.volume || 0;
    const pct = prev ? +(((close / prev - 1) * 100).toFixed(4)) : 0;
    const amp = prev ? +(((high - low) / prev * 100).toFixed(4)) : 0;
    const chg = prev ? +(close - prev).toFixed(4) : 0;
    klines.push([it.day, open.toFixed(2), close.toFixed(2), high.toFixed(2), low.toFixed(2),
      vol, '', amp, pct, chg, ''].join(','));
    prev = close;
  }
  return { data: { klines } };
}

async function oneFetch(url, headers) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': REF, ...headers } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    // curl fallback (native curl is often more reliable against these APIs)
    let buf;
    try {
      buf = execFileSync(CURL, ['-s', '-A', UA, '-e', REF, '--max-time', '25', url], { maxBuffer: 3e8 });
    } catch (ce) {
      // 东财不可达：K 线类请求再试“新浪”备源
      // （本机 push2his /stock/kline/get 被按路径封锁——实测 RemoteDisconnected；新浪同数据可用）
      const m = /push2his\.eastmoney\.com\/api\/qt\/stock\/kline\/get\?([^#]*)/.exec(url);
      if (m) {
        try {
          const q = new URLSearchParams(m[1]);
          const alt = await sinaKline(q.get('secid'), +(q.get('lmt') || 320));
          if (alt) {
            console.log('[em] push2his kline -> 新浪备源 secid=' + q.get('secid') + ' rows=' + alt.data.klines.length);
            return alt;
          }
        } catch (se) { /* 备源也失败则走下面抛出 */ }
      }
      // 子进程失败（例如 curl exit 52 = 空响应/被拒）归类为“东财不可达”，
      // 便于上层区分“网络不可达”与“数据异常”，也不再把 child_process 原始报错糊上来
      const err = new Error('eastmoney-unreachable (' + (ce.status !== undefined ? 'curl exit ' + ce.status : ce.message) + ')');
      err.code = 'EM_UNREACHABLE';
      err.cause = e;
      throw err;
    }
    const t = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!t) throw e;
    return JSON.parse(t);
  }
}

async function getJSON(url, opts = {}) {
  const { ttl = 0, tries = 4, headers = {} } = opts; // ttl seconds; >0 enables disk cache
  const cf = path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');
  if (ttl > 0 && fs.existsSync(cf)) { const st = fs.statSync(cf); if (Date.now() - st.mtimeMs < ttl * 1000) return JSON.parse(fs.readFileSync(cf, 'utf8')); }
  await gate();
  try {
    let data = null, lastErr = null;
    for (let i = 0; i < tries; i++) {
      try { data = await oneFetch(url, headers); break; }
      catch (e) { lastErr = e; await sleep(350 * Math.pow(2, i) + Math.floor(Math.random() * 250)); }
    }
    if (data == null) throw lastErr || new Error('fetch failed');
    if (ttl > 0) { try { fs.writeFileSync(cf, JSON.stringify(data)); } catch (e) { } }
    return data;
  } finally { release(); }
}

async function getJSONMulti(urls, opts = {}) {
  let lastErr = null;
  for (const u of urls) { try { return await getJSON(u, opts); } catch (e) { lastErr = e; } }
  throw lastErr || new Error('all hosts failed');
}
// push2 family: some IPs get an HTML anti-bot page from push2; push2delay is a reliable mirror.
function push2(paths) {
  return paths.map(p => 'https://push2delay.eastmoney.com' + p).concat(paths.map(p => 'https://push2.eastmoney.com' + p));
}

module.exports = { getJSON, getJSONMulti, push2, UA, REF };
