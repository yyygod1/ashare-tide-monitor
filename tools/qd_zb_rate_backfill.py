# qd_zb_rate_backfill.py -- 补第 6 个因子 zb_rate（炸板率），**云端 runner 专用**
#
# 为什么放云端：本地 push2 clist 被墙、且本地没有全市场代码清单；云端 runner 能直连东财。
#
# 口径（与 tide-monitor/premium.js 的真实值同义）：
#   zb_rate = 炸板 / (涨停 + 炸板) × 100
#     涨停 = 当日「最高价触及涨停价」且「收盘仍封在涨停价」
#     炸板 = 当日「最高价触及涨停价」但「收盘未封住」
#   涨停价 = round(昨收 × (1 + 限幅), 2)
#     限幅：名称含 ST 5% ｜ 代码 300/688 开头 20% ｜ 8/4 开头(北交所) 30% ｜ 其余 10%
#   * 用日线 high/close 近似「曾涨停」→ 一字板/盘中反复开板等会有偏差，所以**必须自校验**。
#
# 自校验：拿仓库 tide-data.json 里**已有真实 zb_rate** 的日子（近期，来自涨停/炸板池）与本次近似比对，
#         输出 MAE + Spearman（排序一致性才是情绪分在意的）。校验不过就**不写盘**（除非 --force）。
#
# 用法（云端由 workflow 调）：
#   python qd_zb_rate_backfill.py --validate          # 只校验，不写
#   python qd_zb_rate_backfill.py --apply             # 校验通过后写入缺口段的 zb_rate
#   python qd_zb_rate_backfill.py --apply --force     # 校验不过也写（慎用）
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

os.environ["NO_PROXY"] = "*"
for _k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"):
    os.environ.pop(_k, None)

QD_DIR = Path(os.environ.get("QD_DIR", r"D:\projects\my-quantdash"))

# 云端仓库的 tide rows 实际在 docs/tide-data.json（2026-10-03 核实：tide-monitor/ 目录已不存在）；
# 为兼容不同布局，按候选顺序探测第一个存在的。
def _tide_data() -> Path:
    env = os.environ.get("TIDE_DATA_PATH")
    if env:
        return Path(env)
    for rel in ("docs/tide-data.json", "tide-monitor/tide-data.json",
                "data/markets/a_share/tide-data.json", "data/tide-data.json"):
        p = QD_DIR / rel
        if p.is_file():
            return p
    return QD_DIR / "docs" / "tide-data.json"


TIDE_DATA = _tide_data()
CACHE = Path(os.environ.get("ZB_CACHE") or (QD_DIR / "_bridge" / "cache" / "zb"))
GAP_START, GAP_END = "2026-04-07", "2026-08-26"
EPS = 0.001

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/123 Safari/537.36"}


def http(url, headers=None, timeout=20, decode="utf-8"):
    h = dict(UA)
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode(decode, "replace")


def limit_ratio(code: str, name: str) -> float:
    if "ST" in (name or "").upper():
        return 0.05
    if code.startswith(("300", "301", "688", "689")):
        return 0.20
    if code.startswith(("8", "4", "92")):
        return 0.30
    return 0.10


def full_market() -> list[tuple[str, str, str]]:
    """东财 clist 全市场 -> [(code6, name, market)]；market: 1=沪 0=深"""
    out = []
    fs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
    url = ("https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2"
           "&fid=f12&fs=" + urllib.parse.quote(fs, safe=",:+") + "&fields=f12,f13,f14")
    d = json.loads(http(url, {"Referer": "https://quote.eastmoney.com/"}, timeout=40))
    for s in ((d.get("data") or {}).get("diff") or []):
        c = str(s.get("f12") or "").strip()
        n = str(s.get("f14") or "").strip()
        if len(c) == 6 and c.isdigit():
            out.append((c, n, str(s.get("f13"))))
    return out


def kline(code: str, market: str) -> dict:
    """单只日线 {date: (high, close)}，覆盖缺口段+近期；带磁盘缓存。多源回退：东财 -> 腾讯 -> 新浪"""
    CACHE.mkdir(parents=True, exist_ok=True)
    fp = CACHE / ("%s.json" % code)
    if fp.is_file():
        try:
            raw = json.loads(fp.read_text(encoding="utf-8"))
            return {k: tuple(v) for k, v in raw.items()}
        except Exception:
            pass
    secid = "%s.%s" % (market, code)
    out: dict[str, tuple[float, float]] = {}
    # 1) 东财 push2his（云端可达）
    try:
        u = ("https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=" + secid +
             "&fields1=f1,f2,f3&fields2=f51,f53,f54,f55,f56&klt=101&fqt=0&beg=20260301&end=20261010")
        d = json.loads(http(u, {"Referer": "https://quote.eastmoney.com/"}, timeout=25))
        for ln in (((d.get("data") or {}).get("klines")) or []):
            p = ln.split(",")
            if len(p) >= 4:
                out[p[0][:10]] = (float(p[2]), float(p[3]))   # f54=最高 f53=收盘
    except Exception:
        out = {}
    # 2) 腾讯 ifzq（前复权；用 high/close）
    if not out:
        try:
            sym = ("sh" + code) if code.startswith("6") else (("bj" + code) if code.startswith(("8", "4")) else ("sz" + code))
            d = json.loads(http("https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=%s,day,,,200,qfq" % sym, timeout=25))
            node = ((d.get("data") or {}).get(sym) or {})
            for r in (node.get("qfqday") or node.get("day") or []):
                if len(r) >= 5:
                    out[str(r[0])[:10]] = (float(r[3]), float(r[2]))   # [3]=high [2]=close
        except Exception:
            out = out or {}
    if out:
        fp.write_text(json.dumps({k: list(v) for k, v in out.items()}, ensure_ascii=False), encoding="utf-8")
    return out


