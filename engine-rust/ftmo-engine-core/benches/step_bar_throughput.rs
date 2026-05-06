//! criterion benchmarks for the harness `step_bar` hot path. Three
//! profiles: idle (no signals), breakout-driven, and mean-reversion.

use std::collections::HashMap;

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use ftmo_engine_core::config::{AssetConfig, EngineConfig, MeanReversionSource};
use ftmo_engine_core::harness::{step_bar, BarInput};
use ftmo_engine_core::indicators::atr;
use ftmo_engine_core::signal::PollSignal;
use ftmo_engine_core::signals_breakout::{detect_breakout, BreakoutParams};
use ftmo_engine_core::signals_meanrev::detect_mean_reversion;
use ftmo_engine_core::state::EngineState;
use ftmo_engine_core::Candle;

const N_BARS: usize = 2000;

fn make_candles() -> Vec<Candle> {
    (0..N_BARS)
        .map(|i| {
            let p = 100.0 + (i as f64 * 0.01).sin() * 5.0;
            Candle::new(
                1_700_000_000_000 + i as i64 * 1_800_000,
                p,
                p + 0.5,
                p - 0.5,
                p,
                0.0,
            )
        })
        .collect()
}

fn cfg_with_assets() -> EngineConfig {
    let mut cfg = EngineConfig::r28_v6_passlock_template();
    cfg.assets = vec![AssetConfig {
        symbol: "BTC-TREND".into(),
        source_symbol: Some("BTCUSDT".into()),
        tp_pct: None,
        stop_pct: None,
        risk_frac: 0.4,
        activate_after_day: None,
        min_equity_gain: None,
        max_equity_gain: None,
        hold_bars: None,
        invert_direction: false,
    }];
    cfg
}

fn bench_idle(c: &mut Criterion) {
    let candles = make_candles();
    let cfg = cfg_with_assets();
    let atr_series = atr(&candles, 14);
    c.bench_function("step_bar_idle_2000", |b| {
        b.iter(|| {
            let mut state = EngineState::initial(&cfg.label);
            let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
            feed.insert("BTCUSDT".into(), Vec::with_capacity(N_BARS));
            let mut atr_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
            atr_feed.insert("BTCUSDT".into(), Vec::with_capacity(N_BARS));
            for i in 0..N_BARS {
                feed.get_mut("BTCUSDT").unwrap().push(candles[i]);
                atr_feed.get_mut("BTCUSDT").unwrap().push(atr_series[i]);
                let _ = step_bar(
                    &mut state,
                    &BarInput {
                        candles_by_source: &feed,
                        atr_series_by_source: &atr_feed,
                        signals: vec![],
                    },
                    &cfg,
                );
                if state.stopped_reason.is_some() {
                    break;
                }
            }
            black_box(state);
        });
    });
}

fn bench_breakout(c: &mut Criterion) {
    let candles = make_candles();
    let cfg = cfg_with_assets();
    let atr_series = atr(&candles, 14);
    let asset = cfg.assets[0].clone();
    let bp = BreakoutParams::from_cfg(&cfg, &asset);
    c.bench_function("step_bar_breakout_2000", |b| {
        b.iter(|| {
            let mut state = EngineState::initial(&cfg.label);
            let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
            feed.insert("BTCUSDT".into(), Vec::with_capacity(N_BARS));
            let mut atr_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
            atr_feed.insert("BTCUSDT".into(), Vec::with_capacity(N_BARS));
            for i in 0..N_BARS {
                feed.get_mut("BTCUSDT").unwrap().push(candles[i]);
                atr_feed.get_mut("BTCUSDT").unwrap().push(atr_series[i]);
                let arr = feed.get("BTCUSDT").unwrap();
                let signals: Vec<PollSignal> =
                    match detect_breakout(&mut state, &cfg, &asset, "BTCUSDT", arr, &bp) {
                        Some(s) => vec![s],
                        None => vec![],
                    };
                let _ = step_bar(
                    &mut state,
                    &BarInput {
                        candles_by_source: &feed,
                        atr_series_by_source: &atr_feed,
                        signals,
                    },
                    &cfg,
                );
                if state.stopped_reason.is_some() {
                    break;
                }
            }
            black_box(state);
        });
    });
}

fn bench_meanrev(c: &mut Criterion) {
    let candles = make_candles();
    let cfg = cfg_with_assets();
    let atr_series = atr(&candles, 14);
    let asset = cfg.assets[0].clone();
    let src = MeanReversionSource {
        period: 14,
        oversold: 25.0,
        overbought: 75.0,
        cooldown_bars: 8,
        size_mult: 0.5,
    };
    c.bench_function("step_bar_meanrev_2000", |b| {
        b.iter(|| {
            let mut state = EngineState::initial(&cfg.label);
            let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
            feed.insert("BTCUSDT".into(), Vec::with_capacity(N_BARS));
            let mut atr_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
            atr_feed.insert("BTCUSDT".into(), Vec::with_capacity(N_BARS));
            for i in 0..N_BARS {
                feed.get_mut("BTCUSDT").unwrap().push(candles[i]);
                atr_feed.get_mut("BTCUSDT").unwrap().push(atr_series[i]);
                let arr = feed.get("BTCUSDT").unwrap();
                let signals: Vec<PollSignal> =
                    match detect_mean_reversion(&mut state, &cfg, &asset, "BTCUSDT", arr, &src) {
                        Some(s) => vec![s],
                        None => vec![],
                    };
                let _ = step_bar(
                    &mut state,
                    &BarInput {
                        candles_by_source: &feed,
                        atr_series_by_source: &atr_feed,
                        signals,
                    },
                    &cfg,
                );
                if state.stopped_reason.is_some() {
                    break;
                }
            }
            black_box(state);
        });
    });
}

criterion_group!(benches, bench_idle, bench_breakout, bench_meanrev);
criterion_main!(benches);
