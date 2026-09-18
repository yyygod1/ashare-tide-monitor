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
    signal: AbortSignal.timeout(8000), // 单次 8s 超时（等待网络不计 CPU，不会被 10ms 限额杀掉）
  });
  return res.status;
}

export default {
  // 定时触发。cron 已把窗口卡好（UTC）：
  //   */5 1-3,5-7 * * 1-5  ->  CST 09:00-11:59 / 13:00-15:59，每 5 分钟
  //   35 10 * * 1-5         ->  CST 18:35
  // 这里只再挡一次周末和窗口边缘（节假日放行，靠 workflow 的“无变化不提交”兜底）。
  async scheduled(event, env, ctx) {
    const c = new Date(Date.now() + 8 * 3600e3);
    const dow = c.getUTCDay();
    if (dow < 1 || dow > 5) return;
    const m = c.getUTCHours() * 60 + c.getUTCMinutes();
    const inAM = m >= 9 * 60 + 25 && m <= 11 * 60 + 30;
    const inPM = m >= 13 * 60 && m <= 15 * 60 + 10;
    const wf = (inAM || inPM) ? 'intraday.yml' : 'update.yml';
    ctx.waitUntil((async () => {
      for (let i = 0; i < 3; i++) {
        try {
          const s = await dispatch(env, wf);
          if (s >= 200 && s < 300) return;
          if (s === 401 || s === 403 || s === 404) return; // 认证/权限问题，重试无意义
        } catch (e) { /* 网络错误 -> 重试 */ }
        await new Promise(r => setTimeout(r, 1500 * (i + 1)));
      }
    })());
  },

  // 数据端点：反代 raw 并做 60s 边缘缓存；前端可直连本 Worker，不依赖任何 deploy
  async fetch(request, env) {
    const url = new URL(request.url);

    // 调试触发：/run?key=TRIGGER_KEY[&wf=intraday.yml|update.yml]
    // （生产环境没有 __scheduled 端点；用它可立即验证调度是否通）
    if (url.pathname === '/run') {
      if (!env.TRIGGER_KEY || url.searchParams.get('key') !== env.TRIGGER_KEY) {
        return new Response('forbidden', { status: 403 });
      }
      const wf = url.searchParams.get('wf') === 'update.yml' ? 'update.yml' : 'intraday.yml';
      const s = await dispatch(env, wf);
      return new Response('dispatch ' + wf + ' -> HTTP ' + s + '\n', {
        status: s >= 200 && s < 300 ? 200 : 502,
      });
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
