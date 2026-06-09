#!/usr/bin/env python3
"""Engine-independent CROSS-SECTIONAL edge probe on the crypto universe.

Everything tested so far (engine edge-detector, tsmom_edge_probe) was TIME-SERIES:
one asset's own history predicting its own next return. All of it shows the
variance-lottery signature. This probe asks the structurally different question
the literature says is the strongest documented factor (Jegadeesh-Titman 1993;
Liu-Tsyvinski-Wu RFS 2022 for crypto):

    Does an asset's return RELATIVE TO ITS PEERS predict its next return
    relative to its peers, after costs?

Three signals, all dollar-neutral (long top quintile / short bottom quintile,
0.5 gross each side) so the BTC beta-drift confound that explained every prior
"edge" is structurally removed:

  xsmom    score =  trailing return over L days, skipping the most recent `skip`
  reversal score = -trailing return over L days (short-term reversal)
  funding  score = -trailing 7d mean funding rate (short crowded longs).
           Reported twice: price-only PnL (the part tradeable on FTMO CFDs)
           and price+carry PnL (perp funding income, exchange-only).

Method:
  - daily closes resampled from the 30m Binance cache (last close per UTC day,
    incomplete last day dropped); returns winsorised at +/-50%
  - signal at day t uses data up to close of t; PnL accrues over t -> t+1
  - holding H days via overlapping portfolios (Jegadeesh-Titman calendar-time):
    effective weight = mean of the last H daily signal weights
  - costs = cost_bp * daily turnover (one-way); also reports the BREAK-EVEN
    cost (gross ann. return / ann. turnover) — the honest "edge per unit
    turnover" number. Binance perp taker ~5-10bp, FTMO CFD ~15-25bp.
  - FULL / train70 / test30 splits; a real edge must keep its sign on test30.

Caveat: universe = 27 currently-listed majors -> survivorship bias. Dead coins
(LUNA, FTT) are missing, which mostly UNDERSTATES the short leg of momentum, so
a null result here is conservative for xsmom; treat a positive result on the
LONG leg with extra suspicion.
"""
from __future__ import annotations
import argparse, json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DAY_MS = 86_400_000

PRICE_SYMBOLS = [
    "AAVEUSDT", "ADAUSDT", "ALGOUSDT", "APTUSDT", "ARBUSDT", "ATOMUSDT",
    "AVAXUSDT", "BCHUSDT", "BNBUSDT", "BTCUSDT", "DOGEUSDT", "DOTUSDT",
    "ETCUSDT", "ETHUSDT", "FILUSDT", "INJUSDT", "LINKUSDT", "LTCUSDT",
    "NEARUSDT", "RUNEUSDT", "SANDUSDT", "SOLUSDT", "STXUSDT", "TRXUSDT",
    "UNIUSDT", "XLMUSDT", "XRPUSDT",
]


