# tide-worker — 触发 + 数据端点（Cloudflare Workers，免费）

一个 Worker 干两件事：

1. **定时触发 GitHub Actions**（替代本机「A股情绪潮汐-云端触发」计划任务）
2. **`/tide-data.json` 缓存反代**（替代 Netlify 的 `_redirects` 反代，前端可直连）

## 部署步骤

```bash
cd tide-site/tide-worker
npx wrangler login
npx wrangler secret put GITHUB_TOKEN     # 粘贴 fine-grained PAT
npx wrangler deploy
```

部署后拿到地址，形如 `https://tide-trigger.<你的子域>.workers.dev`。

## GITHUB_TOKEN（fine-grained PAT）

- GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new
- Repository access：**Only select repositories → `yyygod1/ashare-tide-monitor`**
- Permissions：**Actions → Read and write**（其它一律 No access）
- 设一个到期日（如 90 天），到期前轮换

> ⚠️ 不要用 `gho_` 开头的 OAuth token（那是本地登录凭据，放云端不合适）。

## 触发窗口

`wrangler.toml` 里两条 cron（**UTC**）：

| cron | 北京时间 | 用途 |
|---|---|---|
| `*/5 1-3,5-7 * * 1-5` | 09:00–11:59 / 13:00–15:59 每 5 分钟 | 盘中 |
| `35 10 * * 1-5` | 18:35 | 盘后全量 |

Worker 内再判一次 09:25–11:30 / 13:00–15:10（所以 cron 覆盖的边缘时段是空跑，成本≈0）。

## 验证

- `wrangler tail` 看日志
- 浏览器打开 `https://<worker>/tide-data.json`，应与仓库 `docs/tide-data.json` 一致（≤60s 延迟）
- 到点后看仓库 Actions 是否出现 `workflow_dispatch` 触发的运行

## 切换顺序（重要）

**先把 Worker 跑通，再停本机任务**，否则会出现"没人触发"的空窗：

1. 部署本 Worker，确认到点能触发 Actions
2. 禁用本机计划任务：`Disable-ScheduledTask -TaskName 'A股情绪潮汐-云端触发'`
3. 删掉 `intraday.yml`/`update.yml` 里的 `schedule:`（只留 `workflow_dispatch`）
4. 前端如需直连数据端点，把 `DATA_BASE` 指向本 Worker
