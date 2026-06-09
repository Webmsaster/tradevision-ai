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

2026-06-09 late additions (goal: reduce time-to-funded at EQUAL pass rate,
single account) — three mechanisms, none of which touches the signal:
  --daily-stop 0.035  intraday equity stop: a day can lose at most -3.5%
                      (realised), eliminating daily-loss busts (97% of all
                      challenge deaths in the old audit). Close-based proxy;
                      real intraday touches fire slightly more often.
  --book vw           inverse-vol weights per side (more carry per unit risk;
                      premium scaled by the book's carry ratio 4.51/5.00).
  --lev L             leverage on the improved geometry.
Measured (4000 paths, book-level clip, conservative 5% EW premium):
  EW lev1 no-stop: 48.1% funded, 7.4 mo (baseline)
  EW lev1 + stop : 60.0% funded, 7.8 mo
  VW lev1.7+stop : 53.5% funded, 3.4 mo   <- recommended
  VW lev2.0+stop : 52.2% funded, 2.6 mo   <- recommended upper bound
  VW lev2.4-2.8  : 51.7-53.0%, 2.0-1.6 mo (stop fires ~daily, model strained)
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
CARRY_TODAY = {"CL": 15.10, "HO": 13.91, "KC": 2.58, "NG": 15.31, "ZS": 2.02,
               "ZC": 3.35, "ZW": 2.07, "CC": 3.20, "CT": 4.58, "SB": 2.32}


def book_returns(book: str = "ew") -> tuple[list[float], float]:
    """Demeaned daily book returns + the book's carry relative to EW (=1.0)."""
    series = {}
    for sym in LONGS + SHORTS:
        rows = json.loads((HIST_DIR / f"{sym}.json").read_text())
        series[sym] = {int(t) // 86400: c for t, c in rows}
    days = sorted(set.intersection(*(set(v) for v in series.values())))
    raw = {s: [] for s in series}
    for a, b in zip(days, days[1:]):
        if b - a > 7:
            continue                     # skip long gaps
        for s in series:
            raw[s].append(series[s][b] / series[s][a] - 1.0)

    if book == "vw":                     # inverse clipped-vol within each side
        def vol(xs):
            cl = [max(-0.5, min(0.5, x)) for x in xs]
            m = sum(cl) / len(cl)
            return math.sqrt(sum((x - m) ** 2 for x in cl) / len(cl))
        ivl = {s: 1 / vol(raw[s]) for s in LONGS}
        ivs = {s: 1 / vol(raw[s]) for s in SHORTS}
        w = {s: 0.5 * ivl[s] / sum(ivl.values()) for s in LONGS}
        w |= {s: -0.5 * ivs[s] / sum(ivs.values()) for s in SHORTS}
    else:
        w = {s: 0.5 / len(LONGS) for s in LONGS}
        w |= {s: -0.5 / len(SHORTS) for s in SHORTS}

    n = len(raw[LONGS[0]])
    rets = [max(-0.5, min(0.5, sum(wt * raw[s][i] for s, wt in w.items())))
            for i in range(n)]
    mean = sum(rets) / len(rets)
    ew_carry = (sum(CARRY_TODAY[s] for s in LONGS) * 0.5 / len(LONGS)
                + sum(CARRY_TODAY[s] for s in SHORTS) * 0.5 / len(SHORTS))
    carry_ratio = sum(abs(wt) * CARRY_TODAY[s] for s, wt in w.items()) / ew_carry
    return [r - mean for r in rets], carry_ratio


def run_phase(rets, rng, target, premium_d, lev, block=10, daily_stop=None):
    """One phase: (passed, trading_days_used)."""
    eq, n = 1.0, len(rets)
    days = 0
    while days < MAX_DAYS:
        start = rng.randrange(0, n - block)
        for k in range(block):
            r = rets[start + k] * lev + premium_d
            if daily_stop is not None:
                r = max(r, -daily_stop)  # intraday stop realises the cap
            elif r <= DL_SOFT:
                return False, days       # daily loss (close-based proxy)
            eq *= (1.0 + r)
            days += 1
            if eq <= 0.90:
                return False, days                 # total loss
            if eq >= 1.0 + target:
                return True, days
    return False, days


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--paths", type=int, default=4000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--book", choices=["ew", "vw"], default="ew")
    ap.add_argument("--daily-stop", type=float, default=None,
                    help="intraday equity stop, e.g. 0.035 (fraction of equity)")
    ap.add_argument("--levs", default="1,2,3,5,8")
    args = ap.parse_args()
    rets, carry_ratio = book_returns(args.book)
    sd = math.sqrt(sum(r * r for r in rets) / len(rets))
    levs = [float(x) for x in args.levs.split(",")]
    print(f"book={args.book} carry-ratio {carry_ratio:.2f} | {len(rets)} days | "
          f"ann vol {100*sd*math.sqrt(252):.1f}% at gross 1.0 (demeaned) | "
          f"daily-stop {args.daily_stop}")
    print(f"\n{'premium':>9} | " + " | ".join(f"lev {l:>4}" for l in levs))
    print("-" * (12 + 22 * len(levs)))
    for prem_ann in (0.0, 0.03, 0.05, 0.08, 0.12):
        cells = []
        for lev in levs:
            rng = random.Random(args.seed)
            premium_d = (prem_ann * carry_ratio * lev - COST_ANN) / 252.0
            p1 = [run_phase(rets, rng, 0.10, premium_d, lev,
                            daily_stop=args.daily_stop) for _ in range(args.paths)]
            p2 = [run_phase(rets, rng, 0.05, premium_d, lev,
                            daily_stop=args.daily_stop) for _ in range(args.paths)]
            pr1 = sum(x for x, _ in p1) / args.paths
            pr2 = sum(x for x, _ in p2) / args.paths
            passed1 = sorted(d for x, d in p1 if x)
            passed2 = sorted(d for x, d in p2 if x)
            mo = ((passed1[len(passed1) // 2] if passed1 else 0)
                  + (passed2[len(passed2) // 2] if passed2 else 0)) / 21.0
            cells.append(f"{100*pr1*pr2:>5.1f}f {mo:>4.1f}mo")
        print(f"{100*prem_ann:>8.0f}% | " + " | ".join(cells))
    print("\ncells: funded% (P1*P2) + median months to funded")
    print("reference: time-series lottery baseline was ~7-12% single-account funded")


if __name__ == "__main__":
    main()
