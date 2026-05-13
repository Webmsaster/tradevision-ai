//! Donchian-style breakout signal generator — a minimal, self-contained
//! signal source so the harness can drive end-to-end backtests before the
//! full `detectAsset` port lands.
//!
//! Rule (decision at bar `i-1` close, execution at bar `i` open):
//!   - long when `close[i-1] > max(high[i-1-N..i-1])`
//!   - short when `close[i-1] < min(low[i-1-N..i-1])`
//!
//! 2026-05-13 Codex KRITISCH FIX: previously trigger AND entry_price used
//! `candles[i].close` which was a lookahead — at signal-emission time we're
//! at bar `i`'s OPEN (bar `i-1` just closed), so `candles[i].close` is
//! future data. Now mirrors R28V6 timing: trigger uses bar `i-1` close,
//! entry executes at `candles[i].open` (the known current bar open).

use crate::candle::Candle;
use crate::config::{AssetConfig, EngineConfig};
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::sizing::resolve_sizing_factor;
use crate::state::EngineState;

pub struct BreakoutParams {
    pub lookback: usize,
    pub stop_pct: f64,
    pub tp_pct: f64,
    pub base_risk_frac: f64,
}

impl BreakoutParams {
    pub fn from_cfg(cfg: &EngineConfig, asset: &AssetConfig) -> Self {
        Self {
            lookback: cfg.trigger_bars.max(1) as usize,
            stop_pct: asset.stop_pct.unwrap_or(cfg.stop_pct),
            tp_pct: asset.tp_pct.unwrap_or(cfg.tp_pct),
            base_risk_frac: asset.risk_frac,
        }
    }
}

