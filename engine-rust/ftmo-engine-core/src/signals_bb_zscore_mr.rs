//! 2026-05-14 Detector #1 — Bollinger-Band Z-score Mean-Reversion voter.
//!
//! Sixth independent voter for `signals_regime_confluence.rs`. Provides an
//! orthogonal mean-reversion read on top of the existing RSI-based
//! `signals_meanrev.rs` (which fires on momentum-divergence crosses). Where
//! RSI-MR is sensitive to short-term momentum exhaustion, BB-Z is sensitive
//! to absolute price displacement from the rolling mean — they tend to
//! disagree on choppy markets and agree on clean snap-back setups, making
//! a useful additive vote for the consensus gate.
//!
//! ## Signal contract
//!
//! Long-trigger:
//!   1. Recent z-extreme: there exists a bar `k ∈ [trigger_idx - look_back_bars,
//!      trigger_idx]` whose `Z[k] ≤ -z_threshold`.
//!   2. Cross-back-above-lower-BB on the signal bar: `close[i-2] < lower[i-2]
//!      AND close[i-1] ≥ lower[i-1]`. The series indexing follows the codebase
//!      convention `signal_idx = candles.len() - 2`; entry is taken at
//!      `candles[i].open` (where `i = candles.len() - 1`) so the signal-bar
//!      close is fully known and not lookahead.
//!   3. Recovery cap: `Z[trigger_idx] ≤ z_recover_cap` (default 0.0). Filters
//!      out partial recoveries that are still well above neutral.
//!
//! Short-trigger: mirror — recent z ≥ +z_threshold, cross-back-below-upper-BB,
//! `Z[trigger_idx] ≥ -z_recover_cap`.
//!
//! ## TS-parity notes
//!
//! - Population std (`ddof = 0`, divide by `period` not `period - 1`) to match
//!   `Math.sqrt(sum((x-mu)^2)/n)` of the upstream signal-service.
//! - `min_std_pct` guard against degenerate flat markets: when
//!   `std / close < min_std_pct`, the z-score is undefined and the bar
//!   abstains (no signal). Mirrors the same guard pattern as
//!   `compute_vol_confirm_vote` (sma > 0 + finite check).
//! - Cooldown via `state.loss_streak_by_asset_dir` with key prefix `"BBZ|"`
//!   so it lives in the same anti-spam map as `MR|` and `BO|`. Anti-spam
//!   throttles back-to-back signals regardless of trade outcome.
//! - Entry uses `candles[i].open` (entry bar). Stop/TP are anchored on
//!   `entry_price`. Costs/caps go through `apply_post_factor_caps` for the
//!   same dayBased + maxRiskFrac + LIVE_LOSS_CAP gates that R28V6 honors.

use crate::candle::Candle;
use crate::config::{AssetConfig, EngineConfig};
use crate::indicators::{rolling_std, sma};
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::sizing::{apply_post_factor_caps, resolve_sizing_factor};
use crate::state::EngineState;
use crate::time_util::ls_key;

/// Parameters for the Bollinger-Band Z-score Mean-Reversion detector.
///
/// Defaults are tuned for the 30m AMBER_PASSLOCK basket — same TF/asset
/// universe as the existing RegimeConfluence voters. See `default_for` for
/// the per-asset risk_frac propagation rule.
#[derive(Debug, Clone, Copy)]
pub struct BollingerZScoreSource {
    /// SMA / std rolling window length (bars).
    pub bb_period: u32,
    /// Band width: lower = mean - mult × std; upper = mean + mult × std.
    /// Defaults to 2.0 (classic Bollinger).
    pub bb_mult: f64,
    /// Minimum |Z| at the look-back peak required to arm the signal.
    /// Defaults to 2.0 (i.e. ~95% of a normal distribution).
    pub z_threshold: f64,
    /// How far back (in bars BEFORE trigger_idx, inclusive of trigger_idx
    /// itself) we look for the z-extreme. Defaults to 5.
    pub look_back_bars: u32,
    /// Recovery cap on the signal bar's z. For longs the trigger-bar z must
    /// be ≤ this value (so we only fire while price is still in the
    /// reversion zone, not after a complete snap-back). Defaults to 0.0
    /// (must have re-entered the lower-half of the band).
    pub z_recover_cap: f64,
    /// Anti-spam cooldown (bars) installed after every emitted signal,
    /// regardless of trade outcome. Mirrors `signals_meanrev.rs` semantics.
    pub cooldown_bars: u64,
    /// Risk-frac multiplier — typically 0.5 so MR sizes at half the trend
    /// detector. Applied BEFORE `apply_post_factor_caps`.
    pub size_mult: f64,
    /// Minimum std / signal_close ratio. Below this the market is
    /// effectively flat → z-score is undefined → abstain. Defaults to 5bp.
    pub min_std_pct: f64,
    /// Minimum total bars seen before this detector can emit. Independent of
    /// `bb_period` warmup so callers can demand additional global warmup.
    /// Defaults to 40.
    pub min_warmup_bars: u64,
}

