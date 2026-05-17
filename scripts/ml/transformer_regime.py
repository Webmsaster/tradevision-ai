#!/usr/bin/env python3
"""
2026-05-17 Transformer-based market regime detector.

Replaces 3-state HMM with 4-state Transformer-Encoder (bull/bear/range/chaos).
Multi-Head Attention captures regime transitions HMM transition-matrix can't.

Architecture: 2-layer Transformer (d_model=32, 4 heads)
Input: [batch, 64, 8] = 64×30m bars × {OHLCV+ATR+RSI+ad_line}
Output: 4-state Softmax

Lookahead-safe: input = bars[idx-64..=idx-1], NEVER idx
Train: 2020-2024 (200k labeled bars, label = forward-volatility-regime)
Export: ONNX opset 17

Estimated total: 3-4 days (1d feature pipeline, 1d train, 1d Rust integration,
1d validation + walk-forward).
"""
import argparse
import sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candles-dir", required=True)
    ap.add_argument("--output", default="models/regime_transformer.onnx")
    ap.add_argument("--d-model", type=int, default=32)
    ap.add_argument("--n-heads", type=int, default=4)
    ap.add_argument("--n-layers", type=int, default=2)
    ap.add_argument("--seq-len", type=int, default=64)
    ap.add_argument("--n-states", type=int, default=4)
    args = ap.parse_args()

    print(f"[SKELETON] Transformer Regime Detector")
    print(f"  candles_dir: {args.candles_dir}")
    print(f"  Architecture: {args.n_layers}-layer, d_model={args.d_model}, heads={args.n_heads}")
    print(f"  Sequence: {args.seq_len} bars, {args.n_states} states")
    print()
    print(f"NEXT STEPS (not in skeleton):")
    print(f"  1. Feature extractor (OHLCV + ATR + RSI + ad_line per bar)")
    print(f"     STRICT feature_idx = bar - 1")
    print(f"  2. Pseudo-labels from forward-vol-cluster (KRIT: must NOT leak future)")
    print(f"  3. PyTorch Transformer model + train + val")
    print(f"  4. ONNX export to {args.output}")
    print(f"  5. engine-rust/ftmo-engine-core/src/signals_transformer_regime.rs")
    print(f"     using tract-onnx for <2ms inference")
    print(f"  6. Wire into RegimeConfluence as use_transformer_regime voter")
    print()
    print(f"Risk: 60% Debunk-Risk (recursion of 2026-05-10 ML look-ahead bug)")
    print(f"Status: Skeleton ready. Full implementation = ~3-4 days.")
    sys.exit(0)

if __name__ == "__main__":
    main()
