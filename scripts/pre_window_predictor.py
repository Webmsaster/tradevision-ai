#!/usr/bin/env python3
"""
2026-05-17 Pre-Window BTC Indikator.
Hypothese: BTC's Markt-State in den 24h-72h VOR Window-Start ist prädiktiv
für ob das Window "qualifying" wird (breit feuert in den ersten 24h).

Wenn ja: Bot kann LIVE entscheiden Challenge zu kaufen NUR wenn pre-window
features auf qualifying deuten. Das ist Smart-Timing OHNE Schummeln.
"""
import json
from pathlib import Path
from collections import defaultdict

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
TRADES = ROOT / "trades_p06" / "p06_p1_trades.jsonl"
P1_WIN = ROOT / "trades_p06" / "p06_p1_windows.jsonl"
P2_WIN = ROOT / "per_window" / "p06_ptp_8pct_25_p2.jsonl"
MAJORS = {"BTC-TREND", "ETH-TREND", "BNB-TREND", "SOL-TREND"}

# Load BTC 30m candles
print("[load] BTC candles...")
btc_candles = json.load(open("scripts/cache_bakeoff/BTCUSDT_30m.json"))
# index by openTime (ms) for fast lookup
btc_by_time = {c["openTime"]: c for c in btc_candles}
btc_open_times = sorted(btc_by_time.keys())
print(f"  {len(btc_candles)} BTC bars loaded")

def load_jsonl(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["win_idx"]] = r
    return out

p1 = load_jsonl(P1_WIN)
p2 = load_jsonl(P2_WIN)
trades = defaultdict(list)
for line in TRADES.read_text().splitlines():
    if line.strip():
        r = json.loads(line)
        trades[r["winIdx"]].append(r)

def window_start_time(win_idx):
    """Use first trade's entryTime as proxy for window start (close enough)."""
    if win_idx not in trades or not trades[win_idx]:
        return None
    return min(t["entryTime"] for t in trades[win_idx])

def qualifying(win_idx, min_b=4, min_m=3):
    if win_idx not in trades or not trades[win_idx]:
        return False
    s = sorted(trades[win_idx], key=lambda t: t["entryTime"])
    cutoff = s[0]["entryTime"] + 24*3600*1000
    syms = set()
    majs = set()
    for t in s:
        if t["entryTime"] > cutoff:
            break
        syms.add(t["symbol"])
        for p in MAJORS:
            if t["symbol"].startswith(p[:-6] + "-") or t["symbol"] == p:
                majs.add(p)
                break
    return len(syms) >= min_b and len(majs) >= min_m

def btc_features_at(t_ms, hours_back=24):
    """Compute BTC features in the [t-hours_back, t) window — STRICT pre-window
    (no lookahead). Returns dict or None if data insufficient."""
    bar_minutes = 30
    bars_back = hours_back * 60 // bar_minutes
    # Find candles strictly before t_ms
    end_idx = None
    for i, ot in enumerate(btc_open_times):
        if ot >= t_ms:
            end_idx = i
            break
    if end_idx is None or end_idx < bars_back:
        return None
    start_idx = end_idx - bars_back
    sub = [btc_by_time[btc_open_times[i]] for i in range(start_idx, end_idx)]
    if len(sub) < bars_back:
        return None
    closes = [c["close"] for c in sub]
    highs = [c["high"] for c in sub]
    lows = [c["low"] for c in sub]
    # Simple features
    ret_24h = (closes[-1] / closes[0] - 1) * 100  # %
    high_max = max(highs)
    low_min = min(lows)
    range_pct = (high_max - low_min) / closes[0] * 100
    # ATR-like (true range avg)
    trs = []
    for i in range(1, len(sub)):
        h, l, pc = sub[i]["high"], sub[i]["low"], sub[i-1]["close"]
        tr = max(h - l, abs(h - pc), abs(l - pc))
        trs.append(tr / pc * 100)  # % normalized
    atr_pct = sum(trs) / len(trs) if trs else 0.0
    # Linear regression slope (% per bar)
    n = len(closes)
    mean_x = (n-1) / 2
    mean_y = sum(closes) / n
    num = sum((i - mean_x) * (closes[i] - mean_y) for i in range(n))
    den = sum((i - mean_x)**2 for i in range(n))
    slope = num / den if den > 0 else 0.0
    slope_pct = slope / closes[0] * 100  # % per bar
    return {
        "ret_pct": ret_24h,
        "range_pct": range_pct,
        "atr_pct": atr_pct,
        "slope_pct": slope_pct,
    }

