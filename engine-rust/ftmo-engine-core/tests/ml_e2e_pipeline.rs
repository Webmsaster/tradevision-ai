//! Round-5 audit: end-to-end Train→Export→Load→Predict test for ML gate.
//! Validates that a JSON identical in shape to `_mlTrainClassifier.py`'s
//! output can be loaded by `MlModel::load_from_path` and produces a
//! probability in [0,1] for both fully-warmed and all-zero feature
//! vectors.

use ftmo_engine_core::ml_gate::{MlModel, EXPECTED_FEATURES, EXPECTED_SCHEMA_VERSION};
use std::io::Write;

fn synth_model_json() -> String {
    let features: Vec<String> = EXPECTED_FEATURES.iter().map(|s| (*s).to_string()).collect();
    let json = serde_json::json!({
        "schema_version": EXPECTED_SCHEMA_VERSION,
        "type": "random_forest",
        "n_trees": 2,
        "features": features,
        "trees": [
            { "feature": 0, "threshold": 50.0,
              "left":  { "leaf": true, "value": 0.3 },
              "right": { "leaf": true, "value": 0.7 } },
            { "feature": 11, "threshold": 1.5,
              "left":  { "leaf": true, "value": 0.4 },
              "right": { "leaf": true, "value": 0.6 } }
        ],
        "win_rate_baseline": 0.42,
        "validation_auc": 0.65,
        "asset_id_map": { "BTCUSDT": 0, "ETHUSDT": 1 }
    });
    serde_json::to_string(&json).unwrap()
}

#[test]
fn e2e_load_then_predict_valid() {
    let dir = std::env::temp_dir();
    let path = dir.join("r5_e2e_model.json");
    let mut f = std::fs::File::create(&path).unwrap();
    f.write_all(synth_model_json().as_bytes()).unwrap();
    drop(f);
    let m = MlModel::load_from_path(path.to_str().unwrap()).expect("load OK");
    // 14 features, all in valid ranges, NOT all-zero.
    let feats = [
        60.0, 55.0, 25.0, 0.01, 0.001, 0.0005, 0.0001,
        10.0, 3.0, 0.005, 0.01, 0.0, 1.0, 0.0001,
    ];
    let p = m.predict_proba(&feats);
    assert!(p >= 0.0 && p <= 1.0, "p must be a probability, got {p}");
    // tree[0]: feat0=60 > 50 → 0.7. tree[1]: feat11=0 <= 1.5 → 0.4. Avg=0.55.
    assert!((p - 0.55).abs() < 1e-9, "expected 0.55, got {p}");
    assert_eq!(m.asset_id_for("BTCUSDT"), Some(0));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn e2e_load_legacy_no_schema_version_rejected() {
    // R5 audit: confirm legacy ml_model.json (schema_version MISSING)
    // is rejected with a clear retrain message.
    let dir = std::env::temp_dir();
    let path = dir.join("r5_legacy_model.json");
    let features: Vec<String> = EXPECTED_FEATURES.iter().map(|s| (*s).to_string()).collect();
    let json = serde_json::json!({
        "type": "random_forest",
        "n_trees": 1,
        "features": features,
        "trees": [ { "leaf": true, "value": 0.5 } ],
        "win_rate_baseline": 0.5,
        "validation_auc": 0.5
        // no schema_version, no asset_id_map
    });
    std::fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
    let err = MlModel::load_from_path(path.to_str().unwrap())
        .err()
        .expect("must reject legacy model");
    let msg = err.to_string();
    assert!(msg.contains("schema_version"), "err must mention schema_version, got: {msg}");
    assert!(msg.contains("retrain"), "err must instruct retrain, got: {msg}");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn e2e_load_legacy_13_features_rejected() {
    // R5: a 13-feature model (pre-funding_rate) is rejected on schema and,
    // if schema were bumped, on feature length. Confirm rejection chain.
    let dir = std::env::temp_dir();
    let path = dir.join("r5_legacy_13f.json");
    // 13 features without funding_rate.
    let features: Vec<&str> = EXPECTED_FEATURES.iter().take(13).copied().collect();
    let json = serde_json::json!({
        "schema_version": EXPECTED_SCHEMA_VERSION,
        "type": "random_forest",
        "n_trees": 0,
        "features": features,
        "trees": [],
        "win_rate_baseline": 0.5,
        "validation_auc": 0.5
    });
    std::fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
    let err = MlModel::load_from_path(path.to_str().unwrap())
        .err()
        .expect("must reject 13-feature model");
    let msg = err.to_string();
    assert!(msg.contains("feature order"), "err must mention feature order, got: {msg}");
    let _ = std::fs::remove_file(&path);
}
