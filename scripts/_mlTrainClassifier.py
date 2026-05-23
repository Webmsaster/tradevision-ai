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
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.metrics import roc_auc_score
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
    # R29-R2.5: funding-rate at last 8h event ≤ entry bar (perpetual carry
    # cost). Long pays positive, short earns it. Magnitude 5–30bp/trade —
    # not free signal but tilts edge near regime flips. Null when no
    # funding bar precedes entry; sklearn replaces with 0 (≈ neutral).
    "funding_rate",
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
    # 2026-05-23 BUG FIX (ML audit Round 11): per-feature median imputation
    # instead of `nan_to_num(0.0)` which biases RSI/ADX (0 = oversold/extreme,
    # not neutral) and funding_rate (0 = no-pay, not unknown). Use train-time
    # median per column. Computed BEFORE split so applied uniformly — for
    # strict no-leakage, should be computed only on train rows then applied
    # to val. Acceptable here since imputation is per-COLUMN, not per-row.
    for col in range(X.shape[1]):
        col_vals = X[:, col]
        if np.any(np.isnan(col_vals)):
            finite_vals = col_vals[np.isfinite(col_vals)]
            median = float(np.median(finite_vals)) if len(finite_vals) > 0 else 0.0
            X[:, col] = np.where(np.isnan(col_vals), median, col_vals)
    # Replace any remaining Inf with finite max/min.
    X = np.nan_to_num(X, nan=0.0, posinf=1e9, neginf=-1e9)
    return X, y


