#!/usr/bin/env python3
"""
2026-05-17 BTC stress-short v2 — Trigger relaxed sweep.
Codex's original triggers were too strict (1/220 fires). Sweep variants.
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

asset_candles = {}
for sym in ASSETS:
    path = f"scripts/cache_bakeoff/{sym}USDT_30m.json"
    if not Path(path).exists(): continue
    data = json.load(open(path))
    asset_candles[sym] = {"by_time": {c["openTime"]: c for c in data},
                          "sorted": sorted(c["openTime"] for c in data)}

btc_funding = sorted(
    [{"t": int(f["t"]), "r": float(f["r"])}
     for f in json.load(open("scripts/cache_bakeoff/BTCUSDT_funding.json"))],
    key=lambda x: x["t"]
)

def get_close_at(sym, t_ms):
    if sym not in asset_candles: return None
    times, bt = asset_candles[sym]["sorted"], asset_candles[sym]["by_time"]
    last = None
    for t in times:
        if t > t_ms: break
        last = t
    return bt[last]["close"] if last else None

def get_close_offset(sym, t_ms, bar_off):
    if sym not in asset_candles: return None
    times, bt = asset_candles[sym]["sorted"], asset_candles[sym]["by_time"]
    last_idx = None
    for i, t in enumerate(times):
        if t > t_ms: break
        last_idx = i
    if last_idx is None: return None
    target = last_idx + bar_off
    return bt[times[target]]["close"] if 0 <= target < len(times) else None

def get_close_path(sym, start_ms, bars):
    if sym not in asset_candles: return []
    times, bt = asset_candles[sym]["sorted"], asset_candles[sym]["by_time"]
    start_idx = None
    for i, t in enumerate(times):
        if t >= start_ms:
            start_idx = i; break
    if start_idx is None: return []
    return [bt[times[i]] for i in range(start_idx, min(start_idx + bars, len(times)))]

def get_funding_at(t_ms):
    last = None
    for f in btc_funding:
        if f["t"] > t_ms: break
        last = f["r"]
    return last

def load(p):
    out = {}
    for line in Path(p).read_text().splitlines():
        if line.strip(): r=json.loads(line); out[r["win_idx"]] = r
    return out

p1 = load(P1_WIN)
p2 = load(P2_WIN)
trades = defaultdict(list)
for line in TRADES.read_text().splitlines():
    if line.strip(): r=json.loads(line); trades[r["winIdx"]].append(r)

def cluster_at(tl, hours):
    if not tl: return 0, 0
    s = sorted(tl, key=lambda t: t["entryTime"])
    cutoff = s[0]["entryTime"] + hours*3600*1000
    syms, majs = set(), set()
    for t in s:
        if t["entryTime"] > cutoff: break
        syms.add(t["symbol"])
        for p in MAJORS:
            if t["symbol"].startswith(p[:-6]+"-") or t["symbol"]==p:
                majs.add(p); break
    return len(syms), len(majs)

def simulate_short(switch_t, stop_pct=0.018, tp_pct=0.024, hold_bars=48,
                   risk_frac=0.30, cost_bp=30.0):
    btc_now = get_close_at("BTC", switch_t)
    if btc_now is None: return None
    path = get_close_path("BTC", switch_t, hold_bars + 1)
    if not path: return None
    entry = btc_now
    exit_price = None
    for bar in path[1:]:
        if bar["high"] >= entry * (1 + stop_pct):
            exit_price = entry * (1 + stop_pct); break
        if bar["low"] <= entry * (1 - tp_pct):
            exit_price = entry * (1 - tp_pct); break
    if exit_price is None: exit_price = path[-1]["close"]
    raw = (entry - exit_price) / entry
    eff = (raw - (cost_bp / 10000) * 2) * risk_frac
    return eff

def features_at(switch_t):
    btc_now = get_close_at("BTC", switch_t)
    btc_48 = get_close_offset("BTC", switch_t, -48)
    if not btc_now or not btc_48: return None
    btc_ret = btc_now / btc_48 - 1
    brs = []
    for sym in ASSETS:
        if sym == "BTC": continue
        cn = get_close_at(sym, switch_t)
        c48 = get_close_offset(sym, switch_t, -48)
        if cn and c48: brs.append(cn/c48 - 1)
    if not brs: return None
    basket_ret = sum(brs) / len(brs)
    funding = get_funding_at(switch_t)
    return {"btc": btc_ret, "basket": basket_ret,
            "diff": btc_ret - basket_ret, "funding": funding}

# Build feature table per non-qual window
common = sorted(set(p1) & set(p2) & set(trades.keys()))
nq_windows = []
for w in common:
    tl = trades[w]
    if not tl: continue
    syms, majs = cluster_at(tl, 4)  # 4h horizon per Codex
    if syms >= 4 and majs >= 3: continue
    s = sorted(tl, key=lambda t: t["entryTime"])
    switch_t = s[0]["entryTime"] + 4*3600*1000
    feat = features_at(switch_t)
    if feat is None: continue
    nq_windows.append({
        "w": w, "feat": feat, "switch_t": switch_t,
        "real_pass": p1[w]["passed"], "p2_pass": p2[w]["passed"],
        "trades": tl, "base_pnl": sum(t["effPnl"] for t in tl)
    })

print(f"Non-qual windows analyzed: {len(nq_windows)}")
print(f"Real P1 pass-rate non-qual: {sum(1 for r in nq_windows if r['real_pass'])/len(nq_windows)*100:.2f}%")

print("\n=== Trigger Variants — fires + sim flip-rate ===")
print(f"{'Variant':<50} {'Fires':<8} {'Win':<6} {'Loss':<6} {'NetPnL':<10}")

variants = [
    # (label, predicate)
    ("ORIG Codex: btc-basket<=-0.01 & basket<=0.005 & f>=0.000075",
     lambda f: f["diff"]<=-0.01 and f["basket"]<=0.005 and (f["funding"] or 0) >= 0.000075),
    ("Looser: btc-basket<=-0.005 & basket<=0.01 & f>=0.0",
     lambda f: f["diff"]<=-0.005 and f["basket"]<=0.01 and (f["funding"] or 0) >= 0),
    ("Pure C-strong: btc-basket<=-0.02 (no basket/funding)",
     lambda f: f["diff"]<=-0.02),
    ("BTC-down only: btc_ret<=-0.02",
     lambda f: f["btc"]<=-0.02),
    ("BTC-down + funding: btc_ret<=-0.01 & f>=0.0001",
     lambda f: f["btc"]<=-0.01 and (f["funding"] or 0)>=0.0001),
    ("Hybrid: (btc-basket<=-0.01 AND basket<=0.0) OR btc_ret<=-0.02",
     lambda f: (f["diff"]<=-0.01 and f["basket"]<=0) or f["btc"]<=-0.02),
    ("Pure funding-extreme: f >= 0.0005",
     lambda f: (f["funding"] or 0) >= 0.0005),
    ("Basket negative: basket_ret <= -0.01",
     lambda f: f["basket"]<=-0.01),
]

for label, pred in variants:
    fires = [r for r in nq_windows if pred(r["feat"])]
    if not fires:
        print(f"  {label[:48]:<50} {0:<8} -")
        continue
    pnls = [simulate_short(r["switch_t"]) for r in fires]
    pnls = [p for p in pnls if p is not None]
    if not pnls:
        print(f"  {label[:48]:<50} {len(fires):<8} 0  0  0")
        continue
    wins = sum(1 for p in pnls if p > 0)
    losses = sum(1 for p in pnls if p < 0)
    net = sum(pnls)
    print(f"  {label[:48]:<50} {len(fires):<8} {wins:<6} {losses:<6} {net:+.3f}")

# Pick best variant + recompute unconditional pass rate
print("\n=== Recompute Pass-Rate WITH Hybrid Fallback ===")

# Best hybrid trigger from above (will pick most promising)
def best_predicate(f):
    return (f["diff"]<=-0.01 and f["basket"]<=0) or f["btc"]<=-0.02

# Now simulate full window equity with fallback added
qualifies_set = set()
for w in common:
    tl = trades[w]
    if not tl: continue
    s, m = cluster_at(tl, 4)
    if s>=4 and m>=3: qualifies_set.add(w)

# For each non-qual window, compute new equity with fallback short
flipped_to_pass = 0
broken_pass = 0
new_pass_count = 0
real_pass_count = 0
for w in common:
    real_pass = p1[w]["passed"]
    if real_pass: real_pass_count += 1
    if w in qualifies_set or w not in [r["w"] for r in nq_windows]:
        new_pass = real_pass
    else:
        r = next(r for r in nq_windows if r["w"] == w)
        if best_predicate(r["feat"]):
            fb_pnl = simulate_short(r["switch_t"])
            if fb_pnl is not None:
                new_pnl = r["base_pnl"] + fb_pnl
                # Simple pass approx: pnl >= 0.10 AND base_pnl wasn't already breaching
                # If base already failed via DL, fallback can't save (engine ran out before switch_t for some)
                # But many fails happen AFTER switch_t in our scope (4h+). So fb might help.
                # Conservative: if base_pnl >= -0.05 (didn't breach yet) and total >= 0.10 → pass
                if r["base_pnl"] > -0.05 and new_pnl >= 0.10:
                    new_pass = True
                else:
                    new_pass = real_pass
            else:
                new_pass = real_pass
        else:
            new_pass = real_pass

    if new_pass: new_pass_count += 1
    if not real_pass and new_pass: flipped_to_pass += 1
    if real_pass and not new_pass: broken_pass += 1

print(f"Real pass:    {real_pass_count}/{len(common)} = {real_pass_count/len(common)*100:.2f}%")
print(f"New pass:     {new_pass_count}/{len(common)} = {new_pass_count/len(common)*100:.2f}%")
print(f"Flipped fail→pass: {flipped_to_pass}")
print(f"Broken pass→fail:  {broken_pass}")
print(f"Net gain:          {flipped_to_pass - broken_pass}")
