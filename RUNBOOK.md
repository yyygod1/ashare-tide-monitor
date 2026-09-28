# RUNBOOK — ashare-tide-monitor（tide-site）

> 固定四节：环境 / 启动 / 验证 / 回滚
> 更新：2026-09-28 ｜ 仓库：`C:\Users\Administrator\.openclaw\workspace\tide-site`（远端 `github.com/yyygod1/ashare-tide-monitor`）
> 线上：Netlify `https://elaborate-palmier-65e62f.netlify.app/` ｜ GitHub Pages `https://yyygod1.github.io/ashare-tide-monitor/`

## 1. 环境

| 项 | 值 |
|---|---|
| 运行时 | Node.js >= 18（本机 v24.18.0） |
| 依赖安装 | `package.json` 只含 scripts，无需 `npm install` 第三方包 |
| 目录 | `tide-monitor/` 数据管道 + 模板 ｜ `docs/` 静态站点产物 ｜ `lib/` 请求层与工具 ｜ `tide-worker/` Cloudflare Worker 调度器 ｜ `third_party/` 第三方留证 ｜ `.github/workflows/` CI |
| 数据产物 | `tide-monitor/tide-data.json`（历史）、`tide-today.json`（当日）、`fund-daily.json`、`premium-daily.json`、`intraday-hist.json` |
| 本地服务 | 计划任务「A股情绪潮汐-本地服务」→ `lib\hidden.vbs` 包一层 `tide-monitor\serve.cmd`，监听 **8899**（`http://127.0.0.1:8899/` 默认 `v3-live.html`） |
| 网络现实 | `github.com` git 通道被墙 → 推送走 `_push.js`（GitHub Git Data API）；`*.workers.dev` 在国内被 DNS 污染（Worker 只能当调度器，不能当数据端点） |
| 请求层 | `lib/em.js`：并发上限 + 最小间隔 + 退避重试 + curl 兜底 + 磁盘缓存；东财被限流时自动切腾讯（输出显 `源=腾讯`） |

## 2. 启动

```powershell
Set-Location C:\Users\Administrator\.openclaw\workspace\tide-site
npm run update
# = fund.js → premium.js → aggregate.js → build-v3.js → report.js → similar.js → build-site.js
```
- 盘中增量：`node tide-monitor/intraday.js`
- 补数：`node tide-monitor/backfill-prem.js`（配套 `.github/workflows/backfill.yml`）
- 本地页面（无窗口）：`wscript //B //Nologo lib\hidden.vbs tide-monitor\serve.cmd`
- 云端调度：Cloudflare Worker cron（`tide-worker/`，`wrangler.toml`）；本地兜底 `node cloud-trigger.js`
- 推送：`node _push.js`（绕开被墙的 git 通道）

## 3. 验证

| 检查 | 命令 / 位置 | 通过标准 |
|---|---|---|
| 数据龄 | `node tide-monitor/verify.js` | 盘中 `tide-today.json` 必须是**当日**且 < 20 分钟；盘后 `tide-data.json` 必须刚重建；不达标 `exit 1`（CI 变红） |
| 站点产物 | `docs/status.json` | 含本次构建时间与关键指标 |
| 线上数据 | 站点 `/tide-data.json` | 返回 raw 实时 JSON（`docs/_redirects` 规则末尾**必须带 `!`**，否则被同名静态文件 shadow，前端读到旧快照） |
| 本地页面 | `http://127.0.0.1:8899/` | 显示「数据 asof / 拉取于」并能自刷新（必须走 http，`file://` 打不开上传） |
| CI | Actions `update.yml` / `intraday.yml` / `backfill.yml` | verify 步骤为绿 |

## 4. 回滚

| 场景 | 操作 |
|---|---|
| 代码改动出问题 | `git revert <sha>` 或 `git checkout -- <file>`；推送前先本地比对 main |
| 线上数据错乱 | 站点是静态产物 → `git checkout <good-sha> -- docs/ build-site.js tide-monitor/` 后重跑 `node build-site.js` |
| Netlify 反代失效 | 查 `docs/_redirects` 规则末尾是否带 `!` |
| 云端调度失效 | Worker 只当调度器；本地兜底 `node cloud-trigger.js`（依赖本机开机）。**切换顺序：先跑通 Worker → 再停本机任务 → 最后删 workflow 的 `schedule:`** |
| 本地服务 | 停计划任务「A股情绪潮汐-本地服务」，`Get-NetTCPConnection -LocalPort 8899` 确认端口已释放 |

**未验证项（动手前先核）**：`verify.js` / `veto.js` 的确切文件名与参数、`_push.js` 用法、`tide-worker` 当前 cron 表达式。
