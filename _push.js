// push changed files to GitHub via the Git Data API (works when github.com git port is blocked but api.github.com is reachable)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const TOKEN = process.env.GH_TOKEN || execFileSync('C:\\Program Files\\GitHub CLI\\gh.exe', ['auth', 'token'], { encoding: 'utf8' }).trim();
const REPO = 'yyygod1/ashare-tide-monitor';
const API = 'https://api.github.com';
const DIR = 'C:\\Users\\Administrator\\.openclaw\\workspace\\tide-site';
// files to push (env FILES=comma,separated or edit list below); paths relative to DIR
const FILES = (process.env.FILES ? process.env.FILES.split(',') : [
  'tide-monitor/intraday.js'
]).map(s => s.trim()).filter(Boolean);
const H = { Authorization: 'Bearer ' + TOKEN, 'User-Agent': 'tide-push', Accept: 'application/vnd.github+json' };
async function j(u, o) {
  const r = await fetch(u, Object.assign({}, o, { headers: Object.assign({}, H, (o && o.headers) || {}) }));
  if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 300));
  return r.json();
}
(async () => {
  const ref = await j(API + `/repos/${REPO}/git/ref/heads/main`);
  const baseSha = ref.object.sha;
  const base = await j(API + `/repos/${REPO}/git/commits/${baseSha}`);
  const tree = [];
  for (const f of FILES) {
    const content = fs.readFileSync(path.join(DIR, f)).toString('base64');
    const blob = await j(API + `/repos/${REPO}/git/blobs`, { method: 'POST', body: JSON.stringify({ content, encoding: 'base64' }) });
    tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
    console.log('blob', f, blob.sha.slice(0, 7));
  }
  const t = await j(API + `/repos/${REPO}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
  const c = await j(API + `/repos/${REPO}/git/commits`, { method: 'POST', body: JSON.stringify({ message: (process.env.MSG || 'chore: update'), tree: t.sha, parents: [baseSha] }) });
  await j(API + `/repos/${REPO}/git/refs/heads/main`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
  console.log('PUSHED commit', c.sha);
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
