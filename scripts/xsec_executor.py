#!/usr/bin/env python3
"""Daily rebalance executor for the cross-sectional funding-carry signal.

Consumes the TARGET BOOK produced by scripts/xsec_live.py
(tools/xsec-live-state/state.json: eff_prev) — it does NOT recompute the
signal, so executor and paper-tracker stay in parity by construction.
Cron order: xsec_live.py at 03:00, this at 03:15.

Modes:
  paper (default)  No API keys needed. Fetches public Binance mark prices,
                   diffs the target book against paper-positions.json, prints
                   the orders it WOULD send and appends them to
                   paper-orders.jsonl. Surfaces order-level turnover and
                   min-notional skips — the gap the tracker's idealised
                   close-to-close PnL cannot see.
  --live           Sends real MARKET orders via ccxt. Needs env vars
                   XSEC_API_KEY + XSEC_API_SECRET (+ --exchange binanceusdm
                   or bybit). Account must be in one-way position mode with
                   cross margin and leverage >= 2x so a 1.0-gross book fits.

Safety rails: aborts if tracker state is stale (>1 day) unless --allow-stale;
gross capped at --max-gross (scales down, never up); orders below
--min-order-usd are skipped (reported, weights NOT renormalised — drift must
stay visible); --live without --yes asks for interactive confirmation.
"""
from __future__ import annotations
import argparse, datetime as dt, json, os, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = ROOT / "tools" / "xsec-live-state"
DAY = 86_400
FAPI = "https://fapi.binance.com"


def public_prices() -> dict[str, float]:
    with urllib.request.urlopen(f"{FAPI}/fapi/v1/ticker/price", timeout=30) as r:
        return {row["symbol"]: float(row["price"]) for row in json.load(r)}


def to_ccxt(sym: str) -> str:
    return f"{sym[:-4]}/USDT:USDT"


