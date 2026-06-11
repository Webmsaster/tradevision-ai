#!/usr/bin/env python3
"""
2026-05-17 Deep dive: WARUM fail non-qualifying windows?
Wenn wir das pattern erkennen, können wir defensive sub-config bauen
die NUR in non-qualifying setups aktiviert.
"""
import json
from pathlib import Path
from collections import defaultdict, Counter

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
TRADES = ROOT / "trades_p06" / "p06_p1_trades.jsonl"
P1_WIN = ROOT / "trades_p06" / "p06_p1_windows.jsonl"
MAJORS = {"BTC-TREND", "ETH-TREND", "BNB-TREND", "SOL-TREND"}

def load(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["win_idx"]] = r
    return out

p1 = load(P1_WIN)
trades = defaultdict(list)
for line in TRADES.read_text().splitlines():
    if line.strip():
        r = json.loads(line)
        trades[r["winIdx"]].append(r)

def cluster_size(tl, h=24):
    if not tl: return 0, 0
    s = sorted(tl, key=lambda t: t["entryTime"])
    cutoff = s[0]["entryTime"] + h*3600*1000
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
    return len(syms), len(majs)

# Categorize windows
qualifying = []
non_qual = []
for w in p1:
    if w not in trades: continue
    b, m = cluster_size(trades[w], 24)
    if b >= 4 and m >= 3:
        qualifying.append(w)
    else:
        non_qual.append(w)

# Fail reason distribution
print(f"=== Fail-Reason Distribution ===")
print(f"{'Cohort':<14} {'Total':<8} {'Pass':<8} {'DailyLoss':<12} {'TotalLoss':<12} {'Time':<8} {'Other':<8}")
for label, ws in [("Qualifying", qualifying), ("Non-qual", non_qual)]:
    n = len(ws)
    passes = sum(1 for w in ws if p1[w]["passed"])
    fails = Counter()
    for w in ws:
        if not p1[w]["passed"]:
            r = p1[w].get("fail_reason", "Unknown") or "Unknown"
            r = r.split('(')[0].strip()  # drop debug detail
            fails[r] += 1
    dl = fails.get("DailyLoss", 0) + fails.get("DailyLossLimit", 0)
    tl = fails.get("TotalLoss", 0) + fails.get("TotalLossLimit", 0)
    tm = fails.get("Time", 0) + fails.get("TimeUp", 0) + fails.get("Days", 0)
    other = n - passes - dl - tl - tm
    print(f"{label:<14} {n:<8} {passes:<8} {dl:<12} {tl:<12} {tm:<8} {other:<8}")

# Per-day fail analysis (for non-qualifying)
print(f"\n=== Non-Qualifying P1 Fail Day Distribution ===")
day_dist = Counter()
for w in non_qual:
    if not p1[w]["passed"]:
        day_dist[p1[w]["final_day"]] += 1
for d in sorted(day_dist)[:15]:
    bar = "█" * int(day_dist[d] / 2)
    print(f"  Day {d:<3} {day_dist[d]:<4} {bar}")

# What's the first-day equity loss in failed non-qual windows?
print(f"\n=== First-Day Equity Trajectory (Non-Qual Failed) ===")
print(f"Looking at trades in first 24h of failed non-qualifying windows")
losing_clusters = []
for w in non_qual:
    if p1[w]["passed"]: continue
    if w not in trades: continue
    s = sorted(trades[w], key=lambda t: t["entryTime"])
    if not s: continue
    cutoff = s[0]["entryTime"] + 24*3600*1000
    first_day_trades = [t for t in s if t["entryTime"] <= cutoff]
    sum_pnl = sum(t["effPnl"] for t in first_day_trades)
    losing_clusters.append((w, len(first_day_trades), sum_pnl, p1[w].get("fail_reason")))

# Histogram by first-day PnL bucket
buckets = Counter()
for w, n_tr, pnl, _ in losing_clusters:
    if pnl < -0.05: buckets["<-5%"] += 1
    elif pnl < -0.02: buckets["-5 to -2%"] += 1
    elif pnl < 0: buckets["-2 to 0%"] += 1
    elif pnl < 0.02: buckets["0 to 2%"] += 1
    else: buckets[">+2%"] += 1
total = len(losing_clusters)
print(f"Total failed non-qual windows: {total}")
for k in ["<-5%", "-5 to -2%", "-2 to 0%", "0 to 2%", ">+2%"]:
    n = buckets.get(k, 0)
    pct = n / total * 100 if total else 0
    bar = "█" * int(pct / 2)
    print(f"  first-day PnL {k:<12} {n:<4} ({pct:5.1f}%) {bar}")

# Direction analysis: do non-qual windows trade against trend?
print(f"\n=== Trade Direction Skew (Failed Non-Qual, First Day) ===")
long_trades = 0
short_trades = 0
long_loss = 0
short_loss = 0
long_pnl = 0.0
short_pnl = 0.0
for w in non_qual:
    if p1[w]["passed"]: continue
    if w not in trades: continue
    s = sorted(trades[w], key=lambda t: t["entryTime"])
    if not s: continue
    cutoff = s[0]["entryTime"] + 24*3600*1000
    for t in s:
        if t["entryTime"] > cutoff: break
        if t["direction"] == "long":
            long_trades += 1
            long_pnl += t["effPnl"]
            if t["effPnl"] < 0: long_loss += 1
        else:
            short_trades += 1
            short_pnl += t["effPnl"]
            if t["effPnl"] < 0: short_loss += 1
print(f"  Longs:  {long_trades} trades, {long_loss} losses ({long_loss/max(long_trades,1)*100:.1f}% loss-rate), total PnL {long_pnl:+.2f}")
print(f"  Shorts: {short_trades} trades, {short_loss} losses ({short_loss/max(short_trades,1)*100:.1f}% loss-rate), total PnL {short_pnl:+.2f}")

# Same for qualifying winners
print(f"\n=== Trade Direction Skew (PASSED Qualifying, First Day - reference) ===")
long_trades_q = 0
short_trades_q = 0
long_pnl_q = 0.0
short_pnl_q = 0.0
for w in qualifying:
    if not p1[w]["passed"]: continue
    if w not in trades: continue
    s = sorted(trades[w], key=lambda t: t["entryTime"])
    if not s: continue
    cutoff = s[0]["entryTime"] + 24*3600*1000
    for t in s:
        if t["entryTime"] > cutoff: break
        if t["direction"] == "long":
            long_trades_q += 1
            long_pnl_q += t["effPnl"]
        else:
            short_trades_q += 1
            short_pnl_q += t["effPnl"]
print(f"  Longs:  {long_trades_q} trades, total PnL {long_pnl_q:+.2f}, avg {long_pnl_q/max(long_trades_q,1):+.4f}")
print(f"  Shorts: {short_trades_q} trades, total PnL {short_pnl_q:+.2f}, avg {short_pnl_q/max(short_trades_q,1):+.4f}")
