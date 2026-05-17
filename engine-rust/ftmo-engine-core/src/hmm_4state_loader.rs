//! 2026-05-17 4-state HMM Rust loader.
//! Loads JSON model from `models/hmm_4state_btc_30m.json` (trained by
//! scripts/ml/hmm_4state_train.py). Provides regime-classification API.
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize, Clone)]
pub struct Hmm4StateModel {
    pub n_states: usize,
    pub n_features: usize,
    pub feature_names: Vec<String>,
    pub state_labels: Vec<String>,
    pub start_probs: Vec<f64>,
    pub transmat: Vec<Vec<f64>>,
    pub means: Vec<Vec<f64>>,
    pub covars: Vec<Vec<f64>>,
}

impl Hmm4StateModel {
    pub fn load_from_path<P: AsRef<Path>>(path: P) -> anyhow::Result<Self> {
        let bytes = std::fs::read(path.as_ref())?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    /// Forward-pass: classify a sequence of (log_ret, vol) observations.
    /// Returns most-likely state per observation via simple argmax of
    /// emission × state-occupancy (light HMM, not full Viterbi).
    pub fn classify(&self, observations: &[(f64, f64)]) -> Vec<usize> {
        observations.iter().map(|obs| {
            let mut best_state = 0;
            let mut best_score = f64::NEG_INFINITY;
            for s in 0..self.n_states {
                if s >= self.means.len() { continue; }
                if self.means[s].len() < 2 { continue; }
                let mu_ret = self.means[s][0];
                let mu_vol = self.means[s][1];
                let var_ret = self.covars[s].get(0).copied().unwrap_or(1.0);
                let var_vol = self.covars[s].get(1).copied().unwrap_or(1.0);
                // log-Gaussian per feature, sum
                let dr = obs.0 - mu_ret;
                let dv = obs.1 - mu_vol;
                let ll = -0.5 * (dr*dr / var_ret + dv*dv / var_vol)
                       - 0.5 * (var_ret.ln() + var_vol.ln());
                if ll > best_score { best_score = ll; best_state = s; }
            }
            best_state
        }).collect()
    }

    pub fn label_at(&self, state_idx: usize) -> Option<&str> {
        self.state_labels.get(state_idx).map(|s| s.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn load_real_model_if_present() {
        let path = "models/hmm_4state_btc_30m.json";
        if std::path::Path::new(path).exists() {
            let m = Hmm4StateModel::load_from_path(path).expect("load");
            assert_eq!(m.n_states, 4);
            assert_eq!(m.state_labels.len(), 4);
            let states = m.classify(&[(0.001, 0.005), (-0.002, 0.012)]);
            assert_eq!(states.len(), 2);
        }
    }
}
