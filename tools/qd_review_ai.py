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


def score_entry(entry: dict, actual: dict, prev_sent):
    p = entry.get("prediction") or {}
    sent_hit = in_range(actual.get("sent"), p.get("sentimentRange"))
    height_hit = in_range(actual.get("max_lbc"), p.get("heightRange"))
    prem_hit = (sign_of(actual.get("prem_avg")) == p.get("premiumSign")) if p.get("premiumSign") else None
    stance_hit = None
    if p.get("stance") and prev_sent is not None and actual.get("sent") is not None:
        if p["stance"] == "低吸区":
            stance_hit = actual["sent"] > prev_sent
        elif p["stance"] == "追高区":
            stance_hit = actual["sent"] < prev_sent
    items = [v for v in (sent_hit, height_hit, prem_hit, stance_hit) if v is not None]
    hits = sum(1 for v in items if v)
    return {
        "sentHit": sent_hit, "heightHit": height_hit, "premiumHit": prem_hit, "stanceHit": stance_hit,
        "scored": len(items), "hits": hits,
        "accuracy": round(hits / len(items), 2) if items else None,
    }


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
    lines = []
    for entry in reviewed[-limit:]:
        p = entry.get("prediction") or {}
        a = entry.get("actual") or {}
        s = entry.get("score") or {}
        miss = [label for key, label in
                (("sentHit", "情绪区间"), ("heightHit", "高度区间"), ("premiumHit", "溢价方向"), ("stanceHit", "立场"))
                if s.get(key) is False]
        lines.append("- %s→%s｜预测 %s｜实际 情绪分 %s（%s）高度 %s 溢价 %s%%｜命中率 %s%s"
                     % (entry.get("predictDate"), entry.get("targetDate"), p.get("stance") or "未结构化",
                        a.get("sent"), a.get("state6"), a.get("max_lbc"), a.get("prem_avg"),
                        (str(round(s["accuracy"] * 100)) + "%") if s.get("accuracy") is not None else "—",
                        ("｜失准项：" + "、".join(miss)) if miss else ""))
    head = "近 %d 次预测命中率：%s（已复核 %d 次）" % (
        len(reviewed[-limit:]), (str(round(overall * 100)) + "%") if overall is not None else "—", len(reviewed))
    return "\n".join([head] + lines)


# ---------- 提示词（与前端同结构）----------
def build_prompt(memory: dict, state: dict, calibration: str, compact: bool = False) -> str:
    stats = "\n".join(
        "- %s：出现 %s 次，平均性价比 %s，次日情绪上行占比 %s" % (
            k, v.get("count"), v.get("avgScore"),
            (str(round((v.get("winRate") or 0) * 100)) + "%") if v.get("winRate") is not None else "—")
        for k, v in sorted((memory.get("stats") or {}).items(), key=lambda kv: -(kv[1].get("avgScore") or -9))
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
    today = "日期 %s｜情绪分 %s（%s）｜资金温度 %s｜最高板 %s｜炸板率 %s%%｜昨涨停溢价 %s%%｜大面 %s｜veto %s%s" % (
        state.get("date"), state.get("sentiment"), state.get("state6"), state.get("fundTemp"),
        state.get("maxBoard"), state.get("brokenRate"), state.get("premiumAvg"), state.get("bigFace"),
        (state.get("veto") or {}).get("finalState") or "未生效",
        ("（命中 " + "、".join(hits) + "）") if hits else "")

    return f"""【今日环境】{today}

【历史买点节点类型统计（含次日验证胜率）】
{stats}

【最近节点明细（含当时环境、领头题材与核心股、事后验证）】
{chr(10).join(node_txt) or '—'}

【你过去的预测与实际对照（用于自我校准，请根据失准项调整本次判断的尺度）】
{calibration}

请输出一份可读的复盘（400-600 字，中文，分四点）：
1) **当前位置判断**：结合今日环境与上面统计，说明当前更接近哪类节点、是否属于历史上性价比较高的低吸区，还是需要回避的追高区；给出依据（引用上面的数字）。
2) **明日关注方向**：依据历史上高性价比节点出现时的领头题材/梯队特征，说明明日应该重点观察哪类方向与哪类个股结构（如「首板/2板换手充分」「板块内核心 vs 跟风」），不要凭空推荐具体标的。
3) **入场条件与失效条件**：给出可验证的触发（例如情绪分/高度/炸板率/溢价的数值条件）与明确的失效条件。
4) **风险与仓位**：指出当前样本局限（节点数量、估算数据）与需要回避的情形。

最后一行注明：以上为数据整理，不构成投资建议。

然后在末尾追加**严格 JSON**（用 ```json 包起来，不要注释、不要多余文字），用于回测校准：
```json
{{"stance":"低吸区|中性|追高区","sentimentRange":[下限,上限],"heightRange":[下限,上限],"premiumSign":"正|负|持平","focusThemes":["题材A"],"entryConditions":["可验证条件"],"invalidConditions":["失效条件"],"riskNote":"一句话风险"}}
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
    filled = backfill(ledger, history)
    if filled:
        LEDGER_PATH.write_text(json.dumps(ledger, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("[review-ai] 回填 %d 条历史预测（含打分）" % filled)

    predict_date = state.get("date") or datetime.now().strftime("%Y-%m-%d")
    cfg = load_config()
    prompt = build_prompt(memory, state, calibration_summary(ledger))

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
