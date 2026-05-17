#!/usr/bin/env python3
"""P1-only random search. Fixed pt=0.10 max-days=30. Goal: P1 >= 60%."""
import json, random, subprocess, re, time
from pathlib import Path

SWEEP = "./engine-rust/target/release/ftmo-sweep"
SYMS = "AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
COMMON = ["--candles-dir", "scripts/cache_bakeoff", "--funding-dir", "scripts/cache_bakeoff",
          "--symbols", SYMS, "--windows", "334", "--step-days", "3", "--threads", "4",
          "--profit-target", "0.10", "--max-days", "30"]

CONFIGS = [
    "2h-trend-v5-amber-max-passlock",
    "2h-trend-v5-amber-passlock",
    "2h-trend-v5-amber-passlock-daystage",
    "2h-trend-v5-amber-atr-passlock",
    "2h-trend-v5-amber-be-passlock",
    "2h-trend-v5-amber-passlock-timedecay",
    "2h-trend-v5-amber-passlock-sharpe",
    "2h-trend-v5-titanium-passlock",
    "2h-trend-v5-rubin-passlock",
    "2h-trend-v5-sapphir-passlock",
    "2h-trend-v5-diamond-passlock",
    "2h-trend-v5-obsidian-passlock",
    "2h-trend-v5-topaz-passlock",
]
VOTERS = ["poc-z", "bb-z-mr", "supertrend", "hmm", "ad-line", "aroon", "cmf",
          "double-top", "kalman-trend", "ofi", "rsi-hidden-div", "smc-fvg",
          "nupl", "top-trader-ls", "stablecoin", "cb-premium"]
CROSSES = [(None,None,None), ("BTCUSDT",9,21), ("BTCUSDT",12,26), ("BTCUSDT",5,13),
           ("ETHUSDT",9,21), ("SOLUSDT",9,21), ("BTCUSDT",21,50)]

OUT = Path("scripts/cache_bakeoff/hunt_2026_05_16/phase25_p1_search.jsonl")
OUT.parent.mkdir(parents=True, exist_ok=True)

def sample(rng):
    n_voters = rng.choice([3, 4, 5, 6])
    vs = rng.sample(VOTERS, n_voters)
    cross = rng.choice(CROSSES)
    return {
        "config": rng.choice(CONFIGS),
        "tp_mult": round(rng.uniform(0.95, 1.30), 3),
        "kelly_fraction": rng.choice([0.3, 0.5, 0.7, 1.0]),
        "kelly_window": rng.choice([30, 60, 100, 150, 200]),
        "kelly_min_trades": rng.choice([10, 20, 30, 50]),
        "min_votes": rng.choice([2, 3, 4]),
        "voters": vs,
        "cross_asset": cross[0], "ca_fast": cross[1], "ca_slow": cross[2],
    }

def build(t):
    flags = list(COMMON) + ["--config", t["config"],
                            "--override-tp-mult", str(t["tp_mult"]),
                            "--signals", "regime",
                            "--regime-min-votes", str(t["min_votes"]),
                            "--kelly-sizing",
                            "--kelly-fraction", str(t["kelly_fraction"]),
                            "--kelly-window", str(t["kelly_window"]),
                            "--kelly-min-trades", str(t["kelly_min_trades"])]
    for v in t["voters"]:
        flag = f"--regime-{v}" if v in ("poc-z", "bb-z-mr") else f"--regime-use-{v}"
        flags.append(flag)
    if t["cross_asset"]:
        flags += ["--cross-asset-sym", t["cross_asset"],
                  "--cross-asset-fast", str(t["ca_fast"]),
                  "--cross-asset-slow", str(t["ca_slow"])]
    return flags

def run(flags):
    try:
        r = subprocess.run([SWEEP] + flags, capture_output=True, text=True, timeout=90)
        m = re.findall(r'(\d+\.\d+)%', r.stdout + r.stderr)
        return float(m[-1]) if m else None
    except: return None

def main():
    rng = random.Random(99)
    n = 200
    best_p1 = 55.99
    started = time.time()
    print(f"P1-only search baseline best: 55.99%. Target: 60.0%. {n} trials.")
    with open(OUT, "a") as f:
        for i in range(n):
            t = sample(rng)
            p1 = run(build(t))
            if p1 is None:
                print(f"  [{i+1}] SKIP"); continue
            t["P1"] = p1
            t["trial"] = i+1
            f.write(json.dumps(t) + "\n"); f.flush()
            mark = " ★" if p1 > best_p1 else ""
            el = int(time.time() - started)
            print(f"  [{i+1}/{n} @{el}s] P1={p1:.2f}% {t['config'][20:38]:<18} tp={t['tp_mult']} mv={t['min_votes']}{mark}")
            if p1 > best_p1: best_p1 = p1
            if p1 >= 60.0:
                print(f"\n  🎯 BREAKTHROUGH: P1={p1:.2f}% reached 60%!\n  Config: {json.dumps(t, indent=2)}")
                break
    print(f"\nDONE. Best P1: {best_p1:.2f}%")

if __name__ == "__main__":
    main()
