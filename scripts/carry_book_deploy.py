#!/usr/bin/env python3
"""Deploy step of the daily carry pipeline: pilot book -> Windows executor.

Takes the pilot's book (tools/commodity-carry-pilot/book.json, weights from
live FTMO swaps), rounds lots to the REAL MT5 contract specs captured by
ftmo_mt5_probe (tools/commodity-carry-pilot/mt5_specs.json — agri contracts
only allow whole lots), translates web-API symbol names to MT5 names and
writes the deploy book to the Windows side, where the 5-minute
ftmo_carry_loop task applies diffs.

Cron (after pilot regeneration):
  45 3 * * *  pilot --capital 100000 --vol-weighted && this script

Also logs the long-side energy concentration (USOIL+UKOIL+HEATOIL cluster)
for visibility — no auto-capping (that would be untested tuning).
"""
from __future__ import annotations
import argparse, datetime as dt, json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PILOT_BOOK = ROOT / "tools" / "commodity-carry-pilot" / "book.json"
SPECS = ROOT / "tools" / "commodity-carry-pilot" / "mt5_specs.json"
DEFAULT_OUT = "/mnt/c/Users/flooe/carry_book.json"
ENERGY = {"USOIL.cash", "UKOIL.cash", "HEATOIL.c", "NATGAS.cash"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    book = json.loads(PILOT_BOOK.read_text())
    specs = json.loads(SPECS.read_text())["symbols"]
    out = {"date": dt.datetime.now(dt.UTC).date().isoformat(),
           "capital": book["capital"], "source": "pilot+mt5specs",
           "positions": {}}
    gross = energy_long = 0.0
    for sym, pos in book["positions"].items():
        spec = specs.get(sym)
        if spec is None:
            print(f"WARN {sym}: no MT5 spec — skipped (re-run ftmo_mt5_probe)")
            continue
        mid = (spec["bid"] + spec["ask"]) / 2
        step = spec["volume_step"]
        lots = max(spec["volume_min"], round(pos["lots"] / step) * step)
        lots = round(lots, 2)
        notional = lots * spec["contract_size"] * mid
        gross += notional
        if sym in ENERGY and pos["side"] == "long":
            energy_long += notional
        out["positions"][spec["mt5_name"]] = dict(side=pos["side"], lots=lots)
    Path(args.out).write_text(json.dumps(out, indent=1))
    print(f"deployed {len(out['positions'])} positions, gross ${gross:,.0f} "
          f"-> {args.out}")
    if gross:
        print(f"long-side energy concentration: {100*energy_long/gross:.1f}% of gross")


if __name__ == "__main__":
    main()
