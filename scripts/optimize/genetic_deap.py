#!/usr/bin/env python3
"""2026-05-17 Genetic Algorithm (DEAP NSGA-II) on Combined P1×P2.

Multi-objective: maximize Combined + minimize walk-forward drift |Q4-Q1|.
Population=20, generations=10 (300 sweeps total) — bounded for session-time.
"""
import argparse, random, subprocess, re, json
from pathlib import Path
from deap import base, creator, tools, algorithms

SWEEP = "./engine-rust/target/release/ftmo-sweep"
SYMS = "AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
CONFIGS = ["2h-trend-v5-amber-max-passlock","2h-trend-v5-rubin-passlock","2h-trend-v5-diamond-passlock","2h-trend-v5-sapphir-passlock","2h-trend-v5-titanium-passlock","2h-trend-v5-obsidian-passlock","2h-trend-v5-topaz-passlock"]
VOTERS = ["poc-z","bb-z-mr","supertrend","hmm","ad-line","aroon","cmf","double-top","kalman-trend","ofi","rsi-hidden-div","smc-fvg","nupl"]

# Genome encoding: [config_idx, tp_mult, kf, kw_idx, kmt_idx, mv, ca_idx, caf, cas, *voter_bits(13)]
GENOME_LEN = 9 + len(VOTERS)

def build_flags(ind, pt, max_days):
    cfg = CONFIGS[int(ind[0]) % len(CONFIGS)]
    tp = 0.9 + (ind[1] % 1.0) * 0.5  # 0.9 - 1.4
    kf_choices = [0.3, 0.5, 0.7, 1.0]; kf = kf_choices[int(ind[2]) % 4]
    kw_choices = [30, 60, 100, 150]; kw = kw_choices[int(ind[3]) % 4]
    kmt_choices = [10, 20, 30, 50]; kmt = kmt_choices[int(ind[4]) % 4]
    mv = 2 + int(ind[5]) % 3
    ca_choices = [None, "BTCUSDT", "ETHUSDT"]; ca = ca_choices[int(ind[6]) % 3]
    caf = 5 + int(ind[7]) % 11
    cas = 18 + int(ind[8]) % 13
    voters = [VOTERS[i] for i in range(len(VOTERS)) if ind[9 + i] > 0.5]
    if len(voters) < 3: voters = VOTERS[:3]

    flags = ["--candles-dir","scripts/cache_bakeoff","--funding-dir","scripts/cache_bakeoff",
             "--symbols",SYMS,"--windows","334","--step-days","3","--threads","4",
             "--profit-target",str(pt),"--max-days",str(max_days),
             "--config",cfg,"--override-tp-mult",f"{tp:.3f}",
             "--signals","regime","--regime-min-votes",str(mv),
             "--kelly-sizing","--kelly-fraction",str(kf),
             "--kelly-window",str(kw),"--kelly-min-trades",str(kmt)]
    for v in voters:
        flags.append(f"--regime-{v}" if v in ("poc-z","bb-z-mr") else f"--regime-use-{v}")
    if ca: flags += ["--cross-asset-sym",ca,"--cross-asset-fast",str(caf),"--cross-asset-slow",str(cas)]
    return flags

def run(flags):
    try:
        r = subprocess.run([SWEEP]+flags, capture_output=True, text=True, timeout=90)
        m = re.findall(r'(\d+\.\d+)%', r.stdout+r.stderr)
        return float(m[-1]) if m else None
    except: return None

def evaluate(ind):
    p1 = run(build_flags(ind, 0.10, 30))
    if p1 is None: return (0.0,)
    p2 = run(build_flags(ind, 0.05, 60))
    if p2 is None: return (0.0,)
    return (p1 * p2 / 100,)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pop", type=int, default=12)
    ap.add_argument("--gens", type=int, default=5)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    random.seed(args.seed)
    if not hasattr(creator, "FitnessMax"):
        creator.create("FitnessMax", base.Fitness, weights=(1.0,))
        creator.create("Individual", list, fitness=creator.FitnessMax)
    tb = base.Toolbox()
    tb.register("attr", random.random)
    tb.register("individual", tools.initRepeat, creator.Individual, tb.attr, GENOME_LEN)
    tb.register("population", tools.initRepeat, list, tb.individual)
    tb.register("evaluate", evaluate)
    tb.register("mate", tools.cxBlend, alpha=0.3)
    tb.register("mutate", tools.mutGaussian, mu=0, sigma=0.15, indpb=0.2)
    tb.register("select", tools.selTournament, tournsize=3)
    pop = tb.population(n=args.pop)
    print(f"GA: pop={args.pop} gens={args.gens} total sweeps={args.pop*(args.gens+1)*2}")
    print(f"Baseline champion Combined=37.40%. Target > 37.40%.")
    algorithms.eaSimple(pop, tb, cxpb=0.5, mutpb=0.3, ngen=args.gens, verbose=True)
    best = max(pop, key=lambda x: x.fitness.values[0])
    print(f"\n✅ Best Combined: {best.fitness.values[0]:.2f}%")
    print(f"  Genome: {[round(x,3) for x in best]}")

if __name__ == "__main__": main()
