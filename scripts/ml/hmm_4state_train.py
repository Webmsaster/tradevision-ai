#!/usr/bin/env python3
"""Quick 4-state HMM training on BTC 30m log-returns."""
import json
import numpy as np
from hmmlearn.hmm import GaussianHMM
from pathlib import Path

CACHE = Path("scripts/cache_bakeoff/BTCUSDT_30m.json")
OUT = Path("models")
OUT.mkdir(exist_ok=True)

print("Loading BTC 30m candles...")
data = json.loads(CACHE.read_text())
closes = np.array([c['close'] for c in data])
print(f"  {len(closes)} bars loaded")

# log-returns and realized-vol(20)
log_ret = np.log(closes[1:] / closes[:-1])
vol_window = 20
vol = np.array([log_ret[max(0,i-vol_window+1):i+1].std() for i in range(len(log_ret))])
features = np.column_stack([log_ret, vol])
print(f"  features shape: {features.shape}")

print("Training 4-state HMM...")
model = GaussianHMM(n_components=4, covariance_type='diag', n_iter=100, random_state=42)
model.fit(features)
print(f"  converged: {model.monitor_.converged} after {model.monitor_.iter} iter")

# Sort states by (mean log-ret, mean vol)
means = model.means_  # shape (4, 2)
state_order = sorted(range(4), key=lambda i: (means[i,0], -means[i,1]))
labels = ["crash", "bear", "sideways", "bull"]
state_to_label = {state_order[i]: labels[i] for i in range(4)}

print(f"\nState assignment:")
for sid in range(4):
    print(f"  State {sid} (µ_lr={means[sid,0]:+.5f}, µ_vol={means[sid,1]:.5f}) → {state_to_label[sid]}")

# Forward-pass: predict regime per bar
states = model.predict(features)
labelled = [state_to_label[s] for s in states]
counts = {l: labelled.count(l) for l in labels}
print(f"\nState distribution: {counts}")

# Save model JSON — schema matches HmmModel struct in
# engine-rust/ftmo-engine-core/src/signals_hmm_regime.rs so the
# existing 3-state loader can also load a 4-state model.
# hmmlearn returns covars_ for 'diag' as shape (n_states, n_features, n_features)
# (full-cov format); we collapse the diagonal back to (n_states, n_features).
covars_diag = []
for cv in model.covars_:
    arr = np.asarray(cv)
    if arr.ndim == 2:
        covars_diag.append(np.diag(arr).tolist())
    else:
        covars_diag.append(arr.tolist())
out_data = {
    "schema_version": 1,
    "n_states": 4,
    "n_features": 2,
    "feature_names": ["log_ret", "realized_vol_20"],
    "state_labels": [state_to_label[i] for i in range(4)],
    "start_prob": model.startprob_.tolist(),
    "trans_mat": model.transmat_.tolist(),
    "means": model.means_.tolist(),
    "covars": covars_diag,
}
out_file = OUT / "hmm_4state_btc_30m.json"
out_file.write_text(json.dumps(out_data, indent=2))
print(f"\nSaved: {out_file}")
