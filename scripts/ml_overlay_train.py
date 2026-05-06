"""ML-Overlay Trainer (XGBoost) — trains a binary classifier on the
features produced by `_mlOverlayFeatures.ts`. Outcome label = 1 if the
signal eventually closed at TP, 0 if at stop. The model's score becomes
a per-signal "win-probability" used as an entry-gate threshold.

Usage:
    pip install xgboost scikit-learn pandas numpy
    python scripts/ml_overlay_train.py \
      --features scripts/cache_bakeoff/ml_features.jsonl \
      --out scripts/cache_bakeoff/ml_overlay_model.json \
      --report scripts/cache_bakeoff/ml_overlay_report.txt

Integration point (deferred): expose an `MLOverlayPredictor` wrapper that
loads `ml_overlay_model.json` and scores each signal in `detectAsset`. Skip
signals where score < threshold (typical: 0.55).

Status: SKELETON — the actual hyperparameter tuning, walk-forward CV, and
production calibration need careful work before live deployment. This
script does a baseline 80/20 split and reports feature importance + AUC,
which is the "is there signal here?" smoke test.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import numpy as np
    import pandas as pd
    from sklearn.metrics import (
        roc_auc_score,
        precision_recall_fscore_support,
        confusion_matrix,
    )
    from sklearn.model_selection import train_test_split
    import xgboost as xgb
except ImportError as e:
    print(
        f"[ml-overlay-train] missing dependency: {e.name}. "
        "Install with: pip install xgboost scikit-learn pandas numpy",
        file=sys.stderr,
    )
    sys.exit(1)


def load_features(path: Path) -> pd.DataFrame:
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            rows.append(row)
    df = pd.DataFrame(rows)
    print(f"[ml-overlay-train] loaded {len(df)} rows from {path}")
    return df


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--features", type=Path, required=True)
    ap.add_argument(
        "--out", type=Path, default=Path("scripts/cache_bakeoff/ml_overlay_model.json")
    )
    ap.add_argument(
        "--report",
        type=Path,
        default=Path("scripts/cache_bakeoff/ml_overlay_report.txt"),
    )
    ap.add_argument("--test-size", type=float, default=0.2)
    ap.add_argument("--random-state", type=int, default=42)
    args = ap.parse_args()

    if not args.features.exists():
        print(
            f"[ml-overlay-train] features file not found: {args.features}\n"
            f"Run: npx tsx scripts/_mlOverlayFeatures.ts first",
            file=sys.stderr,
        )
        return 1

    df = load_features(args.features)
    if "outcome" not in df.columns:
        print("[ml-overlay-train] no `outcome` column in features", file=sys.stderr)
        return 1

    drop_cols = {"outcome", "eff_pnl", "window_start", "ticket_id"}
    feature_cols = [c for c in df.columns if c not in drop_cols]
    print(f"[ml-overlay-train] {len(feature_cols)} features: {feature_cols}")

    X = df[feature_cols].apply(pd.to_numeric, errors="coerce")
    y = df["outcome"].astype(int)

    # Drop rows with any NaN feature.
    mask = X.notna().all(axis=1)
    X, y = X[mask], y[mask]
    print(f"[ml-overlay-train] after NaN-drop: {len(X)} rows  (TP={y.sum()}, stop={len(y) - y.sum()})")

    if len(X) < 100:
        print(
            "[ml-overlay-train] too few rows (<100) — generate more features first."
            " Run TS extractor on a longer history or more configs.",
            file=sys.stderr,
        )
        return 1

    # Time-series split: sort by window_start, then chronological cutoff.
    # Random split would leak future bars into train (signals from window N
    # share the same regime as their later closes in window N+1).
    if 'window_start' in df.columns:
        order = df.loc[mask].sort_values('window_start').index
        X = X.loc[order]
        y = y.loc[order]
        ws = df.loc[order, 'window_start']
    else:
        ws = pd.Series([0] * len(X), index=X.index)
    cutoff = int(len(X) * (1 - args.test_size))
    X_train, X_test = X.iloc[:cutoff], X.iloc[cutoff:]
    y_train, y_test = y.iloc[:cutoff], y.iloc[cutoff:]
    cutoff_ts = ws.iloc[cutoff] if cutoff < len(ws) else ws.iloc[-1]
    print(
        f'[ml_overlay] time-split: train={len(X_train)}, test={len(X_test)}, '
        f'cutoff=window_start_ts={cutoff_ts}'
    )

    clf = xgb.XGBClassifier(
        n_estimators=200,
        max_depth=4,
        learning_rate=0.05,
        objective="binary:logistic",
        eval_metric="auc",
        random_state=args.random_state,
        tree_method="hist",
    )
    clf.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=False)
    proba = clf.predict_proba(X_test)[:, 1]
    pred = (proba > 0.5).astype(int)

    auc = roc_auc_score(y_test, proba)
    p, r, f1, _ = precision_recall_fscore_support(y_test, pred, average="binary", zero_division=0)
    cm = confusion_matrix(y_test, pred)
    tn, fp, fn, tp = cm.ravel() if cm.size == 4 else (0, 0, 0, 0)

    importance = dict(zip(feature_cols, clf.feature_importances_.tolist()))
    importance_sorted = sorted(importance.items(), key=lambda x: -x[1])

    report = [
        "=== ML Overlay — XGBoost training report ===",
        f"Rows: train={len(X_train)}, test={len(X_test)}",
        f"Class balance (train): TP={y_train.sum()}, stop={len(y_train) - y_train.sum()}",
        "",
        "Test metrics:",
        f"  AUC:       {auc:.4f}",
        f"  precision: {p:.4f}",
        f"  recall:    {r:.4f}",
        f"  f1:        {f1:.4f}",
        f"  TN={tn}  FP={fp}  FN={fn}  TP={tp}",
        "",
        "Feature importance (descending):",
    ]
    for name, imp in importance_sorted:
        report.append(f"  {imp:.4f}  {name}")
    report.append("")
    report.append(
        "Interpretation: AUC > 0.55 suggests there is exploitable signal. "
        "AUC ~ 0.50 means the engine signals are already efficient and ML "
        "won't help — drop the overlay."
    )
    report.append("")
    report.append(
        "Next step: walk-forward CV (split by window_start, not random) and "
        "calibrate the threshold against live drift. THEN integrate into "
        "detectAsset as a per-signal score gate."
    )
    text = "\n".join(report)
    print(text)
    args.report.write_text(text)

    # Persist model in XGBoost JSON format.
    args.out.parent.mkdir(parents=True, exist_ok=True)
    clf.save_model(args.out)
    print(f"\n[ml-overlay-train] model saved → {args.out}")
    print(f"[ml-overlay-train] report saved → {args.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
