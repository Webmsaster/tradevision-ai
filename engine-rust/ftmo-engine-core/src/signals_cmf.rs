//! 2026-05-14 Detector #15 — Chaikin Money Flow (CMF) voter.
//!
//! Marc Chaikin's CMF (1980s) measures the relative pressure of accumulation
//! vs distribution across a sliding window by aggregating money-flow volume
//! (MFV) and normalising by total volume. Unlike OBV (cumulative sign of
//! daily-close direction) or A/D-Line (unbounded cumulative), CMF lives on a
//! bounded `[-1, +1]` ratio scale and resets every `period` bars — so the
//! reading is comparable across time windows and assets without baselining.
//!
//! Per-bar math:
//!     mfm = ((close - low) - (high - close)) / (high - low)   ∈ [-1, +1]
//!     mfv = mfm × volume
//!     cmf = Σ(mfv, n) / Σ(volume, n)
//!
//! A reading > +threshold = persistent accumulation → Long vote (when price
//! also confirms via an SMA trend filter to suppress entries inside late-cycle
//! distribution). Symmetric on the bear side.
//!
//! Signal-bar convention (2026-05-13 Codex KRITISCH FIX): the signal bar is
//! `candles[len-2]` (the last fully-closed bar) and the entry bar is
//! `candles[len-1]` (current execution bar whose close is future data at
//! signal time). The CMF window is therefore inclusive of the signal bar but
//! STRICTLY EXCLUSIVE of the entry bar:
//!   window = `[signal_idx + 1 - n ..= signal_idx]`
//! Lookahead is enforced by the dedicated tests:
//!   * `cmf_must_not_read_entry_bar_ohlc` (entry-bar OHLC mutation no-op)
//!   * `cmf_sma_excludes_entry_bar` (SMA reads only candles[..signal_idx])
//!   * `cmf_persistence_n_signal_bars_only` (per-bar sign-check excludes entry)
//!
//! Detector contract:
//!   * Doji-guard: bars with `high <= low` produce a degenerate MFM (div-by-
//!     zero) and are skipped entirely (zero MFV + zero contribution to volume
//!     sum) rather than propagating NaN through the aggregate. Sustained
//!     Doji windows can fall below `min_total_volume` and abstain on that
//!     gate instead.
//!   * `min_range_pct`: signal-bar `(high - low) / close` must clear this
//!     floor — guards against trading on flat-range bars where the MFM
//!     formula is numerically noisy.
//!   * `require_net_return`: secondary anti-spoof gate — Long requires
//!     `signal_close > first_window_close`, Short the inverse. Catches the
//!     "high CMF with falling price" anti-pattern (institutional offloading
//!     into retail bid-stuffing).
//!   * SMA-trend confirmation: window `[signal_idx - sma_p ..signal_idx]`
//!     (STRICTLY before signal bar). Long needs close > SMA, Short needs
//!     close < SMA.
//!   * Cooldown via `state.loss_streak_by_asset_dir["CMF|{sym}|{dir}"]`,
//!     namespaced to keep disjoint from OFI/MR cooldowns.
//!   * TF-scaling: `scale = round(30 / cfg.bar_minutes).max(1)` so 30m-tuned
//!     defaults stay time-equivalent on 5m / 2h feeds.

use crate::candle::Candle;
use crate::config::{AssetConfig, EngineConfig};
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::signals_r29r5::finalise_signal;
use crate::state::EngineState;

