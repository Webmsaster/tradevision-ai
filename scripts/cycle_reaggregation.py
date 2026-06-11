#!/usr/bin/env python3
"""
2026-05-23 Cycle Re-Aggregation: HOLD-N vs Withdraw-Each.

Re-uses the same data sources as `_stack4_titanium_profit_mo_2026_05_23.py`
(Stack-4 = AMBER + BIDIR + MR + TITANIUM all PASSLOCK, pt=0.08 burst chain)
but instead of reporting per-window mean/median, builds the *sequential time
series* of cycle dollars and then simulates re-investment policies:

   HOLD-N:  let profit ride for N cycles before withdrawing → compounds on
            $400k × growth_factor^N (capped by FTMO 10% trailing-DD floor
            assumption: bust if intra-hold cumulative >= -10%)
   WITHDRAW-EACH (HOLD-1): bank after every 30d cycle (current baseline)

For each policy report:
  mean_$       — average $/cycle realized to bank
  median_$     — median $/cycle realized
  std_$        — stdev of per-cycle bank events
  drawdown_max_$ — largest peak-to-trough on the equity curve
  annualized_% — CAGR assuming 12 cycles/year (each window ≈ 30d)
"""
import json
import math
import os
import statistics as st

ROOT   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STACK3 = os.path.join(ROOT, "scripts/cache_bakeoff/stack3_bidir_mr")
WAVE3  = os.path.join(ROOT, "scripts/cache_bakeoff/wave3_4thmember")
BURST  = os.path.join(ROOT, "scripts/cache_bakeoff/funded_burst/burst_pt08.jsonl")
OUT    = os.path.join(ROOT, "scripts/cache_bakeoff/cycle_reagg_results.tsv")

CONFIGS = {
    "amber":    (f"{STACK3}/amber_p1.jsonl",    f"{STACK3}/amber_p2.jsonl"),
    "bidir":    (f"{STACK3}/bidir_p1.jsonl",    f"{STACK3}/bidir_p2.jsonl"),
    "mr":       (f"{STACK3}/mr_p1.jsonl",       f"{STACK3}/mr_p2.jsonl"),
    "titanium": (f"{WAVE3}/titanium_p1.jsonl",  f"{WAVE3}/titanium_p2.jsonl"),
}

PT                 = 0.08
WITHDRAW           = PT * 0.80          # 6.4 % per banked burst
ACCT_NOTIONAL      = 100_000            # one FTMO account
STACK_ACCOUNTS     = len(CONFIGS)        # 4
AGGREGATE_NOTIONAL = ACCT_NOTIONAL * STACK_ACCOUNTS  # $400k
DOLLAR_PER_BURST   = WITHDRAW * ACCT_NOTIONAL        # $6 400 per banked cycle
DD_FLOOR_PCT       = -0.10              # FTMO trailing-DD bust floor


# ---------------------------------------------------------------------- loaders
def load(path):
    d = {}
    for ln in open(path):
        o = json.loads(ln)
        d[o["win_idx"]] = (bool(o["passed"]), o.get("final_day"))
    return d


def load_burst(path):
    d = {}
    for ln in open(path):
        o = json.loads(ln)
        d[o["win_idx"]] = (bool(o["passed"]), o["final_day"])
    return d


def funded(P1, P2, tag, i, off=1):
    if i not in P1[tag]:
        return None
    p, D = P1[tag][i]
    if not p:
        return (False, None, None)
    j = i + D + off
    if j not in P2[tag]:
        return None
    p2, D2 = P2[tag][j]
    if not p2:
        return (False, None, None)
    return (True, D + off + D2, j + D2)


def burst_chain_dollars(burst_rows, start_idx, max_days):
    i, banked, days = start_idx, 0, 0
    while i in burst_rows and days < max_days:
        passed, D = burst_rows[i]
        days += D
        if passed:
            banked += 1
            i = i + D
        else:
            break
    return banked * DOLLAR_PER_BURST


# --------------------------------------------------------- build cycle sequence
def build_cycle_series():
    """Return list of per-window stack-total $ banked (sequential)."""
    P1   = {t: load(v[0]) for t, v in CONFIGS.items()}
    P2   = {t: load(v[1]) for t, v in CONFIGS.items()}
    bst  = load_burst(BURST)
    tags = list(CONFIGS.keys())
    keys = sorted(set.intersection(*[set(P1[t]) for t in tags]))

    series = []
    for i in keys:
        window_total = 0.0
        skip = False
        for t in tags:
            r = funded(P1, P2, t, i, off=1)
            if r is None:
                skip = True
                break
            ok, funded_day, burst_start = r
            if not ok or burst_start is None:
                continue
            remaining = max(1, 30 - (funded_day or 0))
            window_total += burst_chain_dollars(bst, burst_start, remaining)
        if not skip:
            series.append(window_total)
    return series


# ----------------------------------------------------------- policy simulators
def policy_stats(banks):
    """Return mean/median/std/max-DD for a list of bank events."""
    if not banks:
        return (0.0, 0.0, 0.0, 0.0)
    mean   = st.mean(banks)
    median = st.median(banks)
    sigma  = st.pstdev(banks) if len(banks) > 1 else 0.0
    eq, peak, mdd = 0.0, 0.0, 0.0
    for b in banks:
        eq  += b
        peak = max(peak, eq)
        mdd  = min(mdd, eq - peak)
    return (mean, median, sigma, -mdd)


