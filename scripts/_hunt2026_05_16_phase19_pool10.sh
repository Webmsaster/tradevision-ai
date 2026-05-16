#!/bin/bash
# 2026-05-16 Phase 19 — Multi-Account Pool Expansion 4→10 configs.
# Arch-33 brainstorm idea: Greedy anti-corr selector finds best 3-of-10.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16/multi_account
mkdir -p "$OUT"

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"
KELLY="--kelly-sizing --max-days 45"

run() {
  local label="$1"; local cfg="$2"; shift 2
  local p1_file="$OUT/${label}_p1.jsonl"
  local p2_file="$OUT/${label}_p2.jsonl"
  if [ -f "$p1_file" ] && [ -f "$p2_file" ]; then echo "[skip-done] $label"; return; fi
  echo "=== $label ($cfg) ==="
  $SWEEP $COMMON --config "$cfg" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER $KELLY "$@" --out "$p1_file" 2>&1 | tail -1
  $SWEEP $COMMON --config "$cfg" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER $KELLY "$@" --out "$p2_file" 2>&1 | tail -1
}

# Bestehende A-D bleiben (skip-done schützt)
run "A_amber"        "2h-trend-v5-amber-max-passlock"          --override-tp-mult 1.14
run "B_titanium"     "2h-trend-v5-titanium-passlock"           --override-tp-mult 1.10
run "C_obsidian"     "2h-trend-v5-obsidian-passlock"           --override-tp-mult 1.10
run "D_topaz"        "2h-trend-v5-topaz-passlock"              --override-tp-mult 1.10

# NEU: 6 zusätzliche PASSLOCK-Configs
run "E_rubin"        "2h-trend-v5-rubin-passlock"              --override-tp-mult 1.10
run "F_sapphir"      "2h-trend-v5-sapphir-passlock"            --override-tp-mult 1.10
run "G_diamond"      "2h-trend-v5-diamond-passlock"            --override-tp-mult 1.10
run "H_amber_ds"     "2h-trend-v5-amber-passlock-daystage"     --override-tp-mult 1.10
run "I_amber_atr"    "2h-trend-v5-amber-atr-passlock"          --override-tp-mult 1.10
run "J_r28_v6"       "2h-trend-v5-quartz-lite-r28-v6-passlock" --override-tp-mult 1.10

echo ""
ls -la $OUT/
