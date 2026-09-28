# 第三方声明 / Third-Party Notices

本仓库（ashare-tide-monitor）**不包含**下列第三方项目的任何源代码。

## 1. quantdash-ai-stock

| 项 | 内容 |
|---|---|
| 上游 | `https://github.com/rancy777/quantdash-ai-stock` |
| 本地副本 | `D:\projects\quantdash-ai-stock`（**独立目录，不在本仓库树内**） |
| 获取方式 | tarball 快照（**无 `.git`、无远端**，上游变更不影响本仓库） |
| 快照日期 | 2026-09-28 |
| 许可证 | PolyForm Noncommercial License 1.0.0 |
| 许可原文留证 | `third_party/quantdash-LICENSE-2026-09-28.txt` |
| 离线快照 | `D:\backups\quantdash-snapshot-20260928.tar.gz` |

**允许的接触方式（仅此三种）**
1. 只读其输出的 JSON 数据文件（**不复制其代码**）；
2. 以独立进程通过 HTTP / MCP 调用；
3. 参照其思路**独立重写**（思路不受版权保护，代码表达受版权保护）。

**明确不做**
- 不复制其源代码或文件进本仓库；
- 不在本仓库 `import` 其任何模块；
- 不将其任何文件提交到本仓库。

### 数据适配契约（字段映射只允许出现在适配层）

| 上游字段 | 语义 | 暴露名 |
|---|---|---|
| `date` | 交易日 | `date` |
| `sent` / `sent_factors` | 情绪分 / 6 因子明细 | `sentiment` / `sentimentFactors` |
| `state6` | 六态 | `state6` |
| `temp` | 资金温度 | `fundTemp` |
| `prem_avg` | 平均溢价 | `premiumAvg` |
| `zt` / `max_lbc` | 涨停数 / 最高连板 | `limitUp` / `maxBoard` |
| `zb_rate` / `damian` | 炸板率 / 大面 | `brokenRate` / `bigFace` |
| `veto` | 否决位 | `veto` |

上游改字段时**只改适配层**；本仓库侧对缺失数据必须降级（跳过面板）而不是崩溃。

## 2. 数据来源

行情数据来自公开接口（东方财富等）。其使用条款由数据提供方各自规定，商用前请自行确认；
本仓库默认仅在个人 / 本地用途下运行。

## 3. 运行时依赖

依赖由 `package-lock.json` 锁定，各包适用其自身许可证。