impl BollingerZScoreSource {
    pub fn default_for(_asset: &AssetConfig, _cfg: &EngineConfig) -> Self {
        Self {
            bb_period: 20,
            bb_mult: 2.0,
            z_threshold: 2.0,
            look_back_bars: 5,
            z_recover_cap: 0.0,
            cooldown_bars: 8,
            size_mult: 0.5,
            min_std_pct: 0.0005,
            min_warmup_bars: 40,
        }
    }
}

impl Default for BollingerZScoreSource {
    fn default() -> Self {
        Self {
            bb_period: 20,
            bb_mult: 2.0,
            z_threshold: 2.0,
            look_back_bars: 5,
            z_recover_cap: 0.0,
            cooldown_bars: 8,
            size_mult: 0.5,
            min_std_pct: 0.0005,
            min_warmup_bars: 40,
        }
    }
}

/// Compute the directional vote (long/short/abstain) for the latest signal
/// bar without consulting any engine state. Used as a regime-confluence
/// voter — the caller (`detect_regime_confluence`) just needs the side.
///
/// Lookahead-safe: reads exclusively `candles[..= signal_idx]` where
/// `signal_idx = candles.len() - 2`. The entry bar `candles[i]` is NEVER
/// consulted in the voting path.
pub fn compute_bb_zscore_vote(
    candles: &[Candle],
    src: &BollingerZScoreSource,
) -> Option<PositionSide> {
    if src.bb_period == 0 || src.bb_mult <= 0.0 || src.z_threshold <= 0.0 {
        return None;
    }
    if !src.bb_mult.is_finite() || !src.z_threshold.is_finite() {
        return None;
    }
    // Need: entry bar (i) + signal bar (i-1) + prev-signal bar (i-2) for the
    // band-cross test, plus enough history before that to compute SMA/std at
    // both i-1 and i-2. The minimum series length is `bb_period + 2` (entry +
    // signal-bar + prev-signal-bar needing full SMA window).
    let period = src.bb_period as usize;
    if candles.len() < period + 2 {
        return None;
    }
    let signal_idx = candles.len() - 2; // bar i-1 (just closed; no lookahead)
    let prev_signal_idx = signal_idx.checked_sub(1)?;
    let lb = src.look_back_bars as usize;

    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let sma_series = sma(&closes, period);
    let std_series = rolling_std(&closes, period);

    let mean_now = sma_series[signal_idx]?;
    let std_now = std_series[signal_idx]?;
    let mean_prev = sma_series[prev_signal_idx]?;
    let std_prev = std_series[prev_signal_idx]?;

    if !mean_now.is_finite() || !std_now.is_finite() {
        return None;
    }
    let signal_close = closes[signal_idx];
    let prev_close = closes[prev_signal_idx];
    if !signal_close.is_finite() || !prev_close.is_finite() {
        return None;
    }
    // min_std_pct gate: when std/close is degenerate-small, treat as flat
    // market and abstain. Also short-circuits the std=0 case (constant
    // series).
    if signal_close == 0.0 {
        return None;
    }
    let std_ratio_now = std_now / signal_close.abs();
    if std_ratio_now < src.min_std_pct {
        return None;
    }
    // Even though the cross-check below uses std_prev, we don't require
    // std_prev to clear min_std_pct — a one-bar transition through a flat
    // patch is acceptable as long as the trigger-bar itself isn't flat.
    if std_prev <= 0.0 {
        return None;
    }

    let lower_now = mean_now - src.bb_mult * std_now;
    let upper_now = mean_now + src.bb_mult * std_now;
    let lower_prev = mean_prev - src.bb_mult * std_prev;
    let upper_prev = mean_prev + src.bb_mult * std_prev;

    let z_now = (signal_close - mean_now) / std_now;
    if !z_now.is_finite() {
        return None;
    }

    // Look-back window for the z-extreme. We scan bars
    // [signal_idx - lb ..= signal_idx] (inclusive of signal_idx itself).
    let lb_start = signal_idx.saturating_sub(lb);
    let mut min_z = f64::INFINITY;
    let mut max_z = f64::NEG_INFINITY;
    for k in lb_start..=signal_idx {
        let m = match sma_series[k] {
            Some(v) => v,
            None => continue,
        };
        let s = match std_series[k] {
            Some(v) => v,
            None => continue,
        };
        if s <= 0.0 || !s.is_finite() {
            continue;
        }
        let z = (closes[k] - m) / s;
        if !z.is_finite() {
            continue;
        }
        if z < min_z {
            min_z = z;
        }
        if z > max_z {
            max_z = z;
        }
    }

    // Long-trigger:
    //   - z-extreme in look-back ≤ -z_threshold
    //   - cross-back-above-lower-BB: prev_close < lower_prev AND signal_close ≥ lower_now
    //   - z_now ≤ z_recover_cap (still in lower half by default)
    let long_extreme = min_z <= -src.z_threshold;
    let long_cross = prev_close < lower_prev && signal_close >= lower_now;
    let long_recover = z_now <= src.z_recover_cap;
    if long_extreme && long_cross && long_recover {
        return Some(PositionSide::Long);
    }

    // Short-trigger: mirror.
    let short_extreme = max_z >= src.z_threshold;
    let short_cross = prev_close > upper_prev && signal_close <= upper_now;
    let short_recover = z_now >= -src.z_recover_cap;
    if short_extreme && short_cross && short_recover {
        return Some(PositionSide::Short);
    }

    None
}

