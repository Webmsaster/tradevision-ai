//! Round 67 Asset-Expansion Sweep — pure-Rust greedy-add asset-expansion.
//! Loads 30m candles for 9 R28_V6_PASSLOCK base + 5 V5_TITANIUM-style
//! candidates, generates R28_V6 signals per asset bar-by-bar, drives
//! step_bar, reports pass-rate. Greedy: 9 → up to 14 assets.
//!
//! Run-time target: <2 minutes (vs 4-6h for TS Asset-Expansion).

use std::collections::HashMap;
use std::path::PathBuf;

use ftmo_engine_core::candle::Candle;
use ftmo_engine_core::config::{AssetConfig, EngineConfig};
use ftmo_engine_core::harness::{step_bar, BarInput};
use ftmo_engine_core::indicators::atr;
use ftmo_engine_core::signal::PollSignal;
use ftmo_engine_core::signals_r28v6::{detect_r28_v6, R28V6Inputs, R28V6Params};
use ftmo_engine_core::state::EngineState;
use ftmo_engine_core::templates::r28_v6_passlock;
use serde::Deserialize;

#[derive(Debug, Deserialize, Clone)]
struct CandleRaw {
    #[serde(rename = "openTime")]
    open_time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    #[serde(default)]
    volume: f64,
}

const BASE_BASKET: &[&str] = &[
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "ADAUSDT", "LTCUSDT",
    "BCHUSDT", "ETCUSDT", "XRPUSDT", "AAVEUSDT",
];
const CANDIDATES: &[&str] = &["SOLUSDT", "DOGEUSDT", "LINKUSDT", "AVAXUSDT", "RUNEUSDT"];

fn cache_path(symbol: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/cache_bakeoff")
        .join(format!("{symbol}_30m.json"))
}

fn load_candles(symbol: &str) -> Option<Vec<Candle>> {
    let p = cache_path(symbol);
    if !p.exists() {
        return None;
    }
    let raw = std::fs::read(&p).ok()?;
    let arr: Vec<CandleRaw> = serde_json::from_slice(&raw).ok()?;
    Some(
        arr.into_iter()
            .map(|c| Candle::new(c.open_time, c.open, c.high, c.low, c.close, c.volume))
            .collect(),
    )
}

fn align_basket(symbols: &[&str]) -> HashMap<String, Vec<Candle>> {
    let mut data: HashMap<String, Vec<Candle>> = HashMap::new();
    for s in symbols {
        if let Some(c) = load_candles(s) {
            data.insert((*s).to_string(), c);
        }
    }
    if data.is_empty() {
        return data;
    }
    // Intersection of open_times
    let mut common: Option<std::collections::BTreeSet<i64>> = None;
    for v in data.values() {
        let s: std::collections::BTreeSet<i64> = v.iter().map(|c| c.open_time).collect();
        common = Some(match common {
            None => s,
            Some(c) => c.intersection(&s).copied().collect(),
        });
    }
    let common = common.unwrap();
    let mut aligned: HashMap<String, Vec<Candle>> = HashMap::new();
    for (k, v) in data.iter() {
        let filtered: Vec<Candle> = v.iter().filter(|c| common.contains(&c.open_time)).copied().collect();
        aligned.insert(k.clone(), filtered);
    }
    aligned
}

fn r28_v6_tp_for(source_symbol: &str) -> f64 {
    match source_symbol {
        "BTCUSDT" | "BNBUSDT" | "ADAUSDT" | "BCHUSDT" | "ETCUSDT" => 0.00825,
        "ETHUSDT" => 0.011,
        "AAVEUSDT" => 0.01375,
        "XRPUSDT" => 0.0165,
        "LTCUSDT" => 0.01925,
        _ => 0.022, // SOL, DOGE, LINK, AVAX, RUNE
    }
}

fn build_assets(basket: &[&str]) -> Vec<AssetConfig> {
    basket
        .iter()
        .map(|src| AssetConfig {
            symbol: format!("{}-TREND", src.replace("USDT", "")),
            source_symbol: Some((*src).to_string()),
            tp_pct: Some(r28_v6_tp_for(src)),
            stop_pct: Some(0.05),
            risk_frac: 0.4,
            activate_after_day: None,
            min_equity_gain: None,
            max_equity_gain: None,
            hold_bars: None,
            invert_direction: false,
        })
        .collect()
}

