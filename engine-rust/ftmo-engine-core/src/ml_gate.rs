//! R29-Track-B3: ML signal-gate inference.
//!
//! Loads a Random Forest model exported from
//! `scripts/_mlTrainClassifier.py` and provides per-signal `P(win)`
//! prediction. Used as an entry gate: signals with `P(win) < threshold`
//! are dropped before reaching the harness.
//!
//! Feature vector layout (must match training):
//!   [0]  rsi14
//!   [1]  rsi28
//!   [2]  adx14
//!   [3]  atr14_pct
//!   [4]  sma20_slope
//!   [5]  sma50_slope
//!   [6]  sma200_slope
//!   [7]  hour
//!   [8]  dow
//!   [9]  prior5_return
//!   [10] prior20_return
//!   [11] asset_id
//!   [12] direction_long
//!   [13] funding_rate (R29-R2.5; perpetual carry; null→0 = neutral)
//!
//! NaN/None at training time was nan_to_num→0; do the same here.

use serde::Deserialize;
use std::collections::HashMap;

/// R29-Audit-Round3 2026-05-12: bumped from implicit-v0 to v1 when we added
/// `schema_version` and `asset_id_map` fields. Inference rejects models that
/// were exported before the writer was updated; retrain via
/// `scripts/_mlTrainClassifier.py` to refresh.
pub const EXPECTED_SCHEMA_VERSION: u32 = 1;

#[derive(Deserialize, Debug)]
#[serde(untagged)]
pub enum TreeNode {
    Leaf {
        leaf: bool,
        value: f64,
    },
    Branch {
        feature: usize,
        threshold: f64,
        left: Box<TreeNode>,
        right: Box<TreeNode>,
    },
}

#[derive(Deserialize, Debug)]
pub struct MlModel {
    #[serde(rename = "type")]
    pub model_type: String,
    pub n_trees: usize,
    pub features: Vec<String>,
    pub trees: Vec<TreeNode>,
    #[serde(default)]
    pub win_rate_baseline: f64,
    #[serde(default)]
    pub validation_auc: f64,
    /// R29-Audit-Round3 2026-05-12 (Bug-3 fix): explicit schema version.
    /// Missing → treated as 0 (legacy) and rejected at load to force
    /// a Python-side retrain. Bump `EXPECTED_SCHEMA_VERSION` whenever the
    /// JSON layout, feature ordering, or asset-id semantics change.
    #[serde(default)]
    pub schema_version: u32,
    /// R29-Audit-Round3 2026-05-12 (Bug-2 fix): the symbol→asset_id mapping
    /// the trainer used. Stored so inference can re-look-up the canonical id
    /// regardless of `cfg.assets` position after `--drop-symbols` /
    /// `--keep-symbols` mutate the runtime basket. Optional for back-compat;
    /// when present, `asset_id_for(sym)` is the authoritative source.
    #[serde(default)]
    pub asset_id_map: HashMap<String, usize>,
}

/// R29-Audit-Round2.5: expected feature ordering. Inference computes
/// features in this exact order (sweep.rs::ml_features_for_signal). If
/// the trained model's `features` field deviates, predictions silently
/// score against wrong tree splits. Validate at load time.
pub const EXPECTED_FEATURES: &[&str] = &[
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
    "funding_rate",
];

