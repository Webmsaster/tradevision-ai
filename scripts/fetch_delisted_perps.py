#!/usr/bin/env python3
"""Fetch DELISTED/dead Binance USDT-perp daily klines + funding into
scripts/cache_delisted/ — the survivorship fix for xsec_edge_probe.py.

Universe rule (objective, not curated): every USDT perp that ever existed
(S3 listing of data.binance.vision) but is not TRADING now, whose top-90-day
average dollar volume reached >= 0.8x the smallest of the 27 survivor majors
(STXUSDT, ~$89M). Index products (DEFI/BLUEBIRD/FOOTBALL) excluded.

The fapi still serves klines + fundingRate for delisted symbols (verified:
LUNAUSDT returns the May-2022 collapse days and its -1%/8h funding).
"""
from __future__ import annotations
import json, re, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "scripts/cache_delisted"
SKIP = {"DEFIUSDT", "BLUEBIRDUSDT", "FOOTBALLUSDT"}
S3 = ("https://s3-ap-northeast-1.amazonaws.com/data.binance.vision"
      "?delimiter=/&prefix=data/futures/um/monthly/klines/")
SURVIVOR_FLOOR_QV = 89e6 * 0.8  # 0.8x smallest survivor's top-90d avg $vol


def list_all_perp_symbols():
    seen, marker = [], ""
    while True:
        url = S3 + (f"&marker={marker}" if marker else "")
        xml = urllib.request.urlopen(url, timeout=30).read().decode()
        prefixes = re.findall(
            r"<Prefix>data/futures/um/monthly/klines/([^/<]+)/</Prefix>", xml)
        seen.extend(prefixes)
        if "<IsTruncated>true</IsTruncated>" in xml and prefixes:
            marker = f"data/futures/um/monthly/klines/{prefixes[-1]}/"
        else:
            return sorted(set(s for s in seen if s.endswith("USDT")))


def active_symbols():
    info = json.load(urllib.request.urlopen(
        "https://fapi.binance.com/fapi/v1/exchangeInfo", timeout=30))
    return set(s["symbol"] for s in info["symbols"]
               if s["status"] == "TRADING" and s["symbol"].endswith("USDT"))


def fetch_klines(sym):
    out, start = [], 0
    for _ in range(6):
        url = (f"https://fapi.binance.com/fapi/v1/klines?symbol={sym}"
               f"&interval=1d&limit=1500&startTime={start}")
        try:
            rows = json.load(urllib.request.urlopen(url, timeout=30))
        except Exception:
            return sym, None
        out.extend(rows)
        if len(rows) < 1500:
            break
        start = rows[-1][0] + 1
    return sym, out


def fetch_funding(sym):
    out, start = [], 0
    for _ in range(12):
        url = (f"https://fapi.binance.com/fapi/v1/fundingRate?symbol={sym}"
               f"&limit=1000&startTime={start}")
        try:
            rows = json.load(urllib.request.urlopen(url, timeout=30))
        except Exception:
            break
        out.extend(rows)
        if len(rows) < 1000:
            break
        start = int(rows[-1]["fundingTime"]) + 1
    return sym, out


def main():
    OUT.mkdir(exist_ok=True)
    dead = [s for s in list_all_perp_symbols()
            if s not in active_symbols() and s not in SKIP]
    print(f"{len(dead)} dead USDT perps; downloading klines...")
    qualified = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        for sym, rows in ex.map(fetch_klines, dead):
            if not rows:
                continue
            qv = sorted((float(r[7]) for r in rows), reverse=True)[:90]
            if len(qv) < 60 or sum(qv) / len(qv) < SURVIVOR_FLOOR_QV:
                continue
            qualified.append(sym)
            out = [dict(openTime=int(r[0]), open=float(r[1]), high=float(r[2]),
                        low=float(r[3]), close=float(r[4]), volume=float(r[5]),
                        closeTime=int(r[6]), isFinal=True) for r in rows]
            (OUT / f"{sym}_1d.json").write_text(json.dumps(out))
    print(f"{len(qualified)} qualified dead majors; downloading funding...")
    with ThreadPoolExecutor(max_workers=6) as ex:
        for sym, rows in ex.map(fetch_funding, qualified):
            ser = [dict(t=int(r["fundingTime"]), r=float(r["fundingRate"]))
                   for r in rows]
            (OUT / f"{sym}_funding.json").write_text(json.dumps(ser))
    print(f"done -> {OUT}")


if __name__ == "__main__":
    main()
