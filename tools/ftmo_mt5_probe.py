#!/usr/bin/env python3
"""One-shot probe of a real FTMO MT5 terminal: swap rates, spreads,
contract specs and quote units for the commodity-carry book.

Runs on WINDOWS python (the MetaTrader5 package needs the terminal).
Credentials via env or args — never hardcoded, never committed.

    python tools\\ftmo_mt5_probe.py --login 123 --password ... --server FTMO-Demo

Writes JSON to --out (default: ftmo_mt5_probe.json next to this file).
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

TERMINAL = r"C:\Program Files\MetaTrader 5\terminal64.exe"

BOOK = ["USOIL.cash", "UKOIL.cash", "NATGAS.cash", "HEATOIL.c", "SOYBEAN.c",
        "CORN.c", "WHEAT.c", "COCOA.c", "COFFEE.c", "COTTON.c", "SUGAR.c",
        "XAU/USD", "XAG/USD", "XCU/USD"]


def main() -> None:
    import MetaTrader5 as mt5

    ap = argparse.ArgumentParser()
    ap.add_argument("--login", type=int, default=int(os.environ.get("FTMO_LOGIN", 0)))
    ap.add_argument("--password", default=os.environ.get("FTMO_PASSWORD", ""))
    ap.add_argument("--server", default=os.environ.get("FTMO_SERVER", "FTMO-Demo"))
    ap.add_argument("--terminal", default=TERMINAL)
    ap.add_argument("--out", default=str(Path(__file__).with_name("ftmo_mt5_probe.json")))
    args = ap.parse_args()

    ok = mt5.initialize(path=args.terminal, login=args.login,
                        password=args.password, server=args.server, timeout=60000)
    if not ok:
        raise SystemExit(f"initialize failed: {mt5.last_error()}")
    acct = mt5.account_info()
    print(f"connected: {acct.login} {acct.server} balance {acct.balance} "
          f"{acct.currency} leverage 1:{acct.leverage}")

    all_syms = {s.name: s for s in mt5.symbols_get()}
    print(f"{len(all_syms)} symbols on server")

    out = {"account": dict(login=acct.login, server=acct.server,
                           balance=acct.balance, currency=acct.currency,
                           leverage=acct.leverage),
           "ts": time.time(), "symbols": {}}

    # exact names may differ from the web API — match loosely too
    def find(name):
        if name in all_syms:
            return all_syms[name]
        base = name.replace(".cash", "").replace(".c", "").replace("/", "")
        for n, s in all_syms.items():
            if n.replace(".cash", "").replace(".c", "").replace("/", "").upper() == base.upper():
                return s
        return None

    for name in BOOK:
        s = find(name)
        if s is None:
            print(f"  {name}: NOT FOUND on server")
            continue
        mt5.symbol_select(s.name, True)
        time.sleep(0.3)
        tick = mt5.symbol_info_tick(s.name)
        info = mt5.symbol_info(s.name)
        rec = dict(mt5_name=info.name, bid=tick.bid if tick else None,
                   ask=tick.ask if tick else None, digits=info.digits,
                   swap_long=info.swap_long, swap_short=info.swap_short,
                   swap_mode=info.swap_mode, swap_rollover3days=info.swap_rollover3days,
                   contract_size=info.trade_contract_size,
                   volume_min=info.volume_min, volume_step=info.volume_step,
                   spread_points=info.spread,
                   tick_size=info.trade_tick_size, tick_value=info.trade_tick_value,
                   currency_profit=info.currency_profit)
        out["symbols"][name] = rec
        mid = (rec["bid"] + rec["ask"]) / 2 if tick and tick.bid else None
        spread_pct = (rec["ask"] - rec["bid"]) / mid * 100 if mid else None
        print(f"  {name:<13} -> {info.name:<14} mid {mid} "
              f"swapL {info.swap_long} swapS {info.swap_short} mode {info.swap_mode} "
              f"spread {spread_pct:.4f}%" if mid else f"  {name}: no tick yet")

    Path(args.out).write_text(json.dumps(out, indent=1))
    print(f"\nwritten -> {args.out}")
    mt5.shutdown()


if __name__ == "__main__":
    main()
