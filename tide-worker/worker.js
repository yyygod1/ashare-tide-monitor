// A股情绪潮汐 · Cloudflare Worker
// 职责：① 定时触发 GitHub Actions（workflow_dispatch） ② /tide-data.json 的 60s 边缘缓存反代
// 免费版限额：5 个 Cron Trigger / 账号、100,000 请求/日、10ms CPU/次、subrequests 50/次
// 部署：见同目录 README.md

const API = 'https://api.github.com';
const REPO = 'yyygod1/ashare-tide-monitor';
const RAW = 'https://raw.githubusercontent.com/yyygod1/ashare-tide-monitor/main/docs/tide-data.json';

async function dispatch(env, wf) {
  const res = await fetch(`${API}/repos/${REPO}/actions/workflows/${wf}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'cf-tide-trigger',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main' }),
    signal: AbortSignal.timeout(8000),
  });
  let body = '';
  try { body = (await res.text()).slice(0, 200); } catch (e) {}
  console.log(`dispatch ${wf} -> ${res.status} ${body}`);
  return res.status;
}

export default {
  async scheduled(event, env, ctx) {
    const c = new Date(Date.now() + 8 * 3600e3);
    const dow = c.getUTCDay();
    const m = c.getUTCHours() * 60 + c.getUTCMinutes();
    const stamp = `${c.getUTCHours()}:${String(c.getUTCMinutes()).padStart(2, '0')}`;
    const tokenOk = !!(env.GITHUB_TOKEN && env.GITHUB_TOKEN.length > 20);
    console.log(`scheduled fired cron=${event.cron} cst=${stamp} dow=${dow} tokenLen=${env.GITHUB_TOKEN ? env.GITHUB_TOKEN.length : 0}`);
    if (dow < 1 || dow > 5) { console.log('skip: weekend'); return; }
    const inAM = m >= 9 * 60 + 25 && m <= 11 * 60 + 30;
    const inPM = m >= 13 * 60 && m <= 15 * 60 + 10;
    const inPost = m >= 18 * 60 + 35 && m <= 19 * 60 + 10;
    const widen = env.TEST_WINDOW === '1';            // 临时验证开关
    const inTest = widen && m > 11 * 60 + 30 && m <= 12 * 60;
    const wf = (inAM || inPM || inTest) ? 'intraday.yml' : (inPost ? 'update.yml' : null);
    if (!wf) { console.log('skip: off-window ' + stamp); return; }
    if (!tokenOk) { console.error('GITHUB_TOKEN missing/short!'); return; }
    ctx.waitUntil((async () => {
      for (let i = 0; i < 3; i++) {
        try {
          const s = await dispatch(env, wf);
          if (s >= 200 && s < 300) return;
          if (s === 401 || s === 403 || s === 404) { console.error('dispatch auth/perm fail ' + s); return; }
        } catch (e) { console.error('dispatch threw: ' + (e && e.message)); }
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
      console.error('dispatch gave up: ' + wf);
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      if (!env.TRIGGER_KEY || url.searchParams.get('key') !== env.TRIGGER_KEY) {
        return new Response('forbidden', { status: 403 });
      }
      const wf = url.searchParams.get('wf') === 'update.yml' ? 'update.yml' : 'intraday.yml';
      try {
        const s = await dispatch(env, wf);
        return new Response(`dispatch ${wf} -> HTTP ${s}\n`, { status: s >= 200 && s < 300 ? 200 : 502 });
      } catch (e) {
        return new Response('error: ' + (e && e.message) + '\n', { status: 502 });
      }
    }
    if (url.pathname === '/' || url.pathname === '/tide-data.json') {
      const r = await fetch(RAW, { cf: { cacheTtl: 60, cacheEverything: true } });
      return new Response(r.body, {
        status: r.status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=60',
        },
      });
    }
    return new Response('not found', { status: 404 });
  },
};
