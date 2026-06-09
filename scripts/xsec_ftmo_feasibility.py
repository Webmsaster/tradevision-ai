#!/usr/bin/env python3
"""Can the validated funding-carry signal live on FTMO's actual crypto CFDs?

The 2026-06-09 vehicle decision called FTMO dead on STRUCTURAL grounds
(-30%/yr swap both sides, no meme listings, no carry income) — but the number
was never measured. This measures it: the exact validated signal (funding L7
H7, death-spiral guard, quintile L/S), formed and traded ONLY on the 31 coins
FTMO actually lists (Binance perp data as signal/price source), under three
cost scenarios:

  exchange   reference: Binance perps, 10bp, price+carry  (the real strategy)
  ftmo-swing price-only, 20bp CFD costs, -30%/yr swap on gross, weekend held
             (Swing account: weekend holding allowed, crypto leverage 1:1 --
             a 1.0-gross book consumes ~100% margin, no headroom)
  ftmo-std   price-only, 20bp, weekend FLAT (close Fri / reopen Mon = 2x gross
             extra turnover/week, Sat+Sun pnl = 0), swap Mon-Thu nights only

Universe note: 18 symbols from cache_bakeoff (30m resampled), 13 from
cache_ftmo_extra (1d, incl. XLM whose bakeoff funding is missing) = all 31.
Survivorship is clean by construction: this IS the live FTMO listing.
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from xsec_edge_probe import Universe, quintile_weights, stats  # noqa: E402

BAKEOFF_SYMS = [
    "AAVEUSDT", "ADAUSDT", "ALGOUSDT", "AVAXUSDT", "BCHUSDT", "BNBUSDT",
    "BTCUSDT", "DOGEUSDT", "DOTUSDT", "ETCUSDT", "ETHUSDT", "LINKUSDT",
    "LTCUSDT", "NEARUSDT", "SANDUSDT", "SOLUSDT", "UNIUSDT", "XRPUSDT",
]
FUNDING_LOOK, HOLD, GUARD, MIN_N = 7, 7, -0.0027, 12
SWAP_ANN = 0.30                  # -30%/yr, both sides, FTMO API (percentage)
SWAP_NIGHT = SWAP_ANN / 364.0    # per nightly charge


def weekday(epoch_day: int) -> int:
    """0=Thu 1=Fri 2=Sat 3=Sun 4=Mon 5=Tue 6=Wed (epoch day 0 = Thursday)."""
    return epoch_day % 7


def run(u: Universe, cost_bp: float, scenario: str,
        start_frac=0.0, end_frac=1.0):
    """scenario: exchange | swing | standard. Returns daily pnl list."""
    n = len(u.days)
    lo, hi = int(n * start_frac), int(n * end_frac)
    cost = cost_bp / 1e4
    syms = [s for s in u.symbols if any(x is not None for x in u.funding[s])]
    raw_weights, eff_prev = [], {}
    pnl_series: list[float | None] = [None] * n
    for i in range(n - 1):
        if i < lo or i >= hi:
            raw_weights.append({})
            eff_prev = {}
            continue
        scored = []
        for s in syms:
            if u.close[s][i] is None:
                continue
            f = u.trailing_funding(s, i, FUNDING_LOOK)
            if f is None or f < GUARD:
                continue
            scored.append((s, -f))
        raw_weights.append(quintile_weights(scored, MIN_N))
        recent = raw_weights[-HOLD:]
        eff: dict[str, float] = {}
        for wmap in recent:
            for s, w in wmap.items():
                eff[s] = eff.get(s, 0.0) + w / len(recent)
        if not eff and not eff_prev:
            continue
        day_next = u.days[i + 1]          # the day this pnl accrues over
        wd = weekday(day_next)
        gross_exp = sum(abs(w) for w in eff.values())

        if scenario == "standard" and wd in (2, 3):   # flat over Sat/Sun
            pnl_series[i + 1] = 0.0
            # eff_prev stays = Friday book; Monday rebuild costed below
            continue

        price = carry = 0.0
        for s, w in eff.items():
            r = u.ret[s][i + 1]
            price += w * (r if r is not None else 0.0)
            if scenario == "exchange":
                f = u.funding[s][i + 1]
                carry += -w * (f if f is not None else 0.0)
        turn = sum(abs(eff.get(s, 0.0) - eff_prev.get(s, 0.0))
                   for s in set(eff) | set(eff_prev))
        if scenario == "standard":
            if wd == 1:                   # Friday: close everything tonight
                turn += gross_exp
            if wd == 4:                   # Monday: rebuild from flat
                turn = sum(abs(w) for w in eff.values())
        x = price + carry - cost * turn
        if scenario == "swing":
            x -= SWAP_NIGHT * gross_exp               # every night
        elif scenario == "standard" and wd in (4, 5, 6, 0):
            x -= SWAP_NIGHT * gross_exp               # Mon-Thu nights only
        pnl_series[i + 1] = x
        eff_prev = dict(eff)
    return pnl_series


def main():
    u = Universe(ROOT / "scripts/cache_bakeoff", BAKEOFF_SYMS,
                 delisted_dir=ROOT / "scripts/cache_ftmo_extra", clip=0.95)
    n_funding = sum(1 for s in u.symbols
                    if any(x is not None for x in u.funding[s]))
    print(f"# FTMO crypto-universe feasibility | {len(u.symbols)} symbols "
          f"({n_funding} with funding) | {len(u.days)} days")
    scenarios = [("exchange (10bp, +carry)", "exchange", 10.0),
                 ("ftmo-swing (20bp, -30%/yr swap)", "swing", 20.0),
                 ("ftmo-standard (20bp, weekend-flat)", "standard", 20.0)]
    splits = [("FULL", 0.0, 1.0), ("train70", 0.0, 0.7), ("test30", 0.7, 1.0)]
    for label, scen, bp in scenarios:
        print(f"\n## {label}")
        for split, sf, ef in splits:
            r = stats(run(u, bp, scen, sf, ef))
            if not r:
                print(f"  {split:>8}: insufficient data")
                continue
            print(f"  {split:>8}: ann {100*r['ann_ret']:>7.2f}%  "
                  f"S {r['sharpe']:>5.2f}  t {r['t_stat']:>5.2f}  "
                  f"DD {100*r['max_dd']:>6.1f}%  hit {100*r['hit']:.1f}%")


if __name__ == "__main__":
    main()