/// Run a single window of length `win_bars` starting at `start_bar`.
/// Returns true if challenge passed.
fn run_window(
    aligned: &HashMap<String, Vec<Candle>>,
    cfg: &EngineConfig,
    start_bar: usize,
    win_bars: usize,
    warmup: usize,
    atr_full: &HashMap<String, Vec<Option<f64>>>,
) -> bool {
    let mut state = EngineState::initial(&cfg.label);
    let lo = start_bar.saturating_sub(warmup);
    let hi = (start_bar + win_bars).min(
        aligned.values().map(|v| v.len()).min().unwrap_or(0),
    );
    let mut feeds: HashMap<String, Vec<Candle>> = HashMap::new();
    let mut atr_feeds: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    for k in aligned.keys() {
        feeds.insert(k.clone(), Vec::with_capacity(hi - lo));
        atr_feeds.insert(k.clone(), Vec::with_capacity(hi - lo));
    }
    let mut last_passed = false;
    // Precompute params per asset
    let asset_params: Vec<(AssetConfig, R28V6Params)> = cfg
        .assets
        .iter()
        .map(|a| {
            let p = R28V6Params::default_for(a, cfg);
            (a.clone(), p)
        })
        .collect();
    for i in lo..hi {
        for (k, arr) in aligned.iter() {
            if let Some(c) = arr.get(i) {
                feeds.get_mut(k).unwrap().push(*c);
            }
            if let Some(series) = atr_full.get(k) {
                if let Some(v) = series.get(i).copied() {
                    atr_feeds.get_mut(k).unwrap().push(v);
                }
            }
        }
        if i < start_bar {
            continue; // warmup, no signals/exits yet
        }
        // Emit signals per asset.
        let mut signals: Vec<PollSignal> = Vec::new();
        // BTC closes for cross-asset
        let btc_closes: Vec<f64> = feeds
            .get("BTCUSDT")
            .map(|v| v.iter().map(|c| c.close).collect())
            .unwrap_or_default();
        for (asset, params) in &asset_params {
            let src = asset.source_symbol.as_deref().unwrap_or("");
            let candles = match feeds.get(src) {
                Some(v) => v,
                None => continue,
            };
            // 4h HTF closes = every 8th 30m bar
            let htf_closes: Vec<f64> = candles
                .iter()
                .step_by(8)
                .map(|c| c.close)
                .collect();
            let inputs = R28V6Inputs {
                htf_closes: Some(&htf_closes),
                cross_asset_closes: if src == "BTCUSDT" { None } else { Some(&btc_closes) },
                news_events: None,
            };
            let mut state_clone = state.clone();
            if let Some(s) = detect_r28_v6(
                &mut state_clone,
                cfg,
                asset,
                src,
                candles,
                params,
                &inputs,
            ) {
                signals.push(s);
            }
        }
        let r = step_bar(
            &mut state,
            &BarInput {
                candles_by_source: &feeds,
                atr_series_by_source: &atr_feeds,
                signals,
            },
            cfg,
        );
        last_passed = r.passed;
        if r.challenge_ended {
            break;
        }
    }
    last_passed
}

fn evaluate_basket(basket: &[&str]) -> (usize, usize) {
    let aligned = align_basket(basket);
    if aligned.is_empty() {
        return (0, 0);
    }
    let min_bars = aligned.values().map(|v| v.len()).min().unwrap_or(0);
    let mut cfg = r28_v6_passlock();
    cfg.assets = build_assets(basket);
    let win_bars = cfg.max_days as usize * 48;
    let step_bars = 14 * 48; // 14-day step
    let warmup = 5000;
    // ATR pre-compute per asset
    let chand_period = cfg
        .chandelier_exit
        .as_ref()
        .map(|c| c.period as usize)
        .unwrap_or(14);
    let mut atr_full: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    for (k, v) in aligned.iter() {
        atr_full.insert(k.clone(), atr(v, chand_period));
    }
    let mut pass = 0usize;
    let mut total = 0usize;
    let mut start = warmup;
    while start + win_bars <= min_bars {
        let p = run_window(&aligned, &cfg, start, win_bars, warmup, &atr_full);
        if p {
            pass += 1;
        }
        total += 1;
        start += step_bars;
    }
    (pass, total)
}

#[test]
fn round67_asset_expansion_greedy() {
    let t0 = std::time::Instant::now();

    // Baseline: 9 base assets
    let mut basket: Vec<&str> = BASE_BASKET.to_vec();
    let (bp, bt) = evaluate_basket(&basket);
    let baseline_rate = if bt > 0 { (bp as f64) / (bt as f64) * 100.0 } else { 0.0 };
    eprintln!();
    eprintln!("=== Round 67 Asset-Expansion (Rust pure) ===");
    eprintln!();
    eprintln!(
        "baseline {} assets: {}/{} = {:.2}%",
        basket.len(),
        bp,
        bt,
        baseline_rate
    );

    let mut remaining: Vec<&str> = CANDIDATES.to_vec();
    let mut current_rate = baseline_rate;

    while basket.len() < 14 && !remaining.is_empty() {
        let mut best_rate = current_rate;
        let mut best_pick: Option<&str> = None;
        let mut best_pt: (usize, usize) = (0, 0);
        for &cand in &remaining {
            let mut trial = basket.clone();
            trial.push(cand);
            let (p, t) = evaluate_basket(&trial);
            let rate = if t > 0 { (p as f64) / (t as f64) * 100.0 } else { 0.0 };
            eprintln!(
                "  + {cand:<10} → {} assets: {p}/{t} = {rate:.2}%  Δ {:+.2}pp",
                trial.len(),
                rate - current_rate
            );
            if rate > best_rate + 0.001 {
                best_rate = rate;
                best_pick = Some(cand);
                best_pt = (p, t);
            }
        }
        if let Some(pick) = best_pick {
            basket.push(pick);
            remaining.retain(|s| s != &pick);
            eprintln!(
                "  🎯 PICK {pick} → {} assets: {}/{} = {:.2}%",
                basket.len(),
                best_pt.0,
                best_pt.1,
                best_rate
            );
            current_rate = best_rate;
        } else {
            eprintln!(
                "  no candidate improved (best stays {:.2}%) — stopping at {} assets",
                current_rate,
                basket.len()
            );
            break;
        }
    }
    let elapsed = t0.elapsed();
    eprintln!();
    eprintln!(
        "🏆 Final basket ({} assets, {:.2}%): {}",
        basket.len(),
        current_rate,
        basket.join(", ")
    );
    eprintln!("Δ vs 9-asset baseline: {:+.2}pp", current_rate - baseline_rate);
    eprintln!("elapsed: {:.2}s", elapsed.as_secs_f64());
}