def scan(days_need: set[str]) -> dict[str, dict]:
    """返回 {date: {'zt':n,'zb':n,'zb_rate':x,'scanned':n}}"""
    mk = full_market()
    print("[zb] 全市场 %d 只" % len(mk), flush=True)
    agg: dict[str, dict] = {d: {"zt": 0, "zb": 0, "scanned": 0} for d in days_need}
    ok = fail = 0
    for i, (code, name, market) in enumerate(mk):
        try:
            kl = kline(code, market)
        except Exception:
            kl = {}
        if not kl:
            fail += 1
            continue
        ok += 1
        dates = sorted(kl)
        r = limit_ratio(code, name)
        for j in range(1, len(dates)):
            d, pd = dates[j], dates[j - 1]
            if d not in agg:
                continue
            prev_close = kl[pd][1]
            if prev_close <= 0:
                continue
            lim = round(prev_close * (1 + r), 2)
            high, close = kl[d]
            if high + EPS >= lim:
                agg[d]["scanned"] += 1
                if close + EPS >= lim:
                    agg[d]["zt"] += 1
                else:
                    agg[d]["zb"] += 1
        if (i + 1) % 500 == 0:
            print("[zb] kline 进度 %d/%d（有效 %d 失败 %d）" % (i + 1, len(mk), ok, fail), flush=True)
        time.sleep(0.05)
    for d, v in agg.items():
        tot = v["zt"] + v["zb"]
        v["zb_rate"] = round(100.0 * v["zb"] / tot, 1) if tot else None
    return agg


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if not TIDE_DATA.is_file():
        print("[zb] ❌ 读不到 tide-data.json: %s" % TIDE_DATA)
        return 2
    data = json.loads(TIDE_DATA.read_text(encoding="utf-8-sig"))
    rows = data.get("rows") or []
    byd = {r["date"]: r for r in rows if r.get("date")}
    real_days = [d for d, r in byd.items() if r.get("zb_rate") is not None]
    gap_days = [d for d in byd if GAP_START <= d <= GAP_END and byd[d].get("zb_rate") is None]
    need = set(real_days) | set(gap_days)
    print("[zb] 需扫描 %d 天（近期真实 %d 天用于校验 + 缺口待补 %d 天）" % (len(need), len(real_days), len(gap_days)))

    agg = scan(need)

    # —— 自校验：近似 vs 真实 ——
    pairs = [(agg[d]["zb_rate"], byd[d]["zb_rate"]) for d in sorted(real_days)
             if agg.get(d, {}).get("zb_rate") is not None]
    print("\n=== 自校验（近似 vs 真实，n=%d 天）===" % len(pairs))
    for d in sorted(real_days)[-10:]:
        a = agg.get(d, {}).get("zb_rate")
        print("  %s  近似 %-6s 真实 %-6s  (涨停/炸板=%s/%s)"
              % (d, a, byd[d]["zb_rate"], agg.get(d, {}).get("zt"), agg.get(d, {}).get("zb")))
    if pairs:
        mae = sum(abs(a - b) for a, b in pairs) / len(pairs)
        bias = sum(a - b for a, b in pairs) / len(pairs)

        def rank(xs):
            order = sorted(range(len(xs)), key=lambda i: xs[i])
            r = [0.0] * len(xs)
            for pos, idx in enumerate(order):
                r[idx] = pos + 1
            return r

        ra, rb = rank([p[0] for p in pairs]), rank([p[1] for p in pairs])
        n = len(pairs)
        ma, mb = sum(ra) / n, sum(rb) / n
        num = sum((ra[i] - ma) * (rb[i] - mb) for i in range(n))
        da = sum((x - ma) ** 2 for x in ra) ** 0.5
        db = sum((x - mb) ** 2 for x in rb) ** 0.5
        rho = num / (da * db) if da and db else 0.0
        print("  MAE %.2f pp ｜ 偏差 %+.2f pp ｜ Spearman %.3f" % (mae, bias, rho))
        passed = rho >= 0.85
        print("  判定：%s（判据 Spearman >= 0.85）" % ("✅ 通过" if passed else "❌ 未通过"))
    else:
        passed = False
        print("  ⚠️ 无可用比对样本")

    filled = sum(1 for d in gap_days if agg.get(d, {}).get("zb_rate") is not None)
    print("\n缺口段可补 %d / %d 天" % (filled, len(gap_days)))
    for d in sorted(gap_days)[:6]:
        print("  %s -> %s" % (d, agg.get(d, {}).get("zb_rate")))
    if args.validate and not args.apply:
        return 0 if passed else 1

    if args.apply:
        if not passed and not args.force:
            print("\n[zb] ❌ 自校验未通过，拒绝写盘（要强写加 --force）")
            return 1
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        n = 0
        for d in gap_days:
            v = agg.get(d) or {}
            if v.get("zb_rate") is None:
                continue
            byd[d]["zb_rate"] = v["zb_rate"]
            byd[d]["zb"] = v["zb"]
            byd[d]["_zb_backfill"] = {"at": stamp, "src": "full-market OHLC approximation",
                                     "sampled": v["scanned"], "zt": v["zt"], "zb": v["zb"]}
            n += 1
        TIDE_DATA.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print("\n[zb] 已写入 %d 天 -> %s" % (n, TIDE_DATA))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
