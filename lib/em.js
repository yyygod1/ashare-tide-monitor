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

async function oneFetch(url, headers) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': REF, ...headers } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    // curl fallback (native curl is often more reliable against these APIs)
    const buf = execFileSync(CURL, ['-s', '-A', UA, '-e', REF, '--max-time', '25', url], { maxBuffer: 3e8 });
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

module.exports = { getJSON, UA, REF };
