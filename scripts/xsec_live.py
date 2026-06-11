#!/usr/bin/env python3
"""Live paper-tracker for the cross-sectional FUNDING-carry signal.

Purpose: measure LIVE SIGNAL DRIFT (does the edge persist out-of-sample, on
data that did not exist when the strategy was designed) before any real money.
This does NOT measure slippage — only micro-live with real orders can.

Design:
  - IDEMPOTENT CATCH-UP: every run processes all completed UTC days since the
    last state. Missed cron days are backfilled automatically from Binance
    public data (no API key needed). Run it daily, weekly, or whenever.
  - Signal parity with scripts/xsec_edge_probe.py (the validated probe):
      score   = -(trailing 7d mean of daily funding sum)
      guard   = exclude from candidates if funding < -0.27%/day (death-spiral,
                single pre-registered value, see probe commit a40212b)
      weights = +0.5 spread over top quintile, -0.5 over bottom (max(3, n//5))
      holding = 7-day overlapping portfolios (effective w = mean of last 7)
      pnl(T)  = sum w_eff(T-1)*ret(T) + carry(T) - cost_bp*turnover
  - Universe (objective, computed daily): all TRADING USDT perpetuals whose
    mean daily quote volume over the last 90 days >= $71.2M (0.8x the smallest
    backtest survivor, same floor as fetch_delisted_perps.py).
  - State in tools/xsec-live-state/: state.json (weights ring, equity),
    history.jsonl (one line per processed day), run.log.

First run backfills --backfill-days (default 14) so the 7-day holding window
is warm; those days overlap the backtest period and are labelled warmup=true
in history.jsonl — the honest live track starts at the first warmup=false line.
"""
from __future__ import annotations
import argparse, datetime as dt, json, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = ROOT / "tools" / "xsec-live-state"
DAY_MS = 86_400_000
FAPI = "https://fapi.binance.com"

VOLUME_FLOOR = 89e6 * 0.8     # same floor as backtest universe
FUNDING_LOOK = 7              # days, trailing mean
HOLD = 7                      # overlapping-portfolio days
FUNDING_GUARD = -0.0027       # death-spiral guard, per day (pre-registered)
MIN_UNIVERSE = 12


def get(url: str, retries: int = 3):
    for k in range(retries):
        try:
            return json.load(urllib.request.urlopen(url, timeout=30))
        except Exception:
            if k == retries - 1:
                raise
            time.sleep(2 * (k + 1))


def active_usdt_perps():
    info = get(f"{FAPI}/fapi/v1/exchangeInfo")
    return sorted(
        s["symbol"] for s in info["symbols"]
        if s.get("status") == "TRADING"
        and s.get("contractType") == "PERPETUAL"
        and s.get("quoteAsset") == "USDT"
        and s["symbol"].isascii())


