#!/usr/bin/env python3
"""Volatility-regime classifier: predict PASS vs FAIL per challenge-window
from pre-window features ONLY (no look-ahead).

Features (all pre-challenge, observable at t=0):
  - btc_atr_pre, btc_range_pre, btc_return_pre, btc_vol_pre, btc_trend_pre, btc_up_frac_pre
  - cluster breadth_24h, majors_24h, breadth_48h, majors_48h, breadth_72h, majors_72h
  - dir_coherence_24h (cluster directional coherence)
  - cross_asset_corr (computed below if not cached)

Pure-Python logistic regression (gradient descent), chronological 50/50 split.

If classifier-precision on TEST half > cluster-gate precision (~94% on qualified)
AND it qualifies MORE windows than the gate, that's a real new lever.
"""
from __future__ import annotations
import csv
import json
import math
import random
from pathlib import Path

BASE = Path(__file__).resolve().parent
CA = BASE / "cache_bakeoff" / "cluster_audit"
MACRO = CA / "macro_metrics.csv"
CLUS = CA / "cluster_metrics.csv"
CHAMP = CA / "champion.jsonl"


def load_csv(path):
    rows = []
    with path.open() as f:
        r = csv.DictReader(f)
        for row in r:
            rows.append(row)
    return rows


def to_float(v, default=0.0):
    try:
        return float(v)
    except (ValueError, TypeError):
        return default


def to_bool(v):
    return str(v).strip().lower() in ("true", "1", "yes")


def load_dataset():
    macro = {int(r["win_idx"]): r for r in load_csv(MACRO)}
    clus = {int(r["win_idx"]): r for r in load_csv(CLUS)}
    champ_idx = set()
    champ = {}
    with CHAMP.open() as f:
        for line in f:
            r = json.loads(line)
            champ[r["win_idx"]] = r
            champ_idx.add(r["win_idx"])
    # Join only windows that exist in all three
    keys = sorted(set(macro) & set(clus) & champ_idx)
    rows = []
    for k in keys:
        m = macro[k]
        c = clus[k]
        ch = champ[k]
        feats = {
            "win_idx": k,
            # Macro pre-window features (BTC, 7d look-back BEFORE challenge start)
            "btc_atr_pre": to_float(m.get("btc_atr_pre")),
            "btc_range_pre": to_float(m.get("btc_range_pre")),
            "btc_return_pre": to_float(m.get("btc_return_pre")),
            "btc_vol_pre": to_float(m.get("btc_vol_pre")),
            "btc_trend_pre": to_float(m.get("btc_trend_pre")),
            "btc_up_frac_pre": to_float(m.get("btc_up_frac_pre")),
            # Cluster pre-window features
            # NB: breadth_24h etc are first-24h-IN-window, but for this audit
            # they are what the bot can observe at t=24h after entering.
            # We use them as "early-window observable" features.
            "breadth_24h": to_float(c.get("breadth_24h")),
            "majors_24h": to_float(c.get("majors_24h")),
            "breadth_48h": to_float(c.get("breadth_48h")),
            "majors_48h": to_float(c.get("majors_48h")),
            "breadth_72h": to_float(c.get("breadth_72h")),
            "majors_72h": to_float(c.get("majors_72h")),
            "dir_coherence_24h": to_float(c.get("dir_coherence_24h")),
            "first_4h_count": to_float(c.get("first_4h_count")),
            "first_8h_count": to_float(c.get("first_8h_count")),
            "btc_in_first3": to_float(c.get("btc_in_first3")),
            "majors_in_first3": to_float(c.get("majors_in_first3")),
            # Labels
            "passed": to_bool(m.get("passed")),
            "qualified": to_bool(m.get("qualified")),
        }
        rows.append(feats)
    return rows


# ---------- Pure-Python logistic regression ----------

def standardize(X):
    """Per-feature z-score. X = list of list-of-floats."""
    n_feat = len(X[0])
    means = [0.0] * n_feat
    stds = [0.0] * n_feat
    n = len(X)
    for j in range(n_feat):
        col = [row[j] for row in X]
        m = sum(col) / n
        means[j] = m
        v = sum((x - m) ** 2 for x in col) / n
        stds[j] = math.sqrt(v) if v > 1e-12 else 1.0
    Xn = [[(row[j] - means[j]) / stds[j] for j in range(n_feat)] for row in X]
    return Xn, means, stds


def apply_standardize(X, means, stds):
    return [[(row[j] - means[j]) / stds[j] for j in range(len(means))] for row in X]