def load_json(path: Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--capital", type=float, default=1000.0,
                    help="notional base in USDT (gross 1.0 = this much)")
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--yes", action="store_true", help="skip --live confirmation")
    ap.add_argument("--exchange", default="binanceusdm",
                    choices=["binanceusdm", "bybit"])
    ap.add_argument("--min-order-usd", type=float, default=10.0)
    ap.add_argument("--max-gross", type=float, default=1.05)
    ap.add_argument("--allow-stale", action="store_true")
    ap.add_argument("--state-dir", default=str(STATE_DIR))
    args = ap.parse_args()

    sdir = Path(args.state_dir)
    state = load_json(sdir / "state.json", None)
    if not state or not state.get("eff_prev"):
        sys.exit("no tracker state — run scripts/xsec_live.py first")
    today = int(time.time()) // DAY
    age = today - state["last_day"]
    if age > 1 and not args.allow_stale:
        sys.exit(f"tracker state is {age} days old (last_day "
                 f"{dt.datetime.fromtimestamp(state['last_day']*DAY, dt.UTC).date()}) "
                 "— run scripts/xsec_live.py first or pass --allow-stale")

    weights: dict[str, float] = dict(state["eff_prev"])
    gross = sum(abs(w) for w in weights.values())
    if gross > args.max_gross:
        scale = args.max_gross / gross
        weights = {s: w * scale for s, w in weights.items()}
        print(f"WARN gross {gross:.2f} > cap {args.max_gross} — scaled by {scale:.3f}")

    # ---- venue: prices + current positions ----
    ex = None
    if args.live:
        key, sec = os.environ.get("XSEC_API_KEY"), os.environ.get("XSEC_API_SECRET")
        if not key or not sec:
            sys.exit("--live needs XSEC_API_KEY + XSEC_API_SECRET env vars")
        import ccxt
        ex = getattr(ccxt, args.exchange)({"apiKey": key, "secret": sec,
                                           "options": {"defaultType": "swap"}})
        markets = ex.load_markets()
        prices, missing = {}, []
        for s in weights:
            m = markets.get(to_ccxt(s))
            if m is None:
                missing.append(s)
            else:
                prices[s] = float(ex.fetch_ticker(to_ccxt(s))["last"])
        current = {}
        for p in ex.fetch_positions():
            sym = p["symbol"].replace("/USDT:USDT", "USDT")
            qty = float(p.get("contracts") or 0.0)
            if qty:
                current[sym] = qty if p.get("side") != "short" else -qty
    else:
        all_prices = public_prices()
        prices = {s: all_prices[s] for s in weights if s in all_prices}
        missing = [s for s in weights if s not in all_prices]
        current = load_json(sdir / "paper-positions.json", {})

    if missing:
        print(f"WARN not tradable on venue, skipped (weight dropped, NOT "
              f"renormalised): {', '.join(missing)}")

    # ---- diff target vs current ----
    orders, skipped = [], []
    for sym in sorted(set(prices) | set(current)):
        px = prices.get(sym)
        if px is None:           # open position whose symbol vanished
            print(f"WARN no price for open position {sym} — manual check needed")
            continue
        target = weights.get(sym, 0.0) * args.capital / px
        delta = target - current.get(sym, 0.0)
        notional = abs(delta) * px
        if notional < args.min_order_usd:
            if notional > 1e-9:
                skipped.append((sym, notional))
            continue
        reduces = current.get(sym, 0.0) * delta < 0
        orders.append(dict(symbol=sym, side="buy" if delta > 0 else "sell",
                           qty=abs(delta), price=px, notional=notional,
                           reduces=reduces))
    orders.sort(key=lambda o: not o["reduces"])  # free margin first

    date = dt.datetime.now(dt.UTC).date().isoformat()
    mode = f"LIVE:{args.exchange}" if args.live else "paper"
    print(f"\n=== {date} rebalance [{mode}] capital ${args.capital:,.0f} "
          f"gross {sum(abs(w) for w in weights.values()):.2f} ===")
    traded = 0.0
    for o in orders:
        traded += o["notional"]
        print(f"  {o['side']:<4} {o['symbol']:<14} qty {o['qty']:>12.4f} "
              f"@ ~{o['price']:<10.6g} ${o['notional']:>8.2f}"
              f"{'  [reduce]' if o['reduces'] else ''}")
    if skipped:
        print(f"  skipped {len(skipped)} orders < ${args.min_order_usd:.0f} "
              f"(total ${sum(n for _, n in skipped):.2f})")
    print(f"  total traded notional ${traded:,.2f} "
          f"({100*traded/args.capital:.1f}% of capital)")
    if not orders:
        print("  book already on target — nothing to do")
        return

    # ---- execute ----
    if args.live:
        assert ex is not None
        if not args.yes:
            if input(f"send {len(orders)} REAL orders on {args.exchange}? "
                     "[yes/no] ").strip().lower() != "yes":
                sys.exit("aborted")
        errors = 0
        for o in orders:
            try:
                amt = float(ex.amount_to_precision(to_ccxt(o["symbol"]), o["qty"]))
                ex.create_order(to_ccxt(o["symbol"]), "market", o["side"], amt)
                print(f"  sent {o['side']} {o['symbol']} {amt}")
            except Exception as e:
                errors += 1
                print(f"  ERROR {o['symbol']}: {e}")
        if errors:
            sys.exit(f"{errors}/{len(orders)} orders failed — book may be "
                     "off target, re-run or fix manually")
    else:
        for o in orders:
            d = o["qty"] if o["side"] == "buy" else -o["qty"]
            current[o["symbol"]] = current.get(o["symbol"], 0.0) + d
        current = {s: q for s, q in current.items() if abs(q) > 1e-12}
        (sdir / "paper-positions.json").write_text(json.dumps(current))
        with (sdir / "paper-orders.jsonl").open("a") as fh:
            for o in orders:
                fh.write(json.dumps(dict(date=date, **o)) + "\n")
        print(f"  paper fills recorded → {sdir / 'paper-orders.jsonl'}")


if __name__ == "__main__":
    main()
