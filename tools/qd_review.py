# qd_review.py -- 收盘复盘 + 买点记忆
#
# 目标（用户需求）：把「最近较高性价比的买入时间/情绪节点」总结成**可积累的记忆**，
#   每个节点给出：① 当时环境（情绪分/六态/温度/连板高度/炸板率/溢价/大面/龙虎榜净额）
#                ② 领头题材与个股（题材核心/跟风、连板梯队、龙虎榜买入）
#                ③ 事后验证（次日/3日后的情绪分·溢价·连板高度变化）→ 用于评估"性价比"
#
# 数据来源（全部只读本地）：
#   workspace/tide-monitor/tide-data.json   —— 每日 sent/state6/temp/max_lbc/zt/zb_rate/prem_*/themes/lianban/lhb_top
# 产出：
#   <QD_DIR>/data/markets/a_share/review_memory.json —— 节点库（累积记忆，去重）
#   <QD_DIR>/_bridge/state/复盘记忆.md              —— 人可读总结（每次覆写为最新全量）
#
# 用法：python qd_review.py [--top 12]
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

QD_DIR = os.environ.get("QD_DIR", r"D:\projects\my-quantdash").strip()
TIDE_DATA = Path(os.environ.get("TIDE_DATA_PATH")
                 or r"C:\Users\Administrator\.openclaw\workspace\tide-monitor\tide-data.json")
A_DIR = Path(QD_DIR) / "data" / "markets" / "a_share"
OUT_JSON = Path(os.environ.get("REVIEW_MEMORY_PATH") or (A_DIR / "review_memory.json"))
OUT_MD = Path(os.environ.get("REVIEW_MD_PATH") or (Path(QD_DIR) / "_bridge" / "state" / "复盘记忆.md"))
TIDE_DATA_PATH = Path(os.environ.get("TIDE_DATA_PATH")
                       or r"C:\Users\Administrator\.openclaw\workspace\tide-monitor\tide-data.json")

# 冰点/过冷 的六态档位（低吸区）
COLD_STATES = {"冰点", "过冷", "微冷"}


def num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def load_rows() -> list[dict]:
    if not TIDE_DATA.exists():
        return []
    raw = json.loads(TIDE_DATA.read_text(encoding="utf-8-sig"))
    rows = raw.get("rows") if isinstance(raw, dict) else raw
    return [r for r in (rows or []) if isinstance(r, dict) and r.get("date")]


def env_snapshot(row: dict) -> dict:
    return {
        "sent": row.get("sent"),
        "state6": row.get("state6"),
        "temp": row.get("temp"),
        "max_lbc": row.get("max_lbc"),
        "zt": row.get("zt"),
        "zb_rate": row.get("zb_rate"),
        "prem_avg": row.get("prem_avg"),
        "damian": row.get("damian"),
        "lhb_net": row.get("lhb_net"),
        "diverge": row.get("diverge"),
    }


def leaders(row: dict, limit_stocks: int = 6) -> dict:
    """当时领头题材与个股：题材核心/跟风 + 高位连板 + 龙虎榜净买入"""
    themes_out = []
    for theme in (row.get("themes") or [])[:3]:
        if not isinstance(theme, dict):
            continue
        cores = [f"{s.get('name')}({s.get('lbc')}板)" for s in (theme.get("core") or [])[:2] if s.get("name")]
        follows = [f"{s.get('name')}({s.get('lbc')}板)" for s in (theme.get("follow") or [])[:2] if s.get("name")]
        themes_out.append({
            "theme": theme.get("theme"),
            "net": theme.get("net"),
            "zt": theme.get("zt"),
            "max_lbc": theme.get("max_lbc"),
            "core": cores,
            "follow": follows,
        })
    ladder = []
    lianban = row.get("lianban") or {}
    if isinstance(lianban, dict):
        for level in sorted((k for k in lianban.keys() if str(k).isdigit()), key=lambda x: -int(x))[:3]:
            for stock in (lianban.get(level) or [])[:2]:
                if isinstance(stock, dict) and stock.get("name"):
                    ladder.append(f"{stock['name']}({level}板/{stock.get('theme') or '-'})")
    lhb = []
    for item in (row.get("lhb_top") or [])[:3]:
        if isinstance(item, dict) and item.get("name") and (num(item.get("net")) or 0) > 0:
            lhb.append(f"{item['name']}(净{'+' if (num(item.get('net')) or 0) > 0 else ''}{item.get('net')}亿, {item.get('chg')}%)")
    return {
        "themes": themes_out,
        "ladder": ladder[:limit_stocks],
        "lhbBuy": lhb,
    }


