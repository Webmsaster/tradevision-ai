#!/usr/bin/env python3
"""
2026-05-23 Stack-4 AMBER+BIDIR+MR+TITANIUM monthly profit on $400k aggregate.

Honest measurement using:
  - P1 + P2 TRUE-SEQUENTIAL with offset=1 (no join-day overlap, honest math)
  - Burst-chain proxy: AMBER's burst_pt08.jsonl for the funded-phase forward chain
    (since we only have +8% TP burst measurements for AMBER config)

Per window, simulate parallel 4-account behaviour:
  - For each account independently: did P1∧P2 pass (account becomes funded)?
  - If yes, run burst-chain forward from funded_day for remainder of 30-day window
  - Each banked +8% cycle = +6.4% withdraw = $6400 on $100k
"""
import json
import os
import statistics as st

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STACK3 = os.path.join(ROOT, "scripts/cache_bakeoff/stack3_bidir_mr")
WAVE3 = os.path.join(ROOT, "scripts/cache_bakeoff/wave3_4thmember")
BURST = os.path.join(ROOT, "scripts/cache_bakeoff/funded_burst/burst_pt08.jsonl")

CONFIGS = {
    "amber":    (f"{STACK3}/amber_p1.jsonl",    f"{STACK3}/amber_p2.jsonl"),
    "bidir":    (f"{STACK3}/bidir_p1.jsonl",    f"{STACK3}/bidir_p2.jsonl"),
    "mr":       (f"{STACK3}/mr_p1.jsonl",       f"{STACK3}/mr_p2.jsonl"),
    "titanium": (f"{WAVE3}/titanium_p1.jsonl",  f"{WAVE3}/titanium_p2.jsonl"),
}

PT = 0.08
WITHDRAW = PT * 0.80   # 6.4%
DOLLAR_PER_CYCLE = WITHDRAW * 100_000   # $6400


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


def funded(P1, P2, tag, i, off=1):
    if i not in P1[tag]: return None
    p, D = P1[tag][i]
    if not p: return (False, None, None)
    j = i + D + off
    if j not in P2[tag]: return None
    p2, D2 = P2[tag][j]
    if not p2: return (False, None, None)
    return (True, D + off + D2, j + D2)  # funded after this many days


def burst_chain_dollars(burst_rows, start_idx, max_days):
    """Walk burst-chain forward from start_idx within max_days budget."""
    i = start_idx
    banked = 0
    days = 0
    while i in burst_rows and days < max_days:
        passed, D, _ = burst_rows[i]
        days += D
        if passed:
            banked += 1
            i = i + D
        else:
            break
    return banked * DOLLAR_PER_CYCLE, days


def main():
    P1 = {t: load(v[0]) for t, v in CONFIGS.items()}
    P2 = {t: load(v[1]) for t, v in CONFIGS.items()}
    burst = load_burst(BURST)

    tags = list(CONFIGS.keys())
    allk = set(P1[tags[0]])
    for t in tags[1:]:
        allk &= set(P1[t])
    keys = sorted(allk)

    # For each window, simulate 4-account parallel:
    #   each account funded? → burst-chain forward
    #   Sum per-account $$
    monthly_dollars = []
    funded_count_dist = {0: 0, 1: 0, 2: 0, 3: 0, 4: 0}
    per_acct_dollars_sums = {t: 0.0 for t in tags}
    per_acct_funded_counts = {t: 0 for t in tags}

    for i in keys:
        skip = False
        window_total = 0.0
        funded_this_window = 0
        for t in tags:
            r = funded(P1, P2, t, i, off=1)
            if r is None:
                skip = True
                break
            is_funded, funded_day, burst_start = r
            if not is_funded:
                continue
            funded_this_window += 1
            per_acct_funded_counts[t] += 1
            if burst_start is None:
                continue
            # remaining days in a "30-day cycle"
            remaining = max(1, 30 - (funded_day if funded_day else 0))
            d, _ = burst_chain_dollars(burst, burst_start, remaining)
            window_total += d
            per_acct_dollars_sums[t] += d
        if skip: continue
        funded_count_dist[funded_this_window] += 1
        monthly_dollars.append(window_total)

    n = len(monthly_dollars)
    print(f"=== Stack-4 AMBER+BIDIR+MR+TITANIUM monthly profit (n={n}) ===\n")
    print(f"Funded-account-count distribution per window:")
    for k in sorted(funded_count_dist):
        v = funded_count_dist[k]
        pct = 100*v/n if n else 0
        print(f"  {k} of 4 funded:  {v:>4} windows ({pct:>5.2f}%)")
    print(f"  >>> ≥1 funded:    {sum(funded_count_dist[k] for k in [1,2,3,4]):>4} = {100*sum(funded_count_dist[k] for k in [1,2,3,4])/n:.2f}% (Stack-4 OR)\n")

    print(f"Per-account contribution to total $$ pot:")
    grand_total = sum(per_acct_dollars_sums.values())
    for t in tags:
        share = 100 * per_acct_dollars_sums[t] / grand_total if grand_total > 0 else 0
        print(f"  {t:9s}  ${per_acct_dollars_sums[t]:>12,.0f}  ({share:>5.1f}%, {per_acct_funded_counts[t]} fundings)")

    # Per-window monthly $$ stats
    sorted_d = sorted(monthly_dollars)
    mean = st.mean(monthly_dollars) if monthly_dollars else 0
    median = st.median(monthly_dollars) if monthly_dollars else 0
    p25 = sorted_d[n // 4] if n else 0
    p75 = sorted_d[3*n // 4] if n else 0
    p90 = sorted_d[9*n // 10] if n else 0
    print(f"\nPer-window $$ banked (30-day window from challenge start):")
    print(f"  mean:   ${mean:>10,.0f}   = {100*mean/400_000:.2f}% of $400k notional")
    print(f"  median: ${median:>10,.0f}   = {100*median/400_000:.2f}%")
    print(f"  p25:    ${p25:>10,.0f}")
    print(f"  p75:    ${p75:>10,.0f}   = {100*p75/400_000:.2f}%")
    print(f"  p90:    ${p90:>10,.0f}   = {100*p90/400_000:.2f}%")

    # HEADLINE: long-run EXPECTED monthly profit
    print(f"\n=== HEADLINE: EXPECTED MONTHLY PROFIT ON $400k ===")
    print(f"  Mean $$/mo: ${mean:>10,.0f}  =  {100*mean/400_000:.2f}%/mo on $400k aggregate")
    print(f"  Trader keeps 80% (FTMO split):  ${0.8*mean:>10,.0f}  ({100*0.8*mean/400_000:.2f}%/mo)")
    print(f"\n  WAIT: the burst-chain math already uses 0.80 withdraw → number above is TRADER NET, not gross")
    print(f"  Pre-FTMO-split:  ${mean/0.8:>10,.0f}/mo on the $400k books")


if __name__ == "__main__":
    main()
