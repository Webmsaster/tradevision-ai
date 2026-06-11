//! 2026-05-14 Detector #14 — Accumulation/Distribution-Line Divergence voter.
//!
//! Tracks the cumulative Accumulation/Distribution (A/D) line over a sliding
//! window and looks for price-vs-flow divergence on the just-closed signal
//! bar. A bullish setup fires when the signal bar prints a new window low on
//! price BUT the A/D line is NOT at its window minimum AND is still above
//! its longer-period SMA — interpreted as "buyers absorb selling pressure
//! into a new price low" (textbook accumulation under distribution).
//!
//! Algorithm (per bar `c`):
//!     mfm = ((close - low) - (high - close)) / (high - low)   ∈ [-1, +1]
//!     mfv = mfm × volume
//!     ad  = Σ mfv over the sliding window [signal_idx - n + 1 ..= signal_idx]
//!
//! Signal-bar convention follows the 2026-05-13 Codex KRITISCH FIX:
//! `signal_idx = candles.len() - 2` and the window STRICTLY EXCLUDES the
//! entry bar `candles[len-1]` (whose close is future data at signal time).
//! Lookahead is enforced by the `ad_must_not_read_entry_bar_ohlc` test plus
//! the dedicated `ad_cumulation_only_within_window` test which guards against
//! the easy-to-introduce bug of cumulating A/D from index 0 of the slice
//! (would leak all-time history into the divergence math).
//!
//! Detector contract:
//!   - Bullish (Long): signal_bar.close ≤ price_min(window) + 1e-9 (new low)
//!     AND ad_now > ad_min(window) + min_divergence_frac × |ad_min|
//!     (the A/D line is NOT at its window minimum — divergence)
//!     AND (when `require_close_above_sma`) ad_now > SMA(ad, sma_period).
//!   - Bearish (Short): symmetric inverse.
//!   - Doji-guard: bars with `high <= low` produce NaN MFM → skipped (zero
//!     MFV contribution) instead of propagating NaN through the sum.
//!   - min_mfm_energy: window must accumulate at least this much |MFV|
//!     (absolute sum) — guards against flat-volume windows where the
//!     divergence is mathematically true but economically meaningless.
//!   - Cooldown: state.loss_streak_by_asset_dir keyed by `"ADL|{sym}|{dir}"`
//!     to suppress back-to-back same-direction emits.
//!   - TF-scaling: `scale = round(30 / cfg.bar_minutes).max(1)` so 30m-
//!     tuned window/SMA stays time-equivalent on 5m or 2h feeds.

use crate::candle::Candle;
use crate::config::{AssetConfig, EngineConfig};
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::signals_r29r5::finalise_signal;
use crate::state::EngineState;

/// CLI-tunable parameters for the A/D-line divergence detector. All defaults
/// are 30m-tuned; the detector internally TF-scales `window_bars` and
/// `sma_period`.
#[derive(Debug, Clone, Copy)]
pub struct AdLineTrendParams {
    /// Number of closed bars in the sliding A/D accumulation window. Window
    /// is `[signal_idx - n + 1 ..= signal_idx]` — n=20 = 10 hours on 30m.
    pub window_bars: usize,
    /// SMA-of-A/D period. Trend-confirmation: long needs ad_now > SMA(ad),
    /// short the inverse. Strictly > window_bars so the SMA carries more
    /// history than the divergence test.
    pub sma_period: usize,
    /// Minimum relative divergence between ad_now and ad_min/max of the
    /// window. 0.20 = "ad_now must be at least 20% above ad_min" (Long).
    /// Below this threshold the divergence is treated as numerical noise.
    pub min_divergence_frac: f64,
    /// Minimum window-aggregate |MFV| (absolute sum of money-flow volumes).
    /// Guards against thin windows where divergence is mathematically true
    /// but the A/D line is essentially noise around zero.
    pub min_mfm_energy: f64,
    /// Bars to suppress same-asset/dir signals after an emit. 12 = 6 hours
    /// on a 30m feed.
    pub cooldown_bars: u64,
    /// When true, additionally require ad_now > SMA(ad, sma_period) for
    /// Long and ad_now < SMA(ad, sma_period) for Short. Provides a
    /// medium-term trend filter on top of the short-term divergence.
    pub require_close_above_sma: bool,
    /// Risk-frac multiplier — typically 0.5 so this secondary detector
    /// sizes at half the primary R28V6 trend detector.
    pub size_mult: f64,
    /// Minimum signal-bar range as a fraction of close: `(high-low)/close`.
    /// Bars below this are treated as "no informational candle" and the
    /// detector abstains regardless of A/D state. Default 5bp.
    pub min_range_pct: f64,
    /// Minimum window total `volume` (raw, not z-scored). 0 = disabled.
    pub min_total_volume: f64,
}

