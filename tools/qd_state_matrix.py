# qd_state_matrix.py -- 六态状态转移矩阵（walk-forward）→ review_state_matrix.json
#
# 为什么这样做：直接用全样本算转移矩阵，再拿它"预测"历史，等于 in-sample 自欺。
#   所以两条路分开：
#     matrix      —— 用**全部历史（≤ 最新日）**估的矩阵，供"预测明日"用（不作评估）
#     walkForward —— 对每个历史日 t，矩阵**只用 t 之前**的数据估计，再检验它对 t 的预测力
#                   输出 Top1 命中 / Brier / LogLoss，并与基准对比（六态先验 Brier 0.8064、多数类 27.3%）
#
# 用法：
#   python qd_state_matrix.py                    # 写入 data/markets/a_share/review_state_matrix.json 并打印摘要
#   python qd_state_matrix.py --json <路径>       # 指定输出
#   python qd_state_matrix.py --matrix-only       # 只看当前矩阵
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

QD_DIR = Path(os.environ.get("QD_DIR", r"D:\projects\my-quantdash"))
A_DIR = QD_DIR / "data" / "markets" / "a_share"
TIDE_DATA = Path(os.environ.get("TIDE_DATA_PATH")
                 or r"C:\Users\Administrator\.openclaw\workspace\tide-monitor\tide-data.json")
OUT = Path(os.environ.get("REVIEW_STATE_MATRIX_PATH") or (A_DIR / "review_state_matrix.json"))

STATES = ["冰点", "过冷", "微冷", "微热", "过热", "沸点"]
MIN_HISTORY = 30          # walk-forward 起评所需的最小历史配对数
BASELINE_BRIER_PRIOR = None   # 由边际分布现算；页面/文档用 0.8064 作参考


def _load_rows() -> list[dict]:
    if TIDE_DATA.is_file():
        raw = json.loads(TIDE_DATA.read_text(encoding="utf-8-sig"))
        rows = raw.get("rows") if isinstance(raw, dict) else raw
        return sorted([r for r in (rows or []) if isinstance(r, dict) and r.get("date")], key=lambda r: r["date"])
    hist = A_DIR / "tide_history.json"
    if hist.is_file():
        return sorted(json.loads(hist.read_text(encoding="utf-8")), key=lambda r: r.get("date") or "")
    return []


def _probs_from_pairs(pairs: list[tuple], from_state: str) -> dict:
    """P(次日态 | 今日=from_state)；无样本时退回边际分布（拉普拉斯平滑的极端退化）。"""
    row = [0.0] * len(STATES)
    tot = 0
    for a, b in pairs:
        if a != from_state:
            continue
        tot += 1
        row[STATES.index(b)] += 1
    if tot == 0:
        marg = [0.0] * len(STATES)
        for _, b in pairs:
            marg[STATES.index(b)] += 1
        m = sum(marg) or 1.0
        return {"probs": [v / m for v in marg], "n": 0, "fallback": True}
    return {"probs": [v / tot for v in row], "n": tot, "fallback": False}


def _brier(probs: list[float], actual: str) -> float:
    return sum((p - (1.0 if STATES[i] == actual else 0.0)) ** 2 for i, p in enumerate(probs))


def _logloss(probs: list[float], actual: str) -> float:
    p = max(probs[STATES.index(actual)], 1e-6)
    return -math.log(p)


