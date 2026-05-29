#!/usr/bin/env python3
"""Steady-alpha probe: does LOW risk + NO time-limit crush the DailyLoss busts?

FTMO now has no challenge time-limit. ~97% of fails are DailyLoss (a -5%
intraday move) — a VARIANCE event, not a drift event. Shrinking position size
(`--risk-frac-mult`) shrinks daily swings quadratically faster than it shrinks
the drift toward the +10% target, so with an unlimited horizon the gambler's-ruin
math flips: smaller bets should REACH a fixed +profit goal before ruin MORE often.

This sweeps risk_frac_mult × max_days on a clean champion and prints, per cell,
the fail-reason mix so we can SEE the DailyLoss collapse (or not). max_days is the
"time-limit" proxy: 30 = real FTMO classic, 365 ≈ effectively unlimited.

The cost-drag caveat: traversing a fixed +10% costs ~the same fee total at any
size, so TotalLoss/timeout is the remaining enemy — that's exactly what the matrix
exposes. Median pass-day shows how much longer the steady version takes.
"""
from __future__ import annotations
import argparse, json, subprocess, statistics, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SWEEP = ROOT / "engine-rust/target/release/ftmo-sweep"
CACHE = ROOT / "scripts/cache_bakeoff"


def run_cell(out_dir, config, symbols, target, step, mult, max_days, cache=CACHE, signals="regime"):
    out = out_dir / f"m{mult}_md{max_days}.jsonl"
    if not out.exists() or out.stat().st_size == 0:
        cmd = [
            str(SWEEP), "--candles-dir", str(cache), "--funding-dir", str(cache),
            "--symbols", symbols, "--windows", "9999", "--step-days", str(step),
            "--threads", "1", "--signals", signals, "--config", config,
            "--strict-pass", "--profit-target", str(target),
            "--max-days", str(max_days), "--risk-frac-mult", str(mult),
            "--out", str(out),
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    rows = [json.loads(l) for l in out.read_text().splitlines() if l.strip()] if out.exists() else []
    n = len(rows)
    if not n:
        return (mult, max_days, 0, 0.0, 0.0, 0.0, 0.0, None)
    passed = sum(1 for r in rows if r.get("passed"))
    reasons = {}
    for r in rows:
        if not r.get("passed"):
            reasons[r.get("fail_reason") or "Other"] = reasons.get(r.get("fail_reason") or "Other", 0) + 1
    dl = reasons.get("DailyLoss", 0)
    tl = reasons.get("TotalLoss", 0)
    to = reasons.get("Timeout", 0) + reasons.get("MaxDays", 0)
    other = (n - passed) - dl - tl - to
    pass_days = [r["final_day"] for r in rows if r.get("passed")]
    med_day = statistics.median(pass_days) if pass_days else None
    return (mult, max_days, n, 100*passed/n, 100*dl/n, 100*tl/n, 100*(to+other)/n, med_day)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="2h-trend-v5-diamond-passlock")
    ap.add_argument("--symbols", default="AVAXUSDT,DOTUSDT,NEARUSDT,SOLUSDT")
    ap.add_argument("--target", type=float, default=0.10)
    ap.add_argument("--step", type=int, default=14)
    ap.add_argument("--mults", default="1.0,0.5,0.25,0.125,0.0625")
    ap.add_argument("--max-days", default="30,60,120,240,365")
    ap.add_argument("--jobs", type=int, default=12)
    ap.add_argument("--out-dir", default="/tmp/steady_grid")
    ap.add_argument("--cache-dir", default=str(CACHE))
    ap.add_argument("--signals", default="regime")
    args = ap.parse_args()

    cache = Path(args.cache_dir)
    out_dir = Path(args.out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    mults = [float(x) for x in args.mults.split(",")]
    mds = [int(x) for x in args.max_days.split(",")]
    cells = [(m, md) for m in mults for md in mds]
    print(f"[steady] {args.config} | {args.symbols} | target={args.target:.0%} | "
          f"step={args.step} | {len(cells)} cells")

    results = {}
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(run_cell, out_dir, args.config, args.symbols, args.target,
                          args.step, m, md, cache, args.signals): (m, md) for m, md in cells}
        for f in futs:
            r = f.result()
            results[(r[0], r[1])] = r

    print(f"\n{'risk_mult':>10} {'max_days':>9} {'n':>5} {'PASS%':>7} {'DailyLoss%':>11} "
          f"{'TotalLoss%':>11} {'Time/Oth%':>10} {'medPassDay':>11}")
    print("-" * 90)
    for m in mults:
        for md in mds:
            _, _, n, p, dl, tl, to, md_day = results[(m, md)]
            day_s = f"{md_day:.0f}" if md_day is not None else "—"
            print(f"{m:>10} {md:>9} {n:>5} {p:>6.1f}% {dl:>10.1f}% {tl:>10.1f}% {to:>9.1f}% {day_s:>11}")
        print()


if __name__ == "__main__":
    sys.exit(main())