def outcome(rows: list[dict], index: int) -> dict:
    """事后验证：次日 / 3 日后的环境变化（用来看这个买点的性价比）"""
    node = rows[index]
    def delta(days: int) -> dict | None:
        j = index + days
        if j >= len(rows):
            return None
        after = rows[j]
        def diff(key):
            a, b = num(node.get(key)), num(after.get(key))
            return None if a is None or b is None else round(b - a, 2)
        return {
            "date": after.get("date"),
            "sent": after.get("sent"),
            "sentDelta": diff("sent"),
            "state6": after.get("state6"),
            "premDelta": diff("prem_avg"),
            "maxLbcDelta": (None if node.get("max_lbc") is None or after.get("max_lbc") is None
                            else after.get("max_lbc") - node.get("max_lbc")),
        }
    return {"nextDay": delta(1), "in3Days": delta(3)}


def score_node(node: dict) -> float:
    """性价比打分（可解释）：情绪分回升 + 溢价回升 + 连板高度抬升，各占权重；缺失项不计入"""
    out = node.get("outcome", {}).get("nextDay") or {}
    parts = []
    if out.get("sentDelta") is not None:
        parts.append(("sent", out["sentDelta"] / 20.0))       # 20 分回升记 1.0
    if out.get("premDelta") is not None:
        parts.append(("prem", out["premDelta"] / 2.0))        # 2 个点溢价回升记 1.0
    if out.get("maxLbcDelta") is not None:
        parts.append(("lbc", out["maxLbcDelta"] / 2.0))       # 2 板高度抬升记 1.0
    if not parts:
        return 0.0
    return round(sum(v for _, v in parts) / len(parts), 3)


def detect_nodes(rows: list[dict]) -> list[dict]:
    nodes = []
    for i, row in enumerate(rows):
        if i == 0:
            continue
        prev = rows[i - 1]
        types = []
        sent, sent_prev = num(row.get("sent")), num(prev.get("sent"))
        prem, prem_prev = num(row.get("prem_avg")), num(prev.get("prem_avg"))
        state = str(row.get("state6") or "")

        if state in COLD_STATES and row.get("state6") in ("冰点", "过冷"):
            types.append("冰点/过冷区")
        if prem is not None and prem_prev is not None and prem_prev < 0 <= prem:
            types.append("溢价转正")
        if sent is not None and sent_prev is not None and sent - sent_prev >= 8:
            types.append("情绪跳升")
        nxt = rows[i + 1] if i + 1 < len(rows) else None
        if nxt is not None:
            sent_next = num(nxt.get("sent"))
            if sent is not None and sent_next is not None and sent_next - sent >= 8 and sent <= 45:
                types.append("低位拐点(次日验证)")
        if not types:
            continue
        node = {
            "date": row.get("date"),
            "types": types,
            "env": env_snapshot(row),
            "leaders": leaders(row),
            "outcome": outcome(rows, i),
        }
        node["score"] = score_node(node)
        nodes.append(node)
    # 去重：同一天只保留一条（合并类型）
    merged: dict[str, dict] = {}
    for node in nodes:
        key = node["date"]
        if key in merged:
            merged[key]["types"] = sorted(set(merged[key]["types"]) | set(node["types"]))
            if node["score"] > merged[key]["score"]:
                merged[key]["score"] = node["score"]
        else:
            merged[key] = node
    return sorted(merged.values(), key=lambda x: x["date"])


def summarize(nodes: list[dict]) -> dict:
    stats: dict[str, dict] = {}
    for node in nodes:
        for t in node["types"]:
            bucket = stats.setdefault(t, {"count": 0, "sumScore": 0.0, "wins": 0})
            bucket["count"] += 1
            bucket["sumScore"] += node["score"]
            next_sent = (node.get("outcome", {}).get("nextDay") or {}).get("sentDelta")
            if next_sent is not None and next_sent > 0:
                bucket["wins"] += 1
    out = {}
    for t, b in stats.items():
        out[t] = {
            "count": b["count"],
            "avgScore": round(b["sumScore"] / b["count"], 3) if b["count"] else None,
            "winRate": round(b["wins"] / b["count"], 2) if b["count"] else None,
            "desc": "次日情绪分上行=记为胜",
        }
    return out


