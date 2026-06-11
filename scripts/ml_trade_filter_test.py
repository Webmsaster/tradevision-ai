#!/usr/bin/env /usr/bin/python3
"""
2026-05-18 Last ML attempt: train logistic regression on trade features
to predict winner/loser, filter losers, recompute pass-rate.

STRICT no-lookahead: features are PRE-trade only (entry time, symbol,
direction, preceding BTC return). Target is post-trade outcome.

Out-of-sample split: train on first 2/3 of windows (chronological),
test on last 1/3.
"""
import json
import sys
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
TRADES = ROOT / "trades_p06" / "p06_p1_trades.jsonl"
P1_WIN = ROOT / "trades_p06" / "p06_p1_windows.jsonl"
P2_WIN = ROOT / "per_window" / "p06_ptp_8pct_25_p2.jsonl"

print("[load] data...")
p1 = {}
p2 = {}
for line in Path(P1_WIN).read_text().splitlines():
    if line.strip(): r = json.loads(line); p1[r["win_idx"]] = r
for line in Path(P2_WIN).read_text().splitlines():
    if line.strip(): r = json.loads(line); p2[r["win_idx"]] = r

trades = defaultdict(list)
for line in Path(TRADES).read_text().splitlines():
    if line.strip(): r = json.loads(line); trades[r["winIdx"]].append(r)

# Load BTC for preceding-return features
btc = json.load(open("scripts/cache_bakeoff/BTCUSDT_30m.json"))
btc_by_t = {c["openTime"]: c for c in btc}
btc_times = sorted(btc_by_t.keys())

def btc_return_before(t_ms, hours):
    """Return % over `hours` ending strictly before t_ms (no-lookahead)."""
    bars = hours * 60 // 30
    # Find largest open_time < t_ms
    last_idx = None
    for i, t in enumerate(btc_times):
        if t >= t_ms: break
        last_idx = i
    if last_idx is None or last_idx < bars: return 0.0
    c_now = btc_by_t[btc_times[last_idx]]["close"]
    c_back = btc_by_t[btc_times[last_idx - bars]]["close"]
    return (c_now / c_back - 1) * 100

# Build feature matrix per trade
print("[features] computing per-trade features...")
SYMBOLS = ["AAVE", "ADA", "ALGO", "ARB", "ATOM", "AVAX", "BCH", "BNB", "BTC",
           "DOT", "ETC", "ETH", "LINK", "LTC", "NEAR", "SOL", "TRX", "UNI", "XRP"]
sym_to_idx = {s: i for i, s in enumerate(SYMBOLS)}

X_rows = []
y = []
trade_meta = []  # (win_idx, trade_idx_in_win, eff_pnl, win_time_ms)

common = sorted(set(p1) & set(p2) & set(trades.keys()))
for w in common:
    w_trades = sorted(trades[w], key=lambda t: t["entryTime"])
    for ti, t in enumerate(w_trades):
        entry_ms = t["entryTime"]
        dt = datetime.fromtimestamp(entry_ms / 1000, tz=timezone.utc)
        sym_base = t["symbol"].split("-")[0]
        sym_idx = sym_to_idx.get(sym_base, -1)

        # Features (PRE-trade strict)
        features = [
            dt.weekday(),                 # day of week
            dt.hour,                      # hour
            dt.month,                     # month
            t["entryDay"],                # day in challenge
            sym_idx,                      # which symbol
            1 if t["direction"] == "long" else 0,  # direction
            btc_return_before(entry_ms, 24),       # BTC 24h
            btc_return_before(entry_ms, 4),        # BTC 4h
            btc_return_before(entry_ms, 1),        # BTC 1h
            t["entryPrice"],              # entry price (rough magnitude)
        ]
        X_rows.append(features)
        y.append(1 if t["effPnl"] > 0 else 0)
        trade_meta.append((w, ti, t["effPnl"], entry_ms))

X = np.array(X_rows, dtype=float)
y = np.array(y)
print(f"  Trades: {len(X)}, features: {X.shape[1]}, win-rate: {y.mean()*100:.2f}%")

# Chronological train/test split by window
common_sorted_by_time = sorted(common, key=lambda w: min(t["entryTime"] for t in trades[w]))
n_train_wins = int(len(common_sorted_by_time) * 2 / 3)
train_wins = set(common_sorted_by_time[:n_train_wins])
test_wins = set(common_sorted_by_time[n_train_wins:])

