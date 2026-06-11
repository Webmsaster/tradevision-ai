#!/usr/bin/env python3
"""
2026-05-17 4-State HMM regime-conditional sizing.

Extension of existing 3-state HMM (bear/range/bull) in
engine-rust/ftmo-engine-core/src/signals_hmm_regime.rs.

NEW: 4-state split adds "crash" state (lowest µ_lr + highest µ_vol).
Per-regime size_mult applied at position-open.

Architecture:
- Python: hmmlearn.GaussianHMM(n_components=4) train on BTC 30m log-returns
- Sort states post-fit by (µ_lr, µ_vol): bull|sideways|bear|crash
- Export to JSON: { transitions, means, covars }
- Rust: load HMM JSON, viterbi-decode, lookup size_mult per state

CLI per state:
  --hmm-size-bull 1.2 --hmm-size-bear 0.5 --hmm-size-sideways 0.0 --hmm-size-crash 0.0

Estimated total: 4-6h (Python training + Rust loader + CLI flags + test).

Source: 50-agent Architecture Brainstorm Arch-35.
"""
import argparse
import sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candles", required=True, help="BTC 30m candles JSON")
    ap.add_argument("--n-states", type=int, default=4)
    ap.add_argument("--output", default="models/hmm_4state_btc_30m.json")
    args = ap.parse_args()

    print(f"[SKELETON] 4-state HMM regime detector")
    print(f"  candles: {args.candles}")
    print(f"  n_states: {args.n_states}")
    print(f"  output: {args.output}")
    print()
    print(f"NEXT STEPS:")
    print(f"  pip install hmmlearn numpy")
    print(f"  1. load BTC 30m candles, compute log-returns + realized-vol(20)")
    print(f"  2. fit GaussianHMM(n_components=4, covariance_type='diag')")
    print(f"  3. sort 4 states by (µ_lr, µ_vol):")
    print(f"     - lowest µ_lr + highest µ_vol = crash")
    print(f"     - lowest µ_vol = sideways")
    print(f"     - highest µ_lr = bull")
    print(f"     - mid-negative µ_lr + mid-vol = bear")
    print(f"  4. JSON dump: {{ start_probs, transmat, means, covars }}")
    print(f"  5. Rust load: extend HmmRegimeParams { n_states: 4 }")
    print(f"  6. Add CLI flags --hmm-size-{{bull,bear,sideways,crash}}")
    print(f"  7. Apply size_mult in sizing.rs at signal-fire")
    print()
    print(f"Expected: +1.5-3pp via regime-conditional sizing")
    print(f"Status: Skeleton ready. Full implementation = ~4-6h.")
    sys.exit(0)

if __name__ == "__main__":
    main()