# Compute features per window
print("\n[compute] pre-window BTC features (24h lookback)...")
results = []
for w in sorted(set(p1) & set(p2) & set(trades.keys())):
    t = window_start_time(w)
    if t is None: continue
    feat = btc_features_at(t, 24)
    if feat is None: continue
    q = qualifying(w)
    passed_p1 = p1[w]["passed"]
    passed_p2 = p2[w]["passed"]
    results.append({
        "win": w, "t": t,
        "qualifying": q,
        "p1": passed_p1, "p2": passed_p2,
        "and": passed_p1 and passed_p2,
        **feat
    })

print(f"  computed {len(results)} windows with features\n")

# Summary by qualifying / non-qualifying
def avg(lst, key):
    vals = [r[key] for r in lst]
    return sum(vals) / len(vals) if vals else 0.0

qual = [r for r in results if r["qualifying"]]
nonqual = [r for r in results if not r["qualifying"]]

print(f"=== Pre-Window BTC Features (24h before window-start) ===")
print(f"{'Feature':<14} {'Qualifying (n={})':<25} {'Non-qual (n={})':<25}".format(len(qual), len(nonqual)))
print("-" * 70)
for key in ["ret_pct", "range_pct", "atr_pct", "slope_pct"]:
    qv = avg(qual, key)
    nv = avg(nonqual, key)
    print(f"{key:<14} {qv:<25.4f} {nv:<25.4f} diff={qv-nv:+.4f}")

# Distribution check: thresholds on each feature
print("\n=== Predictive Power (slope_pct buckets) ===")
slopes = sorted([r["slope_pct"] for r in results])
# Quartiles
q1, q2, q3 = slopes[len(slopes)//4], slopes[len(slopes)//2], slopes[3*len(slopes)//4]
print(f"slope quartiles: Q1={q1:.4f} median={q2:.4f} Q3={q3:.4f}")

for bucket_name, lo, hi in [
    ("Q1 (lowest)",  slopes[0], q1),
    ("Q2",           q1, q2),
    ("Q3",           q2, q3),
    ("Q4 (highest)", q3, slopes[-1]),
]:
    sub = [r for r in results if lo <= r["slope_pct"] <= hi]
    if not sub: continue
    qpct = sum(1 for r in sub if r["qualifying"]) / len(sub) * 100
    pass_pct = sum(1 for r in sub if r["and"]) / len(sub) * 100
    print(f"  {bucket_name:<14} n={len(sub):>3} qualify%={qpct:5.1f}  AND-pass%={pass_pct:5.2f}")

# Sweep slope thresholds
print("\n=== Slope-Threshold Sweep (filter: slope_pct >= X) ===")
print(f"{'Threshold':<12} {'Kept':<10} {'Qualify%':<10} {'AND%':<10}")
for thresh in [-0.5, -0.2, -0.1, 0.0, 0.05, 0.1, 0.15, 0.2, 0.3]:
    kept = [r for r in results if r["slope_pct"] >= thresh]
    if not kept: continue
    qpct = sum(1 for r in kept if r["qualifying"]) / len(kept) * 100
    andpct = sum(1 for r in kept if r["and"]) / len(kept) * 100
    print(f"  >={thresh:<8} {len(kept)}/{len(results):<6} {qpct:6.2f}%   {andpct:6.2f}%")

# Combined gate: slope + ret_pct
print("\n=== Combined: slope_pct >= X1 AND ret_pct >= X2 ===")
print(f"{'slope':<8} {'ret':<8} {'Kept':<10} {'AND%':<10}")
for sl in [0.0, 0.05, 0.1]:
    for rt in [-2.0, 0.0, 1.0, 2.0]:
        kept = [r for r in results if r["slope_pct"] >= sl and r["ret_pct"] >= rt]
        if not kept: continue
        andpct = sum(1 for r in kept if r["and"]) / len(kept) * 100
        print(f"  {sl:<6} {rt:<6} {len(kept)}/{len(results):<6} {andpct:6.2f}%")
