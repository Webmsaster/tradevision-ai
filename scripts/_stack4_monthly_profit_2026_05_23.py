#!/usr/bin/env python3
"""
2026-05-23 Stack-4 monthly-profit aggregator.

Per-window OR = 57.17% says "≥1 of 4 accounts funded in this window". Doesn't
say HOW MUCH $$/mo on $400k aggregate. This script computes:

  For each window i:
    For each of 4 accounts independently:
      Did account become funded? (P1∧P2 true-sequential)
      If yes: simulate burst-chain forward at +8% TP, banked × $8000 × 80% = $/cycle
    Sum 4-account $$ per window
  Median / mean / p25 / p75 monthly profit on $400k notional

Burst-chain proxy: uses AMBER's burst_pt08.jsonl rows for ALL 4 accounts (since
we only have a sweep at +8% for AMBER-config). This is an approximation —
BIDIR/MR/RUBIN burst-chains likely differ slightly.
"""

import json
import os
import statistics as st

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STACK3 = os.path.join(ROOT, "scripts/cache_bakeoff/stack3_bidir_mr")
STACK4 = os.path.join(ROOT, "scripts/cache_bakeoff/stack4_rubin")
BURST  = os.path.join(ROOT, "scripts/cache_bakeoff/funded_burst/burst_pt08.jsonl")

CONFIGS = {
    "amber": (f"{STACK3}/amber_p1.jsonl",  f"{STACK3}/amber_p2.jsonl"),
    "bidir": (f"{STACK3}/bidir_p1.jsonl",  f"{STACK3}/bidir_p2.jsonl"),
    "mr":    (f"{STACK3}/mr_p1.jsonl",     f"{STACK3}/mr_p2.jsonl"),
    "rubin": (f"{STACK4}/rubin_p1.jsonl",  f"{STACK4}/rubin_p2.jsonl"),
}

PT = 0.08
WITHDRAW = PT * 0.80   # 6.4% per banked cycle, trader keeps 80%
DOLLAR_PER_CYCLE = WITHDRAW * 100_000  # = $6400 per banked cycle on $100k


def load(path):
    d = {}
    for l in open(path):
        o = json.loads(l)
        d[o["win_idx"]] = (bool(o["passed"]), o.get("final_day"))
    return d


def load_burst(path):
    d = {}
    for l in open(path):
        o = json.loads(l)
        d[o["win_idx"]] = (bool(o["passed"]), o["final_day"], o["fail_reason"])
    return d


def funded(P1, P2, tag, i):
    if i not in P1[tag]: return None
    p1_pass, D = P1[tag][i]
    if not p1_pass: return (False, None, None)
    j = i + D
    if j not in P2[tag]: return None
    p2_pass, D2 = P2[tag][j]
    if not p2_pass: return (False, None, None)
    funded_day = D + D2
    return (True, funded_day, j + D2)  # funded at i+funded_day, ready for burst-chain


def burst_chain_after_funded(burst_rows, start_idx):
    """Walk burst-chain forward from start_idx. Bank +6.4% per pass, stop on bust.
    Returns (banked_cycles, lifespan_days_total)."""
    i = start_idx
    banked = 0
    days = 0
    while i in burst_rows:
        passed, D, _ = burst_rows[i]
        days += D
        if passed:
            banked += 1
            i = i + D
        else:
            break
        if days > 365: break
    return banked, days


