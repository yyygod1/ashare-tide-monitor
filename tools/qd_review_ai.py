# qd_review_ai.py -- 收盘后自动生成 AI 复盘（服务端版，补「忘记点」）
#
# 设计要点：
#   - 与前端同一套提示词结构（今日环境 + 节点统计 + 最近节点明细 + 历史校准），所以结论口径一致
#   - 产出写入**文件台账** data/markets/a_share/review_ledger.json（前端会合并展示）
#   - 每次运行先「回填」：为已到期的预测用 tide_history.json 补实际值并打分（幂等）
#   - 模型配置：优先环境变量 AI_BASE_URL / AI_MODEL / AI_API_KEY；否则读 _bridge/config/ai.local.json
#
# 用法：
#   python qd_review_ai.py --dry-run    # 只组装提示词 + 回填，不调用模型
#   python qd_review_ai.py              # 真正生成（需要配置）
from __future__ import annotations

import argparse
import json
import math
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

QD_DIR = os.environ.get("QD_DIR", r"D:\projects\my-quantdash").strip()
A_DIR = Path(QD_DIR) / "data" / "markets" / "a_share"
MEMORY_PATH = Path(os.environ.get("REVIEW_MEMORY_PATH") or (A_DIR / "review_memory.json"))
STATE_PATH = Path(os.environ.get("TIDE_STATE_PATH") or (A_DIR / "tide_state.json"))
HISTORY_PATH = Path(os.environ.get("TIDE_HISTORY_PATH") or (A_DIR / "tide_history.json"))
LEDGER_PATH = Path(os.environ.get("REVIEW_LEDGER_PATH") or (A_DIR / "review_ledger.json"))
CONFIG_PATH = Path(QD_DIR) / "_bridge" / "config" / "ai.local.json"
# CI/本地通用：tide-monitor 的原始数据（CI 中为仓库内路径）
TIDE_DATA_PATH = Path(os.environ.get("TIDE_DATA_PATH") or r"C:\Users\Administrator\.openclaw\workspace\tide-monitor\tide-data.json")

SYSTEM_PROMPT = (
    "你是 A 股短线「情绪周期」复盘助手。只依据用户提供的统计与节点数据作答，不得编造数据或新增个股。"
    "语气克制、结论可验证；明确给出失效条件；结尾必须注明「以上为数据整理，不构成投资建议」。"
    "除叙事外，必须在最后追加一个 ```json 代码块，字段与取值必须严格遵守用户给定格式，便于机器回测与校准。"
)


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return default


def load_config() -> dict:
    cfg = {}
    if CONFIG_PATH.exists():
        cfg = read_json(CONFIG_PATH, {}) or {}
    return {
        "baseUrl": (os.environ.get("AI_BASE_URL") or cfg.get("baseUrl") or "").rstrip("/"),
        "model": os.environ.get("AI_MODEL") or cfg.get("model") or "",
        "apiKey": os.environ.get("AI_API_KEY") or cfg.get("apiKey") or "",
        "protocol": os.environ.get("AI_PROTOCOL") or cfg.get("protocol") or "openai",
    }


# ---------- 回填与打分（与前端同口径）----------
def in_range(value, rng):
    if value is None or not isinstance(rng, (list, tuple)) or len(rng) != 2:
        return None
    try:
        return float(rng[0]) <= float(value) <= float(rng[1])
    except (TypeError, ValueError):
        return None


def sign_of(value):
    if value is None:
        return None
    return "正" if value > 0.01 else ("负" if value < -0.01 else "持平")


# ---------- 历史相似日匹配（环境向量最近邻）----------
SIM_FEATURES = (
    ("sent", 20.0, 1.0),      # (字段, 归一尺度, 权重)
    ("temp", 30.0, 0.6),
    ("max_lbc", 3.0, 0.6),
    ("zt", 40.0, 0.4),
    ("zb_rate", 15.0, 0.4),
    ("prem_avg", 2.0, 0.4),
)
SIM_SKIP_TAIL = 5   # 排除最后 N 日（避免与自身/近邻重复）
# P1：相似日的 TopK / 阈值 / 降级
#   TopK 3 -> 8：原来只出 3 条，导致「有效匹配 >=5 才算相似日为主」那档永远触发不了。
#   阈值取「绝对下限」与「当日候选相似度 P75」的较大者：实测相似度挤在 0.77~0.82，
#   固定 0.7 形同虚设（全过），改成相对分位才真有筛选力。
SIM_TOP_K = 8
SIM_MIN_SIM = 0.7
SIM_MIN_EFFECTIVE = 3


def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _quantile(nums: list[float], q: float) -> float:
    if not nums:
        return 0.0
    s = sorted(nums)
    return s[min(len(s) - 1, max(0, int(len(s) * q)))]