impl MlModel {
    pub fn load_from_path(path: &str) -> std::io::Result<Self> {
        let bytes = std::fs::read(path)?;
        let model: Self = serde_json::from_slice(&bytes)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        // R29-Audit-Round3 2026-05-12 (Bug-3 fix): schema-version check.
        // Models exported before the schema field existed get `schema_version
        // = 0` via serde's default; reject them so inference never silently
        // runs against a stale layout.
        if model.schema_version != EXPECTED_SCHEMA_VERSION {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "ML model schema_version mismatch: model={} expected={} \
                     — retrain via `scripts/_mlTrainClassifier.py`",
                    model.schema_version, EXPECTED_SCHEMA_VERSION
                ),
            ));
        }
        // Hard-fail on feature-order mismatch — silent reorder is the
        // most insidious model-vs-engine drift.
        if model.features.len() != EXPECTED_FEATURES.len()
            || model
                .features
                .iter()
                .zip(EXPECTED_FEATURES)
                .any(|(a, b)| a != b)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "ML model feature order mismatch: model={:?} expected={:?}",
                    model.features, EXPECTED_FEATURES
                ),
            ));
        }
        Ok(model)
    }

    /// R29-Audit-Round3 2026-05-12 (Bug-2 fix): canonical asset_id for a
    /// symbol. When the model carries an `asset_id_map`, that mapping is
    /// authoritative (it's what training saw). Otherwise the caller falls
    /// back to position-in-`cfg.assets`, which is fragile under
    /// `--drop-symbols` / `--keep-symbols` overrides. Returns None when the
    /// trainer never observed the symbol — caller decides whether to skip
    /// the trade or use a neutral id.
    pub fn asset_id_for(&self, symbol: &str) -> Option<usize> {
        if self.asset_id_map.is_empty() {
            return None;
        }
        if let Some(&id) = self.asset_id_map.get(symbol) {
            return Some(id);
        }
        // Try common cache-key variants used across the TS / Rust split: the
        // training writer emits e.g. "ETHUSDT" while runtime config asset
        // symbols may be "ETH-TREND". Normalise both ends to share lookups.
        let bare = symbol.replace("-TREND", "");
        if let Some(&id) = self.asset_id_map.get(&bare) {
            return Some(id);
        }
        let with_usdt = format!("{bare}USDT");
        self.asset_id_map.get(&with_usdt).copied()
    }

    /// Average P(win=1) across all trees in the forest.
    ///
    /// R29-Audit-Round2.4: training pipeline does `nan_to_num(0.0)` on
    /// features before fitting (`_mlTrainClassifier.py`), so the trees
    /// never saw NaN at split time. At inference, raw features may
    /// contain NaN (e.g. warmup-bar indicator missing). Without this
    /// substitution, `NaN <= threshold` evaluates to `false` and the
    /// tree always routes right — silent prediction drift vs training.
    /// We mirror the training-time substitution here once at the entry
    /// point so the per-tree traversal stays cheap.
    ///
    /// R29-Audit-Round4 2026-05-12 (Bug-5 fix): cold-start guard. If the
    /// caller has no model-prepared features (e.g. all zeros, returned by
    /// `ml_features_for_signal` during warmup), the forest predicts a
    /// deterministic single leaf — slamming P(win) far from the asset's
    /// baseline. We detect the all-zero case here and return
    /// `win_rate_baseline` instead, so the gate never drops a trade purely
    /// because the indicators weren't warmed up yet.
    pub fn predict_proba(&self, features: &[f64]) -> f64 {
        if self.trees.is_empty() {
            return self.win_rate_baseline;
        }
        // R29-Audit-Round4 2026-05-12 (Bug-7 fix): heap-alloc-free
        // cleaning. Previous implementation allocated a Vec<f64> per
        // call; with ~2000 signals × 200 trees in a sweep that's 400k
        // unnecessary allocations. EXPECTED_FEATURES.len() is fixed and
        // small, so we stack-allocate.
        let mut cleaned = [0.0_f64; EXPECTED_FEATURES.len()];
        let n = features.len().min(cleaned.len());
        let mut all_zero = true;
        for (i, &v) in features.iter().take(n).enumerate() {
            cleaned[i] = if v.is_finite() { v } else { 0.0 };
            if cleaned[i] != 0.0 {
                all_zero = false;
            }
        }
        if all_zero {
            return self.win_rate_baseline;
        }
        let mut sum = 0.0_f64;
        for tree in &self.trees {
            sum += traverse(tree, &cleaned);
        }
        sum / self.trees.len() as f64
    }
}

