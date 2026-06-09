#!/usr/bin/env python3
"""Commodity-carry pilot book for FTMO — swap-signal to MT5 order plan.

Signal = FTMO's OWN swap rates (live API): hold the side the swap PAYS,
which (verified 2026-06-09 against real futures curves, 12/13 agree) is the
futures term structure passed through. Long backwardation / short contango —
the documented commodity carry premium, expressed in FTMO's own instruments.

Output: dollar-neutral book (0.5 gross per side, equal weight within side)
translated into MT5 lots via contractSize and live prices, plus the expected
annual swap income. Designed for the FTMO Free Trial first (demo books real
swaps overnight -> 1-2 weeks measures the net premium for free), then a paid
challenge only if the premium confirms.

State in tools/commodity-carry-pilot/book.json; re-running diffs against the
held book and prints only needed changes (rebalance on side-flips, weekly).
Leverage 1 is optimal (challenge-geometry MC: leverage strictly hurts).
"""
from __future__ import annotations
import argparse, datetime as dt, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from ftmo_carry_scan import get_json, yahoo_price, YAHOO  # noqa: E402

STATE_DIR = ROOT / "tools" / "commodity-carry-pilot"
URL = "https://ftmo.com/wp-json/ftmo/symbols"
COMMODITY_CLASSES = {"Cash CFD", "Metals CFD"}
# indices/bonds are not term-structure carry; restrict to true commodities
COMMODITIES = {"USOIL.cash", "UKOIL.cash", "NATGAS.cash", "HEATOIL.c",
               "SOYBEAN.c", "CORN.c", "WHEAT.c", "COCOA.c", "COFFEE.c",
               "COTTON.c", "SUGAR.c", "XAU/USD", "XAG/USD",
               "XPT/USD", "XPD/USD"}
# XCU/USD excluded: FTMO quote unit unverified (HG=F is $/lb, CFD likely
# $/tonne -> the computed +122%/yr carry and lot size are unit artifacts).
# Re-add once the Free-Trial MT5 shows the real quote.
MIN_CARRY_ANN = 1.5      # %/yr; below this the side is noise, skip


def inverse_vol_factors() -> dict[str, float]:
    """Per-instrument 1/vol from the 15y history cache (clipped daily rets).
    Falls back to {} (equal weight) if /tmp/commod_hist is absent."""
    import math
    hist_map = {"USOIL.cash": "CL", "UKOIL.cash": "BZ", "NATGAS.cash": "NG",
                "HEATOIL.c": "HO", "SOYBEAN.c": "ZS", "CORN.c": "ZC",
                "WHEAT.c": "ZW", "COCOA.c": "CC", "COFFEE.c": "KC",
                "COTTON.c": "CT", "SUGAR.c": "SB", "XAU/USD": "GC",
                "XAG/USD": "SI"}
    out = {}
    for code, sym in hist_map.items():
        p = Path("/tmp/commod_hist") / f"{sym}.json"
        if not p.exists():
            continue
        rows = json.loads(p.read_text())
        closes = [c for _, c in rows]
        rets = [max(-0.5, min(0.5, b / a - 1.0))
                for a, b in zip(closes, closes[1:]) if a]
        m = sum(rets) / len(rets)
        sd = math.sqrt(sum((x - m) ** 2 for x in rets) / len(rets))
        if sd > 0:
            out[code] = 1.0 / sd
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--capital", type=float, default=10_000.0,
                    help="account size in USD (Free Trial default 10k... set to yours)")
    ap.add_argument("--vol-weighted", action="store_true",
                    help="inverse-vol weights within each side (recommended: "
                         "+5pp funded, enables lev 1.7-2.0 with -3.5%% daily "
                         "stop for 2.6-3.5mo median time-to-funded)")
    args = ap.parse_args()

    syms = {s["code"]: s for s in get_json(URL)["data"]["symbols"]
            if s.get("active") and s["code"] in COMMODITIES}
    candidates = []
    for code, s in syms.items():
        p = yahoo_price(YAHOO[code]) if code in YAHOO else None
        if not p:
            continue
        point = 10 ** -s["digits"]
        annl = s["swapLong"] * point / p * 364 * 100
        anns = s["swapShort"] * point / p * 364 * 100
        side, ann = ("long", annl) if annl >= anns else ("short", anns)
        if ann >= MIN_CARRY_ANN:
            candidates.append(dict(code=code, side=side, ann=ann, price=p,
                                   contractSize=s["contractSize"],
                                   digits=s["digits"]))

    longs = [c for c in candidates if c["side"] == "long"]
    shorts = [c for c in candidates if c["side"] == "short"]
    if not longs or not shorts:
        sys.exit("book not constructible (need both sides) — market regime check")

    iv = inverse_vol_factors() if args.vol_weighted else {}
    for group, w_side in ((longs, 0.5), (shorts, 0.5)):
        tot = sum(iv.get(c["code"], 1.0) for c in group) if iv else len(group)
        for c in group:
            c["weight"] = w_side * (iv.get(c["code"], 1.0) / tot if iv
                                    else 1.0 / len(group))
            notional = c["weight"] * args.capital
            c["lots"] = round(notional / (c["contractSize"] * c["price"]), 2)
            c["notional"] = notional

    income = sum(c["weight"] * c["ann"] for c in candidates)
    date = dt.datetime.now(dt.UTC).date().isoformat()
    print(f"=== {date} commodity-carry pilot book | ${args.capital:,.0f} | "
          f"gross 1.0 | expected swap income {income:.2f}%/yr ===")
    for c in sorted(candidates, key=lambda c: (c["side"], -c["ann"])):
        print(f"  {c['side']:<5} {c['code']:<13} carry {c['ann']:>+6.2f}%/yr  "
              f"w {100*c['weight']:>4.1f}%  ${c['notional']:>7.0f}  "
              f"lots {c['lots']:>6.2f}")

    # diff vs held book
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    book_f = STATE_DIR / "book.json"
    held = json.loads(book_f.read_text())["positions"] if book_f.exists() else {}
    new = {c["code"]: dict(side=c["side"], lots=c["lots"]) for c in candidates}
    changes = []
    for code in sorted(set(held) | set(new)):
        h, m = held.get(code), new.get(code)
        if h and not m:
            changes.append(f"CLOSE {code} ({h['side']} {h['lots']})")
        elif m and not h:
            changes.append(f"OPEN  {code} {m['side']} {m['lots']} lots")
        elif h and m and (h["side"] != m["side"] or abs(h["lots"] - m["lots"]) > 0.02):
            changes.append(f"FLIP/RESIZE {code} {h['side']} {h['lots']} -> "
                           f"{m['side']} {m['lots']}")
    if changes:
        print(f"\n{len(changes)} order(s) vs held book:")
        for ch in changes:
            print(f"  {ch}")
    else:
        print("\nheld book already on target — no orders")
    book_f.write_text(json.dumps(dict(date=date, capital=args.capital,
                                      income_ann_pct=round(income, 2),
                                      positions=new), indent=1))
    with (STATE_DIR / "book-history.jsonl").open("a") as fh:
        fh.write(json.dumps(dict(date=date, income=round(income, 2),
                                 n=len(candidates))) + "\n")


if __name__ == "__main__":
    main()