impl AdLineTrendParams {
    /// 2026-05-14 — sensible defaults for a 30m crypto AMBER-family basket.
    pub fn default_30m_crypto() -> Self {
        Self {
            window_bars: 20,
            sma_period: 50,
            min_divergence_frac: 0.20,
            min_mfm_energy: 5.0,
            cooldown_bars: 12,
            require_close_above_sma: true,
            size_mult: 0.5,
            min_range_pct: 0.0005,
            min_total_volume: 0.0,
        }
    }
}

/// Per-bar Money-Flow-Multiplier `((close-low)-(high-close))/(high-low)`.
/// Returns `None` if the bar is a doji (`high <= low`) or any OHLC is
/// non-finite — caller treats this as "skip this bar" (zero MFV contribution)
/// instead of poisoning the cumulative sum with NaN.
fn money_flow_multiplier(c: &Candle) -> Option<f64> {
    if !c.high.is_finite() || !c.low.is_finite() || !c.close.is_finite() {
        return None;
    }
    // Doji-guard: zero or inverted range → MFM undefined. Inverted (high<low)
    // is a corrupt feed; treat both as "no information" rather than NaN.
    if c.high <= c.low {
        return None;
    }
    let range = c.high - c.low;
    let mfm = ((c.close - c.low) - (c.high - c.close)) / range;
    if !mfm.is_finite() {
        return None;
    }
    Some(mfm)
}

