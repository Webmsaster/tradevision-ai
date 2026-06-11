#!/usr/bin/env python3
"""
2026-05-17 LSTM ML bug-frei retry — training pipeline.

Replaces the 2026-05-10 debunked RF model. Key bug-fix: feature_idx must use
candles[entry_bar - 1] (closed bar before entry), NEVER candles[entry_bar].

Architecture: 2-layer LSTM (hidden=64) → Dense(32) → Sigmoid → P(win)
Input: [batch, 32, 5] = 32×30m bars × {log_ret, atr_pct, rsi14, macd_hist, adx14}

Train: 2022-01..2024-12 (3y)
Validate: 2025-01..2026-05 (strict OOS)
Export: ONNX opset 17 (for Rust tract inference)

Sanity gate: AUC > 0.65 OOS → trigger causality audit (RF Round 9 hit 0.82
that turned out look-ahead). Acceptance AUC ≥ 0.55, < 0.65.

Usage:
  python3 scripts/ml/lstm_train.py --candles-dir scripts/cache_bakeoff \
    --train-start 2022-01-01 --train-end 2024-12-31 \
    --val-start 2025-01-01 --val-end 2026-05-16 \
    --output models/lstm_pwin.onnx
"""
import argparse
import json
import sys
from pathlib import Path

# NOTE: This is a SKELETON. Full training pipeline requires:
# - pip install torch onnx onnxruntime numpy
# - feature extraction loop (lookahead-safe at feature_idx = entry_bar - 1)
# - PyTorch LSTM model + training loop + early stopping
# - ONNX export + Rust integration via tract crate
# Estimated total: ~2 days implementation + 12h GPU training

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candles-dir", required=True)
    ap.add_argument("--train-start", required=True)
    ap.add_argument("--train-end", required=True)
    ap.add_argument("--val-start", required=True)
    ap.add_argument("--val-end", required=True)
    ap.add_argument("--output", default="models/lstm_pwin.onnx")
    ap.add_argument("--seq-len", type=int, default=32)
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--lr", type=float, default=1e-3)
    args = ap.parse_args()

    print(f"[SKELETON] LSTM ML bug-frei retry")
    print(f"  candles_dir: {args.candles_dir}")
    print(f"  train: {args.train_start} → {args.train_end}")
    print(f"  val:   {args.val_start} → {args.val_end}")
    print(f"  seq_len={args.seq_len} hidden={args.hidden} epochs={args.epochs}")
    print()
    print(f"NEXT STEPS (not in skeleton):")
    print(f"  1. extract_features() using STRICT feature_idx = entry_bar - 1")
    print(f"  2. label = trade outcome (win/loss) from historical sweep JSONL")
    print(f"  3. PyTorch LSTM train with early stopping on val AUC")
    print(f"  4. SANITY: if AUC > 0.65 → trigger causality audit")
    print(f"  5. ONNX export to {args.output}")
    print(f"  6. Add engine-rust/ftmo-engine-core/src/signals_lstm.rs")
    print(f"     using tract-onnx for inference")
    print()
    print(f"Status: Skeleton ready. Full implementation = ~2 days.")
    sys.exit(0)

if __name__ == "__main__":
    main()
