#!/usr/bin/env python3
"""
2026-05-17 Binance Premium-Index Kline Downloader.
Saves to scripts/cache_bakeoff/BTCUSDT_premium_30m.json
Schema: list of {t: ms, open: float, high: float, low: float, close: float}
"""
import json
import time
import urllib.request
from pathlib import Path

OUT = Path("scripts/cache_bakeoff/BTCUSDT_premium_30m.json")
SYMBOL = "BTCUSDT"
INTERVAL = "30m"
START_MS = int(__import__("datetime").datetime(2024, 1, 1).timestamp() * 1000)  # 2024-01-01 onwards
END_MS = int(time.time() * 1000)
BATCH_LIMIT = 1500

print(f"[fetch] {SYMBOL} {INTERVAL} premium-index from {START_MS} to {END_MS}")

all_klines = []
cursor = START_MS
while cursor < END_MS:
    url = (f"https://fapi.binance.com/fapi/v1/premiumIndexKlines"
           f"?symbol={SYMBOL}&interval={INTERVAL}&startTime={cursor}&limit={BATCH_LIMIT}")
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            batch = json.load(r)
    except Exception as e:
        print(f"  error at {cursor}: {e}")
        time.sleep(2)
        continue
    if not batch:
        break
    for row in batch:
        # row: [openTime, open, high, low, close, vol, closeTime, ...]
        all_klines.append({
            "t": int(row[0]),
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
        })
    last_t = int(batch[-1][0])
    print(f"  fetched up to {last_t} ({len(all_klines)} total)")
    if last_t <= cursor: break  # safety
    cursor = last_t + 30 * 60 * 1000  # next bar
    time.sleep(0.2)  # rate-limit polite

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(all_klines))
print(f"\n✅ Saved {len(all_klines)} bars to {OUT}")
print(f"  First: {all_klines[0] if all_klines else None}")
print(f"  Last:  {all_klines[-1] if all_klines else None}")
