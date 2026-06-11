#!/usr/bin/env python3
"""2026-05-17 Logistic-Regression P(win) — minimal trainable script.
6 features → sigmoid → binary classifier. Coefficients exportable to JSON
for Rust inference (5-line sigmoid).
"""
import argparse, json, sys
from pathlib import Path
try:
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import TimeSeriesSplit
    from sklearn.metrics import roc_auc_score
except ImportError:
    print("Install: pip install --user --break-system-packages scikit-learn numpy"); sys.exit(1)

# DEMO: generate synthetic features for testing. Real version reads trade-log JSONLs.
def make_synthetic(n=2000, seed=42):
    rng = np.random.default_rng(seed)
    X = rng.normal(0, 1, (n, 6))
    # synthetic label: positive if feature[0]+feature[3] > 0
    y = ((X[:, 0] + X[:, 3] + rng.normal(0, 0.5, n)) > 0).astype(int)
    return X, y

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="models/logistic_pwin.json")
    ap.add_argument("--synthetic", action="store_true", help="use synthetic demo data")
    args = ap.parse_args()
    if args.synthetic:
        X, y = make_synthetic()
        print(f"[demo] synthetic {X.shape[0]} samples, {X.shape[1]} features")
    else:
        print("Real-data mode requires trade-log JSONL parser (not in skeleton)")
        sys.exit(0)
    tscv = TimeSeriesSplit(n_splits=5)
    aucs = []
    for fold, (tr, va) in enumerate(tscv.split(X)):
        model = LogisticRegression(C=1.0, max_iter=200)
        model.fit(X[tr], y[tr])
        pred = model.predict_proba(X[va])[:, 1]
        auc = roc_auc_score(y[va], pred)
        aucs.append(auc)
        print(f"  fold {fold}: AUC={auc:.3f}")
    print(f"  Mean AUC: {np.mean(aucs):.3f}")
    if np.mean(aucs) > 0.65:
        print("  ⚠ AUC >0.65 → trigger lookahead causality audit before deploy")
    # Final fit on all
    model = LogisticRegression(C=1.0, max_iter=200).fit(X, y)
    out = Path(args.out); out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "schema": "logistic_pwin_v1",
        "coefficients": model.coef_[0].tolist(),
        "intercept": float(model.intercept_[0]),
        "feature_names": ["atr_pct", "trend_strength", "bb_z", "votes_count", "btc_aligned", "funding_z"],
        "auc_mean": float(np.mean(aucs)),
    }, indent=2))
    print(f"✅ Saved to {out}")
if __name__ == "__main__": main()
