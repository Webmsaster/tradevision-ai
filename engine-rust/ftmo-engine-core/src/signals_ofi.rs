//! 2026-05-14 Detector #2 — Order-Flow Imbalance Persistent Cluster.
//!
//! New entry-detector that searches for sustained directional pressure in
//! the **taker-flow** of recent bars. The hypothesis is that a single bar's
//! aggressor imbalance (covered by `detect_vol_imbalance` in
//! `signals_r29r5.rs`) is noisy and easily gamed by single big taker fills,
//! but multiple consecutive same-sign bars are far less likely to be
//! manipulated and tend to precede continuation moves.
//!
//! Signal-bar convention follows the 2026-05-13 Codex KRITISCH FIX: the
//! signal-bar is `candles[len-2]` (the last fully-closed bar) and the entry
//! bar is `candles[len-1]` (current bar, open known, close NOT yet known).
//! The window of bars consulted for taker-flow is therefore
//! `[signal_idx - n + 1 ..= signal_idx]` — inclusive of the signal bar and
//! STRICTLY EXCLUSIVE of the entry bar. This is verified by the dedicated
//! `ofi_must_not_read_entry_bar_volume` lookahead test.
//!
//! Detector contract:
//!   - per-bar delta = `2 × taker_buy_volume − volume`
//!     (=  taker_buy − taker_sell, signed +/−).
//!   - window aggregate `sum_delta` and `sum_volume`; ratio = sum_delta /
//!     sum_volume normalised into [−1, 1].
//!   - Long: ratio ≥ +delta_threshold AND (when `require_all_same_sign`)
//!     every bar in the window has positive delta AND signal_bar.close
//!     > SMA(close, sma_period) (over the bars STRICTLY before the signal
//!     bar) AND `net_return = (signal_close - first_window_close) /
//!     first_window_close > 0`. Short: symmetric inverse.
//!   - Cooldown: state.loss_streak_by_asset_dir keyed by
//!     `"OFI|{symbol}|{dir}"` to prevent back-to-back same-direction emits.
//!   - TF-scaling: `scale = round(30 / cfg.bar_minutes).max(1)` so a 30m-
//!     tuned window/SMA stays time-equivalent on 5m or 2h feeds.

use crate::candle::Candle;
use crate::config::{AssetConfig, EngineConfig};
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::signals_r29r5::finalise_signal;
use crate::state::EngineState;

/// CLI-tunable parameters for the OFI persistent-cluster detector. All defaults
/// are 30m-tuned; the detector internally TF-scales window_bars and sma_period.
#[derive(Debug, Clone, Copy)]
pub struct OfiPersistentParams {
    /// Number of recent (closed) bars to inspect for directional imbalance.
    pub window_bars: usize,
    /// Threshold on `sum_delta / sum_volume` (∈ [−1, 1]) the cluster must
    /// clear. 0.20 = 60/40 takerBuy ratio over the window.
    pub delta_threshold: f64,
    /// SMA period over closes (computed STRICTLY BEFORE signal_bar) used as
    /// trend-direction confirmation: long needs close>SMA, short close<SMA.
    pub sma_period: usize,
    /// Bars to suppress same-asset/dir signals after an emit.
    pub cooldown_bars: u64,
    /// Minimum total window volume (raw, not z-scored). Guards thin markets.
    pub min_total_volume: f64,
    /// When true, EVERY bar in the window must agree in sign with the
    /// requested direction. When false, only the aggregate ratio matters.
    pub require_all_same_sign: bool,
    /// Multiplier applied to `asset.risk_frac` before sizing-cap clamps.
    /// Detector is "secondary"-class, so default 0.5 keeps it from dominating
    /// the multi-account-stack's risk budget vs primary R28V6.
    pub size_mult: f64,
}

