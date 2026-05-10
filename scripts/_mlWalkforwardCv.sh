#!/bin/bash
# R29-Audit: Walk-forward CV — train ML on multiple time-cutoffs, test
# on post-cutoff windows. If 65%+ holds across all folds, ML is robust.
# If only one fold works, we have overfitting / lucky-fold.
set -e
cd "$(dirname "$0")/.."

SYMS="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"

# Cutoff timestamps (UTC midnight Aug 31 of each year, ms)
declare -A CUTOFFS=(
  ["2022-08"]=1661904000000
  ["2023-08"]=1693440000000
  ["2024-08"]=1725114600000  # = 2024-08-31 14:30 UTC (reuses existing model)
  ["2025-08"]=1756630800000  # = 2025-08-31 09:00 UTC (rough)
)

for fold in "2022-08" "2023-08" "2024-08" "2025-08"; do
  CUTOFF="${CUTOFFS[$fold]}"
  MODEL="scripts/cache_bakeoff/ml_model_wfcv_${fold}.json"
  echo ""
  echo "=== Fold cutoff=$fold (ts=$CUTOFF) ==="
  echo "[train] cutoff=$CUTOFF → $MODEL"
  ML_CUTOFF_TS_MS=$CUTOFF ML_MODEL_OUT=$MODEL /usr/bin/python3 scripts/_mlTrainClassifier.py 2>&1 | grep -E "TRAIN|TEST|AUC|t=0.50|t=0.55|t=0.60|t=0.65|kept|Saved"
  echo ""
  echo "[test] sweep on post-$fold windows (phantom-suppress, no ML):"
  ./engine-rust/target/release/ftmo-sweep \
    --candles-dir scripts/cache_bakeoff --symbols "$SYMS" \
    --config 2h-trend-v5-titanium-passlock \
    --windows 400 --step-days 14 --signals per-asset \
    --start-after-ts "$CUTOFF" \
    --phantom-suppress 2>&1 | tail -1
  echo "[test] sweep + ML t=0.60 (target threshold):"
  ./engine-rust/target/release/ftmo-sweep \
    --candles-dir scripts/cache_bakeoff --symbols "$SYMS" \
    --config 2h-trend-v5-titanium-passlock \
    --windows 400 --step-days 14 --signals per-asset \
    --start-after-ts "$CUTOFF" \
    --ml-model "$MODEL" --ml-threshold 0.60 \
    --phantom-suppress 2>&1 | tail -1
  echo "[test] sweep + ML t=0.50:"
  ./engine-rust/target/release/ftmo-sweep \
    --candles-dir scripts/cache_bakeoff --symbols "$SYMS" \
    --config 2h-trend-v5-titanium-passlock \
    --windows 400 --step-days 14 --signals per-asset \
    --start-after-ts "$CUTOFF" \
    --ml-model "$MODEL" --ml-threshold 0.50 \
    --phantom-suppress 2>&1 | tail -1
done