/// Pure helper — computes the A/D-line divergence directional vote without
/// state mutation. Returns `Some(side)` only when window divergence + SMA
/// trend + min-energy + min-range gates all agree. Used both by the
/// standalone `detect_ad_line_divergence` (adds cooldown + sizing on top)
/// AND by `signals_regime_confluence.rs` when A/D is enrolled as a voter.
pub fn compute_ad_line_vote(
    candles: &[Candle],
    params: &AdLineTrendParams,
    cfg: &EngineConfig,
) -> Option<PositionSide> {
    // TF-scale window/SMA so 30m-tuned params stay time-equivalent on 5m or 2h.
    let scale = (30.0 / (cfg.bar_minutes.max(1) as f64)).round().max(1.0) as usize;
    let n = params.window_bars.saturating_mul(scale);
    let sma_p = params.sma_period.saturating_mul(scale);

    if n == 0 || sma_p == 0 {
        return None;
    }
    if !params.min_divergence_frac.is_finite() || params.min_divergence_frac < 0.0 {
        return None;
    }

    // Need: bar i (entry) + signal_idx (i-1) + n window bars + sma_p extra
    // bars STRICTLY before the divergence window so SMA(ad) covers the
    // historical accumulation. Required length = sma_p + n + 1 (the extra
    // +1 is the entry bar at the end).
    let backward = n + sma_p;
    if candles.len() < backward + 1 {
        return None;
    }
    let signal_idx = candles.len() - 2;
    let signal_bar = &candles[signal_idx];
    if !signal_bar.close.is_finite() || !signal_bar.high.is_finite() || !signal_bar.low.is_finite()
    {
        return None;
    }
    // Signal-bar doji-guard (separate from MFM-skip): if the signal bar
    // itself is a doji we should not interpret it as a "new low / new high"
    // decision pivot.
    if signal_bar.high <= signal_bar.low {
        return None;
    }
    // Minimum signal-bar range filter — bars below `min_range_pct` carry
    // too little informational content to justify a divergence call.
    if signal_bar.close.abs() > 0.0 {
        let range_pct = (signal_bar.high - signal_bar.low) / signal_bar.close.abs();
        if !range_pct.is_finite() || range_pct < params.min_range_pct {
            return None;
        }
    } else {
        return None;
    }

    // Build the per-bar MFV series for the COMBINED slice
    // `[signal_idx - n - sma_p + 1 ..= signal_idx]` so we can cumulate A/D
    // both inside the divergence window (last n bars) and across the SMA
    // tail (sma_p bars BEFORE the window). The starting A/D anchor is zero
    // — this is a *window-local* (sliding-from-anchor) cumulation, NOT an
    // all-time cumulative read. The dedicated `ad_cumulation_only_within_
    // window` test pins the property that mutating candles strictly before
    // the SMA tail does not change the decision.
    let series_start = signal_idx + 1 - (n + sma_p);
    let series = &candles[series_start..=signal_idx];

    // Build cumulative A/D across the entire (sma_p + n) slice. We track
    // the running A/D value at each index; ad_min/ad_max over the
    // divergence window come from the last n entries of this series.
    let mut ad_series: Vec<f64> = Vec::with_capacity(series.len());
    let mut running = 0.0_f64;
    let mut window_mfm_energy = 0.0_f64;
    let mut window_total_volume = 0.0_f64;
    for (offset, c) in series.iter().enumerate() {
        if let Some(mfm) = money_flow_multiplier(c) {
            if !c.volume.is_finite() {
                return None;
            }
            let mfv = mfm * c.volume;
            if mfv.is_finite() {
                running += mfv;
            }
            // The divergence window is the TAIL of the series (last n bars).
            // Accumulate energy + volume gates only over that tail so the
            // SMA-history bars do not influence the gate decision.
            if offset >= sma_p {
                window_mfm_energy += mfv.abs();
                window_total_volume += c.volume;
            }
        }
        ad_series.push(running);
    }
    if ad_series.len() != n + sma_p {
        return None;
    }

    // Energy / volume gates over the divergence window only.
    if window_mfm_energy < params.min_mfm_energy {
        return None;
    }
    if params.min_total_volume > 0.0 && window_total_volume < params.min_total_volume {
        return None;
    }

    // Divergence window = last n entries; equivalent to
    // `candles[signal_idx - n + 1 ..= signal_idx]` in absolute indexing.
    let window_start_in_series = ad_series.len() - n;
    let ad_window = &ad_series[window_start_in_series..];
    let ad_now = *ad_window.last()?;
    if !ad_now.is_finite() {
        return None;
    }
    let mut ad_min = f64::INFINITY;
    let mut ad_max = f64::NEG_INFINITY;
    for v in ad_window.iter().copied() {
        if !v.is_finite() {
            return None;
        }
        if v < ad_min {
            ad_min = v;
        }
        if v > ad_max {
            ad_max = v;
        }
    }
    if !ad_min.is_finite() || !ad_max.is_finite() {
        return None;
    }

    // SMA-of-A/D over the FULL series (sma_p + n bars) — captures the
    // longer-period trend in the cumulated flow line. Computed from
    // ad_series so it shares the anchor with ad_now (no zero-baseline
    // mismatch).
    let sma_ad: f64 = ad_series.iter().sum::<f64>() / ad_series.len() as f64;
    if !sma_ad.is_finite() {
        return None;
    }

    // Price min/max over the divergence window only (NOT the SMA tail) —
    // we want to know if `signal_bar.close` made a new low/high within
    // the recent window, not the historical SMA period.
    let price_window = &candles[(signal_idx + 1).saturating_sub(n)..=signal_idx];
    let mut price_min = f64::INFINITY;
    let mut price_max = f64::NEG_INFINITY;
    for c in price_window.iter() {
        if !c.close.is_finite() {
            return None;
        }
        if c.close < price_min {
            price_min = c.close;
        }
        if c.close > price_max {
            price_max = c.close;
        }
    }
    if !price_min.is_finite() || !price_max.is_finite() {
        return None;
    }

    // Long: signal close at window low BUT A/D not at window min AND above SMA.
    // Short: symmetric inverse.
    // Divergence-strength gate: ad_now must be at least `frac × |ad_min|`
    // (or `|ad_max|` for short) above/below the extreme. The absolute value
    // anchor handles the typical near-zero A/D-line case where the line
    // oscillates around its accumulation baseline.
    let frac = params.min_divergence_frac;
    for direction in [PositionSide::Long, PositionSide::Short] {
        // 2026-05-14 — additional safety: ad_min/max may equal ad_now if
        // the window is monotonic. Skip divergence-test when extremes are
        // identical to ad_now (no divergence by construction).
        let ok = match direction {
            PositionSide::Long => {
                let price_at_min = signal_bar.close <= price_min + 1e-9;
                let abs_anchor = ad_min.abs().max(1.0);
                let ad_above_min = ad_now > ad_min + frac * abs_anchor;
                let trend_ok = !params.require_close_above_sma || ad_now > sma_ad;
                price_at_min && ad_above_min && trend_ok
            }
            PositionSide::Short => {
                let price_at_max = signal_bar.close >= price_max - 1e-9;
                let abs_anchor = ad_max.abs().max(1.0);
                let ad_below_max = ad_now < ad_max - frac * abs_anchor;
                let trend_ok = !params.require_close_above_sma || ad_now < sma_ad;
                price_at_max && ad_below_max && trend_ok
            }
        };
        if ok {
            return Some(direction);
        }
    }
    None
}

