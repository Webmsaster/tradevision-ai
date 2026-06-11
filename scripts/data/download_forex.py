#!/usr/bin/env python3
"""
2026-05-17 Forex/Indizes cache downloader for cross-asset diversification.

Sources:
- Forex: Dukascopy historical CSV (free, 1-min OHLC, JSON-ZIP)
- Indizes: Yahoo Finance (US500/SPX, US100/NDX, GER40/DAX, JP225)
- Gold: Yahoo Finance GC=F

Output: scripts/cache_forex/<SYM>_2h.json mit Brownian-bridge-resample
        from 1-min to 2h (lookahead-safe — close = aligned 2h close).

Weekend-gap handling: Fri 22:00 UTC → Sun 22:00 UTC marker (no candle data).

Currency conversion: USDJPY/EURJPY etc. require pip_value × USDJPY-conv at
trade-close for USD-funded FTMO account.

Estimated total: 1-2 days (script + Dukascopy crawler + resample + validate
against TS-shadow + cache invalidation logic).
"""
import argparse
import sys
from pathlib import Path

FOREX_PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD"]
INDICES = ["^GSPC", "^IXIC", "^GDAXI", "^N225"]  # S&P500, NASDAQ, DAX, Nikkei
COMMODITIES = ["GC=F", "SI=F"]  # Gold, Silver

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default="scripts/cache_forex")
    ap.add_argument("--start-date", default="2022-01-01")
    ap.add_argument("--end-date", default="2026-05-16")
    ap.add_argument("--timeframe", default="2h", choices=["5m", "30m", "1h", "2h", "4h"])
    ap.add_argument("--asset-class", default="forex", choices=["forex", "indices", "commodities", "all"])
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    print(f"[SKELETON] Cross-Asset Cache Downloader")
    print(f"  out-dir: {args.out_dir}")
    print(f"  range: {args.start_date} → {args.end_date}")
    print(f"  timeframe: {args.timeframe}")
    print(f"  asset_class: {args.asset_class}")
    print()
    print(f"NEXT STEPS (not in skeleton):")
    print(f"  Forex (Dukascopy):")
    print(f"    pip install requests pandas")
    print(f"    1. Download 1-min CSV-ZIP per day per pair: {FOREX_PAIRS}")
    print(f"    2. Concatenate + resample to {args.timeframe}")
    print(f"    3. Weekend-gap markers (Fri 22:00 → Sun 22:00 UTC = no data)")
    print(f"    4. Write {{sym}}_{args.timeframe}.json in OHLCV format")
    print(f"  Indices (Yahoo):")
    print(f"    pip install yfinance")
    print(f"    yf.download({INDICES}, start, end, interval='2h')")
    print(f"  Commodities: same as indices")
    print()
    print(f"  Then update engine-rust/ftmo-engine-core/src/asset_class.rs:")
    print(f"    enum AssetClass {{ Crypto, Forex, Index, Commodity }}")
    print(f"    impl per-class session/weekend/pip-value handling")
    print()
    print(f"Risk: weekend-gap-handling für Forex; USD-conversion for non-USD-quote pairs")
    print(f"Status: Skeleton ready. Full implementation = ~1-2 days.")
    sys.exit(0)

if __name__ == "__main__":
    main()
