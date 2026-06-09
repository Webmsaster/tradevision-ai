#!/usr/bin/env python3
"""Robustness battery for the two xsec_edge_probe survivors (XSMOM L14, FUNDING L7).

Runs the project's debunk checklist BEFORE believing anything:
  1. per-calendar-year net PnL (regime-luck check)
  2. 3-fold thirds (not just 70/30)
  3. BTC-beta regression of daily PnL (drift-confound check)
  4. long-leg vs short-leg split (survivorship check: short-leg-only profits
     on a survivor universe are suspect; long-leg profits are conservative)
  5. cost stress 10/20/30bp one-way
  6. correlation of the two signals' daily PnL + 50/50 combo
"""
from __future__ import annotations
import math
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from xsec_edge_probe import Universe, run_strategy, stats, PRICE_SYMBOLS, ROOT, DAY_MS


def yearly(u, pnl):
    out = {}
    for i, x in enumerate(pnl):
        if x is None:
            continue
        year = 1970 + (u.days[i] * 86400) // 31_556_952  # approx; fine for bucketing
        out.setdefault(year, []).append(x)
    return out


def ann(pnls):
    n = len(pnls)
    if n < 30:
        return None
    m = sum(pnls) / n
    var = sum((x - m) ** 2 for x in pnls) / n
    sd = math.sqrt(var)
    return dict(ret=m * 365, sharpe=(m / sd * math.sqrt(365)) if sd > 0 else 0.0, n=n)


def leg_strategy(u, mode, look, skip, hold, cost_bp, leg, funding_syms=None):
    """Long-only or short-only leg by zeroing the other side's weights."""
    import xsec_edge_probe as xp
    orig = xp.quintile_weights

    def one_leg(scored, min_n):
        w = orig(scored, min_n)
        if leg == "long":
            return {s: v for s, v in w.items() if v > 0}
        return {s: v for s, v in w.items() if v < 0}

    xp.quintile_weights = one_leg
    try:
        res = run_strategy(u, mode, look, skip, hold, cost_bp,
                           funding_syms=funding_syms)
    finally:
        xp.quintile_weights = orig
    return res


def beta_alpha(u, pnl):
    """OLS daily pnl ~ a + b * btc_ret."""
    btc = u.ret["BTCUSDT"]
    xs, ys = [], []
    for i, y in enumerate(pnl):
        if y is None or btc[i] is None:
            continue
        xs.append(btc[i])
        ys.append(y)
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / n
    vx = sum((x - mx) ** 2 for x in xs) / n
    b = cov / vx if vx > 0 else 0.0
    a = my - b * mx
    resid = [y - (a + b * x) for x, y in zip(xs, ys)]
    sr = ann(resid)
    return a * 365, b, (sr["sharpe"] if sr else 0.0)


def main():
    cache = ROOT / "scripts/cache_bakeoff"
    u = Universe(cache, PRICE_SYMBOLS)
    funding_syms = [s for s in u.symbols if any(x is not None for x in u.funding[s])]
    n = len(u.days)

    candidates = [
        ("XSMOM L14 skip1 H7", dict(mode="xsmom", look=14, skip=1, hold=7)),
        ("FUNDING L7 H7", dict(mode="funding", look=7, skip=0, hold=7,
                               funding_syms=funding_syms)),
    ]

    pnls = {}
    for name, kw in candidates:
        print(f"\n=== {name} ===")
        res = run_strategy(u, cost_bp=10.0, **kw)
        pnls[name] = res["net"]

        print("-- per calendar year (net 10bp):")
        for y, v in sorted(yearly(u, res["net"]).items()):
            a = ann(v)
            if a:
                print(f"   {y}: ret {100*a['ret']:>7.1f}%  Sharpe {a['sharpe']:>5.2f}  (n={a['n']})")

        print("-- 3 folds (net 10bp):")
        for k, (sf, ef) in enumerate([(0.0, 1/3), (1/3, 2/3), (2/3, 1.0)]):
            r = run_strategy(u, cost_bp=10.0, start_frac=sf, end_frac=ef, **kw)
            s = stats(r["net"])
            if s:
                print(f"   fold{k+1}: ret {100*s['ann_ret']:>7.1f}%  Sharpe {s['sharpe']:>5.2f}  t {s['t_stat']:>5.2f}")

        print("-- cost stress (FULL, net):")
        for cb in (10.0, 20.0, 30.0):
            r = run_strategy(u, cost_bp=cb, **kw)
            s = stats(r["net"])
            print(f"   {cb:>4.0f}bp: ret {100*s['ann_ret']:>7.1f}%  Sharpe {s['sharpe']:>5.2f}  t {s['t_stat']:>5.2f}")

        print("-- legs (gross, to locate the edge):")
        for leg in ("long", "short"):
            kw2 = {k: v for k, v in kw.items() if k != "funding_syms"}
            r = leg_strategy(u, leg=leg, cost_bp=10.0,
                             funding_syms=kw.get("funding_syms"), **kw2)
            s = stats(r["gross"])
            if s:
                print(f"   {leg:>5}-only: ret {100*s['ann_ret']:>7.1f}%  Sharpe {s['sharpe']:>5.2f}  t {s['t_stat']:>5.2f}  DD {100*s['max_dd']:>5.1f}%")

        a, b, rs = beta_alpha(u, res["net"])
        print(f"-- BTC regression: ann.alpha {100*a:>6.1f}%  beta {b:>6.3f}  residual Sharpe {rs:>5.2f}")

    # combo
    p1, p2 = pnls[candidates[0][0]], pnls[candidates[1][0]]
    both = [(a, b) for a, b in zip(p1, p2) if a is not None and b is not None]
    xs, ys = [a for a, _ in both], [b for _, b in both]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs) / len(xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys) / len(ys))
    corr = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / len(xs) / (sx * sy)
    combo = [(a + b) / 2 for a, b in both]
    sc = ann(combo)
    print(f"\n=== COMBO 50/50 === corr={corr:.2f}  ret {100*sc['ret']:>6.1f}%  Sharpe {sc['sharpe']:.2f}")
    # combo 3-fold
    third = len(combo) // 3
    for k in range(3):
        seg = combo[k * third:(k + 1) * third if k < 2 else len(combo)]
        a = ann(seg)
        print(f"   fold{k+1}: ret {100*a['ret']:>7.1f}%  Sharpe {a['sharpe']:>5.2f}")


if __name__ == "__main__":
    main()