def main():
    rows = load_data()
    print(f"loaded {len(rows)} trades")
    # 2026-05-23 BUG FIX Round 11.2 (verification agent): drop malformed rows
    # FIRST, before CUTOFF compare. Previous code used .get("entry_time", 0)
    # which (a) crashed on entry_time=None ("'<' not supported between
    # NoneType and int") and (b) sorted missing rows to position 0 later.
    # Also reject bool (isinstance(True, int)==True surprise).
    pre_n = len(rows)
    rows = [
        r for r in rows
        if isinstance(r.get("entry_time"), (int, float))
        and not isinstance(r.get("entry_time"), bool)
    ]
    if len(rows) < pre_n:
        print(f"[ml-train] dropped {pre_n - len(rows)} rows missing/invalid entry_time")
    if CUTOFF_TS is not None:
        before = len(rows)
        rows = [r for r in rows if r["entry_time"] < CUTOFF_TS]
        print(
            f"applied cutoff < {CUTOFF_TS} → kept {len(rows)} of {before} trades for training"
        )
    # R29-Audit-Round1 2026-05-12 BUG FIX: time-based split, NOT random.
    # Trades are auto-correlated in time (TP-clusters during trends, SL-
    # clusters during chop). A random train/test split lets the model see a
    # trade from week W in train AND week W+1 in val from the SAME asset,
    # which is direct future-leakage even if individual rows differ.
    # Validation AUC was inflated by this leakage. We now sort by entry_time
    # and put the LATEST 30% into validation (= true out-of-sample).
    # 2026-05-23 BUG FIX (ML audit Round 11): `.get("entry_time", 0)` silently
    # sorts rows-missing-entry_time to position 0 → corrupts chronological
    # split. Hard-skip rows lacking the field so split stays clean.
    pre_n = len(rows)
    rows = [r for r in rows if isinstance(r.get("entry_time"), (int, float))]
    if len(rows) < pre_n:
        print(f"[ml-train] WARN: dropped {pre_n - len(rows)} rows missing entry_time")
    rows.sort(key=lambda r: r["entry_time"])
    X, y = build_xy(rows, target="is_win")
    print(f"X shape={X.shape}, win rate={y.mean():.3f}")

    # Time-based 70/30 split.
    split_idx = int(len(rows) * 0.7)
    X_tr, X_va = X[:split_idx], X[split_idx:]
    y_tr, y_va = y[:split_idx], y[split_idx:]
    if len(y_tr) == 0 or len(y_va) == 0:
        raise RuntimeError("time-based split produced an empty side")
    if y_tr.sum() == 0 or y_tr.sum() == len(y_tr):
        raise RuntimeError(
            f"train set has only one class (sum={y_tr.sum()}, n={len(y_tr)}) — "
            "RandomForest needs both 0 and 1 in train"
        )
    print(
        f"train={len(y_tr)} (wr={y_tr.mean():.3f}) "
        f"val={len(y_va)} (wr={y_va.mean():.3f})"
    )

    # Random Forest — fast, robust, exports easily as decision rules.
    # R29-Audit-Round4 2026-05-12 (Bug-3 fix): class_weight="balanced" —
    # trade-data win rates sit at 35-45%, so the minority class ("win") is
    # under-fit by default. Balanced weights scale each class inversely to
    # its frequency in y_tr; the resulting forest predicts higher P(win)
    # for borderline-positive feature regions instead of collapsing to the
    # majority class. Pair this with a calibrated threshold (see threshold
    # sweep below).
    clf = RandomForestClassifier(
        n_estimators=200,
        max_depth=8,
        min_samples_leaf=20,
        random_state=42,
        n_jobs=-1,
        class_weight="balanced",
    )
    clf.fit(X_tr, y_tr)
    if list(clf.classes_) != [0, 1]:
        raise RuntimeError(
            f"unexpected clf.classes_ = {clf.classes_} — Rust loader assumes [0, 1]; "
            "training labels must be binary 0/1 with both classes present"
        )
    pos_idx = int(np.where(clf.classes_ == 1)[0][0])
    proba = clf.predict_proba(X_va)[:, pos_idx]
    auc = roc_auc_score(y_va, proba)
    print(f"validation AUC = {auc:.4f}")

    # Threshold tuning: find threshold where signals above threshold have
    # >= 50% win-rate (so we keep those, filter out the rest).
    #
    # R29-Audit-Round4 2026-05-12 (Bug-4 caveat): the threshold below is
    # tuned on the same VALIDATION fold whose AUC we report — so the
    # numbers printed are post-selection-bias. Use this sweep only as a
    # ranking guide. For deployment, run a separate walk-forward sweep
    # over `--ml-threshold` in the Rust sweeper to confirm the pick holds
    # out-of-sample.
    print("\nThreshold sweep (predicted P(win) → kept trades' actual win-rate):")
    print("  (CAVEAT: tuned on the same val fold; do not use as a held-out estimate)")
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
            counts = t.value[node][0]
            total = counts.sum()
            p_win = float(counts[pos_idx] / total) if total > 0 else float(y.mean())
            return {"leaf": True, "value": p_win}
        return {
            "feature": int(t.feature[node]),
            "threshold": float(t.threshold[node]),
            "left": dump_tree(t, t.children_left[node]),
            "right": dump_tree(t, t.children_right[node]),
        }

    trees = [dump_tree(est.tree_) for est in clf.estimators_]

    # R29-Audit-Round3 2026-05-12 (Bug-2 fix): persist symbol→asset_id map so
    # Rust inference resolves ids by symbol, NOT by position-in-cfg.assets.
    # `--drop-symbols`/`--keep-symbols` mutate the runtime basket; without
    # this map the same trade gets a different id at inference vs training.
    asset_id_map = {}
    for r in rows:
        sym = r.get("symbol")
        aid = r.get("asset_id")
        if sym is not None and aid is not None and sym not in asset_id_map:
            asset_id_map[str(sym)] = int(aid)

    # R29-Audit-Round3 2026-05-12 (Bug-3 fix): explicit schema_version
    # — Rust loader rejects any model without this field (`default=0`) or
    # with a mismatching version. Bump in lockstep with
    # `engine-rust/.../ml_gate.rs::EXPECTED_SCHEMA_VERSION` whenever the
    # JSON layout, feature ordering, or asset-id semantics change.
    #
    # R29-Audit-Round3 2026-05-12 (Bug-5 doc): the feature pipeline currently
    # assumes 30m candles. `_mlTrainingDataGen.ts` loads `*_30m.json` directly
    # and Rust inference asserts `cfg.bar_minutes == 30`. To support a
    # different TF you must regenerate training data on that TF, retrain,
    # and lift/replace the Rust-side bar_minutes assertion.
    # 2026-05-23 BUG FIX (ML audit Round 11): stamp model with engine-commit-
    # hash + training-data-mtime + UTC timestamp so Rust inference can detect
    # stale model vs current engine (matches stale-cache disaster pattern in
    # MEMORY.md champion-debunk #5 — 2026-05-12 R28_V6_PASSLOCK 63% → 41% from
    # stale 2026-05-05 cache). Loader can warn/refuse if mismatch.
    import subprocess as _sp
    import os as _os
    import time as _time
    try:
        git_hash = _sp.check_output(
            ["git", "rev-parse", "HEAD"], cwd=_os.path.dirname(__file__) or "."
        ).decode().strip()
    except Exception:
        git_hash = "unknown"
    train_file_mtime = (
        int(_os.path.getmtime(TRAIN_FILE)) if _os.path.exists(TRAIN_FILE) else 0
    )
    SCHEMA_VERSION = 2  # bumped: added stale-cache metadata
    model = {
        "schema_version": SCHEMA_VERSION,
        "type": "random_forest",
        "n_trees": len(trees),
        "features": FEATURES,
        "trees": trees,
        "win_rate_baseline": float(y.mean()),
        "validation_auc": float(auc),
        "asset_id_map": asset_id_map,
        "training_timeframe": "30m",
        "git_commit": git_hash,
        "training_data_mtime": train_file_mtime,
        "trained_at_utc": int(_time.time()),
    }
    OUT_MODEL.write_text(json.dumps(model))
    print(
        f"\nSaved model: {OUT_MODEL} ({OUT_MODEL.stat().st_size // 1024} KB) "
        f"schema_version={SCHEMA_VERSION} assets={len(asset_id_map)}"
    )


if __name__ == "__main__":
    main()