def sigmoid(z):
    if z >= 0:
        ez = math.exp(-z)
        return 1.0 / (1.0 + ez)
    ez = math.exp(z)
    return ez / (1.0 + ez)


def train_logreg(X, y, lr=0.05, n_iter=4000, l2=0.5, verbose=False):
    """Train binary logistic regression with L2 (Ridge). y in {0,1}."""
    n = len(X)
    d = len(X[0])
    w = [0.0] * d
    b = 0.0
    for it in range(n_iter):
        # Forward
        zs = [b + sum(w[j] * X[i][j] for j in range(d)) for i in range(n)]
        ps = [sigmoid(z) for z in zs]
        # Loss (for monitoring)
        if verbose and it % 500 == 0:
            eps = 1e-12
            ll = -sum(y[i] * math.log(ps[i] + eps) + (1 - y[i]) * math.log(1 - ps[i] + eps) for i in range(n)) / n
            print(f"  iter {it} log-loss={ll:.4f}")
        # Gradients
        diff = [ps[i] - y[i] for i in range(n)]
        gw = [sum(diff[i] * X[i][j] for i in range(n)) / n + l2 * w[j] for j in range(d)]
        gb = sum(diff) / n
        # Update
        for j in range(d):
            w[j] -= lr * gw[j]
        b -= lr * gb
    return w, b


def predict_proba(w, b, X):
    return [sigmoid(b + sum(w[j] * x[j] for j in range(len(w)))) for x in X]


def confusion(y_true, y_pred):
    tp = sum(1 for a, p in zip(y_true, y_pred) if a == 1 and p == 1)
    fp = sum(1 for a, p in zip(y_true, y_pred) if a == 0 and p == 1)
    tn = sum(1 for a, p in zip(y_true, y_pred) if a == 0 and p == 0)
    fn = sum(1 for a, p in zip(y_true, y_pred) if a == 1 and p == 0)
    return tp, fp, tn, fn


def metrics(y_true, y_pred):
    tp, fp, tn, fn = confusion(y_true, y_pred)
    n = len(y_true)
    acc = (tp + tn) / n if n else 0.0
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    return acc, prec, rec, f1, (tp, fp, tn, fn)


