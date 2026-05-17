#!/usr/bin/env python3
"""
2026-05-17 Custom Combined-P1xP2 random search wrapper around ftmo-sweep.
Hunter optimizes single-pt; this wraps to optimize REAL FTMO Standard
P1=0.10 × P2=0.05 Combined Funded.
"""
import json
import random
import subprocess
import re
import time
from pathlib import Path

SWEEP = "./engine-rust/target/release/ftmo-sweep"
SYMS = "AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
COMMON_FLAGS = [
    "--candles-dir", "scripts/cache_bakeoff",
    "--funding-dir", "scripts/cache_bakeoff",
    "--symbols", SYMS,
    "--windows", "334",
    "--step-days", "3",
    "--threads", "4",
]

CONFIGS = [
    "2h-trend-v5-amber-max-passlock",
    "2h-trend-v5-amber-passlock",
    "2h-trend-v5-amber-passlock-daystage",
    "2h-trend-v5-amber-atr-passlock",
    "2h-trend-v5-titanium-passlock",
    "2h-trend-v5-rubin-passlock",
    "2h-trend-v5-sapphir-passlock",
    "2h-trend-v5-diamond-passlock",
    "2h-trend-v5-obsidian-passlock",
    "2h-trend-v5-topaz-passlock",
    "2h-trend-v5-quartz-lite-r28-v6-passlock",
]
VOTERS = ["poc-z", "bb-z-mr", "supertrend", "hmm", "ad-line", "aroon", "cmf", "double-top", "kalman-trend",
          "ofi", "rsi-hidden-div", "smc-fvg", "nupl", "top-trader-ls", "stablecoin", "cb-premium"]

OUT = Path("scripts/cache_bakeoff/hunt_2026_05_16/phase24_combined_search.jsonl")
OUT.parent.mkdir(parents=True, exist_ok=True)

def sample_trial(rng):
    n_voters = rng.choice([3, 4, 5, 6, 7])
    vs = rng.sample(VOTERS, n_voters)
    return {
        "config": rng.choice(CONFIGS),
        "tp_mult": round(rng.uniform(0.9, 1.4), 3),
        "kelly_fraction": round(rng.choice([0.3, 0.5, 0.7, 1.0]), 2),
        "kelly_window": rng.choice([30, 60, 100, 150]),
        "kelly_min_trades": rng.choice([10, 20, 30, 50]),
        "max_days": rng.choice([30, 40, 45, 50, 55]),
        "min_votes": rng.choice([2, 3, 4]),
        "voters": vs,
        "cross_asset": rng.choice([None, "BTCUSDT", "ETHUSDT", "SOLUSDT"]),
        "ca_fast": rng.choice([5, 9, 12]),
        "ca_slow": rng.choice([18, 21, 25, 30]),
    }

def build_flags(t, pt):
    flags = list(COMMON_FLAGS) + [
        "--config", t["config"],
        "--profit-target", str(pt),
        "--override-tp-mult", str(t["tp_mult"]),
        "--max-days", str(t["max_days"]),
        "--signals", "regime",
        "--regime-min-votes", str(t["min_votes"]),
        "--kelly-sizing",
        "--kelly-fraction", str(t["kelly_fraction"]),
        "--kelly-window", str(t["kelly_window"]),
        "--kelly-min-trades", str(t["kelly_min_trades"]),
    ]
    for v in t["voters"]:
        flag_name = f"--regime-{v}" if v in ("poc-z", "bb-z-mr") else f"--regime-use-{v}"
        flags.append(flag_name)
    if t["cross_asset"]:
        flags += ["--cross-asset-sym", t["cross_asset"],
                  "--cross-asset-fast", str(t["ca_fast"]),
                  "--cross-asset-slow", str(t["ca_slow"])]
    return flags

def run_sweep(flags):
    try:
        result = subprocess.run([SWEEP] + flags, capture_output=True, text=True, timeout=120)
        out = result.stdout + result.stderr
        m = re.findall(r'(\d+\.\d+)%', out)
        return float(m[-1]) if m else None
    except subprocess.TimeoutExpired:
        return None
    except Exception as e:
        print(f"ERROR: {e}")
        return None

def main():
    rng = random.Random(2026)
    best = 37.40  # champion baseline
    n_trials = 100  # tunable
    started = time.time()
    print(f"Starting {n_trials} Combined-P1xP2 trials...")
    print(f"Baseline: champion = 37.40% Combined Funded")
    print()
    with open(OUT, "a") as f:
        for i in range(n_trials):
            t = sample_trial(rng)
            p1 = run_sweep(build_flags(t, 0.10))
            p2 = run_sweep(build_flags(t, 0.05))
            if p1 is None or p2 is None:
                print(f"  [trial {i+1}] SKIP (sweep failed)")
                continue
            combined = round(p1 * p2 / 100, 2)
            t["P1"] = p1
            t["P2"] = p2
            t["Combined"] = combined
            t["trial_id"] = i + 1
            f.write(json.dumps(t) + "\n")
            f.flush()
            marker = " ★ NEW PEAK" if combined > best else ""
            elapsed = int(time.time() - started)
            print(f"  [{i+1}/{n_trials} @ {elapsed}s] P1={p1:.2f} P2={p2:.2f} Combined={combined:.2f}{marker}")
            if combined > best:
                best = combined
    print(f"\nDONE. Best Combined: {best:.2f}%")

if __name__ == "__main__":
    main()
