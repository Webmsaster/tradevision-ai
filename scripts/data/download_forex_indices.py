#!/usr/bin/env python3
"""2026-05-17 Download Forex + Indices + Gold via yfinance.
Stores OHLCV-2h-bars as JSON compatible with existing engine format.
"""
import argparse
import json
import sys
from pathlib import Path

try:
    import yfinance as yf
except ImportError:
    print("Install: pip install --user --break-system-packages yfinance"); sys.exit(1)

# Yahoo tickers
FOREX = {"EURUSD": "EURUSD=X", "GBPUSD": "GBPUSD=X", "USDJPY": "USDJPY=X",
         "USDCHF": "USDCHF=X", "AUDUSD": "AUDUSD=X"}
INDICES = {"SPX": "^GSPC", "NDX": "^IXIC", "DAX": "^GDAXI", "N225": "^N225"}
COMMODITIES = {"GOLD": "GC=F", "SILVER": "SI=F"}

def download(name, ticker, interval="1h", period="2y"):
    print(f"  {name:8} ({ticker})", end=" ")
    try:
        df = yf.download(ticker, period=period, interval=interval, progress=False, auto_adjust=False)
        if df.empty:
            print("EMPTY")
            return None
        candles = []
        for ts, row in df.iterrows():
            try:
                candles.append({
                    "open_time": int(ts.timestamp() * 1000),
                    "close_time": int(ts.timestamp() * 1000) + 3600_000,
                    "open": float(row["Open"].iloc[0]) if hasattr(row["Open"], 'iloc') else float(row["Open"]),
                    "high": float(row["High"].iloc[0]) if hasattr(row["High"], 'iloc') else float(row["High"]),
                    "low": float(row["Low"].iloc[0]) if hasattr(row["Low"], 'iloc') else float(row["Low"]),
                    "close": float(row["Close"].iloc[0]) if hasattr(row["Close"], 'iloc') else float(row["Close"]),
                    "volume": float(row["Volume"].iloc[0]) if hasattr(row["Volume"], 'iloc') else float(row["Volume"]),
                })
            except (ValueError, TypeError, KeyError):
                continue
        print(f"{len(candles)} bars")
        return candles
    except Exception as e:
        print(f"FAIL: {e}")
        return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default="scripts/cache_forex_indices")
    ap.add_argument("--asset-class", default="all", choices=["forex","indices","commodities","all"])
    ap.add_argument("--interval", default="1h", choices=["1h","30m","5m"])
    ap.add_argument("--period", default="60d",
                    help="yfinance period: 60d (5m), 730d (1h), max")
    args = ap.parse_args()
    out = Path(args.out_dir); out.mkdir(parents=True, exist_ok=True)

    classes = {}
    if args.asset_class in ("forex","all"): classes["forex"] = FOREX
    if args.asset_class in ("indices","all"): classes["indices"] = INDICES
    if args.asset_class in ("commodities","all"): classes["commodities"] = COMMODITIES

    total = 0
    for cls_name, tickers in classes.items():
        print(f"\n=== {cls_name.upper()} ({args.interval}, {args.period}) ===")
        for name, ticker in tickers.items():
            candles = download(name, ticker, args.interval, args.period)
            if candles:
                # Map to FTMO sym naming (e.g. EURUSD → EURUSD_1h.json compatible with cache loader)
                out_file = out / f"{name}_{args.interval}.json"
                out_file.write_text(json.dumps(candles))
                total += len(candles)
    print(f"\n✅ {total} total bars written to {args.out_dir}")

if __name__ == "__main__": main()
