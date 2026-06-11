#!/usr/bin/env python3
"""
2026-05-17 BTC stress-short v3 — FULL replace simulation.
Per Codex: "no new AMBER entries after switch, fallback REPLACES route."
This is the proper test: drop AMBER trades with entryTime > switch_t,
add fallback short PnL, see new outcome.
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
    return {"btc": btc_ret, "basket": basket_ret,
            "diff": btc_ret - basket_ret,
            "funding": get_funding_at(switch_t)}

common = sorted(set(p1) & set(p2) & set(trades.keys()))

def sim_with_fallback(trigger_pred, label, switch_horizon_hours=4, risk_frac=0.30,
                     stop=0.018, tp=0.024, hold=48):
    """Full sim: per non-qual window, drop AMBER trades after switch, add fallback PnL.
    Pass = total >= 0.10 (proxy; ignores DL/TL granularity)."""
    real_pass = 0
    new_pass = 0
    flipped = 0
    broken = 0
    fires = 0
    for w in common:
        tl = trades[w]
        if not tl: continue
        if p1[w]["passed"]: real_pass += 1
        syms, majs = cluster_at(tl, switch_horizon_hours)
        if syms >= 4 and majs >= 3:
            # qualifying: keep AMBER as-is
            if p1[w]["passed"]: new_pass += 1
            continue
        s = sorted(tl, key=lambda t: t["entryTime"])
        switch_t = s[0]["entryTime"] + switch_horizon_hours*3600*1000
        feat = features_at(switch_t)
        if feat is None or not trigger_pred(feat):
            # No fallback fire: keep AMBER
            if p1[w]["passed"]: new_pass += 1
            continue
        fires += 1
        # AMBER trades entered BEFORE switch run-off naturally
        # AMBER trades entered AFTER switch are blocked
        keep_pnl = sum(t["effPnl"] for t in tl if t["entryTime"] <= switch_t)
        # Plus fallback short
        fb_pnl = simulate_short(switch_t, stop, tp, hold, risk_frac)
        if fb_pnl is None:
            if p1[w]["passed"]: new_pass += 1
            continue
        new_total = keep_pnl + fb_pnl
        # Pass approximation: new_total >= 0.10
        new_p = new_total >= 0.10
        if new_p: new_pass += 1
        # Compare
        if not p1[w]["passed"] and new_p: flipped += 1
        if p1[w]["passed"] and not new_p: broken += 1

    n = len(common)
    print(f"{label}")
    print(f"  Fires: {fires}, Real: {real_pass}/{n}={real_pass/n*100:.2f}%, "
          f"New: {new_pass}/{n}={new_pass/n*100:.2f}%, "
          f"Flipped+: {flipped}, Broken-: {broken}, Net: {flipped-broken:+d}\n")
    return new_pass / n * 100

print("=== Full-Replace Simulation (drop AMBER after switch + add fallback) ===\n")

# Variant sweep
variants = [
    ("Codex Plan D ORIG", lambda f: f["diff"]<=-0.01 and f["basket"]<=0.005 and (f["funding"] or 0)>=0.000075),
    ("Looser btc-basket<=-0.005", lambda f: f["diff"]<=-0.005),
    ("Pure C-strong btc-basket<=-0.02", lambda f: f["diff"]<=-0.02),
    ("BTC-down<=-0.02", lambda f: f["btc"]<=-0.02),
    ("BTC-down<=-0.01 + funding>=0.0001", lambda f: f["btc"]<=-0.01 and (f["funding"] or 0)>=0.0001),
    ("Hybrid (diff<=-0.01 OR btc<=-0.02)", lambda f: f["diff"]<=-0.01 or f["btc"]<=-0.02),
    ("Wide+conservative basket<=0", lambda f: f["basket"]<=0),
    ("Permissive ALL fires", lambda f: True),
]

for label, pred in variants:
    sim_with_fallback(pred, label)
