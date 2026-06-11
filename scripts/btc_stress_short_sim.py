#!/usr/bin/env python3
"""
2026-05-17 BTC stress-short Fallback Simulation (Codex Plan D hybrid).

Codex specs:
- After 4h from first AMBER entry, check breadth
- If no-breadth (b<4 OR maj<3): activate fallback
- Stop NEW AMBER entries, let existing run-off
- Open BTC short if:
  - btc_minus_basket_ret_48bars <= -0.01 (BTC underperforms by 1%+)
  - basket_ret_48bars <= +0.005 (basket flat-to-mild-up)
  - funding >= 0.000075 (longs paying)
  - OR fallback: only C-signal if btc_ret_48 <= -0.02
- stop 1.8%, tp 2.4%, hold 48 bars (24h), 1 concurrent max
- Risk 0.25-0.30

Goal: simulate this on existing P06 P1 trade-dumps. Add fallback short PnL
to non-qualifying windows and recompute pass rate.
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

print("[load] 19 asset 30m candle indexes...")
asset_candles = {}
for sym in ASSETS:
    path = f"scripts/cache_bakeoff/{sym}USDT_30m.json"
    if not Path(path).exists():
        continue
    data = json.load(open(path))
    by_time = {c["openTime"]: c for c in data}
    sorted_times = sorted(by_time.keys())
    asset_candles[sym] = {"by_time": by_time, "sorted": sorted_times}

# Funding loader
print("[load] BTC funding...")
btc_funding_path = "scripts/cache_bakeoff/BTCUSDT_funding.json"
btc_funding = []
if Path(btc_funding_path).exists():
    raw = json.load(open(btc_funding_path))
    # Funding format: {"t": ms, "r": rate} (project schema)
    if raw:
        for f in raw:
            try:
                btc_funding.append({"t": int(f["t"]), "r": float(f["r"])})
            except (KeyError, TypeError):
                pass
btc_funding.sort(key=lambda x: x["t"])
print(f"  {len(btc_funding)} funding records")

def get_funding_at(t_ms):
    """Get latest funding rate <= t_ms."""
    if not btc_funding: return None
    # Binary-ish search
    last = None
    for f in btc_funding:
        if f["t"] > t_ms: break
        last = f["r"]
    return last

def get_close_at(sym, t_ms):
    """Get the close of the bar containing t_ms."""
    if sym not in asset_candles: return None
    times = asset_candles[sym]["sorted"]
    bt = asset_candles[sym]["by_time"]
    # Find largest open_time <= t_ms
    last_t = None
    for t in times:
        if t > t_ms: break
        last_t = t
    if last_t is None: return None
    return bt[last_t]["close"]

def get_close_at_offset(sym, t_ms, bar_offset):
    """Close `bar_offset` bars before/after the bar containing t_ms."""
    if sym not in asset_candles: return None
    times = asset_candles[sym]["sorted"]
    bt = asset_candles[sym]["by_time"]
    last_idx = None
    for i, t in enumerate(times):
        if t > t_ms: break
        last_idx = i
    if last_idx is None: return None
    target = last_idx + bar_offset
    if target < 0 or target >= len(times): return None
    return bt[times[target]]["close"]

def get_close_path(sym, start_ms, bars):
    """Get OHLC for next `bars` bars starting at first bar >= start_ms."""
    if sym not in asset_candles: return []
    times = asset_candles[sym]["sorted"]
    bt = asset_candles[sym]["by_time"]
    start_idx = None
    for i, t in enumerate(times):
        if t >= start_ms:
            start_idx = i
            break
    if start_idx is None: return []
    return [bt[times[i]] for i in range(start_idx, min(start_idx + bars, len(times)))]

# Load existing data
def load(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["win_idx"]] = r
    return out

p1 = load(P1_WIN)
p2 = load(P2_WIN)
trades = defaultdict(list)
for line in TRADES.read_text().splitlines():
    if line.strip():
        r = json.loads(line)
        trades[r["winIdx"]].append(r)

def cluster_at_4h(trades_list):
    """Compute (breadth, majors) in first 4h after first entry."""
    if not trades_list: return 0, 0
    s = sorted(trades_list, key=lambda t: t["entryTime"])
    cutoff = s[0]["entryTime"] + 4*3600*1000
    syms, majs = set(), set()
    for t in s:
        if t["entryTime"] > cutoff: break
        syms.add(t["symbol"])
        for p in MAJORS:
            if t["symbol"].startswith(p[:-6]+"-") or t["symbol"] == p:
                majs.add(p); break
    return len(syms), len(majs)

def simulate_fallback_trade(switch_time_ms, risk_frac=0.3):
    """Simulate ONE BTC short triggered at switch_time_ms.
    Returns effective PnL contribution to equity (or None if no signal).
    """
    # Check Codex conditions at switch_time
    btc_now = get_close_at("BTC", switch_time_ms)
    btc_48ago = get_close_at_offset("BTC", switch_time_ms, -48)
    if btc_now is None or btc_48ago is None: return None
    btc_ret_48 = (btc_now / btc_48ago - 1)

    # Basket return
    basket_rets = []
    for sym in ASSETS:
        if sym == "BTC": continue
        c_now = get_close_at(sym, switch_time_ms)
        c_48 = get_close_at_offset(sym, switch_time_ms, -48)
        if c_now is None or c_48 is None: continue
        basket_rets.append(c_now / c_48 - 1)
    if not basket_rets: return None
    basket_ret_48 = sum(basket_rets) / len(basket_rets)
    btc_minus_basket = btc_ret_48 - basket_ret_48

    # Funding check
    funding = get_funding_at(switch_time_ms)

    # Codex's trigger conditions
    trigger_C = btc_minus_basket <= -0.01 and basket_ret_48 <= 0.005
    trigger_funding_confirm = funding is not None and funding >= 0.000075
    trigger_C_strong = btc_minus_basket <= -0.02  # fallback if no funding

    fire = trigger_C and (trigger_funding_confirm or funding is None and trigger_C_strong)
    if not fire: return None

    # Open BTC short at switch_time, hold for 48 bars or until stop/tp
    stop_pct = 0.018
    tp_pct = 0.024
    hold_bars = 48
    entry_price = btc_now
    path = get_close_path("BTC", switch_time_ms, hold_bars + 1)
    if not path: return None

    exit_price = None
    cost_bp = 30.0  # match AMBER cost
    for bar in path[1:]:
        # SHORT: stop if price >= entry*(1+stop), tp if price <= entry*(1-tp)
        if bar["high"] >= entry_price * (1 + stop_pct):
            exit_price = entry_price * (1 + stop_pct)
            break
        if bar["low"] <= entry_price * (1 - tp_pct):
            exit_price = entry_price * (1 - tp_pct)
            break
    if exit_price is None:
        exit_price = path[-1]["close"]

    raw_pnl_pct = (entry_price - exit_price) / entry_price  # short: profit when price down
    eff_pnl_pct = raw_pnl_pct - (cost_bp / 10000) * 2  # entry + exit cost
    # Apply risk_frac to scale
    eff_pnl_account = eff_pnl_pct * risk_frac
    return eff_pnl_account

# Simulate
common = sorted(set(p1) & set(p2) & set(trades.keys()))
print(f"\nProcessing {len(common)} windows...")

# Sim with and without fallback
results = []
fallback_active_count = 0
fallback_fired_count = 0

for w in common:
    tl = trades[w]
    if not tl: continue
    s = sorted(tl, key=lambda t: t["entryTime"])
    first_entry = s[0]["entryTime"]
    switch_time = first_entry + 4*3600*1000
    breadth, majors = cluster_at_4h(tl)
    qualifying = breadth >= 4 and majors >= 3
    if not qualifying:
        fallback_active_count += 1
        fb_pnl = simulate_fallback_trade(switch_time)
        if fb_pnl is not None:
            fallback_fired_count += 1
    else:
        fb_pnl = None

    # Recompute equity = original closed_trades pnl + fallback contribution
    base_pnl = sum(t["effPnl"] for t in tl)
    new_pnl = base_pnl + (fb_pnl if fb_pnl else 0)

    # Original pass (use real p1 field)
    real_pass = p1[w]["passed"]
    # Sim pass (simple: total >= 0.10, and no DL/TL approximation)
    # Approximate: if base_pnl was already breached, fallback might recover total.
    # But DL/TL is per-day — we can't fully reproduce. Use sum-only as proxy.
    new_pass_sum = new_pnl >= 0.10

    results.append({
        "win": w, "qual": qualifying, "real_pass": real_pass,
        "base_pnl": base_pnl, "fb_pnl": fb_pnl or 0,
        "new_pnl": new_pnl, "new_pass_sum": new_pass_sum
    })

print(f"\nFallback active (non-qualifying): {fallback_active_count}/{len(common)}")
print(f"Fallback fired (passed Codex triggers): {fallback_fired_count}/{fallback_active_count}")

# Compute pass stats
# Real
real_pass_all = sum(1 for r in results if r["real_pass"])
real_pass_nq = sum(1 for r in results if not r["qual"] and r["real_pass"])
print(f"\n=== Real Results (no fallback) ===")
print(f"All:          {real_pass_all}/{len(results)} = {real_pass_all/len(results)*100:.2f}%")
nq_all = sum(1 for r in results if not r["qual"])
print(f"Non-qual:     {real_pass_nq}/{nq_all} = {real_pass_nq/nq_all*100:.2f}%")

# Sim with fallback
sim_pass_all = sum(1 for r in results if r["new_pass_sum"])
sim_pass_nq = sum(1 for r in results if not r["qual"] and r["new_pass_sum"])
print(f"\n=== Sim Results (WITH BTC stress-short fallback) ===")
print(f"All:          {sim_pass_all}/{len(results)} = {sim_pass_all/len(results)*100:.2f}%")
print(f"Non-qual:     {sim_pass_nq}/{nq_all} = {sim_pass_nq/nq_all*100:.2f}%")

# Fallback contribution breakdown
fb_positive = sum(1 for r in results if r["fb_pnl"] > 0)
fb_negative = sum(1 for r in results if r["fb_pnl"] < 0)
fb_avg = sum(r["fb_pnl"] for r in results) / max(fallback_fired_count, 1)
print(f"\n=== Fallback Trade Stats ===")
print(f"Fired:    {fallback_fired_count}")
print(f"Winners:  {fb_positive}")
print(f"Losers:   {fb_negative}")
print(f"Avg PnL contribution: {fb_avg*100:.2f}%")

# Saving windows that flipped from fail → pass
flipped = sum(1 for r in results if not r["real_pass"] and r["new_pass_sum"])
broken = sum(1 for r in results if r["real_pass"] and not r["new_pass_sum"])
print(f"\nFlipped fail→pass: {flipped}")
print(f"Broken pass→fail: {broken}")
print(f"Net gain: {flipped - broken}")
