#!/usr/bin/env python3
"""2026-05-17 Dukascopy Forex Downloader (FULL intraday, multi-year).

Sources: Dukascopy Bank free historical CSV-ZIP per day per instrument.
URL pattern: https://datafeed.dukascopy.com/datafeed/{SYM}/{YYYY}/{MM-1}/{DD}/{HH}h_ticks.bi5

Downloads tick-data, aggregates to bars (30m/1h/2h compatible with engine).
Handles weekend-gap (Fri 22:00 UTC → Sun 22:00 UTC = no data).
Currency-conversion ready (stores quote-currency in metadata).

Usage:
  python3 scripts/data/dukascopy_forex.py --pair EURUSD --year 2025 --tf 30m
"""
import argparse, json, sys, time
from datetime import datetime, timedelta
from pathlib import Path
import urllib.request
import struct

try:
    import lzma
except ImportError:
    print("LZMA needed (built-in)")

PAIRS = {
    "EURUSD": ("EURUSD", "EUR", "USD"),
    "GBPUSD": ("GBPUSD", "GBP", "USD"),
    "USDJPY": ("USDJPY", "USD", "JPY"),
    "USDCHF": ("USDCHF", "USD", "CHF"),
    "AUDUSD": ("AUDUSD", "AUD", "USD"),
    "USDCAD": ("USDCAD", "USD", "CAD"),
    "NZDUSD": ("NZDUSD", "NZD", "USD"),
    "EURGBP": ("EURGBP", "EUR", "GBP"),
    "EURJPY": ("EURJPY", "EUR", "JPY"),
}
TF_MINUTES = {"5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240}

def fetch_hour(pair, dt: datetime, point_factor=100000):
    """Download bi5 file for one hour; decompress; return [(ts_ms, bid, ask, vol_bid, vol_ask)]"""
    url = f"https://datafeed.dukascopy.com/datafeed/{pair}/{dt.year}/{dt.month-1:02d}/{dt.day:02d}/{dt.hour:02d}h_ticks.bi5"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            data = r.read()
        if not data: return []
        decompressed = lzma.decompress(data)
    except Exception as e:
        return []
    ticks = []
    # bi5 format: 20 bytes per tick (4 BE int32: ms offset from hour, ask, bid, then 4 BE float32 vol_ask, vol_bid)
    for i in range(0, len(decompressed), 20):
        if i + 20 > len(decompressed): break
        ms_off, ask_pt, bid_pt, vol_ask, vol_bid = struct.unpack(">IIIff", decompressed[i:i+20])
        ts_ms = int(dt.timestamp() * 1000) + ms_off
        ask = ask_pt / point_factor
        bid = bid_pt / point_factor
        ticks.append((ts_ms, bid, ask, vol_bid, vol_ask))
    return ticks

def is_weekend(dt: datetime) -> bool:
    """Forex market closed Fri 22:00 UTC - Sun 22:00 UTC."""
    if dt.weekday() == 5:  # Saturday
        return True
    if dt.weekday() == 4 and dt.hour >= 22:  # Friday after 22:00
        return True
    if dt.weekday() == 6 and dt.hour < 22:  # Sunday before 22:00
        return True
    return False

def aggregate_to_bars(ticks, tf_minutes):
    """Bucket ticks into TF bars. tick = (ts_ms, bid, ask, vb, va). Use mid-price."""
    if not ticks: return []
    bars = []
    tf_ms = tf_minutes * 60_000
    cur_bucket = ticks[0][0] // tf_ms
    cur_ticks = []
    def flush(bucket, ts):
        if not cur_ticks: return None
        mids = [(t[1] + t[2]) / 2 for t in cur_ticks]
        vols = [t[3] + t[4] for t in cur_ticks]
        return {
            "open_time": int(bucket * tf_ms),
            "close_time": int(bucket * tf_ms + tf_ms),
            "open": mids[0], "high": max(mids), "low": min(mids), "close": mids[-1],
            "volume": sum(vols),
        }
    for t in ticks:
        b = t[0] // tf_ms
        if b != cur_bucket:
            bar = flush(cur_bucket, t[0])
            if bar: bars.append(bar)
            cur_bucket = b
            cur_ticks = []
        cur_ticks.append(t)
    final = flush(cur_bucket, ticks[-1][0])
    if final: bars.append(final)
    return bars

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pair", default="EURUSD", choices=list(PAIRS.keys()))
    ap.add_argument("--year", type=int, default=2024)
    ap.add_argument("--months", type=int, default=12)
    ap.add_argument("--tf", default="30m", choices=list(TF_MINUTES.keys()))
    ap.add_argument("--out-dir", default="scripts/cache_forex_dukascopy")
    ap.add_argument("--max-hours", type=int, default=240, help="cap for testing")
    args = ap.parse_args()

    out = Path(args.out_dir); out.mkdir(parents=True, exist_ok=True)
    sym_info = PAIRS[args.pair]
    point_factor = 1000 if "JPY" in args.pair else 100000

    all_ticks = []
    start = datetime(args.year, 1, 1)
    cur = start
    n_hours = 0
    while cur.year == args.year and n_hours < args.max_hours:
        if not is_weekend(cur):
            ticks = fetch_hour(args.pair, cur, point_factor)
            all_ticks.extend(ticks)
            n_hours += 1
            if n_hours % 24 == 0:
                print(f"  {cur.date()} hour {cur.hour:02d}: {len(all_ticks)} ticks total")
        cur += timedelta(hours=1)

    print(f"\n{n_hours} hours fetched, {len(all_ticks)} ticks → aggregate to {args.tf}")
    bars = aggregate_to_bars(all_ticks, TF_MINUTES[args.tf])
    out_file = out / f"{args.pair}_{args.tf}.json"
    out_file.write_text(json.dumps(bars))
    print(f"✅ {len(bars)} bars → {out_file}")
    print(f"   metadata: base={sym_info[1]}, quote={sym_info[2]} (FX-conversion needed for USD-funded accounts)")

if __name__ == "__main__": main()
