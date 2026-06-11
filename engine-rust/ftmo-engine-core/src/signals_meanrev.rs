//! Mean-reversion signal source — port of `cfg.meanReversionSource` from
//! `ftmoLiveEngineV5R.ts`. Emits long/short entries when the closing-RSI
//! crosses a threshold from the wrong side of the band.
//!
//!   - long  → RSI(period) crosses BELOW `oversold` from above
//!   - short → RSI(period) crosses ABOVE `overbought` from below
//!
//! Per-asset|direction `cooldown_bars` prevents back-to-back signals.

use crate::candle::Candle;
use crate::config::{AssetConfig, EngineConfig, MeanReversionSource};
use crate::indicators::rsi;
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::sizing::{apply_post_factor_caps, resolve_sizing_factor};
use crate::state::EngineState;
use crate::time_util::ls_key;

/// O(N²) variant — recomputes RSI from scratch each call. Kept for
/// callers that don't have a pre-computed series. For hot paths use
/// [`detect_mean_reversion_with_rsi`] which accepts a pre-cached series.
pub fn detect_mean_reversion_recompute(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    src: &MeanReversionSource,
) -> Option<PollSignal> {
    detect_mean_reversion(state, cfg, asset, source_symbol, candles, src)
}

/// Hot-path-friendly variant: takes a pre-computed RSI series aligned with
/// `candles`. Eliminates the per-bar O(N) RSI re-compute that dominates
/// signal-driven backtests.
pub fn detect_mean_reversion_with_rsi(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    rsi_series: &[Option<f64>],
    src: &MeanReversionSource,
) -> Option<PollSignal> {
    // 2026-05-14 Lookahead-parity fix: mirror `detect_mean_reversion` —
    // signal-bar = i-1 (last just-closed bar). RSI[i] folds in candles[i].close
    // which is future-data at entry time (entry executes @ candles[i].open).
    // Required ≥ period+3 candles so trigger_idx-1 is in-range.
    if candles.len() < src.period as usize + 3 || rsi_series.len() != candles.len() {
        return None;
    }
    let i = candles.len() - 1;
    let trigger_idx = i - 1;
    let cur = rsi_series[trigger_idx]?;
    let prev = rsi_series[trigger_idx - 1]?;
    let direction = if prev > src.oversold && cur <= src.oversold {
        PositionSide::Long
    } else if prev < src.overbought && cur >= src.overbought {
        PositionSide::Short
    } else {
        return None;
    };
    finish_signal(state, cfg, asset, source_symbol, candles, src, direction)
}