def render_md(nodes: list[dict], stats: dict, top: int) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        "# 复盘记忆 · 高性价比买点节点",
        "",
        f"> 自动生成（最近更新 {now}）｜数据源：tide-data.json（只读）｜口径：见文末",
        "",
        "## 一、节点类型统计（历史胜率参考）",
        "",
        "| 类型 | 出现次数 | 平均性价比分 | 次日情绪上行占比 |",
        "| --- | --- | --- | --- |",
    ]
    for t, s in sorted(stats.items(), key=lambda kv: -(kv[1]["avgScore"] or -9)):
        lines.append(f"| {t} | {s['count']} | {s['avgScore']} | {int((s['winRate'] or 0) * 100)}% |")
    lines += [
        "",
        "## 二、最近节点（按日期倒序，最多 %d 条）" % top,
        "",
    ]
    for node in list(reversed(nodes))[:top]:
        env = node["env"]
        ld = node["leaders"]
        out = node["outcome"]
        nxt = out.get("nextDay") or {}
        lines.append(f"### {node['date']}　{' / '.join(node['types'])}　（性价比 {node['score']}）")
        lines.append("")
        lines.append(f"- **当时环境**：情绪分 {env.get('sent')}（{env.get('state6')}）｜资金温度 {env.get('temp')}｜"
                     f"连板高度 {env.get('max_lbc')}｜涨停 {env.get('zt')} 家｜炸板率 {env.get('zb_rate')}%｜"
                     f"昨涨停溢价 {env.get('prem_avg')}%｜大面 {env.get('damian')}｜龙虎榜净 {env.get('lhb_net')} 亿")
        if ld["themes"]:
            theme_txt = "；".join(
                f"{t['theme']}（净{t.get('net')}亿/{t.get('zt')}家涨停/最高{t.get('max_lbc')}板"
                + (f"，核心: {'、'.join(t['core'])}" if t["core"] else "")
                + (f"，跟风: {'、'.join(t['follow'])}" if t["follow"] else "")
                + ")"
                for t in ld["themes"]
            )
            lines.append(f"- **领头题材**：{theme_txt}")
        if ld["ladder"]:
            lines.append(f"- **连板梯队**：{'；'.join(ld['ladder'])}")
        if ld["lhbBuy"]:
            lines.append(f"- **龙虎榜净买入**：{'；'.join(ld['lhbBuy'])}")
        if nxt:
            lines.append(f"- **次日验证（{nxt.get('date')}）**：情绪分 {nxt.get('sent')}"
                         f"（{'+' if (nxt.get('sentDelta') or 0) > 0 else ''}{nxt.get('sentDelta')}）｜"
                         f"溢价变化 {nxt.get('premDelta')}｜连板高度变化 {nxt.get('maxLbcDelta')}")
        in3 = out.get("in3Days")
        if in3:
            lines.append(f"- **3日后（{in3.get('date')}）**：情绪分 {in3.get('sent')}"
                         f"（{'+' if (in3.get('sentDelta') or 0) > 0 else ''}{in3.get('sentDelta')}）｜"
                         f"六态 {in3.get('state6')}")
        lines.append("")
    lines += [
        "## 三、口径与免责",
        "",
        "- 节点识别规则：① 六态处于**冰点/过冷区**；② **昨涨停溢价由负转正**；③ **情绪分单日跳升 ≥8**；④ **低位（≤45）次日跳升 ≥8**（事后验证型）。",
        "- 性价比分 = 次日「情绪分回升/20 + 溢价回升/2 + 连板高度抬升/2」的均值（缺失项不计），仅用于横向比较。",
        "- 溢价为负值口径代表昨日涨停股今日平均下跌；`prem_est` 标记的估算日仅供参考。",
        "- **本页为历史统计与复盘的整理，不构成任何投资建议；个股名称仅为当时梯队记录，不代表推荐。**",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=12)
    args = ap.parse_args()

    rows = load_rows()
    if not rows:
        print("[review] 读不到 tide-data.json，退出")
        return 1
    nodes = detect_nodes(rows)
    stats = summarize(nodes)
    payload = {
        "updatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "rows": len(rows),
        "range": {"start": rows[0].get("date"), "end": rows[-1].get("date")},
        "stats": stats,
        "nodes": nodes,
    }
    A_DIR.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text(render_md(nodes, stats, args.top), encoding="utf-8")

    print("[review] 节点 %d 个（区间 %s ~ %s）" % (len(nodes), payload["range"]["start"], payload["range"]["end"]))
    for t, s in sorted(stats.items(), key=lambda kv: -(kv[1]["avgScore"] or -9)):
        print("   %-18s 次数=%-3d 平均分=%-6s 次日上行=%s" % (t, s["count"], s["avgScore"], s["winRate"]))
    print("[review] 写入 %s" % OUT_JSON)
    print("[review] 写入 %s" % OUT_MD)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
