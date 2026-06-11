#!/usr/bin/env python3
"""
2026-05-17 Multi-Asset Pre-Window Features.
BTC-only was not predictive. Test if AGGREGATE crypto trend (avg of 19 assets
in 24h-72h before window-start) is predictive for qualifying vs non-qual.

This is the bot's pre-buy scanner: can it see "market is broadly trending"
BEFORE buying challenge?
"""
import json
from pathlib import Path
from collections import defaultdict

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
TRADES = ROOT / "trades_p06" / "p06_p1_trades.jsonl"
P1_WIN = ROOT / "trades_p06" / "p06_p1_windows.jsonl"
P2_WIN = ROOT / "per_window" / "p06_ptp_8pct_25_p2.jsonl"
MAJORS = {"BTC-TREND", "ETH-TREND", "BNB-TREND", "SOL-TREND"}

ASSETS = ["AAVE", "ADA", "ALGO", "ARB", "ATOM", "AVAX", "BCH", "BNB", "BTC",
          "DOT", "ETC", "ETH", "LINK", "LTC", "NEAR", "SOL", "TRX", "UNI", "XRP"]

print("[load] 19 asset candle indexes...")
asset_candles = {}
for sym in ASSETS:
    path = f"scripts/cache_bakeoff/{sym}USDT_30m.json"
    if not Path(path).exists():
        continue
    data = json.load(open(path))
    asset_candles[sym] = {c["openTime"]: c for c in data}
    asset_candles[sym]["_sorted_keys"] = sorted(asset_candles[sym].keys() - {"_sorted_keys"})

# Load windows + trades
p1 = {}
p2 = {}
for line in Path(P1_WIN).read_text().splitlines():
    if line.strip(): r=json.loads(line); p1[r["win_idx"]]=r
for line in Path(P2_WIN).read_text().splitlines():
    if line.strip(): r=json.loads(line); p2[r["win_idx"]]=r
trades = defaultdict(list)
for line in TRADES.read_text().splitlines():
    if line.strip(): r=json.loads(line); trades[r["winIdx"]].append(r)

def window_start(win_idx):
    if win_idx not in trades or not trades[win_idx]: return None
    return min(t["entryTime"] for t in trades[win_idx])

def qualifying(win_idx, b=4, m=3):
    if win_idx not in trades or not trades[win_idx]: return False
    s = sorted(trades[win_idx], key=lambda t: t["entryTime"])
    cutoff = s[0]["entryTime"] + 24*3600*1000
    syms, majs = set(), set()
    for t in s:
        if t["entryTime"] > cutoff: break
        syms.add(t["symbol"])
        for p in MAJORS:
            if t["symbol"].startswith(p[:-6]+"-") or t["symbol"]==p:
                majs.add(p); break
    return len(syms)>=b and len(majs)>=m

def asset_features(sym, end_ms, hours_back):
    """Compute features for one asset in [end-hours_back, end) — pre-window only."""
    if sym not in asset_candles:
        return None
    keys = asset_candles[sym]["_sorted_keys"]
    end_idx = None
    bars_back = hours_back * 60 // 30
    for i, k in enumerate(keys):
        if k >= end_ms:
            end_idx = i
            break
    if end_idx is None or end_idx < bars_back:
        return None
    start_idx = end_idx - bars_back
    sub = [asset_candles[sym][keys[i]] for i in range(start_idx, end_idx)]
    if len(sub) < bars_back:
        return None
    closes = [c["close"] for c in sub]
    ret_pct = (closes[-1] / closes[0] - 1) * 100
    # ATR % normalized
    trs = []
    for i in range(1, len(sub)):
        h, l, pc = sub[i]["high"], sub[i]["low"], sub[i-1]["close"]
        tr = max(h-l, abs(h-pc), abs(l-pc))
        trs.append(tr/pc*100)
    atr_pct = sum(trs)/len(trs) if trs else 0.0
    return {"ret": ret_pct, "atr": atr_pct}

def multi_asset_features(end_ms, hours_back, asset_list):
    feats = []
    for sym in asset_list:
        f = asset_features(sym, end_ms, hours_back)
        if f: feats.append(f)
    if not feats: return None
    return {
        "avg_ret": sum(f["ret"] for f in feats) / len(feats),
        "avg_atr": sum(f["atr"] for f in feats) / len(feats),
        "n_pos": sum(1 for f in feats if f["ret"] > 0),
        "n_neg": sum(1 for f in feats if f["ret"] < 0),
        "n_total": len(feats),
    }

print("\n[compute] multi-asset pre-window features for each window...")
common = sorted(set(p1) & set(p2) & set(trades.keys()))
results = []
for w in common:
    t = window_start(w)
    if t is None: continue
    # 24h lookback
    f24 = multi_asset_features(t, 24, ASSETS)
    if f24 is None: continue
    # 72h lookback
    f72 = multi_asset_features(t, 72, ASSETS)
    if f72 is None: continue
    results.append({
        "win": w, "qual": qualifying(w),
        "and_pass": p1[w]["passed"] and p2[w]["passed"],
        "f24_ret": f24["avg_ret"],
        "f24_atr": f24["avg_atr"],
        "f24_n_pos": f24["n_pos"],
        "f24_pct_pos": f24["n_pos"]/f24["n_total"]*100,
        "f72_ret": f72["avg_ret"],
        "f72_atr": f72["avg_atr"],
        "f72_n_pos": f72["n_pos"],
        "f72_pct_pos": f72["n_pos"]/f72["n_total"]*100,
    })

print(f"computed {len(results)} windows\n")

def avg(lst, k): return sum(x[k] for x in lst)/len(lst) if lst else 0.0

qual = [r for r in results if r["qual"]]
nq = [r for r in results if not r["qual"]]

print(f"=== Multi-Asset Pre-Window Comparison ===")
print(f"{'Feature':<14} {'Qual (n='+str(len(qual))+')':<22} {'Non-qual (n='+str(len(nq))+')':<22} {'Diff':<8}")
for k in ["f24_ret", "f24_atr", "f24_pct_pos", "f72_ret", "f72_atr", "f72_pct_pos"]:
    qv = avg(qual, k)
    nv = avg(nq, k)
    print(f"{k:<14} {qv:<22.3f} {nv:<22.3f} {qv-nv:+.3f}")

# Try gates on multi-asset features
print("\n=== Gate on avg_ret + pct_pos thresholds (24h) ===")
print(f"{'Gate':<35} {'Kept':<8} {'Qualify%':<10} {'AND%':<10}")
for min_ret in [-1.0, 0.0, 0.5, 1.0]:
    for min_pct_pos in [40, 50, 60, 70]:
        kept = [r for r in results if r["f24_ret"]>=min_ret and r["f24_pct_pos"]>=min_pct_pos]
        if not kept: continue
        qpct = sum(1 for r in kept if r["qual"])/len(kept)*100
        andpct = sum(1 for r in kept if r["and_pass"])/len(kept)*100
        label = f"ret>={min_ret} & pct_pos>={min_pct_pos}"
        print(f"  {label:<33} {len(kept)}/{len(results):<6} {qpct:6.2f}%  {andpct:6.2f}%")