def main():
    P1 = {t: load(v[0]) for t, v in CONFIGS.items()}
    P2 = {t: load(v[1]) for t, v in CONFIGS.items()}
    burst = load_burst(BURST)

    tags = list(CONFIGS.keys())
    allk = set(P1[tags[0]])
    for t in tags[1:]:
        allk &= set(P1[t])
    keys = sorted(allk)

    # Per-window result: list of (per-account $$ banked over remaining month)
    per_window_dollars = []
    n_evaluable = 0
    n_any_funded = 0
    funded_count_distribution = {0:0, 1:0, 2:0, 3:0, 4:0}

    for i in keys:
        per_acct_dollars = []
        funded_now = 0
        skip = False
        for t in tags:
            fs = funded(P1, P2, t, i)
            if fs is None:
                skip = True
                break
            is_funded, _funded_day, burst_start = fs
            if not is_funded:
                per_acct_dollars.append(0.0)
                continue
            funded_now += 1
            # simulate burst-chain forward from burst_start
            banked, _lifespan = burst_chain_after_funded(burst, burst_start)
            per_acct_dollars.append(banked * DOLLAR_PER_CYCLE)
        if skip: continue
        n_evaluable += 1
        total = sum(per_acct_dollars)
        if total > 0:
            n_any_funded += 1
        funded_count_distribution[funded_now] = funded_count_distribution.get(funded_now, 0) + 1
        per_window_dollars.append(total)

    print(f"=== Stack-4 monthly-profit aggregation (n={n_evaluable} valid windows) ===\n")
    print(f"funded-count distribution (how many of 4 accounts funded per window):")
    for k in sorted(funded_count_distribution):
        v = funded_count_distribution[k]
        print(f"  {k} of 4 accounts:  {v} windows ({100*v/n_evaluable:.2f}%)")
    print(f"  ≥1 funded:         {n_any_funded} windows ({100*n_any_funded/n_evaluable:.2f}%)  ← Stack-4 OR")

    # per-window dollars assumes lifespan is what the burst-chain produced, but
    # we need it normalized to a 30-day window. The burst already capped at 365d.
    # For monthly: a window represents a START point; the chain plays out forward
    # for as long as bursts keep banking. We compute total $$ / lifespan / 30 days.

    print(f"\n=== Total $$ per evaluable window (proxy for $$ produced over funded lifespan) ===")
    sorted_d = sorted(per_window_dollars)
    mean = st.mean(per_window_dollars)
    med = st.median(per_window_dollars)
    p25 = sorted_d[n_evaluable // 4]
    p75 = sorted_d[3 * n_evaluable // 4]
    p90 = sorted_d[9 * n_evaluable // 10]
    print(f"  mean:    ${mean:>10,.0f}")
    print(f"  median:  ${med:>10,.0f}")
    print(f"  p25:     ${p25:>10,.0f}")
    print(f"  p75:     ${p75:>10,.0f}")
    print(f"  p90:     ${p90:>10,.0f}")

    # Monthly normalization — assume each evaluable window represents 1 day of
    # opportunity start. Sum total $$ across all windows, divide by total days,
    # multiply by 30. This is the LONG-RUN AGGREGATE monthly profit.
    total_dollars = sum(per_window_dollars)
    total_days = n_evaluable  # 1 day per window (step=1d)
    monthly_aggregate = (total_dollars / total_days) * 30
    print(f"\n=== Long-run aggregate monthly profit (sum-$$-across-windows / n_days × 30) ===")
    print(f"  ${monthly_aggregate:>10,.0f}  per month  on $400k notional")
    print(f"  = {100 * monthly_aggregate / 400_000:.2f}%/mo  on $400k aggregate")

    # Compare to single-AMBER baseline
    single_path = os.path.join(ROOT, "scripts/cache_bakeoff/funded_burst/burst_pt08.jsonl")
    single = load_burst(single_path)
    single_dollars = []
    for i in sorted(single):
        b, _ld = burst_chain_after_funded(single, i)
        single_dollars.append(b * DOLLAR_PER_CYCLE)
    single_total = sum(single_dollars)
    single_days = len(single_dollars)
    single_monthly = (single_total / single_days) * 30 if single_days else 0
    print(f"\n=== Compare: single AMBER account (no stack) on $100k ===")
    print(f"  ${single_monthly:>10,.0f}  per month  on $100k notional")
    print(f"  = {100 * single_monthly / 100_000:.2f}%/mo  on $100k")
    print(f"  scale-to-$400k naive: ${4*single_monthly:>10,.0f} = {100*4*single_monthly/400_000:.2f}%/mo")

    print(f"\n=== KEY METRIC ===")
    print(f"  Stack-4 aggregate %/mo:  {100 * monthly_aggregate / 400_000:.2f}%  (on $400k)")
    print(f"  4× single-AMBER naive:   {100 * 4 * single_monthly / 400_000:.2f}%  (on $400k)")
    diff = (monthly_aggregate - 4*single_monthly) / 400_000 * 100
    print(f"  Stack-4 vs 4×single diff: {diff:+.2f}pp")


if __name__ == "__main__":
    main()