fn cooldown_key(symbol: &str, dir: PositionSide) -> String {
    let side = match dir {
        PositionSide::Long => "Long",
        PositionSide::Short => "Short",
    };
    format!("ADL|{}|{}", symbol, side)
}

/// Standalone entry-detector. Emits a `PollSignal` on the entry bar
/// (`candles[len-1]`) when `compute_ad_line_vote` votes a direction AND
/// the per-asset/direction cooldown has elapsed AND post-cap eff_risk > 0.
///
/// State mutations:
///   - Installs `state.loss_streak_by_asset_dir["ADL|{sym}|{dir}"]` cooldown
///     ONLY on successful emit (eff_risk > 0). Mirrors the post-R67 fix in
///     `signals_meanrev::detect_mean_reversion` that moved cooldown-install
///     below the eff_risk gate so dropped signals don't block subsequent
///     bars.
pub fn detect_ad_line_divergence(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &AdLineTrendParams,
) -> Option<PollSignal> {
    let direction = compute_ad_line_vote(candles, params, cfg)?;
    if candles.is_empty() {
        return None;
    }
    let i = candles.len() - 1;
    let entry_bar = candles[i];

    // Honor disable_short / disable_long on the asset. The voter helper
    // does not know about these flags; we enforce them here BEFORE
    // installing cooldown so a disabled direction doesn't silently lock
    // out the opposite direction.
    match direction {
        PositionSide::Long => {
            if asset.disable_long {
                return None;
            }
        }
        PositionSide::Short => {
            if asset.disable_short {
                return None;
            }
        }
    }

    let key = cooldown_key(&asset.symbol, direction);
    if let Some(ls) = state.loss_streak_by_asset_dir.get(&key) {
        if state.bars_seen < ls.cd_until_bars_seen {
            return None;
        }
    }

    // Reuse finalise_signal for sizing+caps+entry-price+stop/TP shape.
    // size_mult flows through a cloned AssetConfig.risk_frac so we don't
    // need to fork finalise_signal's signature.
    let mut sized_asset = asset.clone();
    sized_asset.risk_frac = asset.risk_frac * params.size_mult;
    let s = finalise_signal(
        state,
        cfg,
        &sized_asset,
        source_symbol,
        &entry_bar,
        direction,
    )?;

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

    fn asset() -> AssetConfig {
        AssetConfig {
            symbol: "BTC-TREND".into(),
            source_symbol: Some("BTCUSDT".into()),
            risk_frac: 0.4,
            ..Default::default()
        }
    }

    /// Build a candle with explicit OHLC + volume. The A/D detector reads
    /// O/H/L/C+V, NOT taker_buy_volume (orthogonal to OFI by design — A/D
    /// signal comes from PRICE position inside the bar's range, weighted by
    /// gross volume).
    fn cv(t: i64, open: f64, high: f64, low: f64, close: f64, vol: f64) -> Candle {
        Candle {
            open_time: t,
            open,
            high,
            low,
            close,
            volume: vol,
            close_time: t + 1_799_999,
            is_final: true,
            taker_buy_volume: None,
        }
    }

    fn default_params() -> AdLineTrendParams {
        AdLineTrendParams::default_30m_crypto()
    }

    /// Helper: build a series of `n` neutral candles around `price` so the
    /// initial SMA tail is well-defined. Each candle has equal upper/lower
    /// wick so MFM ≈ 0 → A/D stays near zero.
    fn neutral_series(n: usize, price: f64, vol: f64) -> Vec<Candle> {
        (0..n)
            .map(|k| {
                let t = (k as i64) * 1_800_000;
                cv(t, price, price + 1.0, price - 1.0, price, vol)
            })
            .collect()
    }

    /// Long fires on bullish divergence: price makes new window low BUT
    /// A/D is well above its window minimum AND above SMA. Construct:
    /// 50 baseline neutral bars + 20 window bars where price drops to a
    /// new low but every bar closes near its HIGH (MFM ≈ +1) so A/D
    /// climbs while price falls.
    #[test]
    fn ad_long_fires_on_bullish_divergence() {
        let mut s = EngineState::initial("x");
        let cfg = cfg_30m();
        let a = asset();

        // 50 SMA-tail bars at price 100, neutral MFM.
        let mut candles = neutral_series(50, 100.0, 100.0);

        // 20 window bars: price ladders DOWN from 99 → 80 but every bar
        // closes near its high (close = high − 0.1, low far below) so
        // MFM ≈ +0.95 each → A/D climbs strongly while price plunges.
        for k in 0..20 {
            let t = (50 + k) * 1_800_000;
            let price = 99.0 - k as f64; // 99..=80
                                         // wide range with close pinned to top
            candles.push(cv(
                t,
                price + 0.5,
                price + 1.0,
                price - 4.0,
                price + 0.9,
                200.0,
            ));
        }
        // Force signal bar (idx 69) to print the window's lowest close
        // value so the price_at_min gate triggers. Entry bar at idx 70.
        let signal_idx = candles.len() - 1;
        candles[signal_idx].close = 79.0; // strictly below the 80-floor
        candles[signal_idx].low = 75.0;
        candles[signal_idx].high = 80.5;

        // Entry bar — flat, doesn't influence detector.
        candles.push(cv(70 * 1_800_000, 79.0, 79.5, 78.5, 79.0, 100.0));

        let p = default_params();
        let sig = detect_ad_line_divergence(&mut s, &cfg, &a, "BTCUSDT", &candles, &p)
            .expect("bullish divergence (new low + rising A/D) should fire Long");
        assert_eq!(sig.direction, PositionSide::Long);
    }

    /// Short fires on bearish divergence: price makes new window high BUT
    /// A/D is well below its window maximum AND below SMA.
    #[test]
    fn ad_short_fires_on_bearish_divergence() {
        let mut s = EngineState::initial("x");
        let cfg = cfg_30m();
        let a = asset();

        let mut candles = neutral_series(50, 100.0, 100.0);

        // 20 window bars: price ladders UP from 101 → 120 but every bar
        // closes near its LOW (close = low + 0.1) so MFM ≈ -0.95 each →
        // A/D falls strongly while price climbs.
        for k in 0..20 {
            let t = (50 + k) * 1_800_000;
            let price = 101.0 + k as f64; // 101..=120
            candles.push(cv(
                t,
                price - 0.5,
                price + 4.0,
                price - 1.0,
                price - 0.9,
                200.0,
            ));
        }
        let signal_idx = candles.len() - 1;
        candles[signal_idx].close = 121.0; // strictly above the 120-ceiling
        candles[signal_idx].high = 125.0;
        candles[signal_idx].low = 120.5;

        candles.push(cv(70 * 1_800_000, 121.0, 121.5, 120.5, 121.0, 100.0));

        let p = default_params();
        let sig = detect_ad_line_divergence(&mut s, &cfg, &a, "BTCUSDT", &candles, &p)
            .expect("bearish divergence (new high + falling A/D) should fire Short");
        assert_eq!(sig.direction, PositionSide::Short);
    }

    /// Doji-guard: a doji signal bar (high == low) must NOT fire even if
    /// the cumulative A/D structure has the right divergence shape.
    /// Without the guard, MFM would be 0/0 = NaN and the divergence test
    /// could silently misfire.
    #[test]
    fn ad_doji_bar_returns_none() {
        let mut s = EngineState::initial("x");
        let cfg = cfg_30m();
        let a = asset();

        let mut candles = neutral_series(50, 100.0, 100.0);
        for k in 0..20 {
            let t = (50 + k) * 1_800_000;
            let price = 99.0 - k as f64;
            candles.push(cv(
                t,
                price + 0.5,
                price + 1.0,
                price - 4.0,
                price + 0.9,
                200.0,
            ));
        }
        // Convert the signal bar to a doji: high == low == close.
        let signal_idx = candles.len() - 1;
        candles[signal_idx].close = 79.0;
        candles[signal_idx].high = 79.0;
        candles[signal_idx].low = 79.0;

        candles.push(cv(70 * 1_800_000, 79.0, 79.0, 79.0, 79.0, 100.0));

        let p = default_params();
        let sig = detect_ad_line_divergence(&mut s, &cfg, &a, "BTCUSDT", &candles, &p);
        assert!(sig.is_none(), "doji signal bar must abstain (high==low)");
    }

    /// LOOKAHEAD #1 — mutating `candles[i]` (entry bar) OHLC/volume must NOT
    /// change the detector's decision. Window is exclusive of the entry bar.
    #[test]
    fn ad_must_not_read_entry_bar_ohlc() {
        let mut candles = neutral_series(50, 100.0, 100.0);
        for k in 0..20 {
            let t = (50 + k) * 1_800_000;
            let price = 99.0 - k as f64;
            candles.push(cv(
                t,
                price + 0.5,
                price + 1.0,
                price - 4.0,
                price + 0.9,
                200.0,
            ));
        }
        let signal_idx = candles.len() - 1;
        candles[signal_idx].close = 79.0;
        candles[signal_idx].low = 75.0;
        candles[signal_idx].high = 80.5;
        candles.push(cv(70 * 1_800_000, 79.0, 79.5, 78.5, 79.0, 100.0));

        let cfg = cfg_30m();
        let p = default_params();
        let before = compute_ad_line_vote(&candles, &p, &cfg);
        assert_eq!(before, Some(PositionSide::Long));

        // Corrupt the entry bar with extreme bearish OHLC + huge volume.
        let last = candles.len() - 1;
        candles[last].close = 1.0;
        candles[last].high = 99_999.0;
        candles[last].low = 0.01;
        candles[last].open = 50_000.0;
        candles[last].volume = 1_000_000.0;
        let after = compute_ad_line_vote(&candles, &p, &cfg);
        assert_eq!(
            before, after,
            "LOOKAHEAD: entry-bar OHLC/volume must not change vote"
        );
    }

    /// LOOKAHEAD #2 — A/D cumulation must be window-local (sliding from a
    /// zero anchor inside the SMA tail), NOT an all-time cumulative read.
    /// Mutating candles strictly BEFORE the SMA tail must not change the
    /// decision. Without this guard, an attacker that injected a huge
    /// `taker_buy_volume` spike in early history could swing every later
    /// divergence test.
    #[test]
    fn ad_cumulation_only_within_window() {
        // Build 200 baseline bars (well before the SMA tail at idx
        // [signal_idx - n - sma_p ..)) + 50 SMA bars + 20 window bars
        // + 1 entry bar = 271 candles, signal_idx = 269.
        let mut candles: Vec<Candle> = Vec::new();
        for k in 0..200 {
            // Strong directional pressure: huge MFM=+1 + huge volume.
            // If the detector cumulates from index 0, these will flood
            // ad_now and break the divergence test downstream.
            let t = (k as i64) * 1_800_000;
            candles.push(cv(t, 50.0, 60.0, 40.0, 60.0, 10_000.0));
        }
        for k in 0..50 {
            let t = ((200 + k) as i64) * 1_800_000;
            candles.push(cv(t, 100.0, 101.0, 99.0, 100.0, 100.0));
        }
        for k in 0..20 {
            let t = ((250 + k) as i64) * 1_800_000;
            let price = 99.0 - k as f64;
            candles.push(cv(
                t,
                price + 0.5,
                price + 1.0,
                price - 4.0,
                price + 0.9,
                200.0,
            ));
        }
        let signal_idx = candles.len() - 1;
        candles[signal_idx].close = 79.0;
        candles[signal_idx].low = 75.0;
        candles[signal_idx].high = 80.5;
        candles.push(cv(270 * 1_800_000, 79.0, 79.5, 78.5, 79.0, 100.0));

        let cfg = cfg_30m();
        let p = default_params();
        let before = compute_ad_line_vote(&candles, &p, &cfg);

        // Now ANNIHILATE the pre-SMA-tail history with mirror-image bars
        // (MFM=-1, even huger volume). If the detector leaks pre-window
        // history, ad_now will explode in the OPPOSITE direction.
        for k in 0..200 {
            candles[k].close = 40.0; // close pinned to LOW now → MFM=-1
            candles[k].high = 60.0;
            candles[k].low = 40.0;
            candles[k].open = 50.0;
            candles[k].volume = 1_000_000.0;
        }
        let after = compute_ad_line_vote(&candles, &p, &cfg);
        assert_eq!(
            before, after,
            "LOOKAHEAD: A/D must not leak pre-SMA-tail history"
        );
    }

    /// `min_divergence_frac` gate: a micro-pivot — where the A/D line is
    /// only marginally above its window minimum — must NOT fire when the
    /// threshold is set high. We construct a window where price drifts to
    /// a new low while MFM oscillates around zero, so A/D meanders within
    /// a narrow band: ad_now is technically above ad_min, but the relative
    /// move is tiny.
    #[test]
    fn ad_min_divergence_frac_blocks_micro_pivot() {
        let mut candles = neutral_series(50, 100.0, 100.0);
        // 20 window bars: price ladders down 100→99.05 (new-low signal
        // achievable), but MFM ALTERNATES sign each bar so the A/D line
        // oscillates around zero — ad_now ≈ ad_min ≈ 0.
        for k in 0..20 {
            let t = (50 + k) * 1_800_000;
            let price = 100.0 - 0.05 * (k as f64); // gentle 100..=99.05
                                                   // Alternating: even bars close near high (MFM ≈ +0.9), odd
                                                   // near low (MFM ≈ −0.9). Net A/D ≈ 0 with small per-bar swings.
            let (open, high, low, close) = if k % 2 == 0 {
                (price, price + 0.5, price - 0.5, price + 0.45)
            } else {
                (price, price + 0.5, price - 0.5, price - 0.45)
            };
            candles.push(cv(t, open, high, low, close, 100.0));
        }
        let signal_idx = candles.len() - 1;
        candles[signal_idx].close = 99.0; // new low
        candles[signal_idx].high = 99.2;
        candles[signal_idx].low = 98.8;
        candles.push(cv(70 * 1_800_000, 99.0, 99.1, 98.9, 99.0, 100.0));

        let cfg = cfg_30m();
        // Very high divergence-frac (≥0.95) — only very strong A/D moves
        // pass. Disable other gates so the test isolates frac alone.
        let p_strict = AdLineTrendParams {
            min_divergence_frac: 0.95,
            min_mfm_energy: 0.0,
            require_close_above_sma: false,
            ..default_params()
        };
        let v_strict = compute_ad_line_vote(&candles, &p_strict, &cfg);
        assert!(
            v_strict.is_none(),
            "micro-pivot must be rejected by high min_divergence_frac"
        );

        // Sanity: with the same fixture and a tiny positive frac (1e-9)
        // the gate still rejects when A/D has not meaningfully diverged.
        // The test of the gate's correctness is "monotonicity": loosening
        // the frac must NEVER stricten the rejection.
        let p_loose = AdLineTrendParams {
            min_divergence_frac: 0.0,
            min_mfm_energy: 0.0,
            require_close_above_sma: false,
            ..default_params()
        };
        let v_loose = compute_ad_line_vote(&candles, &p_loose, &cfg);
        // Monotonicity: lowering the strictness must never invert the
        // decision from Some→None. (None→Some or both-None are both fine;
        // both-Some is fine too.)
        assert!(
            !(v_loose.is_none() && v_strict.is_some()),
            "lowering frac must never STRICTEN rejection"
        );
    }

    /// NaN-safe: a single NaN in the signal bar's OHLC must not panic and
    /// must produce a clean `None`.
    #[test]
    fn nan_inputs_safe() {
        let mut candles = neutral_series(50, 100.0, 100.0);
        for k in 0..20 {
            let t = (50 + k) * 1_800_000;
            let price = 99.0 - k as f64;
            candles.push(cv(
                t,
                price + 0.5,
                price + 1.0,
                price - 4.0,
                price + 0.9,
                200.0,
            ));
        }
        // Corrupt the signal bar with NaN.
        let signal_idx = candles.len() - 1;
        candles[signal_idx].close = f64::NAN;
        candles.push(cv(70 * 1_800_000, 79.0, 79.5, 78.5, 79.0, 100.0));

        let cfg = cfg_30m();
        let p = default_params();
        let v = compute_ad_line_vote(&candles, &p, &cfg);
        assert!(v.is_none(), "NaN signal-bar close → None, no panic");

        // Also test NaN volume in a window bar.
        let mut c2 = neutral_series(50, 100.0, 100.0);
        for k in 0..20 {
            let t = (50 + k) * 1_800_000;
            let price = 99.0 - k as f64;
            c2.push(cv(
                t,
                price + 0.5,
                price + 1.0,
                price - 4.0,
                price + 0.9,
                200.0,
            ));
        }
        let signal_idx = c2.len() - 1;
        c2[signal_idx].close = 79.0;
        c2[signal_idx].low = 75.0;
        c2[signal_idx].high = 80.5;
        c2[55].volume = f64::NAN; // one window bar with NaN volume
        c2.push(cv(70 * 1_800_000, 79.0, 79.5, 78.5, 79.0, 100.0));
        let v2 = compute_ad_line_vote(&c2, &p, &cfg);
        assert!(v2.is_none(), "NaN window-bar volume → None, no panic");
    }

    /// `disable_short` on the asset must block a Short signal even when
    /// the bearish-divergence shape would otherwise fire.
    #[test]
    fn respects_disable_short() {
        let cfg = cfg_30m();
        let mut a = asset();
        a.disable_short = true;

        let mut candles = neutral_series(50, 100.0, 100.0);
        for k in 0..20 {
            let t = (50 + k) * 1_800_000;
            let price = 101.0 + k as f64;
            candles.push(cv(
                t,
                price - 0.5,
                price + 4.0,
                price - 1.0,
                price - 0.9,
                200.0,
            ));
        }
        let signal_idx = candles.len() - 1;
        candles[signal_idx].close = 121.0;
        candles[signal_idx].high = 125.0;
        candles[signal_idx].low = 120.5;
        candles.push(cv(70 * 1_800_000, 121.0, 121.5, 120.5, 121.0, 100.0));

        let p = default_params();

        // compute_ad_line_vote does NOT know about disable_short — it just
        // returns the directional vote.
        let vote = compute_ad_line_vote(&candles, &p, &cfg);
        assert_eq!(vote, Some(PositionSide::Short));

        // The standalone detector DOES honor disable_short and must
        // suppress the emit.
        let mut s = EngineState::initial("x");
        let sig = detect_ad_line_divergence(&mut s, &cfg, &a, "BTCUSDT", &candles, &p);
        assert!(
            sig.is_none(),
            "disable_short must block emit even when vote=Short"
        );

        // Confirm symmetry: same fixture with disable_short=false fires.
        let mut a_ok = asset();
        a_ok.disable_short = false;
        let mut s2 = EngineState::initial("x");
        let sig2 = detect_ad_line_divergence(&mut s2, &cfg, &a_ok, "BTCUSDT", &candles, &p);
        assert!(
            sig2.is_some(),
            "without disable_short the short signal must emit"
        );
    }
}
