#!/usr/bin/env python3
"""Scan FTMO's own symbol API for harvestable SWAP CARRY across all asset
classes — the structural-premium angle never tested on FTMO instruments.

Question: does FTMO pass through enough of the real interest-rate / dividend /
roll differential that a held book can EARN swaps (classic FX carry), or does
the broker markup eat it (as it does on crypto: -30%/-30% both sides)?

Method:
  - swap "points" are MT5 points = 10^-digits price units, charged per night,
    ~364 charges/yr (incl. triple-swap day).
      ann% = swap_points * 10^-digits / price * 364 * 100
  - prices: ECB/frankfurter.app for FX crosses, Yahoo chart API for indices/
    commodities/metals (CFD vs futures basis < 2%, fine for this purpose),
    crypto is percentage-type (-30% both sides, known).
  - markup estimate per pair: fair swap satisfies swapLong ~= -swapShort
    (interest differential changes sign); broker take = -(swapLong+swapShort)/2.

Output: every instrument's annualised long/short swap, the positive book
(what a maximally carry-positive FTMO portfolio would earn), and the markup.
"""
from __future__ import annotations
import json, urllib.parse, urllib.request

UA = {"User-Agent": "Mozilla/5.0"}


def get_json(url: str):
    req = urllib.request.Request(url, headers=UA)
    return json.load(urllib.request.urlopen(req, timeout=30))


def fx_rates():
    """ECB rates via frankfurter.app, USD base."""
    d = get_json("https://api.frankfurter.app/latest?from=USD")
    r = d["rates"]
    r["USD"] = 1.0
    r["CNH"] = r.get("CNY")  # offshore ~ onshore for this purpose
    return r


YAHOO = {
    "US30.cash": "^DJI", "US100.cash": "^NDX", "US500.cash": "^GSPC",
    "US2000.cash": "^RUT", "UK100.cash": "^FTSE", "GER40.cash": "^GDAXI",
    "EU50.cash": "^STOXX50E", "FRA40.cash": "^FCHI", "JP225.cash": "^N225",
    "AUS200.cash": "^AXJO", "HK50.cash": "^HSI", "N25.cash": "^AEX",
    "SWI20.cash": "^SSMI", "ES35.cash": "^IBEX", "DXY.cash": "DX-Y.NYB",
    "USOIL.cash": "CL=F", "UKOIL.cash": "BZ=F", "NATGAS.cash": "NG=F",
    "SOYBEAN.c": "ZS=F", "CORN.c": "ZC=F", "WHEAT.c": "ZW=F",
    "COCOA.c": "CC=F", "COFFEE.c": "KC=F", "COTTON.c": "CT=F",
    "SUGAR.c": "SB=F", "HEATOIL.c": "HO=F",
    "XAU/USD": "GC=F", "XAG/USD": "SI=F", "XCU/USD": "HG=F",
    "XPT/USD": "PL=F", "XPD/USD": "PA=F",
}


def yahoo_price(ticker: str):
    try:
        d = get_json(f"https://query1.finance.yahoo.com/v8/finance/chart/"
                     f"{urllib.parse.quote(ticker)}?range=1d&interval=1d")
        return float(d["chart"]["result"][0]["meta"]["regularMarketPrice"])
    except Exception:
        return None


def main():
    syms = get_json("https://ftmo.com/wp-json/ftmo/symbols")["data"]["symbols"]
    fx = fx_rates()

    def price_of(s):
        code = s["code"]
        if s["assetClass"] in ("Forex", "Exotics"):
            base, quote = code.split("/")
            if base in fx and quote in fx and fx[base] and fx[quote]:
                return fx[quote] / fx[base]
            return None
        if code in YAHOO:
            return yahoo_price(YAHOO[code])
        if "/" in code and code.split("/")[1] in fx:   # XAU/EUR, XAG/AUD
            usd_code = code.split("/")[0] + "/USD"
            p = yahoo_price(YAHOO.get(usd_code, ""))
            return p * fx[code.split("/")[1]] if p else None
        return None

    rows = []
    for s in syms:
        if not s.get("active") or s["swapType"] != "points":
            continue
        p = price_of(s)
        if not p:
            rows.append((s["code"], s["assetClass"], None, None, None))
            continue
        point = 10 ** -s["digits"]
        annl = s["swapLong"] * point / p * 364 * 100
        anns = s["swapShort"] * point / p * 364 * 100
        markup = -(annl + anns) / 2
        rows.append((s["code"], s["assetClass"], annl, anns, markup))

    print(f"{'code':<13}{'class':<11}{'long %/yr':>10} {'short %/yr':>10} "
          f"{'markup %/yr':>11}")
    have = [r for r in rows if r[2] is not None]
    for code, ac, annl, anns, markup in sorted(have, key=lambda r: -max(r[2], r[3])):
        best = max(annl, anns)
        flag = " <-- EARNS" if best > 1.0 else ""
        print(f"{code:<13}{ac:<11}{annl:>10.2f} {anns:>10.2f} {markup:>11.2f}{flag}")
    skipped = [r[0] for r in rows if r[2] is None]
    if skipped:
        print(f"\nno price ({len(skipped)}): {', '.join(skipped)}")

    pos = [(c, max(l, s)) for c, _, l, s, _ in have if max(l, s) > 0]
    pos.sort(key=lambda x: -x[1])
    print(f"\n=== POSITIVE-CARRY BOOK ({len(pos)} instruments) ===")
    print("equal-weight gross book earns "
          f"{sum(x for _, x in pos) / len(pos):.2f}%/yr on gross notional"
          if pos else "none")
    print("top 10:", ", ".join(f"{c} {x:+.2f}%" for c, x in pos[:10]))
    avg_markup = sum(m for *_, m in have) / len(have)
    print(f"\navg broker markup across priced instruments: {avg_markup:.2f}%/yr per side")
    print("crypto (percentage type, from API): -30%/yr BOTH sides, all 31")


if __name__ == "__main__":
    main()