def _state_baseline(rows: list[dict]) -> dict:
    """同状态全局基准：与「今日六态」相同的历史日，其次日 情绪/Δsent/溢价/炸板 的分位数。

    相似日样本不足时用它兜底 —— 避免提示词里出现「无匹配」这种零信息状态。
    """
    if not rows:
        return {}
    today_state = rows[-1].get("state6")
    vals: dict = {"sent": [], "sentDelta": [], "prem_avg": [], "zb_rate": []}
    peers = 0
    for i in range(len(rows) - 1):
        if rows[i].get("state6") != today_state:
            continue
        peers += 1
        nxt = rows[i + 1]
        a, b = _num(rows[i].get("sent")), _num(nxt.get("sent"))
        if a is not None and b is not None:
            vals["sentDelta"].append(round(b - a, 1))
        for key in ("sent", "prem_avg", "zb_rate"):
            v = _num(nxt.get(key))
            if v is not None:
                vals[key].append(v)

    def stat(key: str):
        arr = vals[key]
        if not arr:
            return None
        return {"n": len(arr), "p25": _quantile(arr, 0.25),
                "median": _quantile(arr, 0.5), "p75": _quantile(arr, 0.75)}

    return {"state6": today_state, "count": peers, "nextSent": stat("sent"),
            "nextSentDelta": stat("sentDelta"), "nextPremAvg": stat("prem_avg"),
            "nextZbRate": stat("zb_rate")}


def find_similar_days(rows: list[dict], memory: dict, top: int = SIM_TOP_K) -> dict:
    """按环境向量找历史最近邻。

    返回 dict：matches / threshold / similarityMode / candidateCount /
    effectiveMatches / fallback。阈值 = max(绝对下限, 当日候选相似度 P75)；
    有效匹配不足 SIM_MIN_EFFECTIVE 时 fallback 给「同状态全局基准」。
    """
    empty = {"matches": [], "threshold": SIM_MIN_SIM, "similarityMode": "absolute",
             "candidateCount": 0, "effectiveMatches": 0, "fallback": _state_baseline(rows)}
    if len(rows) < SIM_SKIP_TAIL + 3:
        return empty
    target = rows[-1]
    # 节点日期 -> 梯队/题材（来自 qd_review.py 产出的记忆）
    by_date = {}
    for node in (memory.get("nodes") or []):
        if node.get("date"):
            by_date[node["date"]] = node.get("leaders") or {}

    scored = []
    for i, row in enumerate(rows[:-SIM_SKIP_TAIL]):
        dist, used = 0.0, 0
        for key, scale, weight in SIM_FEATURES:
            a, b = _num(target.get(key)), _num(row.get(key))
            if a is None or b is None:
                continue
            dist += weight * abs(a - b) / scale
            used += 1
        if used < 3:      # 样本字段太少不算
            continue
        scored.append((1.0 / (1.0 + dist / used), i, row))

    scored.sort(key=lambda item: -item[0])
    if not scored:
        return empty

    sims = [s for s, _, _ in scored]
    p75 = _quantile(sims, 0.75)
    threshold = round(max(SIM_MIN_SIM, p75), 3)
    mode = "relative" if p75 > SIM_MIN_SIM else "absolute"
    picked = [(s, i, r) for s, i, r in scored[:top] if s >= threshold]

    out = []
    for similarity, index, row in picked:
        nxt = rows[index + 1] if index + 1 < len(rows) else None
        date = row.get("date")
        leaders = by_date.get(date) or {}
        out.append({
            "date": date,
            "similarity": round(similarity, 3),
            "env": {k: row.get(k) for k in ("sent", "state6", "temp", "max_lbc", "zt", "zb_rate", "prem_avg", "damian")},
            "nextDay": ({"date": nxt.get("date"), "sent": nxt.get("sent"), "state6": nxt.get("state6"),
                         "max_lbc": nxt.get("max_lbc"), "prem_avg": nxt.get("prem_avg"),
                         "sentDelta": (round((_num(nxt.get("sent")) or 0) - (_num(row.get("sent")) or 0), 1)
                                       if _num(nxt.get("sent")) is not None and _num(row.get("sent")) is not None else None)}
                        if nxt else None),
            "ladder": (leaders.get("ladder") or [])[:6],
            "themes": [t.get("theme") for t in (leaders.get("themes") or [])[:3]],
        })
    return {"matches": out, "threshold": threshold, "similarityMode": mode,
            "candidateCount": len(scored), "effectiveMatches": len(out),
            "fallback": (_state_baseline(rows) if len(out) < SIM_MIN_EFFECTIVE else None)}


def render_similar(matches: list[dict], meta: dict | None = None) -> str:
    meta = meta or {}
    lines = []
    if not matches:
        head = "（相似日样本不足，已降级为「同状态全局基准」）"
    else:
        head = "- 匹配口径：阈值 %s（%s）｜有效匹配 %d/%s" % (
            meta.get("threshold"), meta.get("similarityMode"), len(matches), meta.get("candidateCount") or len(matches))
    for m in matches:
        env = m.get("env") or {}
        nxt = m.get("nextDay") or {}
        lines.append("- %s（相似度 %s）｜环境：情绪分 %s（%s）｜温度 %s｜高度 %s｜涨停 %s 家｜炸板率 %s%%｜溢价 %s%%\n  → 次日：情绪分 %s（%s）｜六态 %s｜高度 %s｜溢价 %s%%\n  → 当时梯队：%s%s" % (
            m.get("date"), m.get("similarity"), env.get("sent"), env.get("state6"), env.get("temp"),
            env.get("max_lbc"), env.get("zt"), env.get("zb_rate"), env.get("prem_avg"),
            nxt.get("sent"), ("+" + str(nxt.get("sentDelta"))) if (nxt.get("sentDelta") or 0) > 0 else nxt.get("sentDelta"),
            nxt.get("state6"), nxt.get("max_lbc"), nxt.get("prem_avg"),
            "；".join(m.get("ladder") or []) or "（无梯队记录）",
            ("｜题材：" + "、".join(m.get("themes") or [])) if m.get("themes") else ""))
    fb = meta.get("fallback")
    if fb:
        def _fmt(st):
            return "—" if not st else "中位 %s（P25 %s / P75 %s, n=%s）" % (
                st.get("median"), st.get("p25"), st.get("p75"), st.get("n"))
        lines.append("【同状态全局基准（六态=%s，历史 %s 天）】次日情绪分 %s｜次日Δsent %s｜次日溢价 %s｜次日炸板率 %s" % (
            fb.get("state6"), fb.get("count"), _fmt(fb.get("nextSent")), _fmt(fb.get("nextSentDelta")),
            _fmt(fb.get("nextPremAvg")), _fmt(fb.get("nextZbRate"))))
    return "\n".join([head] + lines)


