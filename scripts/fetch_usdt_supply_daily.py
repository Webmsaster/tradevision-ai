#!/usr/bin/env python3
"""Fetch DefiLlama daily USDT-supply aggregate and persist to the macro cache.

Source : https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=1
         (stablecoin=1 == Tether USDT)
Output : scripts/cache_bakeoff/macro/usdt_supply_daily.json
Format : [{"t": unix_ms, "supply_usd": float}, ...]  ascending by t.

The Rust loader `loader::load_stablecoin_supply` reads this exact shape
(see engine-rust/ftmo-engine-cli/src/loader.rs:344-373); each point's
`supply_usd` feeds the `signals_stablecoin_flow.rs` voter (Detector #22).

Refresh cadence : run once per day before a sweep. DefiLlama publishes
day-D aggregate on day-D+1 — voter's `publishing_lag_bars = 48` already
accounts for this.

Usage:
    python3 scripts/fetch_usdt_supply_daily.py
    python3 scripts/fetch_usdt_supply_daily.py --out /custom/path.json
    python3 scripts/fetch_usdt_supply_daily.py --stablecoin 1   # 1=USDT, 2=USDC
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFILLAMA_URL = "https://stablecoins.llama.fi/stablecoincharts/all?stablecoin={sid}"
DEFAULT_OUT = (
    Path(__file__).resolve().parent / "cache_bakeoff" / "macro" / "usdt_supply_daily.json"
)
USER_AGENT = "tradevision-ai-usdt-supply-fetcher/1.0 (+https://github.com/)"


def fetch_raw(stablecoin_id: int, retries: int = 3, timeout: int = 30) -> list[dict]:
    url = DEFILLAMA_URL.format(sid=stablecoin_id)
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if r.status != 200:
                    raise RuntimeError(f"HTTP {r.status}")
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, TimeoutError) as e:
            last_err = e
            sleep = 2**attempt
            print(f"  attempt {attempt}/{retries} failed: {e!r} — retry in {sleep}s", file=sys.stderr)
            time.sleep(sleep)
    raise RuntimeError(f"all {retries} attempts failed: {last_err!r}")


def normalize(raw: list[dict]) -> list[dict]:
    """Convert DefiLlama records into the canonical `{t, supply_usd}` shape.

    DefiLlama returns:
        {"date": "1511913600",
         "totalCirculating":     {"peggedUSD": 109970},
         "totalCirculatingUSD":  {"peggedUSD": 110105}}

    `date` is unix-seconds as STRING. We use `totalCirculatingUSD.peggedUSD`
    (dollar-denominated, matches "cash on venues" voter intuition).
    """
    out: list[dict] = []
    skipped = 0
    for rec in raw:
        try:
            ts_s = int(rec["date"])
            supply = float(rec["totalCirculatingUSD"]["peggedUSD"])
        except (KeyError, ValueError, TypeError):
            skipped += 1
            continue
        if supply <= 0 or supply != supply:  # NaN guard
            skipped += 1
            continue
        out.append({"t": ts_s * 1000, "supply_usd": supply})

    out.sort(key=lambda d: d["t"])
    # Dedup identical timestamps (keep last).
    dedup: dict[int, float] = {}
    for d in out:
        dedup[d["t"]] = d["supply_usd"]
    if skipped:
        print(f"  skipped {skipped} malformed records", file=sys.stderr)
    return [{"t": t, "supply_usd": s} for t, s in sorted(dedup.items())]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"Output JSON path (default: {DEFAULT_OUT})")
    ap.add_argument("--stablecoin", type=int, default=1, help="DefiLlama stablecoin id (1=USDT, 2=USDC). Default 1.")
    args = ap.parse_args()

    print(f"Fetching DefiLlama stablecoin={args.stablecoin} aggregate ...", file=sys.stderr)
    raw = fetch_raw(args.stablecoin)
    print(f"  got {len(raw)} raw records", file=sys.stderr)

    pts = normalize(raw)
    if not pts:
        print("ERROR: zero valid points after normalization", file=sys.stderr)
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_suffix(args.out.suffix + ".tmp")
    tmp.write_text(json.dumps(pts, separators=(",", ":")))
    tmp.replace(args.out)

    first_ms = pts[0]["t"]
    last_ms = pts[-1]["t"]
    span_days = (last_ms - first_ms) / 86_400_000
    print(
        f"Wrote {len(pts)} points to {args.out} "
        f"(span {span_days:.0f}d, first={first_ms}ms, last={last_ms}ms, "
        f"latest_supply=${pts[-1]['supply_usd']:,.0f})",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
