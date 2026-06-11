#!/usr/bin/env python3
"""Swap-persistence analysis over the FTMO swap-history series.

Answers the last open question of the commodity-carry candidate WITHOUT
waiting for forward collection: do FTMO's commodity swaps persist (structure)
or jitter (snapshot luck)? History sources: daily logger (03:30 cron) +
Wayback-Machine backfill of the same API (2026-03-02/04-11/04-29 found
2026-06-09 — the API is archived; check web.archive.org/cdx for more).

Per snapshot: annualise each commodity's best swap side using the price ON
THAT DAY (15y Yahoo daily history in /tmp/commod_hist, refetch via
commodity_carry_mc.py docstring if missing), apply the pilot's book logic,
print side-stability and the book's swap income per date.

First result (4 points over 3.3 months): income +6.0/+5.4/+8.7/+7.7 %/yr —
consistently in the 5-8% band = the 48-56%-funded zone of the geometry MC.
7/13 sides fully stable; flips are economic (NatGas season, oil moving into
backwardation), ~1-2 side changes/month.
"""
from __future__ import annotations
import datetime as dt, json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HIST = Path("/tmp/commod_hist")
SWAP_F = ROOT / "tools" / "ftmo-swap-history" / "swap-history.jsonl"
MAP = {"USOIL.cash": "CL", "UKOIL.cash": "BZ", "NATGAS.cash": "NG",
       "HEATOIL.c": "HO", "SOYBEAN.c": "ZS", "CORN.c": "ZC", "WHEAT.c": "ZW",
       "COCOA.c": "CC", "COFFEE.c": "KC", "COTTON.c": "CT", "SUGAR.c": "SB",
       "XAU/USD": "GC", "XAG/USD": "SI"}
MIN_CARRY = 1.5


def main():
    hist = {}
    for code, sym in MAP.items():
        p = HIST / f"{sym}.json"
        if p.exists():
            hist[code] = {int(t) // 86400: c for t, c in json.loads(p.read_text())}
    if not hist:
        raise SystemExit("no price history in /tmp/commod_hist — refetch first")

    def price_at(code, day):
        h = hist.get(code, {})
        for d in range(day, day - 10, -1):
            if d in h:
                return h[d]
        return None

    snaps = [json.loads(l) for l in SWAP_F.read_text().splitlines() if l]
    dates = [r["date"] for r in snaps]
    table: dict[str, dict[str, tuple]] = {}
    for r in snaps:
        day = int(dt.datetime.fromisoformat(r["date"] + "T00:00+00:00")
                  .timestamp()) // 86400
        for s in r["symbols"]:
            if s["code"] not in MAP:
                continue
            p = price_at(s["code"], day)
            if not p:
                continue
            point = 10 ** -s["d"]
            annl = s["sl"] * point / p * 364 * 100
            anns = s["ss"] * point / p * 364 * 100
            table.setdefault(s["code"], {})[r["date"]] = (annl, anns)

    print(f"{'commodity':<13}" + "".join(f" | {d[5:]:>8}" for d in dates))
    income = {d: ([], []) for d in dates}
    for code in sorted(table):
        cells, sides = [], []
        for d in dates:
            if d not in table[code]:
                cells.append(f"{'—':>8}")
                sides.append(None)
                continue
            annl, anns = table[code][d]
            side, ann = ("L", annl) if annl >= anns else ("S", anns)
            if ann >= MIN_CARRY:
                income[d][0 if side == "L" else 1].append(ann)
                sides.append(side)
            else:
                sides.append("-")
            cells.append(f"{side}{ann:>+7.1f}")
        seq = "".join(s or "?" for s in sides)
        tag = "STABLE" if len(set(s for s in sides if s and s != '-')) <= 1 else f"flip:{seq}"
        print(f"{code:<13}" + " | ".join(cells) + f"  {tag}")
    print("\nbook swap income per date (0.5 gross per side, equal weight):")
    for d in dates:
        L, S = income[d]
        if L and S:
            inc = 0.5 * sum(L) / len(L) + 0.5 * sum(S) / len(S)
            print(f"  {d}: {len(L)}L/{len(S)}S  {inc:+.2f}%/yr")
        else:
            print(f"  {d}: not constructible ({len(L)}L/{len(S)}S)")


if __name__ == "__main__":
    main()
