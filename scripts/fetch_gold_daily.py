#!/usr/bin/env python3
"""Fetch PAXG (PAX Gold, gold-pegged) daily klines from Binance as a gold proxy.

The repo's GOLD_1h.json had only 86 bars (broken). PAXGUSDT tracks spot gold
closely, trades 24/7 (no weekend gaps), and has ~6yr of Binance history — enough
to run the same edge gate the literature says is gold's best shot. Saves to
scripts/cache_forex_indices/GOLD_daily.json in the engine's candle schema.
"""
import json, time, urllib.request, datetime as dt
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "scripts/cache_forex_indices"


def klines(sym, interval="1d", limit=1000, end=None):
    url = f"https://api.binance.com/api/v3/klines?symbol={sym}&interval={interval}&limit={limit}"
    if end:
        url += f"&endTime={end}"
    return json.loads(urllib.request.urlopen(url, timeout=30).read())


def fetch_all(sym, interval="1d"):
    out = {}
    end = None
    for _ in range(10):
        b = klines(sym, interval=interval, end=end)
        if not b:
            break
        for k in b:
            out[int(k[0])] = k
        end = int(b[0][0]) - 1
        if len(b) < 1000:
            break
        time.sleep(0.2)
    ks = sorted(out.values(), key=lambda k: int(k[0]))
    return [{"openTime": int(k[0]), "open": float(k[1]), "high": float(k[2]),
             "low": float(k[3]), "close": float(k[4]), "volume": float(k[5]),
             "isFinal": True} for k in ks]


def main():
    for sym, name in [("PAXGUSDT", "GOLD")]:
        try:
            c = fetch_all(sym)
            (OUT / f"{name}_daily.json").write_text(json.dumps(c))
            f = dt.datetime.utcfromtimestamp(c[0]["openTime"] / 1000).date()
            l = dt.datetime.utcfromtimestamp(c[-1]["openTime"] / 1000).date()
            lc = c[-1]["close"]
            print(f"{name}({sym}): {len(c)} daily bars, {f} -> {l}, last close={lc}")
        except Exception as e:
            print(f"{sym} FAILED: {e}")


if __name__ == "__main__":
    main()