/// R29-Audit-Round4 2026-05-12 (Bug-2 fix): iterative tree traversal.
/// The previous recursive implementation was a Stack-Overflow time-bomb at
/// max_depth=20+ trees and burned an unnecessary frame per branch on the
/// hot path. sklearn trees are still acyclic, but unbalanced splits with
/// min_samples_leaf=20 can produce paths far longer than the configured
/// max_depth would suggest. Iteration eliminates both risks; the function
/// stays inlineable.
fn traverse(node: &TreeNode, features: &[f64]) -> f64 {
    let mut cur = node;
    loop {
        match cur {
            TreeNode::Leaf { value, .. } => return *value,
            TreeNode::Branch {
                feature,
                threshold,
                left,
                right,
            } => {
                let v = features.get(*feature).copied().unwrap_or(0.0);
                // sklearn convention: go left if value <= threshold
                cur = if v <= *threshold { left } else { right };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaf_returns_value() {
        let leaf = TreeNode::Leaf {
            leaf: true,
            value: 0.42,
        };
        assert_eq!(traverse(&leaf, &[1.0, 2.0]), 0.42);
    }

    #[test]
    fn branch_routes_by_threshold() {
        let tree = TreeNode::Branch {
            feature: 0,
            threshold: 5.0,
            left: Box::new(TreeNode::Leaf {
                leaf: true,
                value: 0.1,
            }),
            right: Box::new(TreeNode::Leaf {
                leaf: true,
                value: 0.9,
            }),
        };
        assert_eq!(traverse(&tree, &[3.0]), 0.1);
        assert_eq!(traverse(&tree, &[7.0]), 0.9);
        // Boundary: x <= threshold goes LEFT (sklearn convention).
        assert_eq!(traverse(&tree, &[5.0]), 0.1);
    }

    #[test]
    fn predict_averages_trees() {
        let m = MlModel {
            model_type: "random_forest".into(),
            n_trees: 2,
            features: vec!["x".into()],
            trees: vec![
                TreeNode::Leaf {
                    leaf: true,
                    value: 0.2,
                },
                TreeNode::Leaf {
                    leaf: true,
                    value: 0.8,
                },
            ],
            win_rate_baseline: 0.16,
            validation_auc: 0.0,
            schema_version: EXPECTED_SCHEMA_VERSION,
            asset_id_map: HashMap::new(),
        };
        assert!((m.predict_proba(&[1.0]) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn asset_id_for_resolves_variants() {
        let mut map = HashMap::new();
        map.insert("ETHUSDT".to_string(), 3);
        let m = MlModel {
            model_type: "rf".into(),
            n_trees: 0,
            features: vec![],
            trees: vec![],
            win_rate_baseline: 0.0,
            validation_auc: 0.0,
            schema_version: EXPECTED_SCHEMA_VERSION,
            asset_id_map: map,
        };
        assert_eq!(m.asset_id_for("ETHUSDT"), Some(3));
        // config symbol "ETH-TREND" normalises to "ETH" then "ETHUSDT".
        assert_eq!(m.asset_id_for("ETH-TREND"), Some(3));
        assert_eq!(m.asset_id_for("UNKNOWN"), None);
    }

    #[test]
    fn predict_returns_baseline_on_all_zero_features() {
        // R29-Audit-Round4 (Bug-5 fix): when caller hands us a zero-vector
        // (cold-start / fallback), we must NOT route deterministically to
        // a single leaf. Return baseline so the gate is a no-op.
        let m = MlModel {
            model_type: "rf".into(),
            n_trees: 1,
            features: vec!["x".into()],
            trees: vec![TreeNode::Branch {
                feature: 0,
                threshold: 5.0,
                left: Box::new(TreeNode::Leaf {
                    leaf: true,
                    value: 0.1,
                }),
                right: Box::new(TreeNode::Leaf {
                    leaf: true,
                    value: 0.9,
                }),
            }],
            win_rate_baseline: 0.42,
            validation_auc: 0.0,
            schema_version: EXPECTED_SCHEMA_VERSION,
            asset_id_map: HashMap::new(),
        };
        let zeros = vec![0.0_f64; EXPECTED_FEATURES.len()];
        assert_eq!(m.predict_proba(&zeros), 0.42);
    }

    #[test]
    fn traverse_handles_deep_unbalanced_tree() {
        // R29-Audit-Round4 (Bug-2 fix): build a left-spine 200-deep tree
        // and confirm iterative traversal does not blow the stack and
        // returns the correct leaf.
        let mut node: TreeNode = TreeNode::Leaf {
            leaf: true,
            value: 0.77,
        };
        for _ in 0..200 {
            node = TreeNode::Branch {
                feature: 0,
                threshold: 10.0,
                left: Box::new(node),
                right: Box::new(TreeNode::Leaf {
                    leaf: true,
                    value: 0.99,
                }),
            };
        }
        assert!((traverse(&node, &[1.0]) - 0.77).abs() < 1e-9);
    }

    #[test]
    fn asset_id_for_returns_none_when_map_empty() {
        let m = MlModel {
            model_type: "rf".into(),
            n_trees: 0,
            features: vec![],
            trees: vec![],
            win_rate_baseline: 0.0,
            validation_auc: 0.0,
            schema_version: EXPECTED_SCHEMA_VERSION,
            asset_id_map: HashMap::new(),
        };
        assert_eq!(m.asset_id_for("ANY"), None);
    }
}
