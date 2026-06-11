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
    """Atomic write: tmp + fsync + rename + parent-dir-fsync.

    2026-05-18 Bug-Audit (HOCH): single open() for write+flush+fsync, then
    fsync the parent directory so the rename is durable across power loss.
    Round-3 (NIEDRIG): tmp suffix includes uuid in addition to pid.
    """
    import uuid
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}.{uuid.uuid4().hex[:8]}")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)
    try:
        dirfd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    except (OSError, AttributeError):
        pass


def update_symbol(symbol):
    """Returns (bars_added, last_open_ms).

    2026-05-18 Bug-Audit (HOCH): early-return `(0, 0)` for missing/empty cache
    files would have main()'s staleness-check silently skip them (`if last_open`
    filters them out). Raise FetchError so they surface as a real failure.
    """
    path = CACHE_DIR / f"{symbol}_{INTERVAL}.json"
    if not path.exists():
        raise FetchError(f"no cache file for {symbol} (run initial bake first)")
    # 2026-05-23 Wave1 audit fix: per-file try/except around json.load. Previously
    # a single corrupt cache file raised JSONDecodeError, propagated up through
    # update_symbol → only `FetchError` was caught in main() → entire batch aborted,
    # all subsequent symbols silently skipped. Now: corrupt cache = FetchError for
    # this symbol only, batch continues.
    try:
        with open(path) as f:
            existing = json.load(f)
    except (json.JSONDecodeError, ValueError) as e:
        raise FetchError(f"corrupt cache file for {symbol}: {e}")
    if not existing:
        raise FetchError(f"empty cache file for {symbol}")
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
        # 2026-05-24 Wave6 MED FIX (Agent 4): defensive type check.
        # Binance occasionally returns `{}` (rate-limit error wrapped) or
        # a dict-shaped error response that passes `if not batch:` (truthy)
        # but then crashes inside the iter loop with `row[0]` indexing.
        # Surface the protocol violation loudly instead.
        if not isinstance(batch, list):
            raise FetchError(
                f"unexpected response shape: {type(batch).__name__} "
                f"(expected list of kline arrays); raw={str(batch)[:200]}"
            )
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
        # 2026-05-18 Bug-Audit (HOCH): unified loop-exit logic. Previously
        # had 3 separate break conditions; now: if we didn't add anything OR
        # got a short batch, we're done. Advance cursor from the LAST kept
        # bar's open_time + 1 interval (not batch[-1] which could be a
        # rejected non-final bar).
        last_kept = new_bars[-1]["openTime"] if added_in_batch > 0 else None
        if last_kept is None or len(batch) < LIMIT:
            break
        cursor = last_kept + 30 * 60 * 1000
        time.sleep(0.1)  # rate-limit

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

def update_funding_symbol(symbol: str) -> tuple[int, int]:
    """2026-05-23 Wave1 audit fix: refresh funding-rate cache (8h-aligned events).
    Memory champion-debunk #5 disaster pattern: funding cache 14-21 days stale
    silently invalidated regime-confluence sweeps. Now part of standard refresh.
    """
    path = CACHE_DIR / f"{symbol}_funding.json"
    if not path.exists():
        # No baseline funding cache — skip silently (some symbols have no funding)
        return (0, 0)
    try:
        with open(path) as f:
            existing = json.load(f)
    except (json.JSONDecodeError, ValueError) as e:
        raise FetchError(f"corrupt funding cache for {symbol}: {e}")
    if not existing:
        return (0, 0)
    last_t = max(int(c["t"]) for c in existing)
    # Binance funding endpoint: /fapi/v1/fundingRate
    import urllib.request
    cursor = last_t + 1
    new_events = []
    while True:
        url = (
            f"https://fapi.binance.com/fapi/v1/fundingRate?symbol={symbol}"
            f"&startTime={cursor}&limit=1000"
        )
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                batch = json.load(r)
        except Exception as e:
            raise FetchError(f"funding fetch failed: {e}")
        if not batch:
            break
        for row in batch:
            t = int(row["fundingTime"])
            if t <= last_t:
                continue
            r_val = float(row["fundingRate"])
            new_events.append({"t": t, "r": r_val})
        if len(batch) < 1000:
            break
        cursor = int(batch[-1]["fundingTime"]) + 1
        time.sleep(0.1)
    if not new_events:
        return (0, last_t)
    by_t = {int(c["t"]): c for c in existing}
    for e in new_events:
        by_t[e["t"]] = e
    merged = sorted(by_t.values(), key=lambda c: int(c["t"]))
    # 2026-05-23 Wave2 fix (B1 HIGH): rotation cap. Funding events fire every
    # 8h → ~1095/year/symbol × 19 symbols = unbounded growth. JSON re-serialize
    # cost grows linearly. 50000 records = ~45 years of headroom; well past
    # any realistic backtest window.
    if len(merged) > 50000:
        merged = merged[-50000:]
    atomic_write_json(path, merged)
    print(f"  [{symbol}_funding] +{len(new_events)} events (total={len(merged)})")
    return len(new_events), int(merged[-1]["t"])


def main():
    """2026-05-18 Bug-Audit: failures are now LOUD (sys.exit(1)) so the
    supervisor knows the cache is stale.

    2026-05-23 Wave1 audit fix: also refresh funding caches (was 14-21 days
    stale, silently invalidated regime/funding-aware sweeps).
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
    print(f"\n📊 Refreshing funding caches...")
    for sym in SYMBOLS:
        try:
            added, _ = update_funding_symbol(sym)
            total += added
        except FetchError as e:
            failures.append(f"{sym}_funding: {e}")
        time.sleep(0.1)
    print(f"\n✅ Total entries added: {total}")
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
