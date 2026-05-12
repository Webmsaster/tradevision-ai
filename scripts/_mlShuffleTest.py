#!/usr/bin/env python3
"""
R29-Audit: Label-Shuffle Sanity Check.

Train ML with SHUFFLED labels (random win/loss assignment, preserving
class balance). If pass-rate boost survives label-shuffle, something
non-label is leaking. If boost vanishes (pass-rate ≈ baseline), the
model learned real label correlation.

Output: scripts/cache_bakeoff/ml_model_shuffled.json
"""
import json
from pathlib import Path
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score

CACHE = Path("scripts/cache_bakeoff")
TRAIN_FILE = CACHE / "ml_training.jsonl"
OUT_MODEL = CACHE / "ml_model_shuffled.json"
CUTOFF = 1725114600000  # 2024-08-31

FEATURES = [
    "rsi14", "rsi28", "adx14", "atr14_pct",
    "sma20_slope", "sma50_slope", "sma200_slope",
    "hour", "dow", "prior5_return", "prior20_return",
    "asset_id", "direction_long",
]

rows = []
with open(TRAIN_FILE) as f:
    for line in f:
        r = json.loads(line)
        for k in FEATURES:
            if r.get(k) is None:
                r[k] = np.nan
        rows.append(r)

train = [r for r in rows if r["entry_time"] < CUTOFF]
test = [r for r in rows if r["entry_time"] >= CUTOFF]

X_tr = np.nan_to_num(np.array([[r[k] for k in FEATURES] for r in train], dtype=float))
y_tr = np.array([r["is_win"] for r in train])
X_te = np.nan_to_num(np.array([[r[k] for k in FEATURES] for r in test], dtype=float))
y_te = np.array([r["is_win"] for r in test])

# SHUFFLE labels in training set (preserves class balance, breaks
# feature-label correlation).
rng = np.random.default_rng(42)
rng.shuffle(y_tr)
print(f"TRAIN shuffled: {len(y_tr)} trades, win-rate={y_tr.mean():.3f}")
print(f"TEST (real labels): {len(y_te)} trades, win-rate={y_te.mean():.3f}")

clf = RandomForestClassifier(
    n_estimators=200, max_depth=8, min_samples_leaf=20, random_state=42, n_jobs=-1
)
clf.fit(X_tr, y_tr)
proba = clf.predict_proba(X_te)[:, 1]
auc = roc_auc_score(y_te, proba)
print(f"OOS AUC (with SHUFFLED training labels): {auc:.4f}")
print("Expected if no leak: ~0.50 (random predictor on test set)")

print("\nThreshold sweep on TEST (real labels) using shuffle-trained model:")
for t in [0.10, 0.15, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70]:
    keep = proba >= t
    wr = y_te[keep].mean() if keep.any() else 0
    print(
        f"  t={t:.2f}: kept={keep.sum():6d} ({100*keep.mean():.1f}%), "
        f"actual win-rate={100*wr:.2f}% (baseline {100*y_te.mean():.2f}%)"
    )

# Save model anyway for backtest comparison
def dump_tree(t, node=0):
    if t.children_left[node] == -1:
        return {"leaf": True, "value": float(t.value[node][0][1] / t.value[node][0].sum())}
    return {
        "feature": int(t.feature[node]),
        "threshold": float(t.threshold[node]),
        "left": dump_tree(t, t.children_left[node]),
        "right": dump_tree(t, t.children_right[node]),
    }


trees = [dump_tree(est.tree_) for est in clf.estimators_]
model = {
    "type": "random_forest_SHUFFLED_LABELS",
    "n_trees": len(trees),
    "features": FEATURES,
    "trees": trees,
    "win_rate_baseline": float(y_tr.mean()),
    "validation_auc": float(auc),
}
OUT_MODEL.write_text(json.dumps(model))
print(f"\nSaved shuffle-control model: {OUT_MODEL}")
