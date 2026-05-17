#!/usr/bin/env python3
"""2026-05-17 Bayesian Optimization (Optuna TPE) on Combined P1×P2.

Wraps ftmo-sweep as subprocess; each trial runs P1 (pt=0.10, max-days=30)
+ P2 (pt=0.05, max-days=60) and reports Combined = P1×P2.

Storage: sqlite for resumable studies.
Pruner: HyperbandPruner (early-stop bad trials).
"""
import argparse, json, subprocess, re, time
from pathlib import Path
import optuna
from optuna.samplers import TPESampler
from optuna.pruners import HyperbandPruner

SWEEP = "./engine-rust/target/release/ftmo-sweep"
SYMS = "AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
CONFIGS = ["2h-trend-v5-amber-max-passlock","2h-trend-v5-amber-passlock-daystage","2h-trend-v5-rubin-passlock","2h-trend-v5-diamond-passlock","2h-trend-v5-sapphir-passlock","2h-trend-v5-titanium-passlock","2h-trend-v5-obsidian-passlock"]
VOTERS = ["poc-z","bb-z-mr","supertrend","hmm","ad-line","aroon","cmf","double-top","kalman-trend","ofi","rsi-hidden-div","smc-fvg","nupl"]

def build_flags(t, pt, max_days):
    flags = ["--candles-dir","scripts/cache_bakeoff","--funding-dir","scripts/cache_bakeoff",
             "--symbols",SYMS,"--windows","334","--step-days","3","--threads","4",
             "--profit-target",str(pt),"--max-days",str(max_days),
             "--config",t["config"],"--override-tp-mult",str(t["tp_mult"]),
             "--signals","regime","--regime-min-votes",str(t["mv"]),
             "--kelly-sizing","--kelly-fraction",str(t["kf"]),
             "--kelly-window",str(t["kw"]),"--kelly-min-trades",str(t["kmt"])]
    for v in t["voters"]:
        flags.append(f"--regime-{v}" if v in ("poc-z","bb-z-mr") else f"--regime-use-{v}")
    if t["ca"]:
        flags += ["--cross-asset-sym",t["ca"],"--cross-asset-fast",str(t["caf"]),"--cross-asset-slow",str(t["cas"])]
    return flags

def run(flags):
    try:
        r = subprocess.run([SWEEP]+flags, capture_output=True, text=True, timeout=90)
        m = re.findall(r'(\d+\.\d+)%', r.stdout+r.stderr)
        return float(m[-1]) if m else None
    except: return None

def objective(trial):
    n_voters = trial.suggest_int("n_voters",3,6)
    voter_idx = trial.suggest_categorical("voter_seed",list(range(100)))
    import random; rng = random.Random(voter_idx)
    voters = rng.sample(VOTERS, n_voters)
    t = {
        "config": trial.suggest_categorical("config", CONFIGS),
        "tp_mult": trial.suggest_float("tp_mult",0.9,1.4),
        "kf": trial.suggest_categorical("kf",[0.3,0.5,0.7,1.0]),
        "kw": trial.suggest_categorical("kw",[30,60,100,150]),
        "kmt": trial.suggest_categorical("kmt",[10,20,30,50]),
        "mv": trial.suggest_int("mv",2,4),
        "ca": trial.suggest_categorical("ca",[None,"BTCUSDT","ETHUSDT"]),
        "caf": trial.suggest_int("caf",5,15),
        "cas": trial.suggest_int("cas",18,30),
        "voters": voters,
    }
    p1 = run(build_flags(t, 0.10, 30))
    if p1 is None: return 0.0
    trial.report(p1, step=0)  # intermediate report for pruner
    if trial.should_prune(): raise optuna.TrialPruned()
    p2 = run(build_flags(t, 0.05, 60))
    if p2 is None: return 0.0
    return p1 * p2 / 100  # Combined

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-trials", type=int, default=50)
    ap.add_argument("--storage", default="sqlite:///scripts/cache_bakeoff/hunt_2026_05_16/optuna_study.db")
    args = ap.parse_args()
    print(f"Optuna TPE: {args.n_trials} trials, storage={args.storage}")
    print(f"Baseline champion Combined = 37.40%. Target > 37.40%.")
    study = optuna.create_study(study_name="ftmo_combined", direction="maximize",
        sampler=TPESampler(seed=42, multivariate=True),
        pruner=HyperbandPruner(min_resource=1, max_resource=2, reduction_factor=2),
        storage=args.storage, load_if_exists=True)
    start = time.time()
    study.optimize(objective, n_trials=args.n_trials, show_progress_bar=False,
                   callbacks=[lambda s,t: print(f"  trial {t.number}: Combined={t.value:.2f}% best={s.best_value:.2f}% @{int(time.time()-start)}s")])
    print(f"\n✅ Done. Best Combined: {study.best_value:.2f}%")
    print(f"Best params: {study.best_params}")

if __name__ == "__main__": main()
