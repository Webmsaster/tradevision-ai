#!/usr/bin/env python3
"""
2026-05-17 NEW INSIGHT: Bot is long-only. Non-qual = bearish setups → all longs fail.
Test: Risk-Ramp PER COHORT (qualifying vs non-qual SEPARATELY).
Maybe ramp HURTS qualifying but HELPS non-qualifying — net positive on unconditional.
"""
import json
from pathlib import Path
from collections import defaultdict

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
TRADES = ROOT / "trades_p06" / "p06_p1_trades.jsonl"
P1_WIN = ROOT / "trades_p06" / "p06_p1_windows.jsonl"
P2_WIN = ROOT / "per_window" / "p06_ptp_8pct_25_p2.jsonl"
MAJORS = {"BTC-TREND", "ETH-TREND", "BNB-TREND", "SOL-TREND"}

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

def cluster_features(tl, h=24):
    if not tl: return 0, 0
    s = sorted(tl, key=lambda t: t["entryTime"])
    cutoff = s[0]["entryTime"] + h*3600*1000
    syms = set()
    majs = set()
    for t in s:
        if t["entryTime"] > cutoff: break
        syms.add(t["symbol"])
        for p in MAJORS:
            if t["symbol"].startswith(p[:-6] + "-") or t["symbol"] == p:
                majs.add(p); break
    return len(syms), len(majs)

def sim_window(tl, factor_first_day=1.0, factor_rest=1.0):
    """Simulate equity with optional risk reduction.
    factor_first_day: applied to trades in entryDay 1
    factor_rest: applied to later trades
    Pass = sum eff_pnl >= 0.10, no daily breach -0.05, no -0.10 total.
    """
    if not tl: return False
    s = sorted(tl, key=lambda t: t["entryTime"])
    first_day = s[0]["entryDay"]
    eq = 0.0
    min_eq = 0.0
    day_eq = {}
    for t in s:
        d = t["entryDay"]
        if d not in day_eq: day_eq[d] = eq
        f = factor_first_day if d == first_day else factor_rest
        eq += t["effPnl"] * f
        min_eq = min(min_eq, eq)
        if eq - day_eq[d] <= -0.05:
            return False
    if min_eq <= -0.10:
        return False
    return eq >= 0.10

# Categorize
common = sorted(set(p1) & set(p2) & set(trades.keys()))
qual_set = set()
for w in common:
    b, m = cluster_features(trades[w], 24)
    if b >= 4 and m >= 3:
        qual_set.add(w)
non_qual = [w for w in common if w not in qual_set]
qual = list(qual_set)

print(f"Qualifying: {len(qual)} | Non-qualifying: {len(non_qual)} | Total: {len(common)}")

# Real P1 baseline
real_qual_p1 = sum(1 for w in qual if p1[w]["passed"])
real_nq_p1 = sum(1 for w in non_qual if p1[w]["passed"])
print(f"\nReal P1 (no sim): qual={real_qual_p1}/{len(qual)} ({real_qual_p1/len(qual)*100:.1f}%) "
      f"non-qual={real_nq_p1}/{len(non_qual)} ({real_nq_p1/len(non_qual)*100:.1f}%)")

# Real AND
real_qual_and = sum(1 for w in qual if p1[w]["passed"] and p2[w]["passed"])
real_nq_and = sum(1 for w in non_qual if p1[w]["passed"] and p2[w]["passed"])
print(f"Real AND: qual={real_qual_and}/{len(qual)} ({real_qual_and/len(qual)*100:.1f}%) "
      f"non-qual={real_nq_and}/{len(non_qual)} ({real_nq_and/len(non_qual)*100:.1f}%)")
print(f"Unconditional baseline AND: {(real_qual_and+real_nq_and)/len(common)*100:.2f}%")

# Sim baseline
sim_qual = sum(1 for w in qual if sim_window(trades[w]))
sim_nq = sum(1 for w in non_qual if sim_window(trades[w]))
print(f"\nSim P1 baseline: qual={sim_qual}/{len(qual)} ({sim_qual/len(qual)*100:.1f}%) "
      f"non-qual={sim_nq}/{len(non_qual)} ({sim_nq/len(non_qual)*100:.1f}%)")
sim_qual_and = sum(1 for w in qual if sim_window(trades[w]) and p2[w]["passed"])
sim_nq_and = sum(1 for w in non_qual if sim_window(trades[w]) and p2[w]["passed"])
sim_uncond = (sim_qual_and + sim_nq_and) / len(common) * 100
print(f"Sim AND: qual={sim_qual_and} non-qual={sim_nq_and} → unconditional {sim_uncond:.2f}%")

print(f"\n=== Conditional Ramp Sweep (per-cohort breakdown) ===")
print(f"{'FirstDay':<10} {'Rest':<8} {'Q P1%':<8} {'NQ P1%':<8} {'Q AND':<8} {'NQ AND':<8} {'Total AND%':<12}")
print("-" * 80)
for f1 in [1.0, 0.8, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]:
    for fr in [1.0]:
        q_p1 = sum(1 for w in qual if sim_window(trades[w], f1, fr))
        nq_p1 = sum(1 for w in non_qual if sim_window(trades[w], f1, fr))
        q_and = sum(1 for w in qual if sim_window(trades[w], f1, fr) and p2[w]["passed"])
        nq_and = sum(1 for w in non_qual if sim_window(trades[w], f1, fr) and p2[w]["passed"])
        total = (q_and + nq_and) / len(common) * 100
        print(f"  {f1:<8} {fr:<6} {q_p1/len(qual)*100:5.2f}%  {nq_p1/len(non_qual)*100:5.2f}%  "
              f"{q_and/len(qual)*100:5.2f}%  {nq_and/len(non_qual)*100:5.2f}%  {total:6.2f}%")

# Best per total
print(f"\n=== Best UNCONDITIONAL Total AND (sim) ===")
best = []
for f1 in [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05, 0.0]:
    for fr in [1.0, 0.8, 0.6, 0.4, 0.2]:
        q_and = sum(1 for w in qual if sim_window(trades[w], f1, fr) and p2[w]["passed"])
        nq_and = sum(1 for w in non_qual if sim_window(trades[w], f1, fr) and p2[w]["passed"])
        total = (q_and + nq_and) / len(common) * 100
        best.append((total, f1, fr, q_and, nq_and))
best.sort(reverse=True)
for total, f1, fr, qa, nqa in best[:10]:
    print(f"  Total {total:5.2f}%  fday={f1:<5} rest={fr:<5} qA={qa}/{len(qual)} nqA={nqa}/{len(non_qual)}")