/// CLI-tunable parameters for the CMF voter. All defaults are 30m-tuned; the
/// detector internally TF-scales `period` and `sma_period`.
#[derive(Debug, Clone, Copy)]
pub struct CmfParams {
    /// Sliding window over which Σ MFV / Σ volume is computed. 20 = 10h on
    /// a 30m feed, the classic Chaikin default.
    pub period: usize,
    /// CMF ratio threshold ∈ (0, 1). 0.10 = "20 bars of average +10% money-
    /// flow pressure", a defensible accumulation/distribution floor.
    pub threshold: f64,
    /// SMA-of-close period for price-trend confirmation. Computed STRICTLY
    /// BEFORE the signal bar so the comparison `signal_close vs SMA` does not
    /// peek at future data.
    pub sma_period: usize,
    /// Bars to suppress same-asset/dir signals after an emit.
    pub cooldown_bars: u64,
    /// Minimum total window volume (raw, not z-scored). 0 = disabled — guards
    /// thin markets where the CMF ratio is dominated by a handful of bars.
    pub min_total_volume: f64,
    /// Secondary anti-spoof gate: Long needs net_return > 0 over the window;
    /// Short the inverse. Catches "bullish CMF + falling price" distribution.
    pub require_net_return: bool,
    /// Risk-frac multiplier — typically 0.5 so this secondary voter sizes at
    /// half the primary R28V6 trend detector.
    pub size_mult: f64,
    /// Signal-bar `(high-low)/close` floor. Bars below this are treated as
    /// "no informational candle" and the detector abstains regardless of CMF.
    /// Default 5bp (0.0005) so we still vote on calm-but-non-flat bars.
    pub min_range_pct: f64,
}

impl CmfParams {
    /// 2026-05-14 — sensible defaults for a 30m crypto AMBER-family basket.
    pub fn default_30m_crypto() -> Self {
        Self {
            period: 20,
            threshold: 0.10,
            sma_period: 20,
            cooldown_bars: 12,
            min_total_volume: 0.0,
            require_net_return: true,
            size_mult: 0.5,
            min_range_pct: 0.0005,
        }
    }
}

/// Per-bar Money-Flow-Volume. Returns `(mfv, used_volume)` where
/// `used_volume` is 0 for Doji bars so they neither contribute to the MFV
/// numerator NOR to the volume denominator (avoids dilution either way).
/// Returns `None` for corrupt bars (NaN OHLC or NaN volume) so the caller
/// can hard-fail rather than coerce.
fn per_bar_money_flow(c: &Candle) -> Option<(f64, f64)> {
    if !c.high.is_finite() || !c.low.is_finite() || !c.close.is_finite() || !c.volume.is_finite() {
        return None;
    }
    let range = c.high - c.low;
    // Doji-guard: `high <= low` yields div-by-zero. Treat as "no money-flow
    // information" — zero contribution to both sums. NOTE: we still pass the
    // bar (not None) so a single Doji inside an otherwise valid window does
    // NOT poison the entire reading.
    if range <= 0.0 {
        return Some((0.0, 0.0));
    }
    let mfm = ((c.close - c.low) - (c.high - c.close)) / range;
    if !mfm.is_finite() {
        return Some((0.0, 0.0));
    }
    Some((mfm * c.volume, c.volume))
}