fn finish_signal(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    src: &MeanReversionSource,
    direction: PositionSide,
) -> Option<PollSignal> {
    // 2026-05-14 Lookahead-parity fix: entry-bar = i, signal-bar = i-1.
    // Stop/TP/entry must anchor on entry_bar.open (known at signal time)
    // — was `last.close` which is future-data. Matches `detect_mean_reversion`.
    let i = candles.len() - 1;
    let entry_bar = candles[i];
    let key = format!("MR|{}", ls_key(&asset.symbol, direction));
    if let Some(ls) = state.loss_streak_by_asset_dir.get(&key) {
        if state.bars_seen < ls.cd_until_bars_seen {
            return None;
        }
    }
    // R67 audit fix: was inserting cooldown BEFORE eff_risk gate. If eff_risk
    // ≤ 0 the signal is dropped, but the cooldown was still installed → next
    // `cooldown_bars` worth of bars block legitimate signals on this asset/dir.
    // Move cooldown-insert below all the "may return None" gates so only
    // emitted signals install the cooldown.
    //
    // 2026-05-13 Bug-Audit Round 2 — Bug C clarification: the field name
    // `loss_streak_by_asset_dir` + `cd_until_bars_seen` suggests "cooldown
    // ONLY after loss streak", but the actual semantic is ANTI-SPAM: every
    // emitted MR signal installs a `cooldown_bars` block on the same
    // asset+direction, regardless of subsequent trade outcome. This is
    // intentional (per TS V4-Sim parity) — but worth noting that a winning
    // MR entry also triggers the cooldown, suppressing follow-on entries
    // for `cooldown_bars`.
    // 2026-05-13 Codex Round 7 #B4 FIX: hot-path now uses centralized
    // apply_post_factor_caps (dayBased + maxRiskFrac + LIVE_LOSS_CAP).
    // Previously skipped both dayBased and the maxDailyLoss-derived cap,
    // letting MR-hot-path-only configs silently over-size in early days.
    let stop_pct = asset.stop_pct.unwrap_or(cfg.stop_pct);
    let tp_pct = asset.tp_pct.unwrap_or(cfg.tp_pct);
    let entry_price = entry_bar.open;
    let factor = resolve_sizing_factor(state, cfg, entry_bar.open_time);
    let eff_risk = apply_post_factor_caps(
        cfg,
        state,
        asset.risk_frac * factor * src.size_mult,
        stop_pct,
    );
    if eff_risk <= 0.0 {
        return None;
    }
    let (stop_price, tp_price) = match direction {
        PositionSide::Long => (entry_price * (1.0 - stop_pct), entry_price * (1.0 + tp_pct)),
        PositionSide::Short => (entry_price * (1.0 + stop_pct), entry_price * (1.0 - tp_pct)),
    };
    state.loss_streak_by_asset_dir.insert(
        key,
        crate::state::LossStreakEntry {
            streak: 0,
            cd_until_bars_seen: state.bars_seen + src.cooldown_bars,
        },
    );
    Some(PollSignal {
        symbol: asset.symbol.clone(),
        source_symbol: source_symbol.to_string(),
        direction,
        entry_time: entry_bar.open_time,
        entry_price,
        stop_price,
        tp_price,
        stop_pct,
        tp_pct,
        eff_risk,
        chandelier_atr_at_entry: None,
    })
}

