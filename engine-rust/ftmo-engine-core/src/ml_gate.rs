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
//!
//! NaN/None at training time was nan_to_num→0; do the same here.

use serde::Deserialize;

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
}

impl MlModel {
    pub fn load_from_path(path: &str) -> std::io::Result<Self> {
        let bytes = std::fs::read(path)?;
        serde_json::from_slice(&bytes)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }

    /// Average P(win=1) across all trees in the forest.
    pub fn predict_proba(&self, features: &[f64]) -> f64 {
        if self.trees.is_empty() {
            return self.win_rate_baseline;
        }
        let mut sum = 0.0_f64;
        for tree in &self.trees {
            sum += traverse(tree, features);
        }
        sum / self.trees.len() as f64
    }
}

fn traverse(node: &TreeNode, features: &[f64]) -> f64 {
    match node {
        TreeNode::Leaf { value, .. } => *value,
        TreeNode::Branch {
            feature,
            threshold,
            left,
            right,
        } => {
            let v = features.get(*feature).copied().unwrap_or(0.0);
            // sklearn convention: go left if value <= threshold
            if v <= *threshold {
                traverse(left, features)
            } else {
                traverse(right, features)
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
        };
        assert!((m.predict_proba(&[1.0]) - 0.5).abs() < 1e-9);
    }
}