def build(min_history: int = MIN_HISTORY) -> dict:
    rows = _load_rows()
    seq = [(r.get("date"), r.get("state6")) for r in rows if r.get("state6") in STATES]
    if len(seq) < 5:
        return {"ok": False, "reason": "六态序列太短（%d）" % len(seq)}
    pairs_all = [(seq[i - 1][1], seq[i][1]) for i in range(1, len(seq))]

    # ---- walk-forward 评估（只用 t 之前的数据）----
    wf = []
    for t in range(1, len(seq)):
        hist = [(seq[i - 1][1], seq[i][1]) for i in range(1, t)]
        if len(hist) < min_history:
            continue
        from_state, actual = seq[t - 1][1], seq[t][1]
        est = _probs_from_pairs(hist, from_state)
        probs = est["probs"]
        top1 = STATES[max(range(len(STATES)), key=lambda i: probs[i])]
        wf.append({"date": seq[t][0], "fromState": from_state, "actual": actual,
                   "probs": {s: round(probs[i], 4) for i, s in enumerate(STATES)},
                   "top1": top1, "top1Hit": top1 == actual, "n": est["n"],
                   "brier": round(_brier(probs, actual), 4), "logLoss": round(_logloss(probs, actual), 4)})

    n = len(wf)
    top1_acc = round(sum(1 for x in wf if x["top1Hit"]) / n, 4) if n else None
    brier = round(sum(x["brier"] for x in wf) / n, 4) if n else None
    logloss = round(sum(x["logLoss"] for x in wf) / n, 4) if n else None

    # ---- 当前矩阵（全部历史）----
    matrix = {}
    for s in STATES:
        est = _probs_from_pairs(pairs_all, s)
        matrix[s] = {STATES[i]: round(est["probs"][i], 4) for i in range(len(STATES))}
        matrix[s]["_n"] = est["n"]
        matrix[s]["_fallback"] = est["fallback"]
    marg = [0.0] * len(STATES)
    for _, b in pairs_all:
        marg[STATES.index(b)] += 1
    mtot = sum(marg) or 1.0
    marginal = {STATES[i]: round(marg[i] / mtot, 4) for i in range(len(STATES))}
    brier_prior = round(sum((marginal[s] - (1.0 if s == a else 0.0)) ** 2
                            for s in STATES for a in STATES) / len(STATES) / len(STATES), 4) if False else None

    return {
        "ok": True,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "baseDate": seq[-1][0],
        "todayState": seq[-1][1],
        "days": len(seq),
        "minHistory": min_history,
        "marginal": marginal,
        "matrix": matrix,
        "walkForward": {
            "n": n, "top1Accuracy": top1_acc, "brier": brier, "logLoss": logloss,
            "recent": wf[-10:],
        },
    }


def render_for_prompt(data: dict) -> str:
    """给提示词用的精简片段：今日态对应的转移先验 + 该先验的 walk-forward 成绩 + 基准。"""
    if not data.get("ok"):
        return "（状态转移矩阵不可用）"
    today = data.get("todayState")
    row = (data.get("matrix") or {}).get(today) or {}
    top = sorted(((s, row.get(s, 0)) for s in STATES), key=lambda kv: -kv[1])
    wf = data.get("walkForward") or {}
    lines = [
        "- 今日六态：%s → 明日各态先验概率（按历史 %s 次同态转移估计）：%s"
        % (today, row.get("_n"), "、".join("%s %.0f%%" % (s, 100 * p) for s, p in top)),
        "- 该先验的 walk-forward 成绩：Top1 命中 %s（n=%s）｜Brier %s｜LogLoss %s"
        % (("%.0f%%" % (100 * wf["top1Accuracy"])) if wf.get("top1Accuracy") is not None else "—",
           wf.get("n"), wf.get("brier"), wf.get("logLoss")),
        "- 基准对比：多数类 27.3%、Brier 先验 0.8064（**本先验若不优于基准，说明六态本身信息弱，别过度依赖**）",
    ]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", help="输出路径")
    ap.add_argument("--matrix-only", action="store_true", help="只打印当前矩阵")
    ap.add_argument("--min-history", type=int, default=MIN_HISTORY)
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    data = build(args.min_history)
    if not data.get("ok"):
        print("[matrix] ❌ %s" % data.get("reason"))
        return 2

    if not args.matrix_only:
        out = Path(args.json) if args.json else OUT
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("[matrix] 写入 %s" % out)

    print("[matrix] 六态序列 %d 天，最新 %s（%s）" % (data["days"], data["baseDate"], data["todayState"]))
    print("[matrix] 边际分布: " + "、".join("%s %.1f%%" % (s, 100 * p) for s, p in data["marginal"].items()))
    print("[matrix] 当前矩阵（行=今日，列=明日）：")
    hdr = "         " + "".join("%-8s" % s for s in STATES)
    print(hdr)
    for s in STATES:
        row = data["matrix"][s]
        print("  %-6s " % s + "".join("%-8.3f" % row.get(t, 0) for t in STATES) + " n=%s" % row.get("_n"))
    wf = data["walkForward"]
    print("[matrix] walk-forward（只用历史估）：n=%s  Top1=%.1f%%  Brier=%s  LogLoss=%s"
          % (wf["n"], 100 * (wf["top1Accuracy"] or 0), wf["brier"], wf["logLoss"]))
    print("[matrix] 基准：多数类 27.3%%｜Brier 先验 0.8064  → %s"
          % ("**未优于基准（六态信息弱）**" if (wf["brier"] or 9) >= 0.8064 else "优于基准"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
