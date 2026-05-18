#!/usr/bin/env python3
"""
2026-05-17 Cache Updater for live supervisor.
Fetches latest 30m klines from Binance and appends to existing cache files.
Idempotent (dedup by openTime). Required for live supervisor to use the
real Rust voter engine via ftmo-sweep.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

CACHE_DIR = Path("scripts/cache_bakeoff")
SYMBOLS = ["AAVEUSDT", "ADAUSDT", "ALGOUSDT", "ARBUSDT", "ATOMUSDT",
           "AVAXUSDT", "BCHUSDT", "BNBUSDT", "BTCUSDT", "DOTUSDT",
           "ETCUSDT", "ETHUSDT", "LINKUSDT", "LTCUSDT", "NEARUSDT",
           "SOLUSDT", "TRXUSDT", "UNIUSDT", "XRPUSDT"]
INTERVAL = "30m"
LIMIT = 1000  # max bars per request

class FetchError(Exception):
    """Raised when fetch failed and caller should abort symbol update."""


def fetch_klines(symbol, start_ms):
    """Fetch up to 1000 bars starting from start_ms.

    2026-05-18 Bug-Audit: previously swallowed ALL errors and returned [],
    making 429/418 rate-limit errors silent. Now: retry with backoff on
    transient HTTP errors, raise FetchError on persistent failure.
    """
    url = (f"https://api.binance.com/api/v3/klines"
           f"?symbol={symbol}&interval={INTERVAL}&limit={LIMIT}&startTime={start_ms}")
    backoffs = (1, 3, 10)
    last_err: Exception | None = None
    for delay in backoffs:
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (418, 429):
                print(f"  [rate-limit] {symbol}: HTTP {e.code}, backing off {delay}s",
                      file=sys.stderr)
                time.sleep(delay)
                continue
            print(f"  [http-err] {symbol}: {e}", file=sys.stderr)
            raise FetchError(f"{symbol}: HTTP {e.code}")
        except Exception as e:
            last_err = e
            print(f"  [fetch-err] {symbol}: {e}, retry in {delay}s", file=sys.stderr)
            time.sleep(delay)
    raise FetchError(f"{symbol}: {last_err}")

def atomic_write_json(path: Path, data) -> None:
    """Atomic write to prevent reader (ftmo-sweep) from seeing truncated file."""
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(data))
    with open(tmp, "rb+") as f:
        os.fsync(f.fileno())
    tmp.replace(path)


def update_symbol(symbol):
    path = CACHE_DIR / f"{symbol}_{INTERVAL}.json"
    if not path.exists():
        print(f"  [skip] no cache file for {symbol}", file=sys.stderr)
        return (0, 0)
    with open(path) as f:
        existing = json.load(f)
    if not existing:
        return (0, 0)
    # Existing is sorted by openTime, get last bar
    last_open = max(c["openTime"] for c in existing)
    # Fetch from last_open + 30min (avoid duplicates)
    cursor = last_open + 30 * 60 * 1000
    new_bars = []
    while True:
        try:
            batch = fetch_klines(symbol, cursor)
        except FetchError as e:
            print(f"  [{symbol}] FETCH FAILED — {e}", file=sys.stderr)
            raise  # propagate to main() for non-zero exit
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
        return (0, max(c["openTime"] for c in existing))

    # Dedup-merge into existing
    by_t = {c["openTime"]: c for c in existing}
    for b in new_bars:
        if b["openTime"] not in by_t:
            by_t[b["openTime"]] = b
    merged = sorted(by_t.values(), key=lambda c: c["openTime"])
    # Keep last 100k bars (rolling)
    if len(merged) > 100000:
        merged = merged[-100000:]
    atomic_write_json(path, merged)
    print(f"  [{symbol}] +{len(new_bars)} bars (total={len(merged)})")
    return len(new_bars), merged[-1]["openTime"] if merged else 0

def main():
    """2026-05-18 Bug-Audit: failures are now LOUD (sys.exit(1)) so the
    supervisor knows the cache is stale.
    """
    total = 0
    failures: list[str] = []
    latest_per_sym: dict[str, int] = {}
    for sym in SYMBOLS:
        try:
            added, last_open = update_symbol(sym)
            total += added
            if last_open:
                latest_per_sym[sym] = last_open
        except FetchError as e:
            failures.append(f"{sym}: {e}")
        time.sleep(0.1)
    print(f"\n✅ Total bars added: {total}")
    if failures:
        print(f"\n❌ {len(failures)} symbols failed:", file=sys.stderr)
        for f in failures:
            print(f"   - {f}", file=sys.stderr)
        sys.exit(1)
    # Staleness check: if oldest "last bar" is >2h behind NOW, mark exit code 2.
    now_ms = int(time.time() * 1000)
    stale = [sym for sym, ts in latest_per_sym.items() if (now_ms - ts) > 2 * 3600 * 1000]
    if stale:
        print(f"\n⚠️ Cache stale (>2h old) for: {','.join(stale)}", file=sys.stderr)
        sys.exit(2)

if __name__ == "__main__":
    main()
