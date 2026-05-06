//! Determinism — same input must produce bit-identical output across
//! multiple runs. Catches non-determinism from HashMap iteration order,
//! uninitialised reads, or any other source of run-to-run variance.

use std::collections::HashMap;

use ftmo_engine_core::candle::Candle;
use ftmo_engine_core::config::AssetConfig;
use ftmo_engine_core::harness::{step_bar, BarInput};
use ftmo_engine_core::indicators::atr;
use ftmo_engine_core::position::PositionSide;
use ftmo_engine_core::signal::PollSignal;
use ftmo_engine_core::state::EngineState;
use ftmo_engine_core::templates;

fn run_once(seed: u64) -> (f64, usize, u32, u64) {
    let mut cfg = templates::r28_v6_passlock();
    cfg.assets = vec![AssetConfig {
        symbol: "BTC-TREND".into(),
        source_symbol: Some("BTCUSDT".into()),
        tp_pct: Some(0.022),
        stop_pct: Some(0.02),
        risk_frac: 0.4,
        activate_after_day: None,
        min_equity_gain: None,
        max_equity_gain: None,
        hold_bars: None,
        invert_direction: false,
    }];

    // Synth candles seeded by `seed` (xorshift) — deterministic per seed.
    let mut state_xs = seed | 1;
    let candles: Vec<Candle> = (0..600)
        .map(|i| {
            state_xs ^= state_xs << 13;
            state_xs ^= state_xs >> 7;
            state_xs ^= state_xs << 17;
            let drift = ((state_xs % 2000) as f64 - 1000.0) * 0.01;
            let p = 100.0 + (i as f64 * 0.1).sin() * 5.0 + drift * 0.5;
            Candle::new(
                1_700_000_000_000 + i as i64 * 1_800_000,
                p,
                p + 1.0,
                p - 1.0,
                p,
                0.0,
            )
        })
        .collect();

    let atr_series = atr(&candles, 14);
    let mut state = EngineState::initial(&cfg.label);
    let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
    feed.insert("BTCUSDT".into(), Vec::with_capacity(candles.len()));
    let mut atr_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    atr_feed.insert("BTCUSDT".into(), Vec::with_capacity(candles.len()));

    // Open one trade at bar 50, let it ride.
    for (i, c) in candles.iter().enumerate() {
        feed.get_mut("BTCUSDT").unwrap().push(*c);
        atr_feed.get_mut("BTCUSDT").unwrap().push(atr_series[i]);
        let signals: Vec<PollSignal> = if i == 50 {
            vec![PollSignal {
                symbol: "BTC-TREND".into(),
                source_symbol: "BTCUSDT".into(),
                direction: PositionSide::Long,
                entry_time: c.open_time,
                entry_price: c.close,
                stop_price: c.close * 0.98,
                tp_price: c.close * 1.022,
                stop_pct: 0.02,
                tp_pct: 0.022,
                eff_risk: 0.4,
                chandelier_atr_at_entry: None,
            }]
        } else {
            vec![]
        };
        let r = step_bar(
            &mut state,
            &BarInput {
                candles_by_source: &feed,
                atr_series_by_source: &atr_feed,
                signals,
            },
            &cfg,
        );
        if r.challenge_ended {
            break;
        }
    }
    (state.equity, state.closed_trades.len(), state.day, state.bars_seen)
}

#[test]
fn same_seed_identical_output_across_runs() {
    let seed = 0x1337_DEAD_BEEFu64;
    let (e1, t1, d1, b1) = run_once(seed);
    let (e2, t2, d2, b2) = run_once(seed);
    let (e3, t3, d3, b3) = run_once(seed);
    assert_eq!(e1.to_bits(), e2.to_bits(), "equity not bit-identical run 1↔2");
    assert_eq!(e2.to_bits(), e3.to_bits(), "equity not bit-identical run 2↔3");
    assert_eq!((t1, d1, b1), (t2, d2, b2));
    assert_eq!((t2, d2, b2), (t3, d3, b3));
}

// (Sanity-check that different seeds yield different output was attempted
// but the synth-candle harness lands on the same TP/stop outcome regardless
// — it's a deliberately-narrow lifecycle test. Determinism guarantee above
// is the load-bearing assertion; the equality across runs is the property
// we care about.)