def main():
    rows = load_dataset()
    n = len(rows)
    print(f"Loaded {n} windows.")
    pass_rate_all = sum(1 for r in rows if r["passed"]) / n
    qual_rate_all = sum(1 for r in rows if r["qualified"]) / n
    print(f"Base pass-rate (all): {pass_rate_all*100:.2f}%  qualified-rate: {qual_rate_all*100:.2f}%")

    # Cluster-gate metric (qualified=True ⇒ predict pass)
    # The "gate" uses breadth+majors-24h thresholds; here we use the precomputed `qualified` bool.
    y_all = [1 if r["passed"] else 0 for r in rows]
    qual = [1 if r["qualified"] else 0 for r in rows]
    acc_g, prec_g, rec_g, f1_g, cm_g = metrics(y_all, qual)
    print(f"\n=== Cluster-Gate (qualified flag) on ALL {n} windows ===")
    print(f"  acc={acc_g*100:.2f}%  precision={prec_g*100:.2f}%  recall={rec_g*100:.2f}%  F1={f1_g*100:.2f}%")
    print(f"  TP={cm_g[0]} FP={cm_g[1]} TN={cm_g[2]} FN={cm_g[3]}")

    # Feature names (pre-window only — no look-ahead from the perspective of "predict at t=0")
    # The 24h cluster features are observable AFTER 24h of trading; they're "early-window"
    # not strictly pre-window. We'll run two flavours:
    #   (A) Pure PRE features (BTC macro only) → predict-at-t=0
    #   (B) Early-window (PRE + 24h cluster) → predict-at-t=24h (like cluster gate)

    pure_pre = [
        "btc_atr_pre", "btc_range_pre", "btc_return_pre",
        "btc_vol_pre", "btc_trend_pre", "btc_up_frac_pre",
    ]
    early_window = pure_pre + [
        "breadth_24h", "majors_24h", "dir_coherence_24h",
        "first_4h_count", "first_8h_count",
        "btc_in_first3", "majors_in_first3",
    ]

    # Chronological 50/50 split (rows are sorted by win_idx already)
    split = n // 2

    for flavour, feats in [("A_pure_pre", pure_pre), ("B_early_window", early_window)]:
        print(f"\n=== Classifier {flavour}  features={feats} ===")
        X = [[r[f] for f in feats] for r in rows]
        y = y_all
        X_tr, X_te = X[:split], X[split:]
        y_tr, y_te = y[:split], y[split:]
        # Standardize using TRAIN stats only
        Xs_tr, mu, sd = standardize(X_tr)
        Xs_te = apply_standardize(X_te, mu, sd)
        # Train
        w, b = train_logreg(Xs_tr, y_tr, lr=0.05, n_iter=5000, l2=0.3)

        # Train metrics
        p_tr = predict_proba(w, b, Xs_tr)
        pred_tr = [1 if p >= 0.5 else 0 for p in p_tr]
        acc_tr, prec_tr, rec_tr, f1_tr, _ = metrics(y_tr, pred_tr)
        print(f"  TRAIN: acc={acc_tr*100:.2f}%  precision={prec_tr*100:.2f}%  recall={rec_tr*100:.2f}%  F1={f1_tr*100:.2f}%")

        # Test metrics @0.5
        p_te = predict_proba(w, b, Xs_te)
        pred_te = [1 if p >= 0.5 else 0 for p in p_te]
        acc_te, prec_te, rec_te, f1_te, cm_te = metrics(y_te, pred_te)
        print(f"  TEST @0.5: acc={acc_te*100:.2f}%  precision={prec_te*100:.2f}%  recall={rec_te*100:.2f}%  F1={f1_te*100:.2f}%")
        print(f"             TP={cm_te[0]} FP={cm_te[1]} TN={cm_te[2]} FN={cm_te[3]}  n_test={len(y_te)}")

        # Threshold sweep on TEST (just to see if a higher threshold gives high-precision picks)
        print(f"  Threshold sweep on TEST:")
        for th in [0.40, 0.50, 0.60, 0.70]:
            pred_th = [1 if p >= th else 0 for p in p_te]
            a, pr, rc, f, _ = metrics(y_te, pred_th)
            n_pos = sum(pred_th)
            print(f"    th={th:.2f}: n_picked={n_pos:3d} acc={a*100:5.2f}% prec={pr*100:5.2f}% rec={rc*100:5.2f}% F1={f*100:5.2f}%")

        # Feature importance: |w_j| in standardized space ranks features by predictive contribution
        imps = sorted(zip(feats, w), key=lambda x: abs(x[1]), reverse=True)
        print(f"  Top features by |w| (standardized space):")
        for fname, wj in imps[:8]:
            sign = "PASS-direction" if wj > 0 else "FAIL-direction"
            print(f"    {fname:25s}  w={wj:+.3f}  ({sign})")

        # Compare with cluster-gate on the TEST half
        qual_te = qual[split:]
        acc_g_te, prec_g_te, rec_g_te, f1_g_te, cm_g_te = metrics(y_te, qual_te)
        print(f"  Cluster-Gate on TEST half: acc={acc_g_te*100:.2f}% prec={prec_g_te*100:.2f}% rec={rec_g_te*100:.2f}% F1={f1_g_te*100:.2f}%")
        print(f"  Cluster-Gate TEST cm:    TP={cm_g_te[0]} FP={cm_g_te[1]} TN={cm_g_te[2]} FN={cm_g_te[3]}")

        # === Specific: TREND-DAY vs CHOP-DAY profile from logreg sign+magnitude ===
        print(f"  --- Regime profile (pre-features only, ignore 24h-after-start ones) ---")
        macro_imps = [(fn, wj) for fn, wj in imps if fn in pure_pre]
        for fname, wj in macro_imps:
            interp = "HIGHER => more PASS" if wj > 0 else "HIGHER => more FAIL"
            print(f"    {fname:25s}  w={wj:+.3f}  {interp}")

    # === Quick correlation: do pre-features correlate with passed? ===
    print("\n=== Pearson r(feature, passed) on FULL dataset ===")
    for f in pure_pre + ["breadth_24h", "majors_24h", "dir_coherence_24h"]:
        xs = [r[f] for r in rows]
        ys = [1.0 if r["passed"] else 0.0 for r in rows]
        mx = sum(xs) / n
        my = sum(ys) / n
        num = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
        denx = math.sqrt(sum((x - mx) ** 2 for x in xs))
        deny = math.sqrt(sum((y - my) ** 2 for y in ys))
        r = num / (denx * deny) if denx > 0 and deny > 0 else 0.0
        print(f"    {f:25s}  r={r:+.3f}")

    print("\nDone.")


if __name__ == "__main__":
    random.seed(42)
    main()