/// Detect a mean-reversion signal on the LAST candle of `candles`. Returns
/// `Some(signal)` if RSI crossed the threshold AND no cooldown blocks it.
/// Mutates `state.loss_streak_by_asset_dir` to install the cooldown — we
/// piggy-back on the existing cooldown bookkeeping mechanism.
pub fn detect_mean_reversion(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    src: &MeanReversionSource,
) -> Option<PollSignal> {
    // 2026-05-13 Codex HIGH FIX: signal-bar = i-1 (just closed); entry-bar
    // = i (open known, close future). Previously read RSI[i] which uses
    // bar i's close in the EMA-smoothed RSI computation → lookahead.
    if candles.len() < src.period as usize + 3 {
        return None;
    }
    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let series = rsi(&closes, src.period as usize);
    let i = candles.len() - 1;
    let trigger_idx = i - 1;
    let cur = series[trigger_idx]?;
    let prev = series[trigger_idx - 1]?;

    // Cross detection.
    let direction = if prev > src.oversold && cur <= src.oversold {
        PositionSide::Long
    } else if prev < src.overbought && cur >= src.overbought {
        PositionSide::Short
    } else {
        return None;
    };

    // Cooldown gate (re-uses the loss-streak map's cd_until_bars_seen field
    // as an MR-specific anti-spam timer — different from the loss-streak
    // semantic but the storage shape matches).
    let key = format!("MR|{}", ls_key(&asset.symbol, direction));
    if let Some(ls) = state.loss_streak_by_asset_dir.get(&key) {
        if state.bars_seen < ls.cd_until_bars_seen {
            return None;
        }
    }
    // R67 audit (Round 2): same cooldown-before-eff_risk-gate bug as
    // finish_signal — fixed identically by moving cooldown insert below.
    // 2026-05-13 Codex HIGH FIX: entry uses bar-i's OPEN (known) — was last.close
    // (lookahead). Stop/TP anchored on entry_price.
    let entry_bar = candles[i];
    let entry_price = entry_bar.open;
    let stop_pct = asset.stop_pct.unwrap_or(cfg.stop_pct);
    let tp_pct = asset.tp_pct.unwrap_or(cfg.tp_pct);
    // 2026-05-13 Codex Audit Round 3 — Fix 2: centralized post-factor caps
    // (dayBased + maxRiskFrac + LIVE_LOSS_CAP). Previously this detector
    // only clamped to maxRiskFrac → uncapped against the maxDailyLoss-
    // derived live-loss limit.
    let factor = resolve_sizing_factor(state, cfg, entry_bar.open_time);
    let eff_risk = apply_post_factor_caps(
        cfg,
        state,
        asset.risk_frac * factor * src.size_mult,
        stop_pct,
    );
    if eff_risk <= 0.0 {
        return None;
    }
    let (stop_price, tp_price) = match direction {
        PositionSide::Long => (entry_price * (1.0 - stop_pct), entry_price * (1.0 + tp_pct)),
        PositionSide::Short => (entry_price * (1.0 + stop_pct), entry_price * (1.0 - tp_pct)),
    };
    state.loss_streak_by_asset_dir.insert(
        key,
        crate::state::LossStreakEntry {
            streak: 0,
            cd_until_bars_seen: state.bars_seen + src.cooldown_bars,
        },
    );
    Some(PollSignal {
        symbol: asset.symbol.clone(),
        source_symbol: source_symbol.to_string(),
        direction,
        entry_time: entry_bar.open_time,
        entry_price,
        stop_price,
        tp_price,
        stop_pct,
        tp_pct,
        eff_risk,
        chandelier_atr_at_entry: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AssetConfig;

    fn cfg() -> EngineConfig {
        EngineConfig::r28_v6_passlock_template()
    }
    fn asset() -> AssetConfig {
        AssetConfig {
            symbol: "BTC-MR".into(),
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
    fn src() -> MeanReversionSource {
        MeanReversionSource {
            period: 14,
            oversold: 25.0,
            overbought: 75.0,
            cooldown_bars: 8,
            size_mult: 0.5,
        }
    }

    /// Build a price series whose SIGNAL-bar (i-1 = idx 15) is a sharp drop
    /// so RSI crosses below `oversold` AT that bar (prev was 50 on the
    /// flat phase). 2026-05-13 Codex Fix 2 test-update: extra entry-bar
    /// appended so the trigger now reads idx 15 (signal-bar) and entries
    /// open at idx 16 (entry-bar open).
    fn drop_series() -> Vec<Candle> {
        // 15 flat + 1 down (signal-bar) + 1 entry-bar
        let mut v: Vec<Candle> = (0..15)
            .map(|i| Candle::new(i as i64 * 1800_000, 100.0, 100.5, 99.5, 100.0, 0.0))
            .collect();
        v.push(Candle::new(15 * 1800_000, 100.0, 100.0, 95.0, 95.0, 0.0));
        v.push(Candle::new(16 * 1800_000, 95.0, 95.5, 94.5, 95.2, 0.0));
        v
    }

    #[test]
    fn long_signal_on_oversold_cross() {
        let mut s = EngineState::initial("x");
        let candles = drop_series();
        let sig = detect_mean_reversion(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &src())
            .expect("signal expected on oversold cross");
        assert_eq!(sig.direction, PositionSide::Long);
        assert!(sig.eff_risk > 0.0 && sig.eff_risk <= 0.4);
    }

    #[test]
    fn cooldown_blocks_back_to_back() {
        let mut s = EngineState::initial("x");
        let candles = drop_series();
        let _ = detect_mean_reversion(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &src())
            .expect("first signal");
        // Same call → cooldown must block.
        let again = detect_mean_reversion(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &src());
        assert!(again.is_none());
    }

    #[test]
    fn no_signal_on_neutral_rsi() {
        let mut s = EngineState::initial("x");
        let candles: Vec<Candle> = (0..30)
            .map(|i| Candle::new(i as i64 * 1800_000, 100.0, 100.5, 99.5, 100.0, 0.0))
            .collect();
        assert!(
            detect_mean_reversion(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &src()).is_none()
        );
    }
}
