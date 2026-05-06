//! Forex Mean-Reversion detector — port of the Forex variant of detectAsset
//! that drives FTMO's currency-pair MR configs. Honours `asset.invertDirection`
//! to flip the trend reading per pair (the convention the TS engine uses for
//! pairs that exhibit reverse momentum-vs-MR character — e.g. USDJPY).
//!
//! Rules:
//!   1. Bollinger Bands (period, mult) on closes.
//!   2. Long when close crosses BELOW lower band from above (oversold-bounce).
//!   3. Short when close crosses ABOVE upper band from below.
//!   4. Optional `asset.invertDirection` flips long↔short.
//!   5. Optional RSI confluence + cooldown_bars between same-direction signals.
//!   6. Stop = max(stop_pct, atr_stop). TP = tp_pct.
//!   7. Sizing pipeline + live caps (unless bypass_live_caps).

use crate::candle::Candle;
use crate::config::{AssetConfig, EngineConfig};
use crate::detector_filters::rsi_filter_allows;
use crate::indicators::{atr, rsi, sma};
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::sizing::resolve_sizing_factor;
use crate::state::{EngineState, LossStreakEntry};
use crate::time_util::ls_key;

pub struct ForexMrParams {
    pub bb_period: usize,
    pub bb_mult: f64,
    pub rsi_period: Option<usize>,
    pub rsi_long_max: Option<f64>,
    pub rsi_short_min: Option<f64>,
    pub cooldown_bars: u64,
    pub stop_pct: f64,
    pub tp_pct: f64,
    pub base_risk_frac: f64,
    pub size_mult: f64,
}

impl ForexMrParams {
    pub fn default_for(asset: &AssetConfig, cfg: &EngineConfig) -> Self {
        Self {
            bb_period: 20,
            bb_mult: 2.0,
            rsi_period: Some(14),
            rsi_long_max: Some(30.0),
            rsi_short_min: Some(70.0),
            cooldown_bars: 8,
            stop_pct: asset.stop_pct.unwrap_or(cfg.stop_pct),
            tp_pct: asset.tp_pct.unwrap_or(cfg.tp_pct),
            base_risk_frac: asset.risk_frac,
            size_mult: 1.0,
        }
    }
}

fn bollinger(closes: &[f64], period: usize, mult: f64) -> (Vec<Option<f64>>, Vec<Option<f64>>) {
    let mut upper: Vec<Option<f64>> = vec![None; closes.len()];
    let mut lower: Vec<Option<f64>> = vec![None; closes.len()];
    if period == 0 || closes.len() < period {
        return (upper, lower);
    }
    let sma_series = sma(closes, period);
    for i in (period - 1)..closes.len() {
        let Some(mean) = sma_series[i] else { continue };
        let lo = i + 1 - period;
        let mut variance = 0.0;
        for &v in &closes[lo..=i] {
            variance += (v - mean).powi(2);
        }
        let stddev = (variance / period as f64).sqrt();
        upper[i] = Some(mean + mult * stddev);
        lower[i] = Some(mean - mult * stddev);
    }
    (upper, lower)
}