# ---------- 台账分层与三态（与 services/reviewLedgerService.ts 逐字对齐）----------
DIM_LABEL = {"sent": "情绪区间", "state6": "六态", "height": "高度区间", "zt": "涨停家数",
             "zbRate": "炸板率", "premium": "溢价方向", "stance": "立场",
             "streak": "连板家数", "bigFace": "大面数", "redRatio": "红盘率"}
# 六态对次日的互信息仅 ~11.5%（2026-09-30 回填后实测、置换检验刚显著）-> 降为辅助维
CORE_DIMS = ["sent", "premium", "stance"]
# P0c′ 新增三维按实测覆盖率定门槛：
#   streak（zt_lianban）覆盖 100% -> 立即计入；
#   bigFace（damian）覆盖 ~17% -> 计入（无 actual 自然归 no_actual，不进分母）；
#   redRatio（market_red）仅 ~6% -> 标 pending_actual（暂不进分母）。
EXTENDED_DIMS = ["height", "zt", "zbRate", "streak", "bigFace", "redRatio"]
AUX_DIMS = ["state6"]
ALL_DIMS = CORE_DIMS + EXTENDED_DIMS + AUX_DIMS
DIM_GATE = {k: "active" for k in ALL_DIMS}
DIM_GATE["redRatio"] = "pending_actual"
# 基准（口径 2026-09-30；复跑 _bridge/qd_review_diag.py 可复现）
REVIEW_BASELINES = {"state6Majority": 0.273, "state6TransitionTop1InSample": 0.331,
                    "sentimentBand15": 0.397, "brierState6Prior": 0.8064, "brierDirPrior": 0.6622}


def _dim_status(predicted: bool, actual_available: bool, hit, gate: str = "active") -> str:
    if gate == "pending_actual":
        return "pending_actual"
    if not predicted:
        return "not_predicted"
    if not actual_available:
        return "no_actual"
    return "hit" if hit else "miss"


def _is_range(v) -> bool:
    return isinstance(v, list) and len(v) == 2


# ---------- P2/P3：概率评分 + 失准归因（与 reviewLedgerService.ts 对齐）----------
STATE6_KEYS = ["冰点", "过冷", "微冷", "微热", "过热", "沸点"]
MISS_REASONS = ["数据口径", "状态定义", "模型", "外部冲击"]


def _brier_state6(probs, actual_state):
    """六态多分类 Brier：Σ(p−y)²（容忍未归一化，先归一）"""
    if not isinstance(probs, dict) or actual_state not in STATE6_KEYS:
        return None
    raw = [max(0.0, float(probs.get(k) or 0)) for k in STATE6_KEYS]
    s = sum(raw)
    if s <= 0:
        return None
    p = [v / s for v in raw]
    return round(sum((v - (1.0 if STATE6_KEYS[i] == actual_state else 0.0)) ** 2 for i, v in enumerate(p)), 4)


def _logloss_state6(probs, actual_state):
    """六态 LogLoss（对实际态 −ln p；1e-6 下限避免 Infinity）"""
    if not isinstance(probs, dict) or actual_state not in STATE6_KEYS:
        return None
    import math  # noqa: PLC0415
    raw = [max(0.0, float(probs.get(k) or 0)) for k in STATE6_KEYS]
    s = sum(raw)
    if s <= 0:
        return None
    p = max(float(probs.get(actual_state) or 0) / s, 1e-6)
    return round(-math.log(p), 4)


def _classify_miss(actual: dict, prev_sent, dim_status: dict) -> list:
    """失准归因（可解释、可复现）；样本不足在 stats 层标记"""
    if not any(v == "miss" for v in dim_status.values()):
        return []
    reasons = []
    if sum(1 for v in dim_status.values() if v == "no_actual") >= 2:
        reasons.append("数据口径")
    if prev_sent is not None and actual.get("sent") is not None and abs(actual["sent"] - prev_sent) > 40:
        reasons.append("外部冲击")
    if dim_status.get("state6") == "miss":
        reasons.append("状态定义")
    if not reasons:
        reasons.append("模型")
    return reasons


