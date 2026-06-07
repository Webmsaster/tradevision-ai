#!/usr/bin/env python3
"""Engine-independent EDGE probe: classic Time-Series Momentum (TSMOM) on FX.

The FTMO edge-detector (steady_risk_grid.py) measures edge THROUGH the engine's
full exit machinery (TP cap, ATR stop, trailing, daily-loss rule). That conflates
"does the signal have edge" with "does this exit structure express it". A capped
TP in particular destroys trend's positive-skew edge before it can show.

This probe strips ALL of that away and asks the cleanest possible question, the
one the academic literature (Moskowitz-Ooi-Pedersen 2012; AQR) actually tests:

    Does the SIGN of a trailing return predict the next period's return,
    after realistic costs, on this data?

Method (textbook TSMOM):
  - signal_t = sign(trailing total return over lookback L)
  - position_t = signal_t, scaled to constant target risk via inverse trailing vol
  - pnl_{t+1} = position_t * return_{t+1}  -  cost * |position_t - position_{t-1}|
  - aggregate equal-risk across all assets -> portfolio
  - report annualised mean, vol, Sharpe, t-stat, max DD, hit-rate; net AND gross.

A real edge => Sharpe > 0 with a t-stat that clears ~2 AND survives an
out-of-sample split (fit nothing -> just confirm the sign holds on held-out years).
If gross Sharpe is ~0 the signal has no predictive content and no exit structure
can rescue it. If gross is positive but net is ~0, the edge exists but is smaller
than costs (untradeable retail). Both outcomes are decisive and honest.
"""
from __future__ import annotations
import argparse, json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_closes(cache_dir: Path, symbol: str, tf: str):
    """Return (times_ms, closes) from {SYMBOL}_{tf}.json."""
    p = cache_dir / f"{symbol}_{tf}.json"
    rows = json.loads(p.read_text())
    rows = [r for r in rows if r.get("isFinal", True)]
    t = [int(r["openTime"]) for r in rows]
    c = [float(r["close"]) for r in rows]
    return t, c


def pct_returns(closes, clip=0.05):
    """Simple period returns, winsorised at +/-clip to kill bad-bar outliers."""
    r = [0.0]
    for i in range(1, len(closes)):
        x = closes[i] / closes[i - 1] - 1.0
        if clip:
            x = max(-clip, min(clip, x))
        r.append(x)
    return r


def rolling_vol(rets, win):
    """Trailing std (population) of rets[:i], length-aligned, None until warm."""
    out = [None] * len(rets)
    for i in range(len(rets)):
        if i < win:
            continue
        window = rets[i - win:i]
        m = sum(window) / win
        var = sum((x - m) ** 2 for x in window) / win
        out[i] = math.sqrt(var) if var > 0 else None
    return out


def trailing_return(closes, i, look):
    if i - look < 0:
        return None
    return closes[i] / closes[i - look] - 1.0


def stats(daily_pnl, bars_per_year):
    pnl = [x for x in daily_pnl if x is not None]
    n = len(pnl)
    if n < 30:
        return None
    mean = sum(pnl) / n
    var = sum((x - mean) ** 2 for x in pnl) / n
    sd = math.sqrt(var) if var > 0 else 0.0
    sharpe = (mean / sd * math.sqrt(bars_per_year)) if sd > 0 else 0.0
    t_stat = (mean / sd * math.sqrt(n)) if sd > 0 else 0.0
    ann_ret = mean * bars_per_year
    ann_vol = sd * math.sqrt(bars_per_year)
    # equity + max drawdown (compounded)
    eq = 1.0
    peak = 1.0
    mdd = 0.0
    for x in pnl:
        eq *= (1.0 + x)
        peak = max(peak, eq)
        mdd = min(mdd, eq / peak - 1.0)
    hit = sum(1 for x in pnl if x > 0) / n
    return dict(n=n, ann_ret=ann_ret, ann_vol=ann_vol, sharpe=sharpe,
                t_stat=t_stat, max_dd=mdd, hit=hit, total_ret=eq - 1.0)


