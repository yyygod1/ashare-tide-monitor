# A股情绪潮汐监测 · 独立站点

一个**不依赖任何本机**的行情监测页：GitHub Actions 定时抓数、重建页面，GitHub Pages 托管。
**周一~周五 18:35（北京时间）自动更新**，任何设备打开一个网址即可查看。

## 页面
- `docs/index.html` —— **单文件**（内联 ECharts + 数据快照），在线/离线都能开。

## 数据来源
东方财富公开接口（资金流、涨停池/炸板池、龙虎榜、板块）。

## 结构
```
tide-monitor/   数据管线脚本（fund → premium → aggregate → build-v3 → report → similar）
lib/em.js       请求层（并发限制 + 退避重试 + curl 兜底）
build-site.js   生成 docs/index.html（自包含）
.github/workflows/update.yml   定时重建 + Pages 部署
```

## 手动跑一次（本地）
```
node tide-monitor/fund.js
node tide-monitor/premium.js
node tide-monitor/aggregate.js
node build-site.js
# 或 npm run update
```

## 部署（一次性）
1. 在 GitHub 新建一个仓库（可私有/公开均可，Pages 需公开或 Pro 私有Pages）。
2. push 本目录到该仓库默认分支（如 `main`）。
3. 仓库 Settings → Pages → Source 选 **GitHub Actions**。
4. 到 Actions 里手动跑一次 workflow（workflow_dispatch）验证。
5. 完成后页面地址：`https://<user>.github.io/<repo>/`。

## 口径
温度分 = 沪深主力净额(超大+大) 60 日百分位；六态 = 温度分档（沸点≥85/过热≥70/微热≥55/微冷≥40/过冷≥25/冰点<25）；
溢价率 = 昨日涨停股（剔一字板）今日平均涨跌幅；炸板率 = 炸板/(涨停+炸板)；大面 = 昨涨停今跌>4%。
数据来自东方财富公开接口，涨停池历史约 30 个交易日。仅供研究，不构成投资建议。
