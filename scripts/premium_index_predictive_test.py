#!/usr/bin/env python3
"""
2026-05-17 Pre-Engine Validation: Is Binance Premium-Index prädiktiv für
BTC future-returns? Codex specified: thresholds -2.5 to -30 bps, persistence
1-3 bars, z-score -0.5 to -2.0, future returns at 1/2/4/8/16/24 bars.
"""
import json
from pathlib import Path
from statistics import mean, stdev

PREMIUM = Path("scripts/cache_bakeoff/BTCUSDT_premium_30m.json")
BTC = Path("scripts/cache_bakeoff/BTCUSDT_30m.json")

print("[load]")
prem = json.load(open(PREMIUM))
btc = json.load(open(BTC))
btc_by_t = {c["openTime"]: c for c in btc}

# Align: premium and btc shouldn't have same exact timestamps
# Premium openTime = start of interval. BTC openTime = start of interval.
prem_by_t = {p["t"]: p for p in prem}
common_times = sorted(set(prem_by_t) & set(btc_by_t))
print(f"  Premium bars: {len(prem)}")
print(f"  BTC bars: {len(btc)}")
print(f"  Common timestamps: {len(common_times)}")

# Build aligned arrays
data = []
for t in common_times:
    p = prem_by_t[t]
    b = btc_by_t[t]
    data.append({
        "t": t,
        "premium_close": p["close"],
        "premium_close_bps": p["close"] * 10000,  # convert pct to bps
        "btc_close": b["close"],
    })

# Compute future-returns per bar
for i, row in enumerate(data):
    for horizon in [1, 2, 4, 8, 16, 24]:
        if i + horizon < len(data):
            future_close = data[i + horizon]["btc_close"]
            row[f"ret_{horizon}b"] = (future_close - row["btc_close"]) / row["btc_close"] * 100  # %
        else:
            row[f"ret_{horizon}b"] = None

print(f"\n=== Premium Index Distribution (bps) ===")
prems_bps = sorted(r["premium_close_bps"] for r in data)
n = len(prems_bps)
for pct in [1, 5, 10, 25, 50, 75, 90, 95, 99]:
    print(f"  P{pct:>2}: {prems_bps[int(n*pct/100)]:+.2f} bps")
print(f"  Min: {min(prems_bps):+.2f}, Max: {max(prems_bps):+.2f}")

# Compute z-score (rolling 96 = 48h)
window = 96
for i in range(len(data)):
    lo = max(0, i - window + 1)
    sub = [r["premium_close_bps"] for r in data[lo:i+1]]
    if len(sub) < 10:
        data[i]["z"] = 0
        continue
    m = mean(sub)
    s = stdev(sub) if len(sub) > 1 else 1
    data[i]["z"] = (data[i]["premium_close_bps"] - m) / s if s > 0 else 0

print(f"\n=== Predictive Power (premium <= threshold → future BTC return mean) ===")
print(f"{'Trigger':<25} {'Fires':<8} {'1b mean':<10} {'4b mean':<10} {'16b mean':<10}")
print("-" * 70)

for thresh_bps in [-2.5, -5, -7.5, -10, -15, -20, -30]:
    fires = [r for r in data if r["premium_close_bps"] <= thresh_bps]
    if not fires: continue
    n_fires = len(fires)
    avg_1b = mean([r["ret_1b"] for r in fires if r.get("ret_1b") is not None])
    avg_4b = mean([r["ret_4b"] for r in fires if r.get("ret_4b") is not None])
    avg_16b = mean([r["ret_16b"] for r in fires if r.get("ret_16b") is not None])
    print(f"  prem<={thresh_bps:<8.1f}bps      {n_fires}/{len(data)}  {avg_1b:+7.3f}%   {avg_4b:+7.3f}%   {avg_16b:+7.3f}%")

print(f"\n=== Z-Score Trigger (premium z <= threshold) ===")
print(f"{'Trigger':<25} {'Fires':<8} {'1b mean':<10} {'4b mean':<10} {'16b mean':<10}")
print("-" * 70)

for z_thresh in [-0.5, -1.0, -1.5, -2.0]:
    fires = [r for r in data if r["z"] <= z_thresh]
    if not fires: continue
    n_fires = len(fires)
    avg_1b = mean([r["ret_1b"] for r in fires if r.get("ret_1b") is not None])
    avg_4b = mean([r["ret_4b"] for r in fires if r.get("ret_4b") is not None])
    avg_16b = mean([r["ret_16b"] for r in fires if r.get("ret_16b") is not None])
    print(f"  z<={z_thresh:<8.1f}              {n_fires}/{len(data)}  {avg_1b:+7.3f}%   {avg_4b:+7.3f}%   {avg_16b:+7.3f}%")

# Walk-forward by year
print(f"\n=== Walk-Forward Stability (per year) ===")
print(f"Trigger: prem<=-10 bps")
print(f"{'Year':<8} {'Fires':<8} {'1b':<10} {'4b':<10} {'16b':<10}")
from datetime import datetime
for year in [2024, 2025, 2026]:
    year_data = [r for r in data
                 if datetime.fromtimestamp(r["t"]/1000).year == year]
    year_fires = [r for r in year_data if r["premium_close_bps"] <= -10]
    if not year_fires: continue
    avg_1b = mean([r["ret_1b"] for r in year_fires if r.get("ret_1b") is not None])
    avg_4b = mean([r["ret_4b"] for r in year_fires if r.get("ret_4b") is not None])
    avg_16b = mean([r["ret_16b"] for r in year_fires if r.get("ret_16b") is not None])
    print(f"  {year:<6} {len(year_fires):<7} {avg_1b:+7.3f}%   {avg_4b:+7.3f}%   {avg_16b:+7.3f}%")