def fetch_daily(sym: str, n_days: int):
    """{day_int: (close, quote_volume)} for the last n_days completed days."""
    rows = get(f"{FAPI}/fapi/v1/klines?symbol={sym}&interval=1d&limit={min(1500, n_days)}")
    out = {}
    for r in rows:
        out[int(r[0]) // DAY_MS] = (float(r[4]), float(r[7]))
    today = int(time.time() * 1000) // DAY_MS
    out.pop(today, None)  # drop the running (incomplete) day
    return out


def fetch_funding_daily(sym: str):
    """{day_int: summed funding} covering the last ~333 days."""
    rows = get(f"{FAPI}/fapi/v1/fundingRate?symbol={sym}&limit=1000")
    out: dict[int, float] = {}
    for r in rows:
        d = int(r["fundingTime"]) // DAY_MS
        out[d] = out.get(d, 0.0) + float(r["fundingRate"])
    return out


def quintile_weights(scored):
    if len(scored) < MIN_UNIVERSE:
        return {}
    scored = sorted(scored, key=lambda kv: kv[1])
    nq = max(3, len(scored) // 5)
    w = {}
    for sym, _ in scored[-nq:]:
        w[sym] = 0.5 / nq
    for sym, _ in scored[:nq]:
        w[sym] = w.get(sym, 0.0) - 0.5 / nq
    return w


def signal_weights(day, closes, funding):
    """Raw signal weights for `day` using data up to and incl. that day."""
    scored = []
    for sym, cl in closes.items():
        if day not in cl:
            continue
        win = [funding[sym][d] for d in range(day - FUNDING_LOOK + 1, day + 1)
               if d in funding.get(sym, {})]
        if len(win) < max(3, FUNDING_LOOK // 2):
            continue
        f = sum(win) / len(win)
        if f < FUNDING_GUARD:
            continue  # death-spiral guard: not a candidate
        scored.append((sym, -f))
    return quintile_weights(scored)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cost-bp", type=float, default=10.0)
    ap.add_argument("--backfill-days", type=int, default=14,
                    help="first-run warmup window (labelled warmup in history)")
    ap.add_argument("--state-dir", default=str(STATE_DIR))
    args = ap.parse_args()

    sdir = Path(args.state_dir)
    sdir.mkdir(parents=True, exist_ok=True)
    state_f = sdir / "state.json"
    hist_f = sdir / "history.jsonl"

    state = json.loads(state_f.read_text()) if state_f.exists() else None
    today = int(time.time() * 1000) // DAY_MS
    first_run = state is None
    if first_run:
        state = dict(last_day=today - args.backfill_days - 1, equity=1.0,
                     raw_weights=[], eff_prev={}, started=today)
    pending = list(range(state["last_day"] + 1, today))  # completed days only
    if not pending:
        print("up to date — no completed days to process")
        return

    # ---- fetch market data (public, no keys) ----
    syms = active_usdt_perps()
    span = today - min(pending) + 100  # 90d volume window + lookbacks
    print(f"{len(syms)} active USDT perps | processing {len(pending)} day(s) "
          f"{pending[0]}..{pending[-1]} | fetching {span}d of daily klines...")
    closes = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for sym, data in zip(syms, ex.map(lambda s: fetch_daily(s, span), syms)):
            if data:
                closes[sym] = data

    # universe per latest day: 90d mean quote volume >= floor (per processed
    # day we reuse the same qualification — volume floor moves slowly)
    qual = []
    for sym, data in closes.items():
        last90 = [qv for d, (c, qv) in data.items() if d > today - 91]
        if len(last90) >= 30 and sum(last90) / len(last90) >= VOLUME_FLOOR:
            qual.append(sym)
    closes = {s: {d: c for d, (c, qv) in closes[s].items()} for s in qual}
    print(f"universe: {len(qual)} symbols above ${VOLUME_FLOOR/1e6:.0f}M 90d-avg volume")

    funding = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for sym, f in zip(qual, ex.map(fetch_funding_daily, qual)):
            funding[sym] = f

    # ---- replay each completed day with backtest-identical semantics ----
    for day in pending:
        w_raw = signal_weights(day, closes, funding)
        state["raw_weights"] = (state["raw_weights"] + [w_raw])[-HOLD:]
        eff: dict[str, float] = {}
        for wmap in state["raw_weights"]:
            for s, w in wmap.items():
                eff[s] = eff.get(s, 0.0) + w / len(state["raw_weights"])
        eff_prev = state["eff_prev"]
        # pnl realised over day -> uses PREVIOUS day's effective weights
        pnl = carry = 0.0
        for s, w in eff_prev.items():
            c0 = closes.get(s, {}).get(day - 1)
            c1 = closes.get(s, {}).get(day)
            r = (c1 / c0 - 1.0) if (c0 and c1) else 0.0
            r = max(-0.95, min(0.95, r))
            pnl += w * r
            carry += -w * funding.get(s, {}).get(day, 0.0)
        turn = sum(abs(eff.get(s, 0.0) - eff_prev.get(s, 0.0))
                   for s in set(eff) | set(eff_prev))
        net = pnl + carry - args.cost_bp / 1e4 * turn
        state["equity"] *= (1.0 + net)
        state["eff_prev"] = eff
        state["last_day"] = day
        date = dt.datetime.fromtimestamp(day * 86400, dt.UTC).date().isoformat()
        warmup = first_run and day < today - 1
        rec = dict(date=date, day=day, net=round(net, 6), price=round(pnl, 6),
                   carry=round(carry, 6), turnover=round(turn, 4),
                   equity=round(state["equity"], 6), n_pos=len(eff),
                   universe=len(qual), warmup=warmup)
        with hist_f.open("a") as fh:
            fh.write(json.dumps(rec) + "\n")
        print(f"{date}  net {100*net:>7.3f}%  (price {100*pnl:>6.3f}% carry "
              f"{100*carry:>6.3f}%)  turn {turn:.2f}  eq {state['equity']:.4f}"
              f"{'  [warmup]' if warmup else ''}")

    state_f.write_text(json.dumps(state))

    # ---- current target book ----
    eff = state["eff_prev"]
    longs = sorted(((s, w) for s, w in eff.items() if w > 1e-6), key=lambda x: -x[1])
    shorts = sorted(((s, w) for s, w in eff.items() if w < -1e-6), key=lambda x: x[1])
    print(f"\n=== TARGET BOOK after {dt.datetime.fromtimestamp(state['last_day']*86400, dt.UTC).date()} "
          f"(gross {sum(abs(w) for _, w in eff.items()):.2f}) ===")
    print("LONG : " + ", ".join(f"{s.replace('USDT','')} {100*w:.1f}%" for s, w in longs))
    print("SHORT: " + ", ".join(f"{s.replace('USDT','')} {100*w:.1f}%" for s, w in shorts))


if __name__ == "__main__":
    main()