def load_daily_closes(cache_dir: Path, symbol: str):
    """{utc_day_int: close} from the 30m cache; incomplete last day dropped."""
    rows = json.loads((cache_dir / f"{symbol}_30m.json").read_text())
    rows = [r for r in rows if r.get("isFinal", True)]
    by_day: dict[int, float] = {}
    for r in rows:
        by_day[int(r["openTime"]) // DAY_MS] = float(r["close"])
    if by_day:
        by_day.pop(max(by_day), None)  # last day is partial as of fetch time
    return by_day


def load_daily_closes_1d(path: Path):
    """{utc_day_int: close} from a direct 1d-kline file; last (partial) day dropped."""
    rows = json.loads(path.read_text())
    rows = [r for r in rows if r.get("isFinal", True)]
    by_day = {int(r["openTime"]) // DAY_MS: float(r["close"]) for r in rows}
    if by_day:
        by_day.pop(max(by_day), None)
    return by_day


def load_daily_funding(cache_dir: Path, symbol: str):
    """{utc_day_int: summed funding rate} (3x 8h payments per day)."""
    p = cache_dir / f"{symbol}_funding.json"
    if not p.exists():
        return {}
    out: dict[int, float] = {}
    for e in json.loads(p.read_text()):
        d = int(e["t"]) // DAY_MS
        out[d] = out.get(d, 0.0) + float(e["r"])
    return out


def stats(daily_pnl, bars_per_year=365.0):
    pnl = [x for x in daily_pnl if x is not None]
    n = len(pnl)
    if n < 60:
        return None
    mean = sum(pnl) / n
    var = sum((x - mean) ** 2 for x in pnl) / n
    sd = math.sqrt(var) if var > 0 else 0.0
    sharpe = (mean / sd * math.sqrt(bars_per_year)) if sd > 0 else 0.0
    t_stat = (mean / sd * math.sqrt(n)) if sd > 0 else 0.0
    eq, peak, mdd = 1.0, 1.0, 0.0
    for x in pnl:
        eq *= (1.0 + x)
        peak = max(peak, eq)
        mdd = min(mdd, eq / peak - 1.0)
    hit = sum(1 for x in pnl if x > 0) / n
    return dict(n=n, ann_ret=mean * bars_per_year, ann_vol=sd * math.sqrt(bars_per_year),
                sharpe=sharpe, t_stat=t_stat, max_dd=mdd, hit=hit)


class Universe:
    def __init__(self, cache_dir: Path, symbols, delisted_dir: Path | None = None,
                 clip: float = 0.5):
        self.clip = clip
        self.symbols = []
        per_sym_days = {}
        funding_src = {}
        for s in symbols:
            d = load_daily_closes(cache_dir, s)
            if len(d) > 200:
                per_sym_days[s] = d
                funding_src[s] = cache_dir
                self.symbols.append(s)
        if delisted_dir and delisted_dir.is_dir():
            for p in sorted(delisted_dir.glob("*_1d.json")):
                s = p.name[:-len("_1d.json")]
                if s in per_sym_days:
                    continue
                d = load_daily_closes_1d(p)
                if len(d) > 60:
                    per_sym_days[s] = d
                    funding_src[s] = delisted_dir
                    self.symbols.append(s)
        self.days = sorted(set().union(*per_sym_days.values()))
        self.idx = {d: i for i, d in enumerate(self.days)}
        n = len(self.days)
        self.close = {s: [per_sym_days[s].get(d) for d in self.days] for s in self.symbols}
        self.funding = {}
        for s in self.symbols:
            fd = load_daily_funding(funding_src[s], s)
            self.funding[s] = [fd.get(d) for d in self.days]
        # daily returns, winsorised
        self.ret = {}
        self.n_clipped = 0
        for s in self.symbols:
            c = self.close[s]
            r = [None] * n
            for i in range(1, n):
                if c[i] is not None and c[i - 1] is not None and c[i - 1] > 0:
                    x = c[i] / c[i - 1] - 1.0
                    if abs(x) > clip:
                        self.n_clipped += 1
                        x = max(-clip, min(clip, x))
                    r[i] = x
            self.ret[s] = r

    def trailing_ret(self, sym, i, look, skip):
        c = self.close[sym]
        a, b = i - skip, i - skip - look
        if b < 0 or c[a] is None or c[b] is None or c[b] <= 0:
            return None
        return c[a] / c[b] - 1.0

    def trailing_funding(self, sym, i, look):
        f = self.funding[sym]
        if i - look + 1 < 0:
            return None
        w = [x for x in f[i - look + 1:i + 1] if x is not None]
        if len(w) < max(3, look // 2):
            return None
        return sum(w) / len(w)


def quintile_weights(scored, min_n):
    """Dollar-neutral weights: +0.5 spread over top quintile, -0.5 over bottom."""
    if len(scored) < min_n:
        return {}
    scored = sorted(scored, key=lambda kv: kv[1])
    nq = max(3, len(scored) // 5)
    w = {}
    for sym, _ in scored[-nq:]:
        w[sym] = 0.5 / nq
    for sym, _ in scored[:nq]:
        w[sym] = w.get(sym, 0.0) - 0.5 / nq
    return w


def run_strategy(u: Universe, mode, look, skip, hold, cost_bp, min_n=15,
                 funding_syms=None, start_frac=0.0, end_frac=1.0,
                 funding_floor=None):
    """funding_floor: death-spiral guard for the funding mode. A coin whose
    trailing daily funding is BELOW this (e.g. -0.0027/day = -100%/yr annualised)
    is excluded from the candidate pool: such funding prices acute collapse
    (LUNA hit -0.75%/8h), not harvestable unpopularity. Single pre-registered
    value, deliberately NOT swept (overfit discipline)."""
    """Returns dict of pnl series: gross, net, and for funding mode also *_carry."""
    n = len(u.days)
    lo, hi = int(n * start_frac), int(n * end_frac)
    syms = funding_syms if mode == "funding" else u.symbols
    raw_weights = []          # per-day signal weights
    eff_prev: dict[str, float] = {}
    gross_pnl = [None] * n
    net_pnl = [None] * n
    carry_pnl = [None] * n    # price + funding income
    turnover_sum, turnover_days = 0.0, 0
    cost = cost_bp / 1e4
    for i in range(n - 1):
        if i < lo or i >= hi:
            raw_weights.append({})
            eff_prev = {}
            continue
        scored = []
        for s in syms:
            if u.close[s][i] is None:
                continue
            if mode == "xsmom":
                v = u.trailing_ret(s, i, look, skip)
            elif mode == "reversal":
                v = u.trailing_ret(s, i, look, skip)
                v = -v if v is not None else None
            elif mode == "funding":
                v = u.trailing_funding(s, i, look)
                if v is not None and funding_floor is not None and v < funding_floor:
                    v = None  # death-spiral guard: not a long candidate
                v = -v if v is not None else None
            else:
                raise ValueError(mode)
            if v is not None:
                scored.append((s, v))
        raw_weights.append(quintile_weights(scored, min_n))
        # overlapping-portfolio effective weight = mean of last `hold` signals
        recent = raw_weights[-hold:]
        eff: dict[str, float] = {}
        for wmap in recent:
            for s, w in wmap.items():
                eff[s] = eff.get(s, 0.0) + w / hold
        if not eff and not eff_prev:
            continue
        turn = sum(abs(eff.get(s, 0.0) - eff_prev.get(s, 0.0))
                   for s in set(eff) | set(eff_prev))
        turnover_sum += turn
        turnover_days += 1
        g = 0.0
        carry = 0.0
        for s, w in eff.items():
            r = u.ret[s][i + 1]
            g += w * (r if r is not None else 0.0)
            f = u.funding[s][i + 1]
            carry += -w * (f if f is not None else 0.0)  # long pays positive funding
        gross_pnl[i + 1] = g
        net_pnl[i + 1] = g - cost * turn
        carry_pnl[i + 1] = g + carry - cost * turn
        eff_prev = eff
    avg_turn = turnover_sum / turnover_days if turnover_days else 0.0
    return dict(gross=gross_pnl, net=net_pnl, carry=carry_pnl, avg_turnover=avg_turn)


def fmt_row(tag, split, res, bars_per_year=365.0):
    sg = stats(res["gross"], bars_per_year)
    sn = stats(res["net"], bars_per_year)
    if not sg or not sn:
        return f"{tag} {split:>8}   (insufficient data)"
    ann_turn = res["avg_turnover"] * bars_per_year
    be_cost = (sg["ann_ret"] / ann_turn * 1e4) if ann_turn > 0 else float("inf")
    return (f"{tag} {split:>8} {sg['n']:>5} | g {100*sg['ann_ret']:>7.2f}% "
            f"S {sg['sharpe']:>5.2f} t {sg['t_stat']:>5.2f} | n {100*sn['ann_ret']:>7.2f}% "
            f"S {sn['sharpe']:>5.2f} t {sn['t_stat']:>5.2f} | DD {100*sn['max_dd']:>5.1f}% "
            f"| turn/d {res['avg_turnover']:>4.2f} | beCost {be_cost:>5.1f}bp")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", default="scripts/cache_bakeoff")
    ap.add_argument("--delisted-dir", default=None,
                    help="dir with {SYM}_1d.json + {SYM}_funding.json for dead coins "
                         "(survivorship fix), e.g. scripts/cache_delisted")
    ap.add_argument("--winsor", type=float, default=0.5,
                    help="daily-return clip; use 0.95 with --delisted-dir so real "
                         "crash days (LUNA -94%%) are not artificially dampened")
    ap.add_argument("--cost-bp", type=float, default=10.0,
                    help="one-way cost per unit turnover (10=Binance-ish, 20=CFD-ish)")
    ap.add_argument("--min-n", type=int, default=15)
    args = ap.parse_args()

    cache = ROOT / args.cache_dir if not Path(args.cache_dir).is_absolute() else Path(args.cache_dir)
    dd = None
    if args.delisted_dir:
        dd = ROOT / args.delisted_dir if not Path(args.delisted_dir).is_absolute() else Path(args.delisted_dir)
    u = Universe(cache, PRICE_SYMBOLS, delisted_dir=dd, clip=args.winsor)
    funding_syms = [s for s in u.symbols if any(x is not None for x in u.funding[s])]
    print(f"# XS edge probe | {len(u.symbols)} syms | {len(u.days)} days "
          f"({u.days[0]}..{u.days[-1]} epoch-days) | {len(funding_syms)} with funding | "
          f"cost={args.cost_bp}bp | winsor-clips={u.n_clipped}")
    print("# g=gross n=net S=Sharpe t=t-stat beCost=break-even cost/turnover")

    splits = [("FULL", 0.0, 1.0), ("train70", 0.0, 0.7), ("test30", 0.7, 1.0)]

    print("\n## XSMOM (long winners / short losers, dollar-neutral)")
    for look, skip, hold in [(7, 1, 7), (14, 1, 7), (28, 1, 7), (56, 7, 7), (91, 7, 7),
                             (28, 1, 1), (28, 1, 14)]:
        for split, sf, ef in splits:
            res = run_strategy(u, "xsmom", look, skip, hold, args.cost_bp,
                               args.min_n, start_frac=sf, end_frac=ef)
            print(fmt_row(f"L{look:>3} skip{skip} H{hold:>2}", split, res))
        print()

    print("## REVERSAL (long losers / short winners)")
    for look, hold in [(2, 2), (5, 5), (7, 7)]:
        for split, sf, ef in splits:
            res = run_strategy(u, "reversal", look, 0, hold, args.cost_bp,
                               args.min_n, start_frac=sf, end_frac=ef)
            print(fmt_row(f"L{look:>3} skip0 H{hold:>2}", split, res))
        print()

    print("## FUNDING-CARRY (short crowded longs; price-only = FTMO-tradeable part)")
    for look, hold in [(3, 7), (7, 7), (14, 7)]:
        for split, sf, ef in splits:
            res = run_strategy(u, "funding", look, 0, hold, args.cost_bp,
                               min_n=12, funding_syms=funding_syms,
                               start_frac=sf, end_frac=ef)
            row = fmt_row(f"L{look:>3} fund  H{hold:>2}", split, res)
            sc = stats(res["carry"])
            if sc:
                row += f" | +carry: S {sc['sharpe']:>5.2f} t {sc['t_stat']:>5.2f} ({100*sc['ann_ret']:.1f}%)"
            print(row)
        print()


if __name__ == "__main__":
    main()
