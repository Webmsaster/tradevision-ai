#!/usr/bin/env python3
"""
2026-05-17 Codex Hebel #1: Breadth-Quality.
Not just "first cluster >= N assets", but check QUALITY:
- at least M majors (BTC/ETH/BNB/SOL) in cluster
- no "fragile-only" clusters (LINK/NEAR/ARB/ALGO majority)

Tests breadth + major-content as compound gate.
"""
import json
from pathlib import Path
from collections import defaultdict

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
TRADES = ROOT / "trades_p06" / "p06_p1_trades.jsonl"
P1_WIN = ROOT / "trades_p06" / "p06_p1_windows.jsonl"
P2_WIN = ROOT / "per_window" / "p06_ptp_8pct_25_p2.jsonl"

MAJORS = {"BTC-TREND", "ETH-TREND", "BNB-TREND", "SOL-TREND"}
FRAGILE = {"LINK-TREND", "NEAR-TREND", "ARB-TREND", "ALGO-TREND", "UNI-TREND"}

def load(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["win_idx"]] = bool(r.get("passed", False))
    return out

p1 = load(P1_WIN)
p2 = load(P2_WIN)
trades = defaultdict(list)
for line in TRADES.read_text().splitlines():
    if line.strip():
        r = json.loads(line)
        trades[r["winIdx"]].append(r)

def first_cluster_symbols(trades_list, window_hours=24):
    if not trades_list:
        return set()
    s = sorted(trades_list, key=lambda t: t["entryTime"])
    cutoff = s[0]["entryTime"] + window_hours * 3600 * 1000
    return {t["symbol"] for t in s if t["entryTime"] <= cutoff}

common = sorted(set(p1) & set(p2) & set(trades.keys()))
print(f"Common windows: {len(common)}\n")

def eval_gate(predicate, label):
    kept = [w for w in common if predicate(first_cluster_symbols(trades[w]))]
    if not kept:
        return None
    n = len(kept)
    p1_p = sum(1 for k in kept if p1[k]) / n * 100
    p2_p = sum(1 for k in kept if p2[k]) / n * 100
    and_p = sum(1 for k in kept if p1[k] and p2[k]) / n * 100
    return (label, n, p1_p, p2_p, and_p)

results = []

# Baseline: pure breadth (codex original)
print("=== Pure Breadth (baseline) ===")
print(f"{'Gate':<40} {'Kept':<10} {'P1%':<8} {'P2%':<8} {'AND%':<8}")
for b in [4, 5, 6, 7]:
    r = eval_gate(lambda s, b=b: len(s) >= b, f"breadth>={b}")
    if r:
        print(f"{r[0]:<40} {r[1]}/{len(common):<8} {r[2]:5.2f}%  {r[3]:5.2f}%  {r[4]:5.2f}%")
        results.append(r)

# +Majors content
print("\n=== Breadth + Min Majors (BTC/ETH/BNB/SOL) ===")
print(f"{'Gate':<40} {'Kept':<10} {'P1%':<8} {'P2%':<8} {'AND%':<8}")
for b in [4, 5, 6, 7]:
    for m in [1, 2, 3]:
        if m > b:
            continue
        r = eval_gate(
            lambda s, b=b, m=m: len(s) >= b and len(s & MAJORS) >= m,
            f"breadth>={b} & majors>={m}"
        )
        if r:
            print(f"{r[0]:<40} {r[1]}/{len(common):<8} {r[2]:5.2f}%  {r[3]:5.2f}%  {r[4]:5.2f}%")
            results.append(r)

# +No fragile-majority
print("\n=== Breadth + No-Fragile-Majority (fragile<50%) ===")
print(f"{'Gate':<40} {'Kept':<10} {'P1%':<8} {'P2%':<8} {'AND%':<8}")
for b in [4, 5, 6, 7]:
    r = eval_gate(
        lambda s, b=b: len(s) >= b and len(s & FRAGILE) < len(s) * 0.5,
        f"breadth>={b} & fragile<50%"
    )
    if r:
        print(f"{r[0]:<40} {r[1]}/{len(common):<8} {r[2]:5.2f}%  {r[3]:5.2f}%  {r[4]:5.2f}%")
        results.append(r)

# Compound: breadth + majors + no-fragile
print("\n=== Compound (Breadth + Majors + No-Fragile) ===")
print(f"{'Gate':<40} {'Kept':<10} {'P1%':<8} {'P2%':<8} {'AND%':<8}")
for b in [4, 5, 6]:
    for m in [1, 2]:
        r = eval_gate(
            lambda s, b=b, m=m: (
                len(s) >= b
                and len(s & MAJORS) >= m
                and len(s & FRAGILE) < len(s) * 0.5
            ),
            f"b>={b} & maj>={m} & frag<50%"
        )
        if r:
            print(f"{r[0]:<40} {r[1]}/{len(common):<8} {r[2]:5.2f}%  {r[3]:5.2f}%  {r[4]:5.2f}%")
            results.append(r)

# Top results
print("\n=== Top-10 by AND%, kept >= 100 (production-usable retention) ===")
top = sorted([r for r in results if r[1] >= 100], key=lambda r: -r[4])
for r in top[:10]:
    print(f"  {r[4]:5.2f}%  {r[0]:<40} kept={r[1]}/{len(common)} P1={r[2]:.1f} P2={r[3]:.1f}")