/// Stateful detector — emits a `PollSignal` ready for the harness when the
/// vote fires AND state-gates (cooldown, warmup, disable_short/long,
/// caps) clear. Entry uses `candles[i].open` (entry bar) where
/// `i = candles.len() - 1`.
///
/// State mutations: installs cooldown via `loss_streak_by_asset_dir` with
/// key prefix `"BBZ|"`. Does NOT mutate equity / day-start / kelly-tier.
pub fn detect_bb_zscore_mr(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    src: &BollingerZScoreSource,
) -> Option<PollSignal> {
    // Warmup gate — global bars-seen threshold. Independent of bb_period
    // (which only gates the SMA/std series); this lets sweep configs demand
    // additional warmup before any signal can emit.
    if state.bars_seen < src.min_warmup_bars {
        return None;
    }
    let direction = compute_bb_zscore_vote(candles, src)?;
    if asset.disable_short && direction == PositionSide::Short {
        return None;
    }
    if asset.disable_long && direction == PositionSide::Long {
        return None;
    }
    if let Some(deact) = asset.deactivate_after_day {
        if state.day >= deact {
            return None;
        }
    }
    // Entry-bar = bar i (= candles.len() - 1). Open is known at signal-emit
    // time; close is FUTURE (would be lookahead).
    if candles.is_empty() {
        return None;
    }
    let i = candles.len() - 1;
    let entry_bar = candles[i];
    if !entry_bar.open.is_finite() {
        return None;
    }

    // Cooldown gate — same anti-spam pattern as signals_meanrev.rs but with
    // its own "BBZ|" prefix so it doesn't collide with the MR detector's
    // cooldown map (a config running BOTH would otherwise share the
    // cooldown and one detector's signal would silence the other for
    // cooldown_bars).
    let key = format!("BBZ|{}", ls_key(&asset.symbol, direction));
    if let Some(ls) = state.loss_streak_by_asset_dir.get(&key) {
        if state.bars_seen < ls.cd_until_bars_seen {
            return None;
        }
    }

    let stop_pct = asset.stop_pct.unwrap_or(cfg.stop_pct);
    let tp_pct = asset.tp_pct.unwrap_or(cfg.tp_pct);

    // R51 — skip outright if effective stop is wider than max_stop_pct.
    if !cfg.bypass_live_caps {
        if let Some(caps) = cfg.live_caps.as_ref() {
            if stop_pct > caps.max_stop_pct {
                return None;
            }
        }
    }
    let factor = resolve_sizing_factor(state, cfg, entry_bar.open_time);
    let eff_risk =
        apply_post_factor_caps(cfg, state, asset.risk_frac * factor * src.size_mult, stop_pct);
    if eff_risk <= 0.0 {
        return None;
    }

    let entry_price = entry_bar.open;
    let (stop_price, tp_price) = match direction {
        PositionSide::Long => (entry_price * (1.0 - stop_pct), entry_price * (1.0 + tp_pct)),
        PositionSide::Short => (entry_price * (1.0 + stop_pct), entry_price * (1.0 - tp_pct)),
    };
    // Cooldown install AFTER all may-return-None gates (mirrors the R67
    // audit fix in signals_meanrev.rs::finish_signal).
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
            invert_direction: false,
            ..Default::default()
        }
    }

    fn src() -> BollingerZScoreSource {
        BollingerZScoreSource::default()
    }

    /// Build a candle slice that drives the close DOWN by `drop` (deep z
    /// extreme below the lower band) and then recovers to `recover` so the
    /// prev-signal bar (idx len-3) sits BELOW the lower band and the
    /// signal bar (idx len-2) is BACK INSIDE.  Entry bar (idx len-1) gets
    /// a small open so eff_risk has something to chew on. Returns a series
    /// long enough that `bb_period=20` + `look_back_bars=5` warmup is met.
    fn oversold_cross_back_series() -> Vec<Candle> {
        // 30 flat candles at 100 → bb_mean ≈ 100, std ≈ 0 then tiny.
        // We need std > 0 so introduce a 0.5-amplitude oscillation to keep
        // std non-degenerate.
        let mut v: Vec<Candle> = Vec::new();
        for i in 0..40_i64 {
            let osc = if i % 2 == 0 { 100.5 } else { 99.5 };
            v.push(Candle::new(i * 1_800_000, osc, osc + 0.2, osc - 0.2, osc, 1.0));
        }
        // Bar at idx 40 — deep drop (below lower band, big negative z).
        v.push(Candle::new(40 * 1_800_000, 100.0, 100.0, 90.0, 90.0, 1.0));
        // Bar at idx 41 — signal bar: still BELOW prior lower band in close
        // terms but we'll cross back above the NEW lower band thanks to a
        // mean shift. To make this clean we just bring close back to ~98 so
        // it sits between lower_now and the mean.
        v.push(Candle::new(
            41 * 1_800_000,
            93.0,
            98.5,
            92.5,
            98.0,
            1.0,
        ));
        // Bar at idx 42 — entry bar (we read .open). Anything finite works.
        v.push(Candle::new(42 * 1_800_000, 98.5, 99.0, 98.0, 98.7, 1.0));
        v
    }

    #[test]
    fn long_signal_on_oversold_cross_back() {
        let mut s = EngineState::initial("x");
        s.bars_seen = 100; // bypass min_warmup_bars
        let candles = oversold_cross_back_series();
        // Sanity check on the vote helper first.
        let vote = compute_bb_zscore_vote(&candles, &src());
        assert_eq!(
            vote,
            Some(PositionSide::Long),
            "vote helper must signal Long on oversold cross-back fixture"
        );
        let sig = detect_bb_zscore_mr(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &src())
            .expect("signal expected on oversold cross-back");
        assert_eq!(sig.direction, PositionSide::Long);
        assert!(sig.eff_risk > 0.0 && sig.eff_risk <= 0.4);
        // Entry price = entry-bar OPEN (= 98.5), NOT signal-bar close.
        assert!(
            (sig.entry_price - 98.5).abs() < 1e-9,
            "entry_price must use entry-bar open, got {}",
            sig.entry_price
        );
    }

    #[test]
    fn no_signal_when_z_inside_bands() {
        // Pure oscillation around 100, never breaches ±2σ.
        let mut s = EngineState::initial("x");
        s.bars_seen = 100;
        let candles: Vec<Candle> = (0..60_i64)
            .map(|i| {
                let osc = if i % 2 == 0 { 100.2 } else { 99.8 };
                Candle::new(i * 1_800_000, osc, osc + 0.1, osc - 0.1, osc, 1.0)
            })
            .collect();
        let vote = compute_bb_zscore_vote(&candles, &src());
        assert!(vote.is_none(), "tight oscillation must not vote");
        let sig = detect_bb_zscore_mr(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &src());
        assert!(sig.is_none());
    }

    #[test]
    fn cooldown_blocks_back_to_back() {
        let mut s = EngineState::initial("x");
        s.bars_seen = 100;
        let candles = oversold_cross_back_series();
        let _ = detect_bb_zscore_mr(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &src())
            .expect("first signal must fire");
        // Same call: bars_seen unchanged → cooldown still active → None.
        let again = detect_bb_zscore_mr(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &src());
        assert!(
            again.is_none(),
            "back-to-back call must hit cooldown gate"
        );
        // Advance past cooldown — signal must come back.
        s.bars_seen += src().cooldown_bars + 1;
        let third = detect_bb_zscore_mr(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &src());
        assert!(third.is_some(), "post-cooldown call must re-fire");
    }

    #[test]
    fn no_signal_when_std_collapsed() {
        // Perfectly flat series → std = 0 → min_std_pct guard triggers.
        let mut s = EngineState::initial("x");
        s.bars_seen = 100;
        let candles: Vec<Candle> = (0..40_i64)
            .map(|i| Candle::new(i * 1_800_000, 100.0, 100.0, 100.0, 100.0, 1.0))
            .collect();
        let vote = compute_bb_zscore_vote(&candles, &src());
        assert!(vote.is_none(), "flat-market std=0 must not vote");
        let sig = detect_bb_zscore_mr(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &src());
        assert!(sig.is_none());
    }

    /// KRITISCH lookahead check: modifying `candles[i].close` (the entry bar)
    /// must NOT change the signal output, since the detector only reads
    /// candles[..=signal_idx] where signal_idx = candles.len() - 2.
    #[test]
    fn no_lookahead_on_entry_bar_close() {
        let mut s1 = EngineState::initial("x");
        s1.bars_seen = 100;
        let mut s2 = EngineState::initial("x");
        s2.bars_seen = 100;

        let candles_a = oversold_cross_back_series();
        let mut candles_b = candles_a.clone();
        // Mutate the entry-bar close to an EXTREME value — if the detector
        // were peeking, the signal direction / fire bit would flip.
        let last = candles_b.len() - 1;
        candles_b[last].close = 1.0; // crash to 1.0 (catastrophic)
        candles_b[last].high = 1.0;
        candles_b[last].low = 0.5;

        let sig_a = detect_bb_zscore_mr(&mut s1, &cfg(), &asset(), "BTCUSDT", &candles_a, &src());
        let sig_b = detect_bb_zscore_mr(&mut s2, &cfg(), &asset(), "BTCUSDT", &candles_b, &src());

        assert_eq!(
            sig_a.is_some(),
            sig_b.is_some(),
            "entry-bar close mutation must not change fire-bit (lookahead suspect)"
        );
        if let (Some(a), Some(b)) = (&sig_a, &sig_b) {
            assert_eq!(
                a.direction, b.direction,
                "entry-bar close mutation must not change direction"
            );
            assert!(
                (a.stop_pct - b.stop_pct).abs() < 1e-12,
                "stop_pct must be deterministic from pre-signal state"
            );
        }
    }

    #[test]
    fn respects_disable_short() {
        // Build a series whose vote helper produces a SHORT — then assert
        // detect_bb_zscore_mr returns None when asset.disable_short=true.
        // Symmetric to the oversold fixture: deep up-spike + cross-back.
        let mut v: Vec<Candle> = Vec::new();
        for i in 0..40_i64 {
            let osc = if i % 2 == 0 { 100.5 } else { 99.5 };
            v.push(Candle::new(i * 1_800_000, osc, osc + 0.2, osc - 0.2, osc, 1.0));
        }
        v.push(Candle::new(40 * 1_800_000, 100.0, 110.0, 100.0, 110.0, 1.0));
        v.push(Candle::new(41 * 1_800_000, 107.0, 107.5, 101.5, 102.0, 1.0));
        v.push(Candle::new(42 * 1_800_000, 101.5, 102.0, 101.0, 101.7, 1.0));

        // Vote should be Short on this fixture.
        let vote = compute_bb_zscore_vote(&v, &src());
        assert_eq!(vote, Some(PositionSide::Short), "fixture must vote Short");

        let mut s = EngineState::initial("x");
        s.bars_seen = 100;
        let mut a = asset();
        a.disable_short = true;
        let sig = detect_bb_zscore_mr(&mut s, &cfg(), &a, "BTCUSDT", &v, &src());
        assert!(
            sig.is_none(),
            "disable_short must suppress short signals at detector output"
        );
    }

    #[test]
    fn warmup_gate_blocks_early_signals() {
        // State.bars_seen < min_warmup_bars → return None unconditionally,
        // regardless of how strong the vote is.
        let mut s = EngineState::initial("x");
        s.bars_seen = 0;
        let candles = oversold_cross_back_series();
        let sig = detect_bb_zscore_mr(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &src());
        assert!(
            sig.is_none(),
            "warmup gate must block before min_warmup_bars elapsed"
        );
        // After enough bars elapse, signal must fire on same series.
        s.bars_seen = src().min_warmup_bars + 1;
        let sig2 = detect_bb_zscore_mr(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &src());
        assert!(
            sig2.is_some(),
            "post-warmup, signal must fire on the same fixture"
        );
    }

    /// PASSLOCK semantic: the engine-level `close_all_on_target_reached`
    /// gate lives in `harness::step_bar` (it suppresses new entries while
    /// `state.paused_at_target` is true). The detector itself doesn't need
    /// to re-check that flag — the harness intercepts BEFORE detector calls.
    /// This test verifies the contract by setting `paused_at_target` and
    /// confirming the detector still produces its signal (the harness is
    /// responsible for dropping it, not us). The test prevents a future
    /// refactor from accidentally pushing PASSLOCK logic into the detector
    /// (which would create dual-write semantics and divergence with TS).
    #[test]
    fn passlock_target_reached_blocks_new_entry() {
        let mut s = EngineState::initial("x");
        s.bars_seen = 100;
        s.paused_at_target = true;
        s.first_target_hit_day = Some(0);
        let candles = oversold_cross_back_series();
        let sig = detect_bb_zscore_mr(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &src());
        // Contract: detector emits — harness gates downstream.
        assert!(
            sig.is_some(),
            "detector layer must not own PASSLOCK gating (it lives in harness::step_bar)"
        );
    }

    /// liveCaps.max_stop_pct: when the effective stop_pct exceeds the cap,
    /// the detector must skip outright (mirrors signals_breakout R51 gate).
    #[test]
    fn cost_cap_blocks_when_stop_pct_exceeds() {
        let mut s = EngineState::initial("x");
        s.bars_seen = 100;
        let mut c = cfg();
        // Force a tight cap and a wide stop so the gate triggers.
        if let Some(caps) = c.live_caps.as_mut() {
            caps.max_stop_pct = 0.01;
        }
        let mut a = asset();
        a.stop_pct = Some(0.10); // 10% — way above the 1% cap.
        let candles = oversold_cross_back_series();
        let sig = detect_bb_zscore_mr(&mut s, &c, &a, "BTCUSDT", &candles, &src());
        assert!(
            sig.is_none(),
            "stop_pct > liveCaps.max_stop_pct must skip outright"
        );
    }
}
