#!/usr/bin/env python3
"""
2026-05-17 Codex Hebel #5: Early Damage Control + Risk-Ramp.
Simulate on P06 trade-dump:
- Risk-Ramp: Tag 0-1 at risk_init (0.6-0.8x), after eq>=ramp_threshold full size
- Damage Control: if day-eq <= -damage_drop, skip remaining same-day entries

P1-Fails laut Codex sind 84 DailyLoss + 63 TotalLoss, fast alle bis Tag 5.
→ Ansatz richtig: erste Tage konservativer.
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
            out[r["win_idx"]] = bool(r.get("passed", False))
    return out

p1 = load(P1_WIN)
p2 = load(P2_WIN)
trades = defaultdict(list)
for line in TRADES.read_text().splitlines():
    if line.strip():
        r = json.loads(line)
        trades[r["winIdx"]].append(r)

def cluster_symbols(tl, h=24):
    if not tl: return set()
    s = sorted(tl, key=lambda t: t["entryTime"])
    cutoff = s[0]["entryTime"] + h*3600*1000
    return {t["symbol"] for t in s if t["entryTime"] <= cutoff}

def sim_damage_ramp(trades_list, ramp_days=2, ramp_factor=0.7, ramp_threshold=0.02,
                    damage_threshold=-0.02, damage_pause_day=False):
    """Simulate Risk-Ramp + Damage Control.
    - ramp_days first days at ramp_factor unless cumulative eq >= ramp_threshold
    - if day_pnl <= damage_threshold, pause same-day entries (if damage_pause_day)
    Pass: eq >= 0.10, no daily breach <= -0.05, no total <= -0.10.
    """
    if not trades_list:
        return False
    s = sorted(trades_list, key=lambda t: t["entryTime"])
    eq = 0.0
    min_eq = 0.0
    day_start_eq = {}
    day_paused = set()
    first_day = s[0]["entryDay"]
    for t in s:
        d = t["entryDay"]
        if d not in day_start_eq:
            day_start_eq[d] = eq
            if damage_pause_day and d in day_paused:
                continue
        # Risk ramp: if we're still in early days AND haven't broken through ramp_threshold
        applied_factor = 1.0
        if (d - first_day) < ramp_days and eq < ramp_threshold:
            applied_factor = ramp_factor
        # Damage control: skip if same-day cumulative damage exceeded
        day_pnl = eq - day_start_eq[d]
        if day_pnl <= damage_threshold:
            if damage_pause_day:
                day_paused.add(d)
                continue
        # Apply trade
        eq += t["effPnl"] * applied_factor
        min_eq = min(min_eq, eq)
        # Daily breach check (real-time)
        if eq - day_start_eq[d] <= -0.05:
            return False
    if min_eq <= -0.10:
        return False
    return eq >= 0.10

common = sorted(set(p1) & set(p2) & set(trades.keys()))
gate_b4m3 = lambda s: len(s)>=4 and len(s&MAJORS)>=3

# Compare against no-modification baseline
def sim_baseline(trades_list):
    """Replay without any ramp/damage logic — sanity baseline."""
    return sim_damage_ramp(trades_list, ramp_days=0, ramp_factor=1.0,
                           ramp_threshold=0.0, damage_threshold=-99,
                           damage_pause_day=False)

# Sanity
kept_base = [w for w in common if gate_b4m3(cluster_symbols(trades[w]))]
print(f"Gate b>=4 & maj>=3: kept {len(kept_base)}/{len(common)}\n")

base_p1 = sum(1 for w in kept_base if sim_baseline(trades[w]))
base_and = sum(1 for w in kept_base if sim_baseline(trades[w]) and p2[w])
real_and = sum(1 for w in kept_base if p1[w] and p2[w])
print(f"Sim baseline P1: {base_p1}/{len(kept_base)} ({base_p1/len(kept_base)*100:.2f}%)")
print(f"Sim baseline AND: {base_and}/{len(kept_base)} ({base_and/len(kept_base)*100:.2f}%)")
print(f"Real AND: {real_and}/{len(kept_base)} ({real_and/len(kept_base)*100:.2f}%)")
print(f"(sim is conservative — engine-state simplifications)\n")

# Grid ramp factor + damage threshold
print("=== Risk-Ramp + Damage Control Grid (on b>=4 & maj>=3 = 143 windows) ===")
print(f"{'Ramp':<8} {'Damage':<10} {'Pause':<8} {'SimP1%':<10} {'SimAND%':<10}")
for ramp in [1.0, 0.9, 0.8, 0.7, 0.6]:
    for damage in [-0.02, -0.03, -99]:
        for pause in [False, True]:
            if damage == -99 and pause:
                continue  # no damage trigger → no pause
            sim_p1 = sum(1 for w in kept_base if sim_damage_ramp(
                trades[w], ramp_days=2, ramp_factor=ramp,
                ramp_threshold=0.02, damage_threshold=damage,
                damage_pause_day=pause
            ))
            sim_both = sum(1 for w in kept_base if sim_damage_ramp(
                trades[w], ramp_days=2, ramp_factor=ramp,
                ramp_threshold=0.02, damage_threshold=damage,
                damage_pause_day=pause
            ) and p2[w])
            n = len(kept_base)
            print(f"{ramp:<8.2f} {damage:<10.2f} {str(pause):<8} {sim_p1/n*100:6.2f}%   {sim_both/n*100:6.2f}%")
    print()
