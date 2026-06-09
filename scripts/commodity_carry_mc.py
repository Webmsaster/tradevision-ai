#!/usr/bin/env python3
"""Monte-Carlo FTMO-challenge simulation for a commodity-carry book.

Context (2026-06-09): FTMO's cash-CFD swaps pass through the futures term
structure (USOIL swapLong +15.1%/yr vs real WTI curve +20%/yr). The classic
commodity carry premium (long backwardation / short contango) is therefore
tradeable on FTMO — but no historical swap series exists yet (forward
collection started). This script answers the question that does not need the
swap history: GIVEN a net premium of X%/yr on the carry book, what is the
FTMO pass probability — and what premium is break-even vs the fee?

Method:
  - Book: today's FTMO-swap-implied sides, equal weight per side, gross 1.0:
    LONG CL HO KC (backwardated) / SHORT NG ZS ZC ZW CC CT SB (contango).
    15y of real daily returns (Yahoo continuous futures) -> the book's
    actual vol/correlation/tail structure. The historical MEAN of the book
    is REMOVED — drift is injected only via the premium parameter, so the
    simulation never borrows in-sample directional luck.
  - 10-day block bootstrap (preserves vol clustering), N paths per cell.
  - FTMO Standard 2-step: P1 +10%, P2 +5%, both -10% total / -5% daily
    (close-based; intraday DL approximated by also busting on -4% days),
    no time limit (capped at 500 trading days, undecided counts as fail).
  - Grid over premium x leverage. Costs: -1%/yr drag (low-turnover book,
    weekly rebalance, flat commissions).

This is a GEOMETRY calculator, not proof the premium exists post-haircut.
"""
from __future__ import annotations
import argparse, json, math, random
from pathlib import Path

HIST_DIR = Path("/tmp/commod_hist")
LONGS = ["CL", "HO", "KC"]
SHORTS = ["NG", "ZS", "ZC", "ZW", "CC", "CT", "SB"]
COST_ANN = 0.01
DL_SOFT = -0.04          # FTMO daily loss is -5%; -4% close-based proxies intraday paths
MAX_DAYS = 500


def book_returns() -> list[float]:
    series = {}
    for sym in LONGS + SHORTS:
        rows = json.loads((HIST_DIR / f"{sym}.json").read_text())
        series[sym] = {int(t) // 86400: c for t, c in rows}
    days = sorted(set.intersection(*(set(v) for v in series.values())))
    rets = []
    for a, b in zip(days, days[1:]):
        if b - a > 7:
            continue                     # skip long gaps
        r = 0.0
        for sym in LONGS:
            r += 0.5 / len(LONGS) * (series[sym][b] / series[sym][a] - 1.0)
        for sym in SHORTS:
            r += -0.5 / len(SHORTS) * (series[sym][b] / series[sym][a] - 1.0)
        rets.append(max(-0.5, min(0.5, r)))
    mean = sum(rets) / len(rets)
    return [r - mean for r in rets]      # demeaned: no in-sample luck


def run_phase(rets, rng, target, premium_d, lev, block=10):
    """One phase: returns True (pass) / False (bust or undecided)."""
    eq, n = 1.0, len(rets)
    days = 0
    while days < MAX_DAYS:
        start = rng.randrange(0, n - block)
        for k in range(block):
            r = rets[start + k] * lev + premium_d
            if r <= DL_SOFT:
                return False         # daily loss (intraday proxy at -4% close)
            eq *= (1.0 + r)
            if eq <= 0.90:
                return False                       # total loss
            if eq >= 1.0 + target:
                return True
            days += 1
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--paths", type=int, default=4000)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rets = book_returns()
    sd = math.sqrt(sum(r * r for r in rets) / len(rets))
    print(f"book: {len(rets)} daily returns | ann vol {100*sd*math.sqrt(252):.1f}% "
          f"at gross 1.0 (demeaned)")
    print(f"\n{'premium':>9} | " + " | ".join(f"lev {l:>2}" for l in (1, 2, 3, 5, 8)))
    print("-" * 64)
    for prem_ann in (0.0, 0.03, 0.05, 0.08, 0.12):
        cells = []
        for lev in (1, 2, 3, 5, 8):
            rng = random.Random(args.seed)
            premium_d = (prem_ann * lev - COST_ANN) / 252.0
            p1 = sum(run_phase(rets, rng, 0.10, premium_d, lev)
                     for _ in range(args.paths)) / args.paths
            p2 = sum(run_phase(rets, rng, 0.05, premium_d, lev)
                     for _ in range(args.paths)) / args.paths
            cells.append(f"{100*p1:>4.0f}/{100*p2:<4.0f}{100*p1*p2:>5.1f}f")
        print(f"{100*prem_ann:>8.0f}% | " + " | ".join(cells))
    print("\ncells: P1%/P2% funded%  (funded = P1*P2)")
    print("reference: time-series lottery baseline was ~7-12% single-account funded")


if __name__ == "__main__":
    main()
