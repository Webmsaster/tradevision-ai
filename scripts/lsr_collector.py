#!/usr/bin/env python3
"""
2026-05-17 Binance Long/Short-Ratio Live-Logger.
Codex Plan: collect LSR data forward for 30-60 days, use as gating signal.

Fetches 3 endpoints for BTC/ETH/SOL/BNB:
  - /futures/data/globalLongShortAccountRatio
  - /futures/data/topLongShortAccountRatio
  - /futures/data/topLongShortPositionRatio

Storage: JSONL append-only, parallel to funding schema.
Files:
  scripts/cache_bakeoff/{SYM}_lsr_global_30m.json
  scripts/cache_bakeoff/{SYM}_lsr_top_accounts_30m.json
  scripts/cache_bakeoff/{SYM}_lsr_top_positions_30m.json

Schema per record:
  {"t": <unix-ms>, "r": <ratio>, "l": <long-frac>, "s": <short-frac>}

Run modes:
  python3 scripts/lsr_collector.py            # one-shot incremental pull
  python3 scripts/lsr_collector.py --daemon   # loop every 30min
  python3 scripts/lsr_collector.py --backfill # try max history (~10 days)
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

CACHE_DIR = Path("scripts/cache_bakeoff")
SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"]
PERIOD = "30m"

ENDPOINTS = {
    "global":         "globalLongShortAccountRatio",
    "top_accounts":   "topLongShortAccountRatio",
    "top_positions":  "topLongShortPositionRatio",
}

def fetch(endpoint_name, symbol, limit=500):
    """Fetch up to `limit` records from Binance for this endpoint+symbol.

    2026-05-23 Wave2 fix (B4 LOW): silent-fail anti-pattern. Previously
    returned [] on ANY exception (rate-limit 429, 418-IP-ban, network) →
    daemon thought it was healthy while feeding empty caches for hours.
    Same bug-class fixed in cache_updater.fetch_klines earlier (2026-05-18).
    Now retry once on network errors and raise on 4xx/5xx so the operator
    sees a real failure instead of a silent stale cache.
    """
    import urllib.error as _urllib_error
    import urllib.request as _urllib_request
    url = (f"https://fapi.binance.com/futures/data/{endpoint_name}"
           f"?symbol={symbol}&period={PERIOD}&limit={limit}")
    last_err = None
    for attempt in range(2):
        try:
            with _urllib_request.urlopen(url, timeout=20) as r:
                return json.load(r)
        except _urllib_error.HTTPError as e:
            # 4xx (rate-limit, banned IP) or 5xx — re-raise so caller sees it.
            last_err = e
            if e.code in (429, 418):
                # IP-rate-limit / temporary ban: bubble up immediately so
                # the daemon can back off; do NOT silently return [].
                raise
            if 500 <= e.code < 600 and attempt < 1:
                time.sleep(1.0 + attempt)
                continue
            raise
        except (_urllib_error.URLError, OSError) as e:
            # Network hiccup — retry once, then raise.
            last_err = e
            if attempt < 1:
                time.sleep(1.0)
                continue
            raise
    # Unreachable but pleases the type-checker.
    raise RuntimeError(f"lsr_collector.fetch exhausted retries: {last_err}")

def normalize(record):
    """Convert API response to our schema."""
    return {
        "t": int(record["timestamp"]),
        "r": float(record["longShortRatio"]),
        "l": float(record["longAccount"]),
        "s": float(record["shortAccount"]),
    }

def file_for(symbol, kind):
    return CACHE_DIR / f"{symbol}_lsr_{kind}_{PERIOD}.json"

def load_existing(path):
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as e:
        # 2026-05-23 Wave2 fix (B5 LOW): back up corrupt cache before
        # returning empty. Without this, the next merge would silently
        # overwrite the file with new data only and the history is gone.
        try:
            ts = int(time.time())
            backup_path = path.with_suffix(path.suffix + f".corrupt.{ts}")
            path.rename(backup_path)
            print(f"  [lsr-load] CORRUPT JSON in {path.name} → backed up to "
                  f"{backup_path.name} ({e})", file=sys.stderr)
        except OSError:
            pass
        return []

# 2026-05-23 Wave2 fix (B3 MED): TF-aware rotation cap. The hardcoded magic
# number 100k assumed 30m period. Switching PERIOD to "5m" would silently
# truncate to ~347 days. Express cap as years-coverage instead.
_BARS_PER_DAY = {"5m": 288, "15m": 96, "30m": 48, "1h": 24, "2h": 12, "4h": 6}
_MAX_YEARS = 6

def _max_records() -> int:
    bars_per_day = _BARS_PER_DAY.get(PERIOD, 48)
    return int(bars_per_day * 365 * _MAX_YEARS)

def merge_and_save(path, existing, new_records):
    """Merge by timestamp (newest wins), sort, save."""
    by_t = {r["t"]: r for r in existing}
    for r in new_records:
        by_t[r["t"]] = r  # overwrite if same ts (latest from API wins)
    merged = sorted(by_t.values(), key=lambda r: r["t"])
    # 2026-05-23 Wave2 fix (B2 HIGH): rotation cap. LSR cache had ZERO bound
    # → daemon-mode growth was linear forever, and full re-read+re-write
    # every 30min became O(n²) over time.
    cap = _max_records()
    if len(merged) > cap:
        merged = merged[-cap:]
    # 2026-05-23 Wave2 fix (B6 LOW): atomic write via tmp+rename so a
    # SIGKILL / power-loss mid-write can't corrupt the file.
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(merged))
    tmp.replace(path)
    return len(merged), len(new_records)

def collect_once():
    """One-shot incremental collection."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    summary = []
    for kind, endpoint in ENDPOINTS.items():
        for sym in SYMBOLS:
            time.sleep(0.3)  # rate-limit polite
            raw = fetch(endpoint, sym, limit=500)
            if not raw:
                continue
            new = [normalize(r) for r in raw]
            path = file_for(sym, kind)
            existing = load_existing(path)
            total, _ = merge_and_save(path, existing, new)
            summary.append((kind, sym, len(new), total))
            print(f"  [{kind:<14}] {sym}: fetched={len(new):<4} total_stored={total}")
    return summary

def daemon_loop(interval_sec=1800):
    """Loop forever, fetch every interval_sec."""
    print(f"[daemon] LSR collector starting, interval={interval_sec}s")
    while True:
        start = time.time()
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        print(f"\n[{ts}] tick")
        try:
            collect_once()
        except KeyboardInterrupt:
            print("\n[daemon] interrupted, exiting cleanly")
            return
        except Exception as e:
            print(f"  [tick-err] {e}", file=sys.stderr)
        elapsed = time.time() - start
        wait = max(60, interval_sec - elapsed)
        print(f"  [tick] elapsed={elapsed:.1f}s, sleeping {wait:.0f}s")
        time.sleep(wait)

def main():
    daemon = "--daemon" in sys.argv
    if daemon:
        daemon_loop()
    else:
        print("[one-shot] LSR incremental pull")
        summary = collect_once()
        if not summary:
            print("\nNo data fetched.")
            return
        print(f"\n=== Summary: {len(summary)} endpoint×symbol pulls ===")
        for kind, sym, fetched, total in summary:
            print(f"  {kind:<14} {sym:<10} +{fetched} (total={total})")

if __name__ == "__main__":
    main()
