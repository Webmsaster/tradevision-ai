#!/usr/bin/env python3
"""
2026-05-17 Cache Updater for live supervisor.
Fetches latest 30m klines from Binance and appends to existing cache files.
Idempotent (dedup by openTime). Required for live supervisor to use the
real Rust voter engine via ftmo-sweep.
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

CACHE_DIR = Path("scripts/cache_bakeoff")
SYMBOLS = ["AAVEUSDT", "ADAUSDT", "ALGOUSDT", "ARBUSDT", "ATOMUSDT",
           "AVAXUSDT", "BCHUSDT", "BNBUSDT", "BTCUSDT", "DOTUSDT",
           "ETCUSDT", "ETHUSDT", "LINKUSDT", "LTCUSDT", "NEARUSDT",
           "SOLUSDT", "TRXUSDT", "UNIUSDT", "XRPUSDT"]
INTERVAL = "30m"
LIMIT = 1000  # max bars per request

def fetch_klines(symbol, start_ms):
    """Fetch up to 1000 bars starting from start_ms."""
    url = (f"https://api.binance.com/api/v3/klines"
           f"?symbol={symbol}&interval={INTERVAL}&limit={LIMIT}&startTime={start_ms}")
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return json.load(r)
    except Exception as e:
        print(f"  [fetch-err] {symbol}: {e}", file=sys.stderr)
        return []

def update_symbol(symbol):
    path = CACHE_DIR / f"{symbol}_{INTERVAL}.json"
    if not path.exists():
        print(f"  [skip] no cache file for {symbol}", file=sys.stderr)
        return 0
    existing = json.load(open(path))
    if not existing:
        return 0
    # Existing is sorted by openTime, get last bar
    last_open = max(c["openTime"] for c in existing)
    # Fetch from last_open + 30min (avoid duplicates)
    cursor = last_open + 30 * 60 * 1000
    new_bars = []
    while True:
        batch = fetch_klines(symbol, cursor)
        if not batch:
            break
        # Filter: only bars with openTime > last_open + drop non-final
        added_in_batch = 0
        for row in batch:
            # row format from kline API:
            # [openTime, open, high, low, close, vol, closeTime, qVol, ntrades, tbVol, tqVol, ignore]
            ot = int(row[0])
            close_time = int(row[6])
            # Only "final" bars (close_time strictly before now)
            now_ms = int(time.time() * 1000)
            if close_time >= now_ms - 1000:
                continue
            new_bars.append({
                "openTime": ot,
                "open": float(row[1]),
                "high": float(row[2]),
                "low": float(row[3]),
                "close": float(row[4]),
                "volume": float(row[5]),
                "closeTime": close_time,
                "isFinal": True,
                "takerBuyVolume": float(row[9]) if len(row) > 9 else 0.0,
            })
            added_in_batch += 1
        if added_in_batch == 0:
            break
        cursor = int(batch[-1][0]) + 30 * 60 * 1000
        time.sleep(0.1)  # rate-limit
        if len(batch) < LIMIT:
            break

    if not new_bars:
        print(f"  [{symbol}] no new bars")
        return 0

    # Dedup-merge into existing
    by_t = {c["openTime"]: c for c in existing}
    for b in new_bars:
        if b["openTime"] not in by_t:
            by_t[b["openTime"]] = b
    merged = sorted(by_t.values(), key=lambda c: c["openTime"])
    # Keep last 100k bars (rolling)
    if len(merged) > 100000:
        merged = merged[-100000:]
    path.write_text(json.dumps(merged))
    print(f"  [{symbol}] +{len(new_bars)} bars (total={len(merged)})")
    return len(new_bars)

def main():
    total = 0
    for sym in SYMBOLS:
        total += update_symbol(sym)
        time.sleep(0.1)
    print(f"\n✅ Total bars added: {total}")

if __name__ == "__main__":
    main()
