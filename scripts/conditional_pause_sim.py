#!/usr/bin/env python3
"""
2026-05-17 NEW IDEA: Conditional Risk-Pause auf non-qualifying Windows.
Bot kauft Challenge IMMER (user-mandate: blind buy).
Nach 24h check: wenn breadth >= threshold → continue normal.
Wenn breadth < threshold → REDUCE/PAUSE trading.

Ziel: 90% UNCONDITIONAL passrate auf alle 324 windows.
"""
import json
from pathlib import Path
from collections import defaultdict

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
TRADES_P1 = ROOT / "trades_p06" / "p06_p1_trades.jsonl"
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
for line in TRADES_P1.read_text().splitlines():
    if line.strip():
        r = json.loads(line)
        trades[r["winIdx"]].append(r)

def cluster_check_24h(trades_list, min_breadth, min_majors):
    if not trades_list:
        return False
    s = sorted(trades_list, key=lambda t: t["entryTime"])
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
    return len(syms) >= min_breadth and len(majs) >= min_majors

def sim_conditional_pause(trades_list, qualified, pause_factor):
    """If qualified: trades run with eff_pnl as-is.
    If NOT qualified: trades AFTER 24h-mark have eff_pnl * pause_factor.
    Pass = sum(eff_pnl) >= 0.10 AND no day breach <= -0.05 AND no -0.10 total.
    """
    if not trades_list:
        return False
    s = sorted(trades_list, key=lambda t: t["entryTime"])
    first = s[0]["entryTime"]
    cutoff = first + 24*3600*1000
    eq = 0.0
    min_eq = 0.0
    day_eq = {}
    for t in s:
        d = t["entryDay"]
        if d not in day_eq:
            day_eq[d] = eq
        factor = 1.0 if (qualified or t["entryTime"] <= cutoff) else pause_factor
        eq += t["effPnl"] * factor
        min_eq = min(min_eq, eq)
        if eq - day_eq[d] <= -0.05:
            return False
    if min_eq <= -0.10:
        return False
    return eq >= 0.10

common = sorted(set(p1) & set(p2) & set(trades.keys()))
n = len(common)

print(f"=== Conditional Risk-Pause Simulation (P1 phase, n={n}) ===")
print(f"{'Gate':<22} {'PauseFactor':<14} {'SimP1%':<10} {'SimAND%':<10}")
print("-" * 65)

for b, m in [(4, 3), (5, 3), (6, 2), (7, 3)]:
    qual_map = {w: cluster_check_24h(trades[w], b, m) for w in common}
    for pf in [1.0, 0.5, 0.3, 0.1, 0.0]:
        sim_p1 = sum(1 for w in common if sim_conditional_pause(trades[w], qual_map[w], pf))
        sim_both = sum(
            1 for w in common
            if sim_conditional_pause(trades[w], qual_map[w], pf) and p2[w]["passed"]
        )
        print(f"b>={b} & m>={m:<7}  factor={pf:<6}  "
              f"{sim_p1/n*100:6.2f}%   {sim_both/n*100:6.2f}%")
    print()

# Best combos
print("\n=== Best UNCONDITIONAL Funded-Prob over all windows ===")
print(f"Baseline (no gate): 54.63% AND")
best = []
for b, m in [(3, 2), (4, 2), (4, 3), (5, 2), (5, 3), (6, 2), (7, 3)]:
    qual_map = {w: cluster_check_24h(trades[w], b, m) for w in common}
    for pf in [0.0, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0]:
        sim_both = sum(
            1 for w in common
            if sim_conditional_pause(trades[w], qual_map[w], pf) and p2[w]["passed"]
        )
        best.append((sim_both/n*100, f"b>={b} m>={m} pf={pf}"))
best.sort(reverse=True)
for andp, label in best[:15]:
    print(f"  {andp:5.2f}%  {label}")
