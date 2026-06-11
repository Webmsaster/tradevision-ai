#!/usr/bin/env python3
"""Daily logger for FTMO's symbol API swap rates -> tools/ftmo-swap-history/.

Why: FTMO's cash-CFD swaps pass through the commodity futures term structure
(verified 2026-06-09: WTI curve +20%/yr backwardation vs FTMO swapLong +15%/yr;
NatGas contango vs swapShort +15%/yr). That makes the documented commodity
carry premium (long backwardation / short contango, x-sectional) tradeable on
FTMO — the first FTMO-compatible structural premium found in this project.
There is NO historical swap series anywhere, so we forward-collect it daily
(same philosophy as the xsec funding-carry paper track).

Output: one JSONL line per day with every active instrument's swapLong/
swapShort/digits + assetClass. Idempotent: skips if today already logged.
"""
from __future__ import annotations
import datetime as dt, json, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "tools" / "ftmo-swap-history"
URL = "https://ftmo.com/wp-json/ftmo/symbols"


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_f = OUT_DIR / "swap-history.jsonl"
    today = dt.datetime.now(dt.UTC).date().isoformat()
    if out_f.exists():
        for line in out_f.read_text().splitlines():
            if line and json.loads(line)["date"] == today:
                print(f"{today} already logged")
                return
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    syms = json.load(urllib.request.urlopen(req, timeout=30))["data"]["symbols"]
    rec = dict(date=today, symbols=[
        dict(code=s["code"], cls=s["assetClass"], sl=s["swapLong"],
             ss=s["swapShort"], st=s["swapType"], d=s["digits"])
        for s in syms if s.get("active")])
    with out_f.open("a") as fh:
        fh.write(json.dumps(rec) + "\n")
    print(f"{today}: logged {len(rec['symbols'])} instruments")


if __name__ == "__main__":
    main()