def run_tsmom(cache_dir, symbols, tf, look, vol_win, cost_bp, target_vol,
              bars_per_year, allow_short=True, start_frac=0.0, end_frac=1.0):
    """Equal-risk TSMOM portfolio across symbols. Returns (portfolio_stats, per_sym)."""
    cost = cost_bp / 1e4
    per_sym = {}
    # collect each symbol's strategy daily pnl series (aligned by its own index)
    all_series = []
    for sym in symbols:
        try:
            _, closes = load_closes(cache_dir, sym, tf)
        except FileNotFoundError:
            continue
        rets = pct_returns(closes)
        vol = rolling_vol(rets, vol_win)
        lo = int(len(closes) * start_frac)
        hi = int(len(closes) * end_frac)
        pnl = []
        prev_pos = 0.0
        for i in range(len(closes) - 1):
            if i < lo or i >= hi:
                pnl.append(None)
                continue
            tr = trailing_return(closes, i, look)
            v = vol[i]
            if tr is None or v is None or v == 0:
                pnl.append(None)
                prev_pos = 0.0
                continue
            sig = 1.0 if tr > 0 else (-1.0 if tr < 0 else 0.0)
            if not allow_short and sig < 0:
                sig = 0.0
            # inverse-vol sizing to a constant target risk per bar
            size = target_vol / v
            size = min(size, 5.0)  # cap leverage
            pos = sig * size
            gross = pos * rets[i + 1]
            turn = abs(pos - prev_pos)
            net = gross - cost * turn
            pnl.append(net)
            prev_pos = pos
        s = stats(pnl, bars_per_year)
        if s:
            per_sym[sym] = s
            all_series.append(pnl)
    # equal-weight portfolio (average across symbols where all present)
    if not all_series:
        return None, per_sym
    L = max(len(s) for s in all_series)
    port = []
    for i in range(L):
        vals = [s[i] for s in all_series if i < len(s) and s[i] is not None]
        port.append(sum(vals) / len(vals) if vals else None)
    return stats(port, bars_per_year), per_sym


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", default="scripts/cache_forex")
    ap.add_argument("--symbols", default="EURUSD,GBPUSD,USDJPY,USDCAD,AUDUSD,NZDUSD")
    ap.add_argument("--tf", default="daily")
    ap.add_argument("--looks", default="21,63,126,252",
                    help="momentum lookbacks in bars (daily: 1mo,3mo,6mo,12mo)")
    ap.add_argument("--vol-win", type=int, default=63)
    ap.add_argument("--cost-bp", type=float, default=3.0, help="round-trip cost per unit turnover")
    ap.add_argument("--target-vol", type=float, default=0.01, help="per-bar target risk")
    ap.add_argument("--bars-per-year", type=float, default=260.0)
    ap.add_argument("--no-short", action="store_true")
    args = ap.parse_args()

    cache = ROOT / args.cache_dir if not Path(args.cache_dir).is_absolute() else Path(args.cache_dir)
    syms = args.symbols.split(",")
    looks = [int(x) for x in args.looks.split(",")]
    bpy = args.bars_per_year

    print(f"# TSMOM edge probe | {args.cache_dir} | tf={args.tf} | {len(syms)} syms | "
          f"cost={args.cost_bp}bp | short={'no' if args.no_short else 'yes'}")
    print(f"{'look':>5} {'split':>8} {'n':>6} {'annRet%':>8} {'annVol%':>8} "
          f"{'Sharpe':>7} {'t-stat':>7} {'maxDD%':>7} {'hit%':>6}")
    print("-" * 72)
    for look in looks:
        for name, sf, ef in [("FULL", 0.0, 1.0), ("train70", 0.0, 0.7), ("test30", 0.7, 1.0)]:
            s, _ = run_tsmom(cache, syms, args.tf, look, args.vol_win, args.cost_bp,
                             args.target_vol, bpy, allow_short=not args.no_short,
                             start_frac=sf, end_frac=ef)
            if s:
                print(f"{look:>5} {name:>8} {s['n']:>6} {100*s['ann_ret']:>7.2f}% "
                      f"{100*s['ann_vol']:>7.2f}% {s['sharpe']:>7.2f} {s['t_stat']:>7.2f} "
                      f"{100*s['max_dd']:>6.1f}% {100*s['hit']:>5.1f}%")
        print()


if __name__ == "__main__":
    main()