impl OfiPersistentParams {
    /// 2026-05-14 — sensible defaults for a 30m crypto AMBER-family basket.
    pub fn default_30m_crypto() -> Self {
        Self {
            window_bars: 5,
            delta_threshold: 0.20,
            sma_period: 20,
            cooldown_bars: 12,
            min_total_volume: 0.0,
            require_all_same_sign: true,
            size_mult: 0.5,
        }
    }
}

/// Compute the per-bar signed delta `2·taker_buy − volume`. Returns `None`
/// if `taker_buy_volume` is missing on the supplied bar — that's a HARD
/// failure (no imputation): without true taker-flow we cannot decide on
/// persistence and refuse to vote.
fn per_bar_delta(c: &Candle) -> Option<f64> {
    let tbv = c.taker_buy_volume?;
    // Data-corruption guard: taker_buy > volume is impossible (taker_buy is
    // a strict subset of total volume on each bar). Treat as missing data
    // rather than coerce — silently clamping would hide upstream feed bugs.
    if !tbv.is_finite() || !c.volume.is_finite() || tbv > c.volume {
        return None;
    }
    Some(2.0 * tbv - c.volume)
}

/// Pure helper — computes the OFI directional vote without state mutation.
/// Returns `Some(side)` only when the persistence cluster, ratio gate, SMA
/// trend, and net-return secondary filter all agree. Used both by the
/// standalone `detect_ofi_persistent` (which adds state-based cooldown +
/// sizing on top) AND by `signals_regime_confluence.rs` when OFI is enrolled
/// as a 6th independent voter.
pub fn compute_ofi_vote(
    candles: &[Candle],
    params: &OfiPersistentParams,
    cfg: &EngineConfig,
) -> Option<PositionSide> {
    // TF-scale window/SMA so a 30m-tuned param stays time-equivalent on
    // 5m or 2h feeds. scale = round(30 / bar_minutes).max(1).
    let scale = (30.0 / (cfg.bar_minutes.max(1) as f64)).round().max(1.0) as usize;
    let n = params.window_bars.saturating_mul(scale);
    let sma_p = params.sma_period.saturating_mul(scale);

    if n == 0 || sma_p == 0 {
        return None;
    }
    if !params.delta_threshold.is_finite() || params.delta_threshold <= 0.0 {
        return None;
    }

    // Need: bar `i` (entry) + signal_idx (i-1) + n window bars + sma_p SMA bars
    // strictly before signal_idx. Take the max of the two backward
    // requirements: `signal_idx − max(n−1, sma_p) ≥ 0` ⇒ `len ≥ max(n, sma_p+1) + 1`.
    let backward = n.max(sma_p + 1);
    if candles.len() < backward + 1 {
        return None;
    }
    let signal_idx = candles.len() - 2;
    let signal_bar = &candles[signal_idx];
    if !signal_bar.close.is_finite() {
        return None;
    }

    // Window slice: [signal_idx - n + 1 ..= signal_idx] (n bars, ends at the
    // last fully-closed bar). EXCLUSIVE of the entry bar.
    let window = &candles[signal_idx + 1 - n..=signal_idx];
    let first_window_close = window[0].close;
    if !first_window_close.is_finite() || first_window_close <= 0.0 {
        return None;
    }

    // Aggregate sum_delta + sum_volume. Hard-fail on any missing taker-flow
    // bar (return None) — guards against silent half-data windows where
    // some feeds patched in TBV-None placeholders.
    let mut sum_delta = 0.0_f64;
    let mut sum_volume = 0.0_f64;
    let mut all_positive = true;
    let mut all_negative = true;
    for c in window.iter() {
        let d = per_bar_delta(c)?;
        if !d.is_finite() {
            return None;
        }
        sum_delta += d;
        sum_volume += c.volume;
        if d <= 0.0 {
            all_positive = false;
        }
        if d >= 0.0 {
            all_negative = false;
        }
    }
    if sum_volume <= 0.0 || !sum_volume.is_finite() {
        return None;
    }
    if sum_volume < params.min_total_volume {
        return None;
    }
    let ratio = sum_delta / sum_volume;
    if !ratio.is_finite() {
        return None;
    }

    // Direction candidate from ratio gate. With `require_all_same_sign` we
    // additionally require every per-bar delta to match.
    let direction = if ratio >= params.delta_threshold {
        if params.require_all_same_sign && !all_positive {
            return None;
        }
        PositionSide::Long
    } else if ratio <= -params.delta_threshold {
        if params.require_all_same_sign && !all_negative {
            return None;
        }
        PositionSide::Short
    } else {
        return None;
    };

    // SMA confirmation: window is STRICTLY BEFORE signal_idx
    // ([signal_idx-sma_p .. signal_idx)) so the SMA does not include the
    // signal bar itself. Long needs close>SMA, short close<SMA.
    let sma_slice = &candles[signal_idx - sma_p..signal_idx];
    let sma_sum: f64 = sma_slice.iter().map(|c| c.close).sum();
    if !sma_sum.is_finite() {
        return None;
    }
    let sma_val = sma_sum / sma_p as f64;
    if !sma_val.is_finite() {
        return None;
    }
    match direction {
        PositionSide::Long => {
            if signal_bar.close <= sma_val {
                return None;
            }
        }
        PositionSide::Short => {
            if signal_bar.close >= sma_val {
                return None;
            }
        }
    }

    // Net-return secondary gate. Catches "spoofed direction" cases where
    // taker-flow says Long but the price actually fell over the window —
    // a textbook anti-OFI tell.
    let net_return = (signal_bar.close - first_window_close) / first_window_close;
    if !net_return.is_finite() {
        return None;
    }
    match direction {
        PositionSide::Long => {
            if net_return <= 0.0 {
                return None;
            }
        }
        PositionSide::Short => {
            if net_return >= 0.0 {
                return None;
            }
        }
    }

    Some(direction)
}