def score_entry(entry: dict, actual: dict, prev_sent):
    p = entry.get("prediction") or {}
    sent_hit = in_range(actual.get("sent"), p.get("sentimentRange"))
    state6_hit = (p.get("state6Next") == actual.get("state6")) if (p.get("state6Next") and actual.get("state6")) else None
    height_hit = in_range(actual.get("max_lbc"), p.get("heightRange"))
    zt_hit = in_range(actual.get("zt"), p.get("ztRange"))
    zb_rate_hit = in_range(actual.get("zb_rate"), p.get("zbRateRange"))
    prem_hit = (sign_of(actual.get("prem_avg")) == p.get("premiumSign")) if p.get("premiumSign") else None
    stance_hit = None
    if p.get("stance") and prev_sent is not None and actual.get("sent") is not None:
        if p["stance"] == "低吸区":
            stance_hit = actual["sent"] > prev_sent
        elif p["stance"] == "追高区":
            stance_hit = actual["sent"] < prev_sent
    big_face_hit = in_range(actual.get("bigFace"), p.get("bigFaceRange"))
    streak_hit = in_range(actual.get("zt_lianban"), p.get("streakRange"))
    red_ratio_hit = in_range(actual.get("marketRedRatio"), p.get("redRatioRange"))

    # 三态 + 覆盖率门槛：显式列出「预测是否给了该维」「实际是否有该维」，gate=pending_actual 不计分
    pred_present = {
        "sent": _is_range(p.get("sentimentRange")), "state6": bool(p.get("state6Next")),
        "height": _is_range(p.get("heightRange")), "zt": _is_range(p.get("ztRange")),
        "zbRate": _is_range(p.get("zbRateRange")), "premium": bool(p.get("premiumSign")),
        "stance": bool(p.get("stance")), "bigFace": _is_range(p.get("bigFaceRange")),
        "streak": _is_range(p.get("streakRange")), "redRatio": _is_range(p.get("redRatioRange")),
    }
    actual_present = {
        "sent": actual.get("sent") is not None, "state6": actual.get("state6") is not None,
        "height": actual.get("max_lbc") is not None, "zt": actual.get("zt") is not None,
        "zbRate": actual.get("zb_rate") is not None, "premium": actual.get("prem_avg") is not None,
        "stance": prev_sent is not None and actual.get("sent") is not None,
        "bigFace": actual.get("bigFace") is not None, "streak": actual.get("zt_lianban") is not None,
        "redRatio": actual.get("marketRedRatio") is not None,
    }
    raw_hits = {"sent": sent_hit, "state6": state6_hit, "height": height_hit, "zt": zt_hit,
                "zbRate": zb_rate_hit, "premium": prem_hit, "stance": stance_hit,
                "bigFace": big_face_hit, "streak": streak_hit, "redRatio": red_ratio_hit}
    dim_status = {k: _dim_status(pred_present[k], actual_present[k], raw_hits[k], DIM_GATE.get(k, "active"))
                  for k in ALL_DIMS}
    items = [dim_status[k] for k in ALL_DIMS if dim_status[k] in ("hit", "miss")]
    hits = sum(1 for s in items if s == "hit")
    core_decided = [dim_status[k] for k in CORE_DIMS if dim_status[k] in ("hit", "miss")]
    core_hits = sum(1 for s in core_decided if s == "hit")

    return {
        "sentHit": sent_hit, "state6Hit": state6_hit, "heightHit": height_hit,
        "ztHit": zt_hit, "zbRateHit": zb_rate_hit,
        "premiumHit": prem_hit, "stanceHit": stance_hit,
        "scored": len(items), "hits": hits,
        "accuracy": round(hits / len(items), 2) if items else None,
        "dimStatus": dim_status,
        "coreHits": core_hits,
        "coreScored": len(core_decided),
        "coreAccuracy": round(core_hits / len(core_decided), 2) if core_decided else None,
        "brierState6": _brier_state6(p.get("state6Probs"), actual.get("state6")),
        "logLoss": _logloss_state6(p.get("state6Probs"), actual.get("state6")),
        "missReasons": _classify_miss(actual, prev_sent, dim_status),
    }


def dedupe_by_date(entries: list[dict]) -> tuple[list[dict], int]:
    """一天只保留一条（取最近一次生成）。返回 (新列表, 移除条数)。"""
    best: dict[str, dict] = {}
    for entry in entries:
        key = entry.get("predictDate") or entry.get("id") or ""
        if not key:
            continue
        prev = best.get(key)
        if prev is None or (entry.get("createdAt") or "") >= (prev.get("createdAt") or ""):
            best[key] = entry
    out = sorted(best.values(), key=lambda e: e.get("predictDate") or "")
    return out, len(entries) - len(out)