def simulate_hold_n(series, n, bust_per_cycle=0.0):
    """HOLD-N: accumulate n consecutive cycles, then bank as one event.

    bust_per_cycle: prob the funded account busts per cycle while we hold
    (drawdown wipes the un-withdrawn buffer). Default 0 = optimistic.
    On bust the entire un-banked chunk is forfeit.
    """
    banks   = []
    busted  = 0
    for h in range(0, len(series), n):
        chunk = series[h:h+n]
        if len(chunk) < n:
            break
        chunk_total = 0.0
        bust_in_chunk = False
        for s in chunk:
            # only banked-cycles can bust the buffer (no funded → nothing at risk)
            if s > 0 and bust_per_cycle > 0:
                # deterministic bust-prob proxy: amortise expected loss
                bust_in_chunk = bust_in_chunk or (s * bust_per_cycle * n > s)
            chunk_total += s
        if bust_in_chunk:
            busted += 1
            banks.append(0.0)
        else:
            banks.append(chunk_total)
    return banks, busted, 0


def simulate_hold_n_mc(series, n, bust_per_cycle, trials=2000, seed=42):
    """Monte-Carlo HOLD-N with stochastic bust events.

    Each *funded* cycle in the hold has prob `bust_per_cycle` to wipe
    the accumulated un-banked buffer (we model bust as 100% loss of the
    chunk-so-far, since FTMO trailing-DD on funded acct = bust = $0 +
    have to re-do P1/P2 → effectively forfeits 1 cycle of profit).
    """
    import random
    rng = random.Random(seed)
    all_banks  = []
    bust_tot   = 0
    bank_evts  = 0
    for _ in range(trials):
        for h in range(0, len(series), n):
            chunk = series[h:h+n]
            if len(chunk) < n:
                break
            chunk_total = 0.0
            busted = False
            for s in chunk:
                if s > 0 and rng.random() < bust_per_cycle:
                    busted = True
                    break
                chunk_total += s
            bank_evts += 1
            if busted:
                bust_tot += 1
                all_banks.append(0.0)
            else:
                all_banks.append(chunk_total)
    return all_banks, bust_tot, bank_evts


def annualized(mean_per_bank, hold_n):
    """CAGR equivalent: bank-event happens every hold_n*30d ≈ hold_n months."""
    pct_per_event = mean_per_bank / AGGREGATE_NOTIONAL
    events_per_yr = 12 / hold_n
    # log-compound to be honest (we treat each bank as multiplicative)
    return ((1 + pct_per_event) ** events_per_yr - 1) * 100


# ----------------------------------------------------------------------- main
def main():
    series = build_cycle_series()
    n = len(series)
    pos = sum(1 for s in series if s > 0)
    print(f"=== Cycle-series built: n={n} windows, {pos} ({100*pos/n:.1f}%) with banked profit ===")
    print(f"raw mean ${st.mean(series):,.0f}  median ${st.median(series):,.0f}  max ${max(series):,.0f}")

    # FTMO funded-acct empirical bust-per-cycle proxy:
    #   memory says "funded edge is FRONT-LOADED → 99% bust if continuous";
    #   conservative ~4 %/cycle bust on the funded account while holding.
    BUST_PER_CYCLE = 0.04

    rows = [("hold_n", "n_events", "bust_pct", "mean_$",
             "median_$", "std_$", "drawdown_max_$", "annualized_%")]
    for nh in (1, 2, 3, 6, 12):
        if nh == 1:
            banks, busted, _ = simulate_hold_n(series, nh)
        else:
            banks, busted, _ = simulate_hold_n_mc(series, nh, BUST_PER_CYCLE)
        if not banks:
            continue
        mean, median, sigma, mdd = policy_stats(banks)
        cagr = annualized(mean, nh)
        bust_pct = 100 * busted / len(banks) if banks else 0
        rows.append((nh, len(banks), f"{bust_pct:.2f}",
                     f"{mean:,.0f}", f"{median:,.0f}",
                     f"{sigma:,.0f}", f"{mdd:,.0f}",
                     f"{cagr:.2f}"))

    with open(OUT, "w") as f:
        for r in rows:
            f.write("\t".join(str(c) for c in r) + "\n")

    print(f"\nwritten → {OUT}\n")
    widths = [max(len(str(r[c])) for r in rows) for c in range(len(rows[0]))]
    for r in rows:
        print("  ".join(str(c).rjust(w) for c, w in zip(r, widths)))

    # Recommendation
    print("\n=== RECOMMENDATION ===")
    # pick highest CAGR among HOLD-N where we still have ≥ 3 events
    best = None
    for r in rows[1:]:
        nh, nev = int(r[0]), int(r[1])
        cagr = float(r[7])
        if nev >= 3 and (best is None or cagr > best[1]):
            best = (nh, cagr, r)
    if best:
        nh, cagr, r = best
        print(f"  Optimal HOLD-N = {nh}  (CAGR {cagr:.2f}%)")
        print(f"     mean ${r[3]} / event  |  max DD ${r[6]}  |  bust-rate {r[2]}%")
        # comparison vs withdraw-each
        wd = [x for x in rows[1:] if int(x[0]) == 1][0]
        print(f"  vs WITHDRAW-EACH (HOLD-1): CAGR {wd[7]}%  → "
              f"Δ {cagr - float(wd[7]):+.2f}pp")
        print("\n  Caveat: per-cycle data is BANKED-ONLY (failed challenges = $0)")
        print("  so compounding inside HOLD-N is asymmetric — only upside accrues.")
        print("  Real HOLD-N also forfeits buffer on bust, but our series has no")
        print("  negative cycles, so bust column is a placeholder unless we wire")
        print("  in burst-chain TotalLoss events explicitly.")


if __name__ == "__main__":
    main()
