//! Detector #11 Phase 0 — funding-cost golden fixture test.
//!
//! Loads `tests/fixtures/funding_parity.json` and verifies that
//! `compute_eff_pnl_with_funding` produces the expected raw/eff PnL on a
//! 30+ bar synthetic funding feed with 3 funding events.
//!
//! Reference math: hand-computed expected values in the fixture's
//! `_walk_` comment. Each case is a different funding-walk topology:
//!   - long, entry not on boundary, 3 buckets crossed
//!   - short, entry exactly on boundary, 2 buckets visited
//!   - long, no boundary crossed (zero funding paid)
//!
//! Together these exercise (1) STRICT `<` push-to-next-boundary path,
//! (2) entry-on-boundary single-bucket case, (3) short-side sign flip,
//! (4) zero-funding intraday case.

use std::path::PathBuf;

use ftmo_engine_core::config::{AssetConfig, EngineConfig};
use ftmo_engine_core::pnl::compute_eff_pnl_with_funding;
use ftmo_engine_core::position::{OpenPosition, PositionSide};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct FundingFixture {
    bar_dur_ms: i64,
    bar0_open_time_ms: i64,
    n_bars: usize,
    funding: Vec<FundingEvent>,
    expected_cases: Vec<ExpectedCase>,
}

#[derive(Debug, Deserialize)]
struct FundingEvent {
    bar_idx: usize,
    rate: f64,
}

#[derive(Debug, Deserialize)]
struct ExpectedCase {
    name: String,
    direction: String,
    entry_offset_ms_from_bar0: i64,
    exit_offset_ms_from_bar0: i64,
    entry_price: f64,
    exit_price: f64,
    eff_risk: f64,
    leverage: f64,
    expected_raw_pnl: f64,
    expected_eff_pnl: f64,
}

fn build_funding_series(n: usize, events: &[FundingEvent]) -> Vec<Option<f64>> {
    let mut v = vec![Some(0.0_f64); n];
    for e in events {
        v[e.bar_idx] = Some(e.rate);
    }
    v
}

fn make_pos(symbol: &str, side: PositionSide, entry_price: f64, entry_time: i64, eff_risk: f64) -> OpenPosition {
    OpenPosition {
        ticket_id: "fixture-t".into(),
        symbol: symbol.into(),
        source_symbol: "BTCUSDT".into(),
        direction: side,
        entry_time,
        entry_price,
        initial_stop_pct: 0.02,
        stop_price: if matches!(side, PositionSide::Long) {
            entry_price * 0.98
        } else {
            entry_price * 1.02
        },
        tp_price: if matches!(side, PositionSide::Long) {
            entry_price * 1.04
        } else {
            entry_price * 0.96
        },
        eff_risk,
        entry_bar_idx: 0,
        high_watermark: entry_price,
        be_active: false,
        ptp_triggered: false,
        ptp_realized_pct: 0.0,
        ptp_level_idx: 0,
        ptp_levels_realized: 0.0,
        last_known_price: None,
        trail_active: false,
        trail_peak: 0.0,
    }
}

#[test]
fn funding_golden_fixture_all_cases() {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("tests/fixtures/funding_parity.json");
    let raw = std::fs::read_to_string(&path).expect("read funding_parity.json");
    let fix: FundingFixture = serde_json::from_str(&raw).expect("parse fixture");

    let funding = build_funding_series(fix.n_bars, &fix.funding);

    for case in &fix.expected_cases {
        // Build a config that hard-zeroes cost/slippage/swap (the fixture
        // isolates funding-cost math).
        let mut cfg = EngineConfig::r28_v6_passlock_template();
        cfg.leverage = case.leverage;
        cfg.assets.push(AssetConfig {
            symbol: "BTC-TREND".into(),
            cost_bp: Some(0.0),
            slippage_bp: Some(0.0),
            swap_bp_per_day: Some(0.0),
            ..Default::default()
        });

        let side = match case.direction.as_str() {
            "long" => PositionSide::Long,
            "short" => PositionSide::Short,
            other => panic!("unknown direction '{}' in case '{}'", other, case.name),
        };
        let entry_time = fix.bar0_open_time_ms + case.entry_offset_ms_from_bar0;
        let exit_time = fix.bar0_open_time_ms + case.exit_offset_ms_from_bar0;
        let pos = make_pos("BTC-TREND", side, case.entry_price, entry_time, case.eff_risk);

        let r = compute_eff_pnl_with_funding(
            &pos,
            case.exit_price,
            &cfg,
            Some(exit_time),
            Some(&funding),
            fix.bar0_open_time_ms,
            fix.bar_dur_ms,
        );

        // 1e-12 tolerance: TS engine uses f64 throughout; bit-precision is
        // achievable for this minimal funding-only setup.
        assert!(
            (r.raw_pnl - case.expected_raw_pnl).abs() < 1e-12,
            "case '{}': raw_pnl={} expected={} diff={:.2e}",
            case.name,
            r.raw_pnl,
            case.expected_raw_pnl,
            (r.raw_pnl - case.expected_raw_pnl).abs()
        );
        assert!(
            (r.eff_pnl - case.expected_eff_pnl).abs() < 1e-12,
            "case '{}': eff_pnl={} expected={} diff={:.2e}",
            case.name,
            r.eff_pnl,
            case.expected_eff_pnl,
            (r.eff_pnl - case.expected_eff_pnl).abs()
        );
    }
}