def backfill(entries: list[dict], rows: list[dict]) -> int:
    by_date = {r.get("date"): i for i, r in enumerate(rows)}
    changed = 0
    for entry in entries:
        if entry.get("actual"):
            continue
        target = entry.get("targetDate") or next((r["date"] for r in rows if r.get("date", "") > entry.get("predictDate", "")), "")
        if not target or target not in by_date:
            continue
        idx = by_date[target]
        row = rows[idx]
        prev_sent = rows[idx - 1].get("sent") if idx > 0 else None
        actual = {k: row.get(k) for k in ("date", "sent", "state6", "max_lbc", "prem_avg", "zt", "zb_rate")}
        # P0c′ 新增三维的实际值（字段名与 tide_history/tide-data 对齐）
        actual["zt_lianban"] = row.get("zt_lianban")
        actual["bigFace"] = row.get("damian")
        actual["marketRedRatio"] = row.get("market_red")
        entry["targetDate"] = target
        entry["actual"] = actual
        entry["score"] = score_entry(entry, actual, prev_sent)
        entry["reviewedAt"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        changed += 1
    return changed


def calibration_summary(entries: list[dict], limit: int = 8) -> str:
    reviewed = [e for e in entries if e.get("score") and e.get("actual")]
    if not reviewed:
        return "（暂无历史预测记录，这是第一批）"
    accs = [e["score"]["accuracy"] for e in reviewed if e["score"].get("accuracy") is not None]
    overall = round(sum(accs) / len(accs), 2) if accs else None
    # 主指标：核心维池化（与前端 computeStats 同口径）
    core_hits = sum(e["score"].get("coreHits", 0) for e in reviewed)
    core_scored = sum(e["score"].get("coreScored", 0) for e in reviewed)
    core = round(core_hits / core_scored, 2) if core_scored else None
    main = core if core is not None else overall
    lines = []
    for entry in reviewed[-limit:]:
        p = entry.get("prediction") or {}
        a = entry.get("actual") or {}
        s = entry.get("score") or {}
        miss = [label for key, label in
                (("sentHit", "情绪区间"), ("heightHit", "高度区间"), ("premiumHit", "溢价方向"), ("stanceHit", "立场"))
                if s.get(key) is False]
        reasons = s.get("missReasons") or []
        lines.append("- %s→%s｜预测 %s｜实际 情绪分 %s（%s）高度 %s 溢价 %s%%｜命中率 %s%s%s"
                     % (entry.get("predictDate"), entry.get("targetDate"), p.get("stance") or "未结构化",
                        a.get("sent"), a.get("state6"), a.get("max_lbc"), a.get("prem_avg"),
                        (str(round(s["accuracy"] * 100)) + "%") if s.get("accuracy") is not None else "—",
                        ("｜失准项：" + "、".join(miss)) if miss else "",
                        ("｜归因：" + "＋".join(reasons)) if reasons else ""))
    head = ("近 %d 次预测：核心维（情绪区间/溢价方向/立场）命中率 %s（主指标）｜全维平均 %s｜已复核 %d 次"
            "｜基准：六态多数类 %d%%、情绪 ±15 带宽 %d%%（低于基准即无优势）") % (
        len(reviewed[-limit:]),
        (str(round(main * 100)) + "%") if main is not None else "—",
        (str(round(overall * 100)) + "%") if overall is not None else "—",
        len(reviewed), round(REVIEW_BASELINES["state6Majority"] * 100), round(REVIEW_BASELINES["sentimentBand15"] * 100))
    return "\n".join([head] + lines)


# ---------- 提示词（与前端同结构）----------
def build_prompt(memory: dict, state: dict, calibration: str, compact: bool = False, similar_text: str = "", matrix_text: str = "") -> str:
    def _wilson95(p, n):
        if n <= 0:
            return None
        z = 1.96
        z2 = z * z
        denom = 1 + z2 / n
        center = (p + z2 / (2 * n)) / denom
        half = (z * math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
        return max(0.0, center - half), min(1.0, center + half)

    def _stat_line(item):
        k, v = item
        cnt = v.get("count") or 0
        wr = v.get("winRate")
        ci = _wilson95(wr, cnt) if (wr is not None and cnt > 0) else None
        ci_txt = ("（95%%CI %d~%d%%）" % (int(ci[0] * 100 + 0.5), int(ci[1] * 100 + 0.5))) if ci else ""
        wr_txt = (str(int(wr * 100 + 0.5)) + "%") if wr is not None else "—"
        return "- %s：出现 %s 次，平均性价比 %s，次日情绪上行占比 %s%s" % (k, v.get("count"), v.get("avgScore"), wr_txt, ci_txt)

    _node_dates = sorted([nd.get("date") for nd in (memory.get("nodes") or []) if nd.get("date")])
    stat_window = ("样本窗口 %s ~ %s（买点节点 %d 个）" % (_node_dates[0], _node_dates[-1], len(_node_dates))) if _node_dates else "样本窗口 —"
    stats = "\n".join(
        _stat_line(item) for item in sorted((memory.get("stats") or {}).items(), key=lambda kv: -(kv[1].get("avgScore") or -9))
    ) or "—"
    nodes = list(memory.get("nodes") or [])[-3 if compact else -8:]
    node_txt = []
    for node in reversed(nodes):
        env = node.get("env") or {}
        if compact:
            nxt = (node.get("outcome") or {}).get("nextDay") or {}
            node_txt.append("- %s｜%s｜性价比 %s｜情绪分 %s（%s）｜次日 %s" % (
                node.get("date"), "/".join(node.get("types") or []), node.get("score"),
                env.get("sent"), env.get("state6"), nxt.get("sentDelta")))
            continue
        themes = "；".join(
            "%s（净 %s 亿/最高 %s 板%s）" % (t.get("theme"), t.get("net"), t.get("max_lbc"),
                                        ("，核心 " + "、".join(t.get("core") or [])) if t.get("core") else "")
            for t in ((node.get("leaders") or {}).get("themes") or [])[:3])
        nxt = (node.get("outcome") or {}).get("nextDay") or {}
        block = [
            "### %s｜%s｜性价比 %s" % (node.get("date"), " / ".join(node.get("types") or []), node.get("score")),
            "- 环境：情绪分 %s（%s）｜温度 %s｜高度 %s｜涨停 %s 家｜炸板率 %s%%｜溢价 %s%%｜大面 %s" % (
                env.get("sent"), env.get("state6"), env.get("temp"), env.get("max_lbc"),
                env.get("zt"), env.get("zb_rate"), env.get("prem_avg"), env.get("damian")),
        ]
        if themes:
            block.append("- 领头题材：" + themes)
        ladder = (node.get("leaders") or {}).get("ladder") or []
        if ladder:
            block.append("- 连板梯队：" + "；".join(ladder))
        if nxt:
            block.append("- 次日验证：情绪分 %s（变化 %s）｜溢价变化 %s｜高度变化 %s" % (
                nxt.get("sent"), nxt.get("sentDelta"), nxt.get("premDelta"), nxt.get("maxLbcDelta")))
        node_txt.append("\n".join(block))

    hits = [k for k, v in ((state.get("veto") or {}).get("hits") or {}).items() if v]
    today = "日期 %s｜情绪分 %s（%s）｜资金温度 %s｜最高板 %s｜涨停家数 %s 家｜炸板率 %s%%｜昨涨停溢价 %s%%｜大面 %s｜veto %s%s" % (
        state.get("date"), state.get("sentiment"), state.get("state6"), state.get("fundTemp"),
        state.get("maxBoard"), state.get("limitUp"), state.get("brokenRate"), state.get("premiumAvg"), state.get("bigFace"),
        (state.get("veto") or {}).get("finalState") or "未生效",
        ("（命中 " + "、".join(hits) + "）") if hits else "")

    return f"""【今日环境】{today}

【历史买点节点类型统计（含次日验证胜率）】
（{stat_window}）
{stats}

【最近节点明细（含当时环境、领头题材与核心股、事后验证）】
{chr(10).join(node_txt) or '—'}

【你过去的预测与实际对照（用于自我校准，请根据失准项调整本次判断的尺度）】
{calibration}

【历史相似日匹配（按环境向量算的最近邻，含其次日表现与当时梯队）】
{similar_text or '（无）'}

【六态状态转移先验（walk-forward 估计；已附其历史成绩，若不如基准请勿过度依赖）】
{matrix_text or '（未生成）'}

请输出一份可读的复盘（400-600 字，中文，分四点）：
1) **当前位置判断**：结合今日环境与上面统计，说明当前更接近哪类节点、是否属于历史上性价比较高的低吸区，还是需要回避的追高区；给出依据（引用上面的数字）。**主结果**给出**次日情绪分区间**（sentimentRange）与**方向**（sentimentDirection：上行/震荡/下行），并给出**置信度（高/中/低）**。**六态仅作辅助标签**（历史可分性弱，勿当主结论）：一并给出 `state6Next` 与 `state6Probs`（六态完整概率分布，六项之和必须为 1，可用 0 表示该态无可能）。另给 `confidenceScore`（0~1 自评概率，须与 confidence 档位一致）与 `crossValidation`（节点统计／相似日／状态转移 三源方向一致性：偏多/偏空/分歧）。并在本段末写明**数据质量**（`dataQuality` 里 missing/uncertain 的字段及其对置信度的影响）。
2) **明日关注方向**：依据**历史相似日的次日表现与其当时梯队**（上面已给出最近邻匹配），说明明日应重点观察哪类方向与哪类个股结构（如「3板以上接力」「2板卡位」「首板换手充分」），并给出**重点关注名单**（可包含具体个股——仅作为当时梯队里的观察对象，不是推荐；也可只给梯队层级）。
3) **入场条件与失效条件**：给出可验证的触发（例如情绪分/高度/炸板率/溢价的数值条件）与明确的失效条件。触发必须拆两级：**entryNecessary = 必要条件，最多 2 条**（需全部满足才算触发）；**entryConfirm = 观察/确认项**（单独列出、不参与硬匹配，可为空）。并对**中间档**（如情绪分 70~85 的模糊区）给出处理，写进 `middleBand`。
4) **风险与仓位**：指出当前样本局限（节点数量、估算数据）与需要回避的情形，并给出明确的**仓位与出手建议**（观望 / 1成试仓 / 3成 / 5成以上）。**硬约束**：样本不足时（台账已复核条数 < 30，或相似日有效匹配 < 3，或溢价 prem_avg 缺失）positionAdvice 必须为「观望」，并在正文说明样本不足。并回看上方校准段的**上一次预测 vs 实际**，用一句话给出**失准归因**（取 missReasons 枚举：数据口径／外部冲击／状态定义／模型）。

最后一行注明：以上为数据整理，不构成投资建议。（字段补充：bigFaceRange=次日大面数区间、streakRange=次日连板家数区间、redRatioRange=次日全市场红盘率区间；拿不到就给 null。dataQuality 标注 zbRate/redRatio/bigFace 的取值来源状态：ok=正常取到 / missing=压根没有 / uncertain=估算或继承 / zero=确实为 0。missAttribution=失准归因（用上述枚举词）；dataBasis=数据口径：收盘实盘/回测/盘中）

然后在末尾追加**严格 JSON**（用 ```json 包起来，不要注释、不要多余文字），用于回测校准：
```json
{{"stance":"低吸区|中性|追高区","confidence":"高|中|低","confidenceScore":0.0,"sentimentDirection":"上行|震荡|下行","crossValidation":"偏多|偏空|分歧","state6Next":"冰点|过冷|微冷|微热|过热|沸点|不确定","state6Probs":{{"冰点":0,"过冷":0,"微冷":0,"微热":0,"过热":0,"沸点":0}},"sentimentRange":[下限,上限],"heightRange":[下限,上限],"ztRange":[下限,上限],"zbRateRange":[下限,上限],"bigFaceRange":[下限,上限],"streakRange":[下限,上限],"redRatioRange":[下限,上限],"premiumSign":"正|负|持平","positionAdvice":"观望|1成试仓|3成|5成以上","ladderFocus":"3板以上接力|2板卡位|首板换手","watchlist":["个股名(板数/题材)"],"focusThemes":["题材A","题材B"],"entryNecessary":["必要条件，≤2条"],"entryConfirm":["观察/确认项"],"middleBand":"中间档(如情绪70-85)怎么处理","invalidConditions":["失效条件"],"dataQuality":{{"zbRate":"ok|missing|uncertain|zero","redRatio":"ok|missing|uncertain|zero","bigFace":"ok|missing|uncertain|zero"}},"missAttribution":"失准归因(用 missReasons 枚举词)","dataBasis":"收盘实盘|回测|盘中","riskNote":"一句话风险"}}
```"""


def parse_prediction(content: str):
    match = re.search(r"```json\s*([\s\S]*?)```", content, re.IGNORECASE)
    if not match:
        return None, content.strip()
    try:
        return json.loads(match.group(1)), content.replace(match.group(0), "").strip()
    except Exception:
        return None, content.replace(match.group(0), "").strip()


def call_model(cfg: dict, prompt: str, max_tokens: int = 4000) -> str:
    body = {
        "model": cfg["model"],
        "temperature": 0.3,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tokens,
    }
    req = urllib.request.Request(
        cfg["baseUrl"] + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["apiKey"]},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = json.loads(resp.read().decode("utf-8", "replace"))
    return (((payload.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()


def load_tide_rows() -> list[dict]:
    """CI/本地通用：从 tide-data.json 取 rows（供缺 tide_state/tide_history 时降级使用）"""
    raw = read_json(TIDE_DATA_PATH, {}) or {}
    rows = raw.get("rows") if isinstance(raw, dict) else raw
    return [r for r in (rows or []) if isinstance(r, dict) and r.get("date")]


def derive_state(rows: list[dict]) -> dict:
    if not rows:
        return {}
    row = rows[-1]
    veto = row.get("veto") or {}
    return {
        "date": row.get("date"),
        "sentiment": row.get("sent"),
        "state6": row.get("state6"),
        "fundTemp": row.get("temp"),
        "maxBoard": row.get("max_lbc"),
        "limitUp": row.get("zt"),
        "brokenRate": row.get("zb_rate"),
        "premiumAvg": row.get("prem_avg"),
        "bigFace": row.get("damian"),
        "veto": {"finalState": veto.get("final_state"), "total": veto.get("total"),
                 "hits": veto.get("hits") or {}},
    }


def derive_history(rows: list[dict], days: int = 120) -> list[dict]:
    out = []
    for row in rows[-days:]:
        out.append({k: row.get(k) for k in ("date", "sent", "state6", "max_lbc", "prem_avg", "zt", "zb_rate")})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="已有今日记录时也重新生成")
    args = ap.parse_args()

    memory = read_json(MEMORY_PATH, {}) or {}
    tide_rows = load_tide_rows()
    state = read_json(STATE_PATH, {}) or {}
    if not state.get("date"):
        state = derive_state(tide_rows)          # CI 里没有 qd_tide_state.py 的产出 -> 直接从 tide-data 降级
        print("[review-ai] tide_state.json 缺失，已从 tide-data.json 降级推导")
    history = read_json(HISTORY_PATH, []) or []
    if not history:
        history = derive_history(tide_rows)
        print("[review-ai] tide_history.json 缺失，已从 tide-data.json 降级推导（%d 天）" % len(history))
    if not memory.get("nodes"):
        print("[review-ai] 没有 review_memory.json，先跑 qd_review.py")
        return 1

    ledger = read_json(LEDGER_PATH, []) or []
    ledger, removed = dedupe_by_date(ledger)
    if removed:
        print("[review-ai] 台账去重：一天一条，移除 %d 条历史重复" % removed)
    filled = backfill(ledger, history)
    if filled or removed:
        LEDGER_PATH.write_text(json.dumps(ledger, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if filled:
        print("[review-ai] 回填 %d 条历史预测（含打分）" % filled)

    predict_date = state.get("date") or datetime.now().strftime("%Y-%m-%d")
    cfg = load_config()
    sim = find_similar_days(tide_rows, memory)
    matches = sim.get("matches") or []
    similar_text = render_similar(matches, sim)
    # 写出匹配结果（供页面展示与前端生成时使用）
    try:
        similar_path = Path(os.environ.get("REVIEW_SIMILAR_PATH") or (A_DIR / "review_similar.json"))
        similar_path.parent.mkdir(parents=True, exist_ok=True)
        similar_path.write_text(json.dumps({
            "computedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "baseDate": predict_date,
            "threshold": sim.get("threshold"),
            "similarityMode": sim.get("similarityMode"),
            "candidateCount": sim.get("candidateCount"),
            "effectiveMatches": sim.get("effectiveMatches"),
            "fallback": sim.get("fallback"),
            "matches": matches,
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("[review-ai] 历史相似日：有效 %d 条（阈值 %s/%s，候选 %d）-> %s" % (
            sim.get("effectiveMatches"), sim.get("threshold"), sim.get("similarityMode"),
            sim.get("candidateCount"), similar_path))
    except Exception as exc:
        print("[review-ai] 相似日文件写入失败：%s" % type(exc).__name__)
    # P1：六态状态转移矩阵（walk-forward）—— 生成 review_state_matrix.json 并喂进提示词
    matrix_text = ""
    try:
        from qd_state_matrix import build as _build_matrix, render_for_prompt as _render_matrix  # noqa: PLC0415
        mdata = _build_matrix()
        if mdata.get("ok"):
            mout = Path(os.environ.get("REVIEW_STATE_MATRIX_PATH") or (A_DIR / "review_state_matrix.json"))
            mout.parent.mkdir(parents=True, exist_ok=True)
            mout.write_text(json.dumps(mdata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            matrix_text = _render_matrix(mdata)
            row = {k: v for k, v in (mdata["matrix"].get(mdata.get("todayState")) or {}).items() if not k.startswith("_")}
            top1 = max(row.items(), key=lambda kv: kv[1])[0] if row else "—"
            print("[review-ai] 状态转移矩阵：今日 %s -> 明日 Top1 %s｜walk-forward Brier %s（基准 0.8064）"
                  % (mdata.get("todayState"), top1, (mdata.get("walkForward") or {}).get("brier")))
        else:
            print("[review-ai] 状态转移矩阵不可用：%s" % mdata.get("reason"))
    except Exception as exc:
        print("[review-ai] 状态转移矩阵跳过（%s）" % type(exc).__name__)

    prompt = build_prompt(memory, state, calibration_summary(ledger), similar_text=similar_text, matrix_text=matrix_text)

    if args.dry_run:
        print("[review-ai] dry-run：提示词 %d 字，台账 %d 条（已复核 %d）"
              % (len(prompt), len(ledger), sum(1 for e in ledger if e.get("score"))))
        print("[review-ai] 配置检测：baseUrl=%s model=%s key=%s"
              % (cfg["baseUrl"] or "(未配置)", cfg["model"] or "(未配置)", "已设置" if cfg["apiKey"] else "(未配置)"))
        print("---- 提示词前 600 字 ----")
        print(prompt[:600])
        return 0

    if not (cfg["baseUrl"] and cfg["model"] and cfg["apiKey"]):
        print("[review-ai] 缺少模型配置：请在 _bridge/config/ai.local.json 填 baseUrl/model/apiKey（或设 AI_BASE_URL/AI_MODEL/AI_API_KEY 环境变量）")
        return 1
    if not args.force and any(e.get("predictDate") == predict_date for e in ledger):
        print("[review-ai] 今日（%s）已有预测记录，跳过（--force 可强制重生成）" % predict_date)
        return 0

    try:
        content = call_model(cfg, prompt)
    except urllib.error.HTTPError as exc:
        print("[review-ai] 模型调用失败 HTTP %s: %s" % (exc.code, exc.read().decode("utf-8", "replace")[:200]))
        return 1
    except Exception as exc:
        print("[review-ai] 模型调用失败 %s: %s" % (type(exc).__name__, exc))
        return 1

    if not content:
        print("[review-ai] 模型返回空内容（若用推理型模型，建议改用非推理模型或加大 max_tokens）")
        return 1

    prediction, text = parse_prediction(content)
    # 一天只留一条：同一天重新生成则覆盖旧记录
    ledger = [e for e in ledger if e.get("predictDate") != predict_date]
    ledger.append({
        "id": "%s-%s-%d" % (predict_date, cfg["model"], int(datetime.now().timestamp())),
        "predictDate": predict_date,
        "targetDate": "",
        "providerLabel": "服务端自动(" + cfg["model"] + ")",
        "model": cfg["model"],
        "createdAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "prediction": prediction,
        "predictionText": text,
        "baseEnv": {"date": predict_date, "sent": state.get("sentiment"), "state6": state.get("state6"),
                    "max_lbc": state.get("maxBoard"), "prem_avg": state.get("premiumAvg")},
        "actual": None,
        "score": None,
        "reviewedAt": None,
    })
    LEDGER_PATH.write_text(json.dumps(ledger, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("[review-ai] 已生成 %s 的预测并入台账（结构化=%s，台账共 %d 条）"
          % (predict_date, "是" if prediction else "否（模型未按要求输出 JSON）", len(ledger)))
    print("[review-ai] 预测立场：%s" % ((prediction or {}).get("stance") or "—"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