/// Pure helper — computes the CMF directional vote without state mutation.
/// Returns `Some(side)` only when the threshold, persistence, SMA-trend, and
/// (optionally) net-return filters all agree. Used both by the standalone
/// `detect_cmf` (which adds state-based cooldown + sizing on top) AND by
/// `signals_regime_confluence.rs` when CMF is enrolled as an additional voter.
pub fn compute_cmf_vote(
    candles: &[Candle],
    params: &CmfParams,
    cfg: &EngineConfig,
) -> Option<PositionSide> {
    // TF-scale period + SMA so 30m-tuned params stay time-equivalent on
    // 5m / 2h feeds. scale = round(30 / bar_minutes).max(1).
    let scale = (30.0 / (cfg.bar_minutes.max(1) as f64)).round().max(1.0) as usize;
    let n = params.period.saturating_mul(scale);
    let sma_p = params.sma_period.saturating_mul(scale);

    if n == 0 || sma_p == 0 {
        return None;
    }
    if !params.threshold.is_finite() || params.threshold <= 0.0 {
        return None;
    }

    // Need: entry bar (len-1) + signal_idx (len-2) + n window bars ending at
    // signal_idx + sma_p SMA bars STRICTLY before signal_idx.
    //   ⇒ len ≥ max(n, sma_p + 1) + 1
    let backward = n.max(sma_p + 1);
    if candles.len() < backward + 1 {
        return None;
    }
    let signal_idx = candles.len() - 2;
    let signal_bar = &candles[signal_idx];
    if !signal_bar.close.is_finite() || signal_bar.close <= 0.0 {
        return None;
    }

    // Signal-bar range gate — skip Doji-ish bars where the MFM math is noisy.
    if params.min_range_pct > 0.0 {
        if !signal_bar.high.is_finite() || !signal_bar.low.is_finite() {
            return None;
        }
        let range_pct = (signal_bar.high - signal_bar.low) / signal_bar.close;
        if !range_pct.is_finite() || range_pct < params.min_range_pct {
            return None;
        }
    }

    // CMF window: [signal_idx + 1 - n ..= signal_idx] (n bars, last fully-
    // closed bar). EXCLUSIVE of the entry bar (candles[len-1]).
    let window = &candles[signal_idx + 1 - n..=signal_idx];
    let first_window_close = window[0].close;
    if !first_window_close.is_finite() || first_window_close <= 0.0 {
        return None;
    }

    let mut sum_mfv = 0.0_f64;
    let mut sum_volume = 0.0_f64;
    let mut all_positive = true;
    let mut all_negative = true;
    for c in window.iter() {
        let (mfv, used_v) = per_bar_money_flow(c)?;
        if !mfv.is_finite() || !used_v.is_finite() {
            return None;
        }
        sum_mfv += mfv;
        sum_volume += used_v;
        // Doji bars (used_v == 0) abstain from the per-bar sign-check rather
        // than counting as "agreement with both sides" (which would silently
        // collapse the persistence filter for the entire window).
        if used_v > 0.0 {
            if mfv <= 0.0 {
                all_positive = false;
            }
            if mfv >= 0.0 {
                all_negative = false;
            }
        }
    }
    if sum_volume <= 0.0 || !sum_volume.is_finite() {
        return None;
    }
    if sum_volume < params.min_total_volume {
        return None;
    }
    let cmf = sum_mfv / sum_volume;
    if !cmf.is_finite() {
        return None;
    }

    // Threshold gate — directional candidate.
    let direction = if cmf >= params.threshold {
        if !all_positive {
            // Persistence: at least one bar's MFV agreed with the candidate
            // direction; we already know aggregate ratio passes. But a SINGLE
            // outlier (e.g. one 80% TBV bar at the start of an otherwise
            // distributive window) would otherwise carry the vote — reject.
            // (`all_positive` is true iff every non-Doji bar had mfv > 0.)
            return None;
        }
        PositionSide::Long
    } else if cmf <= -params.threshold {
        if !all_negative {
            return None;
        }
        PositionSide::Short
    } else {
        return None;
    };

    // SMA confirmation — window STRICTLY before signal_idx.
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

    // Optional net-return secondary gate. Same shape as `signals_ofi` —
    // catches the spoofed-direction archetype where CMF says bullish but
    // price falls over the window (distribution masquerading as buying).
    if params.require_net_return {
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
    }

    Some(direction)
}

fn cooldown_key(symbol: &str, dir: PositionSide) -> String {
    let side = match dir {
        PositionSide::Long => "Long",
        PositionSide::Short => "Short",
    };
    format!("CMF|{}|{}", symbol, side)
}