fn cooldown_key(symbol: &str, dir: PositionSide) -> String {
    let side = match dir {
        PositionSide::Long => "Long",
        PositionSide::Short => "Short",
    };
    format!("OFI|{}|{}", symbol, side)
}

/// Standalone entry-detector. Emits a `PollSignal` on the entry bar
/// (`candles[len-1]`) when `compute_ofi_vote` votes a direction AND the
/// per-asset/direction cooldown has elapsed AND post-cap eff_risk > 0.
///
/// State mutations:
///   - Installs `state.loss_streak_by_asset_dir["OFI|{sym}|{dir}"]` cooldown
///     ONLY on successful emit (eff_risk > 0). Mirrors the post-R67 fix in
///     `signals_meanrev::detect_mean_reversion` that moved cooldown-install
///     below the eff_risk gate to avoid silent blocked-on-zero-risk loops.
pub fn detect_ofi_persistent(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &OfiPersistentParams,
) -> Option<PollSignal> {
    let direction = compute_ofi_vote(candles, params, cfg)?;
    if candles.is_empty() {
        return None;
    }
    let i = candles.len() - 1;
    let entry_bar = candles[i];

    // Cooldown gate. We piggy-back on loss_streak_by_asset_dir (same shape as
    // MR cooldown) keyed by an "OFI|" prefix to keep namespaces disjoint.
    let key = cooldown_key(&asset.symbol, direction);
    if let Some(ls) = state.loss_streak_by_asset_dir.get(&key) {
        if state.bars_seen < ls.cd_until_bars_seen {
            return None;
        }
    }

    // Reuse finalise_signal for the sizing+caps+entry-price+stop/TP shape.
    // size_mult flows through a cloned AssetConfig.risk_frac so we don't
    // need to fork finalise_signal's signature.
    let mut sized_asset = asset.clone();
    sized_asset.risk_frac = asset.risk_frac * params.size_mult;
    let s = finalise_signal(state, cfg, &sized_asset, source_symbol, &entry_bar, direction)?;

    // Successful emit → install cooldown (after the eff_risk gate inside
    // finalise_signal so a dropped signal does NOT block the next bar).
    state.loss_streak_by_asset_dir.insert(
        key,
        crate::state::LossStreakEntry {
            streak: 0,
            cd_until_bars_seen: state.bars_seen + params.cooldown_bars,
        },
    );
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AssetConfig;

    fn cfg_30m() -> EngineConfig {
        EngineConfig::r28_v6_passlock_template() // bar_minutes = 30
    }

    fn cfg_5m() -> EngineConfig {
        let mut c = cfg_30m();
        c.bar_minutes = 5;
        c
    }

    fn asset() -> AssetConfig {
        AssetConfig {
            symbol: "BTC-TREND".into(),
            source_symbol: Some("BTCUSDT".into()),
            risk_frac: 0.4,
            ..Default::default()
        }
    }

    /// Build a candle with explicit close + volume + taker_buy_volume. open/
    /// high/low default to close so OFI logic isn't disturbed by spurious
    /// wicks; the OFI detector ignores OHL anyway.
    fn cv(t: i64, close: f64, vol: f64, tbv: f64) -> Candle {
        Candle {
            open_time: t,
            open: close,
            high: close,
            low: close,
            close,
            volume: vol,
            close_time: t + 1_799_999,
            is_final: true,
            taker_buy_volume: Some(tbv),
        }
    }

    fn cv_none_tbv(t: i64, close: f64, vol: f64) -> Candle {
        Candle {
            open_time: t,
            open: close,
            high: close,
            low: close,
            close,
            volume: vol,
            close_time: t + 1_799_999,
            is_final: true,
            taker_buy_volume: None,
        }
    }

    fn default_params() -> OfiPersistentParams {
        OfiPersistentParams::default_30m_crypto()
    }

    /// Long fires when persistent bullish delta + price > SMA + positive net
    /// return. Build 30 bars: first 24 at price 100 with neutral 50/50 TBV,
    /// then 5 window bars (signal_idx ∈ [25..29]) all at progressively higher
    /// prices with 80% TBV ratio, then entry bar (idx 30).
    #[test]
    fn ofi_long_fires_when_persistent_bullish_delta_and_price_above_sma() {
        let mut s = EngineState::initial("x");
        let cfg = cfg_30m();
        let a = asset();
        let mut candles = Vec::new();
        // 25 baseline neutral bars at price 100, volume 100, TBV=50.
        for k in 0..25 {
            candles.push(cv(k * 1_800_000, 100.0, 100.0, 50.0));
        }
        // Window of 5 bars all rising + 80% TBV (ratio = 0.6, well over 0.2).
        for k in 0..5 {
            let t = (25 + k) * 1_800_000;
            candles.push(cv(t, 101.0 + k as f64, 100.0, 80.0));
        }
        // Entry bar (idx 30).
        candles.push(cv(30 * 1_800_000, 106.0, 100.0, 50.0));

        let p = default_params();
        let sig = detect_ofi_persistent(&mut s, &cfg, &a, "BTCUSDT", &candles, &p)
            .expect("OFI Long should fire");
        assert_eq!(sig.direction, PositionSide::Long);
    }

    /// Mixed-sign window must abstain when require_all_same_sign=true even
    /// if aggregate ratio passes the threshold. Construct: 4 bullish bars
    /// (80% TBV) + 1 bearish bar (20% TBV) → aggregate ratio still ≥ 0.2,
    /// but per-bar sign rule rejects.
    #[test]
    fn ofi_does_not_fire_when_window_has_mixed_signs() {
        let mut s = EngineState::initial("x");
        let cfg = cfg_30m();
        let a = asset();
        let mut candles = Vec::new();
        for k in 0..25 {
            candles.push(cv(k * 1_800_000, 100.0, 100.0, 50.0));
        }
        // Mixed window: 4 strong-bull + 1 strong-bear bar.
        candles.push(cv(25 * 1_800_000, 101.0, 100.0, 90.0));
        candles.push(cv(26 * 1_800_000, 102.0, 100.0, 90.0));
        candles.push(cv(27 * 1_800_000, 103.0, 100.0, 10.0)); // bearish bar
        candles.push(cv(28 * 1_800_000, 104.0, 100.0, 90.0));
        candles.push(cv(29 * 1_800_000, 105.0, 100.0, 90.0));
        candles.push(cv(30 * 1_800_000, 106.0, 100.0, 50.0)); // entry

        let p = OfiPersistentParams {
            require_all_same_sign: true,
            ..default_params()
        };
        let sig = detect_ofi_persistent(&mut s, &cfg, &a, "BTCUSDT", &candles, &p);
        assert!(sig.is_none(), "mixed-sign window must abstain (rule on)");

        // Sanity: with the rule OFF, aggregate ratio alone should pass and
        // emit a Long (4×0.8 + 1×−0.8) / 5 = 0.48 > 0.20.
        let p_off = OfiPersistentParams {
            require_all_same_sign: false,
            ..default_params()
        };
        let mut s2 = EngineState::initial("x");
        let sig2 = detect_ofi_persistent(&mut s2, &cfg, &a, "BTCUSDT", &candles, &p_off)
            .expect("with rule off, aggregate ratio carries the signal");
        assert_eq!(sig2.direction, PositionSide::Long);
    }

    /// Cooldown gate: after first successful emit, identical fixture must
    /// abstain until cooldown elapses.
    #[test]
    fn ofi_respects_cooldown_after_emit() {
        let mut s = EngineState::initial("x");
        let cfg = cfg_30m();
        let a = asset();
        let mut candles = Vec::new();
        for k in 0..25 {
            candles.push(cv(k * 1_800_000, 100.0, 100.0, 50.0));
        }
        for k in 0..5 {
            let t = (25 + k) * 1_800_000;
            candles.push(cv(t, 101.0 + k as f64, 100.0, 80.0));
        }
        candles.push(cv(30 * 1_800_000, 106.0, 100.0, 50.0));

        let p = default_params();
        let _ = detect_ofi_persistent(&mut s, &cfg, &a, "BTCUSDT", &candles, &p)
            .expect("first call must fire");
        // Immediate re-call (no bars_seen advance) — cooldown gates it.
        let sig2 = detect_ofi_persistent(&mut s, &cfg, &a, "BTCUSDT", &candles, &p);
        assert!(sig2.is_none(), "cooldown must suppress repeat emit");

        // Advance past cooldown — must fire again.
        s.bars_seen += p.cooldown_bars + 1;
        let sig3 = detect_ofi_persistent(&mut s, &cfg, &a, "BTCUSDT", &candles, &p);
        assert!(sig3.is_some(), "after cooldown elapses, fires again");
    }

    /// Missing taker_buy_volume on ANY window bar = hard fail (no imputation).
    #[test]
    fn ofi_skips_bar_with_missing_tbv() {
        let mut s = EngineState::initial("x");
        let cfg = cfg_30m();
        let a = asset();
        let mut candles = Vec::new();
        for k in 0..25 {
            candles.push(cv(k * 1_800_000, 100.0, 100.0, 50.0));
        }
        // Drop TBV on bar 27 (one of the window bars).
        candles.push(cv(25 * 1_800_000, 101.0, 100.0, 80.0));
        candles.push(cv(26 * 1_800_000, 102.0, 100.0, 80.0));
        candles.push(cv_none_tbv(27 * 1_800_000, 103.0, 100.0));
        candles.push(cv(28 * 1_800_000, 104.0, 100.0, 80.0));
        candles.push(cv(29 * 1_800_000, 105.0, 100.0, 80.0));
        candles.push(cv(30 * 1_800_000, 106.0, 100.0, 50.0));

        let p = default_params();
        let sig = detect_ofi_persistent(&mut s, &cfg, &a, "BTCUSDT", &candles, &p);
        assert!(sig.is_none(), "missing TBV in window → no signal");
    }

    /// LOOKAHEAD #1 — mutating candles[i] (entry bar) taker_buy_volume must
    /// NOT change the detector's decision. Window is exclusive of the entry
    /// bar, so its TBV is never consulted.
    #[test]
    fn ofi_must_not_read_entry_bar_volume() {
        let mut candles = Vec::new();
        for k in 0..25 {
            candles.push(cv(k * 1_800_000, 100.0, 100.0, 50.0));
        }
        for k in 0..5 {
            let t = (25 + k) * 1_800_000;
            candles.push(cv(t, 101.0 + k as f64, 100.0, 80.0));
        }
        candles.push(cv(30 * 1_800_000, 106.0, 100.0, 50.0));

        let cfg = cfg_30m();
        let p = default_params();
        let before = compute_ofi_vote(&candles, &p, &cfg);
        assert_eq!(before, Some(PositionSide::Long));

        // Flip the entry-bar TBV to extreme bearish + corrupt volume.
        let last = candles.len() - 1;
        candles[last].taker_buy_volume = Some(0.0);
        candles[last].volume = 99_999.0;
        let after = compute_ofi_vote(&candles, &p, &cfg);
        assert_eq!(
            before, after,
            "LOOKAHEAD: entry-bar TBV/volume must not affect decision"
        );
    }

    /// LOOKAHEAD #2 — SMA window is STRICTLY BEFORE signal_bar. Mutating
    /// candles[i].close (entry bar) to 9999 must not change SMA-based
    /// trend-direction decision.
    #[test]
    fn sma_window_excludes_entry_bar_close() {
        let mut candles = Vec::new();
        for k in 0..25 {
            candles.push(cv(k * 1_800_000, 100.0, 100.0, 50.0));
        }
        for k in 0..5 {
            let t = (25 + k) * 1_800_000;
            candles.push(cv(t, 101.0 + k as f64, 100.0, 80.0));
        }
        candles.push(cv(30 * 1_800_000, 106.0, 100.0, 50.0));

        let cfg = cfg_30m();
        let p = default_params();
        let before = compute_ofi_vote(&candles, &p, &cfg);
        let last = candles.len() - 1;
        candles[last].close = 9999.0;
        candles[last].high = 9999.5;
        candles[last].low = 9998.5;
        let after = compute_ofi_vote(&candles, &p, &cfg);
        assert_eq!(
            before, after,
            "LOOKAHEAD: SMA must not see entry-bar close (mutation no-op)"
        );
    }

    /// LOOKAHEAD #3 — persistence (all-same-sign) check spans only the n
    /// signal-bars, not the entry bar. Mutating entry-bar TBV to flip its
    /// sign must NOT poison the persistence rule.
    #[test]
    fn persistence_check_only_n_signal_bars() {
        let mut candles = Vec::new();
        for k in 0..25 {
            candles.push(cv(k * 1_800_000, 100.0, 100.0, 50.0));
        }
        // All-bullish window.
        for k in 0..5 {
            let t = (25 + k) * 1_800_000;
            candles.push(cv(t, 101.0 + k as f64, 100.0, 80.0));
        }
        // Entry bar with EXTREME bearish flow — must not invalidate.
        candles.push(cv(30 * 1_800_000, 106.0, 100.0, 0.0));

        let cfg = cfg_30m();
        let p = OfiPersistentParams {
            require_all_same_sign: true,
            ..default_params()
        };
        let vote = compute_ofi_vote(&candles, &p, &cfg);
        assert_eq!(
            vote,
            Some(PositionSide::Long),
            "entry-bar polarity must not poison persistence"
        );
    }

    /// Data-corruption guard: taker_buy_volume > volume is impossible
    /// (subset relationship). Helper returns None on the bar; detector
    /// returns None overall.
    #[test]
    fn tbv_greater_than_volume_skips_bar() {
        let mut candles = Vec::new();
        for k in 0..25 {
            candles.push(cv(k * 1_800_000, 100.0, 100.0, 50.0));
        }
        candles.push(cv(25 * 1_800_000, 101.0, 100.0, 80.0));
        candles.push(cv(26 * 1_800_000, 102.0, 100.0, 80.0));
        // Corrupt bar: TBV (200) > volume (100).
        candles.push(cv(27 * 1_800_000, 103.0, 100.0, 200.0));
        candles.push(cv(28 * 1_800_000, 104.0, 100.0, 80.0));
        candles.push(cv(29 * 1_800_000, 105.0, 100.0, 80.0));
        candles.push(cv(30 * 1_800_000, 106.0, 100.0, 50.0));

        let cfg = cfg_30m();
        let p = default_params();
        let mut s = EngineState::initial("x");
        let sig = detect_ofi_persistent(&mut s, &cfg, &asset(), "BTCUSDT", &candles, &p);
        assert!(sig.is_none(), "corrupt TBV>volume bar must produce no signal");
    }

    /// Spoofed direction: all bars have 80% TBV (ratio strongly Long), but
    /// the actual price closes BELOW the first window close → net_return
    /// negative → reject Long even though aggressor-flow says yes.
    #[test]
    fn net_return_filter_blocks_spoofed_direction() {
        let mut candles = Vec::new();
        for k in 0..25 {
            // Strong uptrend baseline so SMA is well below later price.
            candles.push(cv(k * 1_800_000, 90.0 + k as f64, 100.0, 50.0));
        }
        // Window: prices FALL from 115 → 111 (net_return < 0) even though
        // TBV stays at 80% throughout (would otherwise vote Long).
        for k in 0..5 {
            let t = (25 + k) * 1_800_000;
            candles.push(cv(t, 115.0 - k as f64, 100.0, 80.0));
        }
        // Entry.
        candles.push(cv(30 * 1_800_000, 110.0, 100.0, 50.0));

        let cfg = cfg_30m();
        let p = default_params();
        let mut s = EngineState::initial("x");
        let sig = detect_ofi_persistent(&mut s, &cfg, &asset(), "BTCUSDT", &candles, &p);
        assert!(
            sig.is_none(),
            "net_return < 0 must veto a Long despite bullish OFI ratio"
        );
    }

    /// TF-scaling: a 30m param run on a 5m feed scales `window_bars × 6` and
    /// `sma_period × 6`. Verify the detector still works on 5m and the
    /// boundary is enforced (too-short slice = None, sufficient slice = OK).
    #[test]
    fn tf_scaling_5min_scales_window_correctly() {
        let cfg = cfg_5m();
        let p = default_params(); // window=5, sma=20 → scaled 30+120 on 5m
        let a = asset();

        // Build 25 baseline + 30 window-scaled + 1 entry = 175 bars (need
        // ≥ max(30, 120+1)+1 = 122 → 175 is plenty).
        let mut candles = Vec::new();
        for k in 0..145 {
            candles.push(cv(k * 300_000, 100.0, 100.0, 50.0));
        }
        // 30 rising bars with 80% TBV (5 × 6 scaled).
        for k in 0..30 {
            let t = (145 + k) * 300_000;
            candles.push(cv(t, 101.0 + k as f64 * 0.1, 100.0, 80.0));
        }
        // Entry.
        candles.push(cv(175 * 300_000, 104.5, 100.0, 50.0));

        let mut s = EngineState::initial("x");
        let sig = detect_ofi_persistent(&mut s, &cfg, &a, "BTCUSDT", &candles, &p);
        assert!(sig.is_some(), "5m TF-scaled window must still fire on uptrend");
        assert_eq!(sig.unwrap().direction, PositionSide::Long);

        // Now build a SHORTER feed below the scaled threshold — must abstain
        // safely (no panic) instead of indexing OOB.
        let mut short_candles = Vec::new();
        for k in 0..50 {
            short_candles.push(cv(k * 300_000, 100.0, 100.0, 50.0));
        }
        let cfg = cfg_5m();
        let v = compute_ofi_vote(&short_candles, &p, &cfg);
        assert!(v.is_none(), "below TF-scaled backward requirement → safe None");
    }
}