/// Emit at most one signal for the LAST candle in `candles` (live-poll
/// convention). Returns `None` if the breakout filter doesn't fire or there
/// aren't enough bars yet.
pub fn detect_breakout(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &BreakoutParams,
) -> Option<PollSignal> {
    // 2026-05-13 Codex KRITISCH FIX: signal-bar = `i-1` (the just-closed
    // bar), execution-bar = `i` (current bar, open known, close not).
    // Need at least lookback+1 prior bars to compute the donchian range on
    // bars BEFORE `i-1`, plus bar `i` itself → `lookback + 2` total.
    if candles.len() < params.lookback + 2 {
        return None;
    }
    let i = candles.len() - 1;
    let signal_idx = i - 1;
    let signal_bar = candles[signal_idx];
    let entry_bar = candles[i];
    let lo = signal_idx - params.lookback;
    let max_high = candles[lo..signal_idx]
        .iter()
        .map(|c| c.high)
        .fold(f64::MIN, f64::max);
    let min_low = candles[lo..signal_idx]
        .iter()
        .map(|c| c.low)
        .fold(f64::MAX, f64::min);

    let direction = if signal_bar.close > max_high {
        PositionSide::Long
    } else if signal_bar.close < min_low {
        PositionSide::Short
    } else {
        return None;
    };

    // 2026-05-13 Bug-Audit Round 2 — Bug B FIX (revised): honor only
    // asset.disable_short. Direction inversion is INCORRECT here because
    // detect_breakout's output direction is the "open this side" trade
    // direction — same convention R28V6 emits AFTER its internal invert
    // bookkeeping. They both fire "Long" on momentum-up regardless of
    // invert=true. (Previous attempt to invert here regressed Champion C2
    // by 48pp because it flipped breakout's vote against R28V6's vote in
    // REGIME consensus.) disable_short still warranted at signal source
    // for parity with R28V6's `candidates` filter.
    if asset.disable_short && direction == PositionSide::Short {
        return None;
    }

    let factor = resolve_sizing_factor(state, cfg, entry_bar.open_time);
    let mut eff_risk = params.base_risk_frac * factor;
    if !cfg.bypass_live_caps {
        if let Some(caps) = cfg.live_caps.as_ref() {
            eff_risk = eff_risk.min(caps.max_risk_frac);
            // R51 — also skip outright if effective stop is wider than max_stop_pct.
            if params.stop_pct > caps.max_stop_pct {
                return None;
            }
        }
    }
    if eff_risk <= 0.0 {
        return None;
    }

    // 2026-05-13 Codex KRITISCH FIX: entry_price uses bar `i`'s OPEN (known
    // at signal-emit time) instead of the previous `last.close` lookahead.
    // Stop/TP anchors stay on entry_price so risk-arithmetic is consistent
    // with R28V6.
    let entry_price = entry_bar.open;
    let (stop_price, tp_price) = match direction {
        PositionSide::Long => (
            entry_price * (1.0 - params.stop_pct),
            entry_price * (1.0 + params.tp_pct),
        ),
        PositionSide::Short => (
            entry_price * (1.0 + params.stop_pct),
            entry_price * (1.0 - params.tp_pct),
        ),
    };

    Some(PollSignal {
        symbol: asset.symbol.clone(),
        source_symbol: source_symbol.to_string(),
        direction,
        entry_time: entry_bar.open_time,
        entry_price,
        stop_price,
        tp_price,
        stop_pct: params.stop_pct,
        tp_pct: params.tp_pct,
        eff_risk,
        chandelier_atr_at_entry: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AssetConfig;

    fn cfg() -> EngineConfig {
        let mut c = EngineConfig::r28_v6_passlock_template();
        c.trigger_bars = 5;
        c.stop_pct = 0.02;
        c.tp_pct = 0.04;
        c
    }

    fn asset() -> AssetConfig {
        AssetConfig {
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
            ..Default::default()
        }
    }

    fn ramp(n: usize, base: f64, slope: f64) -> Vec<Candle> {
        (0..n)
            .map(|i| {
                let p = base + slope * i as f64;
                Candle::new(i as i64 * 1800_000, p, p + 0.1, p - 0.1, p, 0.0)
            })
            .collect()
    }

    #[test]
    fn no_breakout_when_close_inside_range() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        let p = BreakoutParams::from_cfg(&cfg, &a);
        let candles = ramp(20, 100.0, 0.0); // flat
        assert!(detect_breakout(&mut s, &cfg, &a, "BTCUSDT", &candles, &p).is_none());
    }

    #[test]
    fn long_breakout_on_uptrend() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        let p = BreakoutParams::from_cfg(&cfg, &a);
        let mut candles = ramp(10, 100.0, 0.5); // rising
                                                // 2026-05-13 Codex KRITISCH FIX adjusted: signal-bar = i-1,
                                                // not i. Force candles[len-2].close above prev-N highs.
        let n = candles.len();
        let prev_high = candles[..n - 2]
            .iter()
            .map(|c| c.high)
            .fold(f64::MIN, f64::max);
        candles[n - 2].close = prev_high + 5.0;
        let sig = detect_breakout(&mut s, &cfg, &a, "BTCUSDT", &candles, &p).unwrap();
        assert_eq!(sig.direction, PositionSide::Long);
        // Entry uses candles[n-1].open — same ramp slope so it sits above stop.
        assert!(sig.stop_price < sig.entry_price);
        assert!(sig.tp_price > sig.entry_price);
        assert!((sig.eff_risk - 0.4).abs() < 1e-9);
    }

    #[test]
    fn short_breakout_on_downtrend() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        let p = BreakoutParams::from_cfg(&cfg, &a);
        let mut candles = ramp(10, 100.0, -0.5);
        let n = candles.len();
        let prev_low = candles[..n - 2]
            .iter()
            .map(|c| c.low)
            .fold(f64::MAX, f64::min);
        candles[n - 2].close = prev_low - 5.0;
        let sig = detect_breakout(&mut s, &cfg, &a, "BTCUSDT", &candles, &p).unwrap();
        assert_eq!(sig.direction, PositionSide::Short);
        assert!(sig.stop_price > sig.entry_price);
        assert!(sig.tp_price < sig.entry_price);
    }

    #[test]
    fn skips_when_stop_pct_exceeds_live_cap() {
        let mut s = EngineState::initial("x");
        let mut cfg = cfg();
        cfg.live_caps = Some(crate::config::LiveCaps {
            max_stop_pct: 0.01,
            max_risk_frac: 0.4,
        });
        let a = asset();
        let mut p = BreakoutParams::from_cfg(&cfg, &a);
        p.stop_pct = 0.05; // above cap
        let mut candles = ramp(10, 100.0, 0.5);
        let n = candles.len();
        let prev_high = candles[..n - 2]
            .iter()
            .map(|c| c.high)
            .fold(f64::MIN, f64::max);
        candles[n - 2].close = prev_high + 5.0;
        assert!(detect_breakout(&mut s, &cfg, &a, "BTCUSDT", &candles, &p).is_none());
    }
}