/// Standalone entry-detector. Emits a `PollSignal` on the entry bar
/// (`candles[len-1]`) when `compute_cmf_vote` votes a direction AND the
/// per-asset/direction cooldown has elapsed AND post-cap eff_risk > 0.
///
/// State mutations:
///   * Installs `state.loss_streak_by_asset_dir["CMF|{sym}|{dir}"]` cooldown
///     ONLY on successful emit (eff_risk > 0). Mirrors `signals_ofi` and
///     post-R67 `signals_meanrev` to avoid silent blocked-on-zero-risk loops.
pub fn detect_cmf(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &CmfParams,
) -> Option<PollSignal> {
    let direction = compute_cmf_vote(candles, params, cfg)?;
    if candles.is_empty() {
        return None;
    }
    let i = candles.len() - 1;
    let entry_bar = candles[i];

    let key = cooldown_key(&asset.symbol, direction);
    if let Some(ls) = state.loss_streak_by_asset_dir.get(&key) {
        if state.bars_seen < ls.cd_until_bars_seen {
            return None;
        }
    }

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

    /// Build a candle with explicit OHLC + volume. Used by tests that need
    /// realistic per-bar MFM = ((close - low) - (high - close)) / (high - low).
    /// For a strongly bullish bar set close near high (MFM → +1); for bearish,
    /// set close near low (MFM → -1).
    fn c_ohlc(t: i64, open: f64, high: f64, low: f64, close: f64, vol: f64) -> Candle {
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

    /// Neutral baseline bar — close at the midpoint of the range so MFM = 0.
    fn c_neutral(t: i64, price: f64, vol: f64) -> Candle {
        c_ohlc(t, price, price + 0.5, price - 0.5, price, vol)
    }

    /// Strongly bullish bar — close at high (MFM ≈ +1, mfv ≈ +volume).
    fn c_bull(t: i64, low: f64, high: f64, vol: f64) -> Candle {
        c_ohlc(t, low, high, low, high, vol)
    }

    /// Strongly bearish bar — close at low (MFM ≈ -1, mfv ≈ -volume).
    fn c_bear(t: i64, low: f64, high: f64, vol: f64) -> Candle {
        c_ohlc(t, high, high, low, low, vol)
    }

    fn default_params() -> CmfParams {
        CmfParams::default_30m_crypto()
    }

    /// Long fires when 20 consecutive bars print near-high closes
    /// (CMF ≈ +1 >> 0.10 threshold) AND signal_bar.close > SMA(20) AND
    /// net_return over window > 0. Layout: 30 neutral baseline (idx 0..29)
    /// to seed the SMA at ~100, then 20 progressively-higher bullish bars
    /// (idx 30..49). signal_idx = len-2 = 49 → window [30..=49] = 20 bars
    /// (all strongly bullish), SMA-slice [29..49] avg ≈ 100 << signal_close.
    /// Entry bar at idx 50, len = 51.
    #[test]
    fn cmf_long_fires_on_persistent_bullish_money_flow_above_sma() {
        let mut s = EngineState::initial("x");
        let cfg = cfg_30m();
        let a = asset();
        let mut candles = Vec::new();
        // 30 neutral baseline bars at 100 (seed SMA below later price).
        for k in 0..30 {
            candles.push(c_neutral(k * 1_800_000, 100.0, 100.0));
        }
        // 20 bullish bars (idx 30..49) — closes near high, price rising.
        // signal_idx = 49 → window [30..=49] = 20 strongly-bullish bars.
        for k in 0..20 {
            let t = (30 + k) * 1_800_000;
            // Rising channel: low = 100 + k*0.5, high = 101 + k*0.5, close = high.
            candles.push(c_bull(
                t,
                100.0 + k as f64 * 0.5,
                101.0 + k as f64 * 0.5,
                100.0,
            ));
        }
        // Entry bar (idx 50). Closes don't matter for the detector.
        candles.push(c_neutral(50 * 1_800_000, 115.0, 100.0));

        let p = default_params();
        let sig = detect_cmf(&mut s, &cfg, &a, "BTCUSDT", &candles, &p)
            .expect("CMF Long should fire on persistent bullish window above SMA");
        assert_eq!(sig.direction, PositionSide::Long);
    }

    /// Short fires symmetric — 20-bar window of near-low closes (MFM ≈ -1)
    /// + signal_close below SMA + net_return < 0. Layout mirrors the Long
    /// test: 30 neutral baseline + 20 bearish bars (idx 30..49) + 1 entry.
    #[test]
    fn cmf_short_fires_on_persistent_bearish() {
        let mut s = EngineState::initial("x");
        let cfg = cfg_30m();
        let a = asset();
        let mut candles = Vec::new();
        // 30 neutral baseline bars at 100 (SMA above later price).
        for k in 0..30 {
            candles.push(c_neutral(k * 1_800_000, 100.0, 100.0));
        }
        // 20 bearish bars (idx 30..49) — closes at low, price falling.
        for k in 0..20 {
            let t = (30 + k) * 1_800_000;
            let low = 99.0 - k as f64 * 0.5;
            let high = 100.0;
            candles.push(c_bear(t, low, high, 100.0));
        }
        candles.push(c_neutral(50 * 1_800_000, 85.0, 100.0));

        let p = default_params();
        let sig = detect_cmf(&mut s, &cfg, &a, "BTCUSDT", &candles, &p)
            .expect("CMF Short should fire on persistent bearish window");
        assert_eq!(sig.direction, PositionSide::Short);
    }

    /// CMF reading below threshold (e.g. mixed window with cmf ≈ 0) → abstain
    /// even though SMA-trend would otherwise pass for a Long.
    #[test]
    fn cmf_abstains_below_threshold() {
        let mut s = EngineState::initial("x");
        let cfg = cfg_30m();
        let a = asset();
        let mut candles = Vec::new();
        for k in 0..20 {
            candles.push(c_neutral(k * 1_800_000, 100.0, 100.0));
        }
        // Window of 19 NEUTRAL bars (MFM = 0 → cmf = 0 < 0.10). Price rises
        // slowly so SMA trend would be bullish, but CMF threshold isn't cleared.
        for k in 0..19 {
            let t = (20 + k) * 1_800_000;
            candles.push(c_neutral(t, 100.5 + k as f64 * 0.05, 100.0));
        }
        candles.push(c_neutral(39 * 1_800_000, 102.0, 100.0));

        let p = default_params();
        let sig = detect_cmf(&mut s, &cfg, &a, "BTCUSDT", &candles, &p);
        assert!(
            sig.is_none(),
            "neutral CMF ≈ 0 must not fire below threshold"
        );
    }

    /// Doji-guard: bar with `high == low` contributes 0 to both sums (no NaN
    /// propagation). A window of pure Doji bars has sum_volume = 0 → abstain.
    #[test]
    fn cmf_high_equals_low_skips_bar() {
        let cfg = cfg_30m();
        let mut candles = Vec::new();
        for k in 0..20 {
            candles.push(c_neutral(k * 1_800_000, 100.0, 100.0));
        }
        // Window of 19 DOJI bars (high == low == close == 100 + tiny step).
        // Total used_volume across these = 0 → sum_volume tally = 0.
        for k in 0..19 {
            let t = (20 + k) * 1_800_000;
            let p = 100.0 + k as f64 * 0.01;
            candles.push(c_ohlc(t, p, p, p, p, 100.0));
        }
        candles.push(c_neutral(39 * 1_800_000, 100.5, 100.0));

        let p = default_params();
        let vote = compute_cmf_vote(&candles, &p, &cfg);
        assert!(vote.is_none(), "all-Doji window → sum_volume=0 abstain");

        // Sanity: per_bar_money_flow on a single Doji = (0.0, 0.0)
        let doji = c_ohlc(0, 100.0, 100.0, 100.0, 100.0, 100.0);
        let (mfv, used) = per_bar_money_flow(&doji).expect("Doji bar is valid (just degenerate)");
        assert_eq!(mfv, 0.0);
        assert_eq!(used, 0.0, "Doji used_volume must be 0 (not 100)");
    }

    /// LOOKAHEAD #1 — mutating candles[i] (entry bar) OHLC must NOT change
    /// the detector's decision. The CMF window strictly ends at signal_idx
    /// (= len-2), so the entry-bar's close/high/low are never consulted.
    #[test]
    fn cmf_must_not_read_entry_bar_ohlc() {
        let cfg = cfg_30m();
        let mut candles = Vec::new();
        for k in 0..30 {
            candles.push(c_neutral(k * 1_800_000, 100.0, 100.0));
        }
        for k in 0..20 {
            let t = (30 + k) * 1_800_000;
            candles.push(c_bull(
                t,
                100.0 + k as f64 * 0.5,
                101.0 + k as f64 * 0.5,
                100.0,
            ));
        }
        candles.push(c_neutral(50 * 1_800_000, 115.0, 100.0));

        let p = default_params();
        let before = compute_cmf_vote(&candles, &p, &cfg);
        assert_eq!(before, Some(PositionSide::Long));

        // Corrupt the entry bar: extreme bearish OHLC + huge volume. None of
        // it should reach the detector.
        let last = candles.len() - 1;
        candles[last].open = 200.0;
        candles[last].high = 200.0;
        candles[last].low = 1.0;
        candles[last].close = 1.0;
        candles[last].volume = 99_999.0;
        let after = compute_cmf_vote(&candles, &p, &cfg);
        assert_eq!(
            before, after,
            "LOOKAHEAD: entry-bar OHLC/volume must not affect decision"
        );
    }

    /// LOOKAHEAD #2 — SMA window is STRICTLY BEFORE signal_idx. Mutating
    /// candles[i].close (entry bar) to 9999 must not change SMA-based trend
    /// confirmation.
    #[test]
    fn cmf_sma_excludes_entry_bar() {
        let cfg = cfg_30m();
        let mut candles = Vec::new();
        for k in 0..30 {
            candles.push(c_neutral(k * 1_800_000, 100.0, 100.0));
        }
        for k in 0..20 {
            let t = (30 + k) * 1_800_000;
            candles.push(c_bull(
                t,
                100.0 + k as f64 * 0.5,
                101.0 + k as f64 * 0.5,
                100.0,
            ));
        }
        candles.push(c_neutral(50 * 1_800_000, 115.0, 100.0));

        let p = default_params();
        let before = compute_cmf_vote(&candles, &p, &cfg);
        let last = candles.len() - 1;
        candles[last].close = 9999.0;
        candles[last].high = 9999.5;
        candles[last].low = 9998.5;
        let after = compute_cmf_vote(&candles, &p, &cfg);
        assert_eq!(
            before, after,
            "LOOKAHEAD: SMA must not see entry-bar close (mutation no-op)"
        );
    }

    /// LOOKAHEAD #3 — persistence (per-bar sign-check) spans only the n
    /// signal bars [signal_idx+1-n ..= signal_idx], not the entry bar.
    /// Mutating entry-bar MFV to extreme bearish must NOT poison persistence.
    #[test]
    fn cmf_persistence_n_signal_bars_only() {
        let cfg = cfg_30m();
        let mut candles = Vec::new();
        for k in 0..30 {
            candles.push(c_neutral(k * 1_800_000, 100.0, 100.0));
        }
        // All-bullish window (mfm ≈ +1 each bar).
        for k in 0..20 {
            let t = (30 + k) * 1_800_000;
            candles.push(c_bull(
                t,
                100.0 + k as f64 * 0.5,
                101.0 + k as f64 * 0.5,
                100.0,
            ));
        }
        // Entry bar with EXTREME bearish setup — close at low, large volume.
        // The persistence rule rejected this if it ever reached the loop.
        let t_entry = 50 * 1_800_000;
        candles.push(c_ohlc(t_entry, 115.0, 115.5, 105.0, 105.0, 9_999.0));

        let p = default_params();
        let vote = compute_cmf_vote(&candles, &p, &cfg);
        assert_eq!(
            vote,
            Some(PositionSide::Long),
            "entry-bar bearish polarity must not poison window persistence"
        );
    }

    /// Cooldown: after first successful emit, identical fixture must abstain
    /// until cooldown elapses.
    #[test]
    fn cmf_respects_cooldown_after_emit() {
        let mut s = EngineState::initial("x");
        let cfg = cfg_30m();
        let a = asset();
        let mut candles = Vec::new();
        for k in 0..30 {
            candles.push(c_neutral(k * 1_800_000, 100.0, 100.0));
        }
        for k in 0..20 {
            let t = (30 + k) * 1_800_000;
            candles.push(c_bull(
                t,
                100.0 + k as f64 * 0.5,
                101.0 + k as f64 * 0.5,
                100.0,
            ));
        }
        candles.push(c_neutral(50 * 1_800_000, 115.0, 100.0));

        let p = default_params();
        let _ =
            detect_cmf(&mut s, &cfg, &a, "BTCUSDT", &candles, &p).expect("first call must fire");
        // Immediate re-call (no bars_seen advance) — cooldown gates it.
        let sig2 = detect_cmf(&mut s, &cfg, &a, "BTCUSDT", &candles, &p);
        assert!(sig2.is_none(), "cooldown must suppress repeat emit");

        // Advance past cooldown — must fire again.
        s.bars_seen += p.cooldown_bars + 1;
        let sig3 = detect_cmf(&mut s, &cfg, &a, "BTCUSDT", &candles, &p);
        assert!(sig3.is_some(), "after cooldown elapses, fires again");
    }

    /// TF-scaling: 30m-tuned params on a 5m feed scale period × 6. Verify
    /// the detector still works on 5m AND that too-short feeds safely abstain
    /// (no panic / OOB).
    #[test]
    fn cmf_tf_scaling_5min_scales_window() {
        let cfg = cfg_5m();
        let p = default_params(); // period=20, sma=20 → scaled 120 each on 5m
        let a = asset();

        // Backward requirement = max(120, 120+1) = 121 → need len ≥ 122.
        // Layout: 130 neutral baseline + 120 bullish window + 1 entry = 251.
        // signal_idx = 249 → window [130..=249] = 120 bullish bars; SMA-slice
        // [129..249] is mostly neutral (avg ≈ 100) << signal_close.
        let mut candles = Vec::new();
        for k in 0..130 {
            candles.push(c_neutral(k * 300_000, 100.0, 100.0));
        }
        // 120 rising bullish bars (idx 130..249).
        for k in 0..120 {
            let t = (130 + k) * 300_000;
            let lo = 100.0 + k as f64 * 0.05;
            let hi = 101.0 + k as f64 * 0.05;
            candles.push(c_bull(t, lo, hi, 100.0));
        }
        // Entry.
        candles.push(c_neutral(250 * 300_000, 110.0, 100.0));

        let mut s = EngineState::initial("x");
        let sig = detect_cmf(&mut s, &cfg, &a, "BTCUSDT", &candles, &p);
        assert!(
            sig.is_some(),
            "5m TF-scaled window must still fire on uptrend"
        );
        assert_eq!(sig.unwrap().direction, PositionSide::Long);

        // Now build a too-short feed below the TF-scaled threshold — must
        // abstain safely instead of indexing OOB.
        let mut short_candles = Vec::new();
        for k in 0..50 {
            short_candles.push(c_neutral(k * 300_000, 100.0, 100.0));
        }
        let v = compute_cmf_vote(&short_candles, &p, &cfg);
        assert!(
            v.is_none(),
            "below TF-scaled backward requirement → safe None"
        );
    }

    /// Net-return secondary filter blocks "spoofed direction": bars with
    /// strongly-bullish MFM but the actual close lower than first_window_close
    /// → reject Long.
    #[test]
    fn cmf_net_return_filter_blocks_spoofed_direction() {
        let cfg = cfg_30m();
        let mut candles = Vec::new();
        // Strong uptrend baseline so SMA is well below later prices.
        for k in 0..30 {
            candles.push(c_neutral(k * 1_800_000, 80.0 + k as f64, 100.0));
        }
        // Window: each bar prints close-at-high (mfm ≈ +1) BUT prices
        // monotone DROP over 20 bars (net_return < 0). Detector should
        // veto Long despite bullish per-bar MFV. 20 bars at 115 → 95.
        for k in 0..20 {
            let t = (30 + k) * 1_800_000;
            let lo = 114.0 - k as f64;
            let hi = 115.0 - k as f64;
            candles.push(c_bull(t, lo, hi, 100.0));
        }
        candles.push(c_neutral(50 * 1_800_000, 95.0, 100.0));

        let p = default_params(); // require_net_return = true
        let mut s = EngineState::initial("x");
        let sig = detect_cmf(&mut s, &cfg, &asset(), "BTCUSDT", &candles, &p);
        assert!(
            sig.is_none(),
            "net_return < 0 must veto Long despite bullish CMF + bullish per-bar MFV"
        );
    }
}