pub fn detect_forex_mr(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &ForexMrParams,
) -> Option<PollSignal> {
    if candles.len() < params.bb_period + 4 {
        return None;
    }
    let i = candles.len() - 1;
    let last = candles[i];
    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let (upper, lower) = bollinger(&closes, params.bb_period, params.bb_mult);
    let (cur_u, prev_u, cur_l, prev_l) = (upper[i]?, upper[i - 1]?, lower[i]?, lower[i - 1]?);
    let prev_close = closes[i - 1];

    // Cross detection.
    let mut direction = if prev_close >= prev_l && last.close < cur_l {
        // Crossed below lower → long (oversold bounce).
        PositionSide::Long
    } else if prev_close <= prev_u && last.close > cur_u {
        // Crossed above upper → short.
        PositionSide::Short
    } else {
        return None;
    };
    if asset.invert_direction {
        direction = direction.opposite();
    }

    // RSI confluence.
    if let Some(period) = params.rsi_period {
        let series = rsi(&closes, period);
        if !rsi_filter_allows(series[i], direction, params.rsi_long_max, params.rsi_short_min) {
            return None;
        }
    }

    // Per-direction cooldown — piggy-back on lossStreak map under "FXMR|sym|dir".
    let key = format!("FXMR|{}", ls_key(&asset.symbol, direction));
    if let Some(ls) = state.loss_streak_by_asset_dir.get(&key) {
        if state.bars_seen < ls.cd_until_bars_seen {
            return None;
        }
    }
    state.loss_streak_by_asset_dir.insert(
        key,
        LossStreakEntry {
            streak: 0,
            cd_until_bars_seen: state.bars_seen + params.cooldown_bars,
        },
    );

    // Stop_pct via optional ATR-stop.
    let mut stop_pct = params.stop_pct;
    if let Some(at) = cfg.atr_stop {
        let series = atr(candles, at.period as usize);
        if let Some(a) = series[i] {
            let atr_stop = (at.stop_mult * a) / last.close.max(1e-9);
            stop_pct = stop_pct.max(atr_stop);
        }
    }
    if !cfg.bypass_live_caps {
        if let Some(caps) = cfg.live_caps.as_ref() {
            if stop_pct > caps.max_stop_pct {
                return None;
            }
        }
    }

    // Sizing.
    let factor = resolve_sizing_factor(state, cfg, last.open_time);
    let mut eff_risk = params.base_risk_frac * factor * params.size_mult;
    if !cfg.bypass_live_caps {
        if let Some(caps) = cfg.live_caps.as_ref() {
            eff_risk = eff_risk.min(caps.max_risk_frac);
        }
    }
    if eff_risk <= 0.0 {
        return None;
    }
    let (stop_price, tp_price) = match direction {
        PositionSide::Long => (last.close * (1.0 - stop_pct), last.close * (1.0 + params.tp_pct)),
        PositionSide::Short => (last.close * (1.0 + stop_pct), last.close * (1.0 - params.tp_pct)),
    };
    Some(PollSignal {
        symbol: asset.symbol.clone(),
        source_symbol: source_symbol.to_string(),
        direction,
        entry_time: last.open_time,
        entry_price: last.close,
        stop_price,
        tp_price,
        stop_pct,
        tp_pct: params.tp_pct,
        eff_risk,
        chandelier_atr_at_entry: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> EngineConfig {
        EngineConfig::r28_v6_passlock_template()
    }
    fn asset(invert: bool) -> AssetConfig {
        AssetConfig {
            symbol: "EURUSD-MR".into(),
            source_symbol: Some("EURUSD".into()),
            tp_pct: None,
            stop_pct: None,
            risk_frac: 0.4,
            activate_after_day: None,
            min_equity_gain: None,
            max_equity_gain: None,
            hold_bars: None,
            invert_direction: invert,
        }
    }

    fn build_lower_cross() -> Vec<Candle> {
        // 28 stable bars (≥ bb_period+4), then a sharp drop on the last bar
        // pushes close below lower band.
        let mut v: Vec<Candle> = (0..28)
            .map(|i| Candle::new(i * 1800_000, 1.0, 1.001, 0.999, 1.0, 0.0))
            .collect();
        // Final bar: deep drop close — clearly below lower band.
        v.push(Candle::new(28 * 1800_000, 0.99, 0.99, 0.95, 0.95, 0.0));
        v
    }

    #[test]
    fn long_signal_on_lower_band_cross() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset(false);
        let mut p = ForexMrParams::default_for(&a, &cfg);
        p.rsi_period = None; // disable rsi for this test
        let candles = build_lower_cross();
        let sig = detect_forex_mr(&mut s, &cfg, &a, "EURUSD", &candles, &p)
            .expect("expected long mr signal");
        assert_eq!(sig.direction, PositionSide::Long);
    }

    #[test]
    fn invert_direction_flips_long_to_short() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset(true);
        let mut p = ForexMrParams::default_for(&a, &cfg);
        p.rsi_period = None;
        let candles = build_lower_cross();
        let sig = detect_forex_mr(&mut s, &cfg, &a, "EURUSD", &candles, &p)
            .expect("signal expected");
        assert_eq!(sig.direction, PositionSide::Short);
    }

    #[test]
    fn cooldown_blocks_back_to_back() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset(false);
        let mut p = ForexMrParams::default_for(&a, &cfg);
        p.rsi_period = None;
        let candles = build_lower_cross();
        let _ = detect_forex_mr(&mut s, &cfg, &a, "EURUSD", &candles, &p)
            .expect("first signal");
        let again = detect_forex_mr(&mut s, &cfg, &a, "EURUSD", &candles, &p);
        assert!(again.is_none());
    }
}