train_mask = np.array([m[0] in train_wins for m in trade_meta])
test_mask = np.array([m[0] in test_wins for m in trade_meta])

print(f"\nTrain trades: {train_mask.sum()}, Test trades: {test_mask.sum()}")
print(f"Train windows: {len(train_wins)}, Test windows: {len(test_wins)}")

# Scale + train
scaler = StandardScaler()
X_train = scaler.fit_transform(X[train_mask])
X_test = scaler.transform(X[test_mask])

model = LogisticRegression(C=1.0, max_iter=500)
model.fit(X_train, y[train_mask])

train_acc = model.score(X_train, y[train_mask]) * 100
test_acc = model.score(X_test, y[test_mask]) * 100
print(f"\nTrain accuracy: {train_acc:.2f}%")
print(f"Test accuracy:  {test_acc:.2f}%")
print(f"Baseline (predict all win): {y[test_mask].mean()*100:.2f}%")

# Per-trade probability of winning
probs_test = model.predict_proba(X_test)[:, 1]
print(f"\nProb-of-win distribution (test set):")
for pct in [10, 25, 50, 75, 90]:
    print(f"  P{pct}: {np.percentile(probs_test, pct):.3f}")

# Now: filter trades — keep only those with prob >= threshold
# Recompute pass rate per window
print(f"\n=== Pass-Rate with ML-Filter (test windows only, n={len(test_wins)}) ===")
print(f"{'Threshold':<12} {'KeepRate':<10} {'WinRate':<10} {'P1 pass':<10} {'AND pass':<10}")

test_meta = [m for i, m in enumerate(trade_meta) if test_mask[i]]
test_probs = probs_test

for thresh in [0.0, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85]:
    # Group trades by window
    per_win_kept = defaultdict(list)
    for (w, ti, eff_pnl, _), prob in zip(test_meta, test_probs):
        if prob >= thresh:
            per_win_kept[w].append(eff_pnl)
    # Simulate pass per window
    p1_pass_count = 0
    p2_pass_count = 0
    and_pass_count = 0
    for w in test_wins:
        kept = per_win_kept.get(w, [])
        # Simple sim: sum eff_pnl. If >= 0.10 → P1 pass (approximate, ignores DL/TL granularity)
        # Use a rough DL/TL approximation
        eq = 0.0
        min_eq = 0.0
        sim_breach = False
        for p in kept:
            eq += p
            min_eq = min(min_eq, eq)
            if eq <= -0.05: sim_breach = True; break  # very rough DL
        if sim_breach or min_eq <= -0.10:
            sim_p1 = False
        else:
            sim_p1 = eq >= 0.10
        # P2 unchanged (separate sweep needed for full, but use real for ref)
        real_p2 = p2[w]["passed"]
        if sim_p1:
            p1_pass_count += 1
        if sim_p1 and real_p2:
            and_pass_count += 1
    kept_trades = sum(1 for p in test_probs if p >= thresh)
    keep_rate = kept_trades / len(test_probs) * 100
    win_rate = sum(1 for i, p in enumerate(test_probs) if p >= thresh and y[test_mask][i] == 1) / max(kept_trades, 1) * 100
    print(f"  >={thresh:<8.2f} {keep_rate:5.2f}%   {win_rate:5.2f}%   "
          f"{p1_pass_count/len(test_wins)*100:6.2f}%   {and_pass_count/len(test_wins)*100:6.2f}%")

# Also: what's the baseline P1 pass rate on test windows (real)?
real_test_p1 = sum(1 for w in test_wins if p1[w]["passed"]) / len(test_wins) * 100
real_test_p2 = sum(1 for w in test_wins if p2[w]["passed"]) / len(test_wins) * 100
real_test_and = sum(1 for w in test_wins if p1[w]["passed"] and p2[w]["passed"]) / len(test_wins) * 100
print(f"\n=== Real baseline (test windows, no filter) ===")
print(f"  Real P1: {real_test_p1:.2f}%")
print(f"  Real P2: {real_test_p2:.2f}%")
print(f"  Real AND: {real_test_and:.2f}%")
