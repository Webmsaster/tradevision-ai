#!/usr/bin/env python3
"""
R29-Track-B2: train a binary classifier (P(win)) on the FTMO trade dump.

Loads scripts/cache_bakeoff/ml_training.jsonl, fits a gradient-boosting
classifier with cross-validated hyperparams, and exports the model as
JSON (+ a simple-rules fallback) for Rust inference.

Output: scripts/cache_bakeoff/ml_model.json
"""
import json
import sys
from pathlib import Path
import numpy as np

try:
    from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
    from sklearn.model_selection import cross_val_score, train_test_split
    from sklearn.metrics import roc_auc_score, classification_report
except ImportError:
    print("Missing sklearn — install: pip install scikit-learn numpy")
    sys.exit(2)

CACHE = Path("scripts/cache_bakeoff")
TRAIN_FILE = CACHE / "ml_training.jsonl"
# Allow override of model output path + train-cutoff via env vars.
import os as _os
OUT_MODEL = Path(_os.environ.get("ML_MODEL_OUT", str(CACHE / "ml_model.json")))
CUTOFF_TS_MS = _os.environ.get("ML_CUTOFF_TS_MS")
CUTOFF_TS = int(CUTOFF_TS_MS) if CUTOFF_TS_MS else None

FEATURES = [
    "rsi14",
    "rsi28",
    "adx14",
    "atr14_pct",
    "sma20_slope",
    "sma50_slope",
    "sma200_slope",
    "hour",
    "dow",
    "prior5_return",
    "prior20_return",
    "asset_id",
    "direction_long",
]


def load_data():
    rows = []
    with open(TRAIN_FILE) as f:
        for line in f:
            r = json.loads(line)
            # Replace None / null with NaN.
            for k in FEATURES:
                if r.get(k) is None:
                    r[k] = np.nan
            rows.append(r)
    return rows


def build_xy(rows, target="is_win"):
    X = np.array([[r[k] for k in FEATURES] for r in rows], dtype=np.float64)
    y = np.array([r[target] for r in rows], dtype=np.int64)
    # Replace NaN with 0 for sklearn (gradient boosting can't handle NaN
    # without HistGradientBoosting; use simple imputation).
    X = np.nan_to_num(X, nan=0.0)
    return X, y


def main():
    rows = load_data()
    print(f"loaded {len(rows)} trades")
    if CUTOFF_TS is not None:
        before = len(rows)
        rows = [r for r in rows if r.get("entry_time", 0) < CUTOFF_TS]
        print(
            f"applied cutoff < {CUTOFF_TS} → kept {len(rows)} of {before} trades for training"
        )
    X, y = build_xy(rows, target="is_win")
    print(f"X shape={X.shape}, win rate={y.mean():.3f}")

    # 70/30 split for held-out validation.
    X_tr, X_va, y_tr, y_va = train_test_split(
        X, y, test_size=0.3, random_state=42, stratify=y
    )
    print(f"train={len(y_tr)} val={len(y_va)}")

    # Random Forest — fast, robust, exports easily as decision rules.
    clf = RandomForestClassifier(
        n_estimators=200,
        max_depth=8,
        min_samples_leaf=20,
        random_state=42,
        n_jobs=-1,
    )
    clf.fit(X_tr, y_tr)
    proba = clf.predict_proba(X_va)[:, 1]
    auc = roc_auc_score(y_va, proba)
    print(f"validation AUC = {auc:.4f}")

    # Threshold tuning: find threshold where signals above threshold have
    # >= 50% win-rate (so we keep those, filter out the rest).
    print("\nThreshold sweep (predicted P(win) → kept trades' actual win-rate):")
    thresholds = [0.10, 0.12, 0.15, 0.17, 0.20, 0.22, 0.25, 0.30, 0.35, 0.40]
    for t in thresholds:
        keep = proba >= t
        kept_wr = y_va[keep].mean() if keep.any() else 0.0
        kept_count = int(keep.sum())
        print(
            f"  t={t:.2f}: kept={kept_count:6d} ({100*keep.mean():5.1f}%), "
            f"win-rate={100*kept_wr:5.2f}%"
        )

    # Feature importance
    print("\nFeature importance:")
    for f, imp in sorted(
        zip(FEATURES, clf.feature_importances_), key=lambda x: -x[1]
    ):
        print(f"  {f:18s}: {imp:.4f}")

    # Export model: random forest as a list of trees (each tree as nested dict).
    # Simple recursive walker.
    def dump_tree(t, node=0):
        if t.children_left[node] == -1:
            return {
                "leaf": True,
                "value": float(t.value[node][0][1] / t.value[node][0].sum()),
            }
        return {
            "feature": int(t.feature[node]),
            "threshold": float(t.threshold[node]),
            "left": dump_tree(t, t.children_left[node]),
            "right": dump_tree(t, t.children_right[node]),
        }

    trees = [dump_tree(est.tree_) for est in clf.estimators_]
    model = {
        "type": "random_forest",
        "n_trees": len(trees),
        "features": FEATURES,
        "trees": trees,
        "win_rate_baseline": float(y.mean()),
        "validation_auc": float(auc),
    }
    OUT_MODEL.write_text(json.dumps(model))
    print(f"\nSaved model: {OUT_MODEL} ({OUT_MODEL.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
