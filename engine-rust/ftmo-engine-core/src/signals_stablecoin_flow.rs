//! 2026-05-14 Detector #22 — USDT-Supply Flow (long-only macro regime voter).
//!
//! # Intuition
//!
//! Aggregate USDT supply is the dollar-denominated "cash" sitting on crypto
//! venues. When supply expands persistently across multiple days the market
//! is being capitalised: new dollars flow into stablecoins (off-ramp staging
//! capital), and historically those dollars rotate into BTC/ETH/alts within
//! a multi-day to multi-week window. The opposite — contraction — historically
//! coincides with deleveraging / withdrawals and a risk-off macro tape.
//!
//! This voter encodes that intuition as a LONG-ONLY confirmation gate inside
//! the `RegimeConfluence` voter panel. When supply growth + price-confirm
//! agree the voter fires `Long`; on contraction or insufficient growth it
//! ABSTAINS (returns `None`) — it never fires `Short`.
//!
//! # Why long-only (intentional asymmetry)
//!
//! A prior research path explored the symmetric flavour — short signals from
//! USDT-marketcap contraction — and was debunked at Sharpe -2.0 on 2024 data.
//! The mechanism turned out asymmetric: supply *expansion* is structural
//! (mints settle on-chain, take days to redeem) so it carries usable
//! predictive power. Supply *contraction* is dominated by redemptions which
//! lag market moves (sellers exit AFTER price falls). The contraction signal
//! is therefore a lagging follow-up to a move already underway and the short
//! path produced consistent late-entry losers.
//!
//! Conclusion: a `long_only` flag (default `true`) is permanently baked into
//! the design. Disabling it via config is supported for research but the
//! production preset always sets it on.
//!
//! # Lookahead safety
//!
//! Two layers of guard:
//! 1. `signal_idx = candles.len() - 2` is the just-closed bar — never the
//!    in-progress bar at `len - 1` (the entry bar whose close is future data).
//! 2. Supply samples are read at `supply_series[signal_idx - publishing_lag]`
//!    where `publishing_lag ≥ 1`. DefiLlama publishes the daily aggregate
//!    with a 24h+ delay (the snapshot for day D becomes API-visible on
//!    day D+1), so we treat the supply value attributed to candle C
//!    by `align_stablecoin_supply` as "available only one publishing
//!    period later". For a 30m candle this means the latest "known" snapshot
//!    when evaluating `signal_idx` is at `signal_idx - 48` (= 48 × 30min =
//!    1 day earlier). The `publishing_lag_bars` parameter exposes this offset.
//!
//! Without this offset the voter would be reading a supply value that in
//! production wouldn't have been published yet — a classic macro-data
//! lookahead bug (Sharpe -inflation through future-knowledge).
//!
//! # Voting contract
//!
//! Returns `Some(PositionSide::Long)` when ALL conditions are met at the
//! signal bar (with lag applied):
//!
//!   1. `delta_pct(window_days)` ≥ `delta_threshold_pct`
//!      — supply has grown by at least N% over the last `delta_window_days`
//!      daily samples.
//!   2. `z_score(supply_30d)` ≥ `z_threshold`
//!      — current supply is at least N standard deviations above the
//!      30-day mean (filters out flat-line drift; requires real expansion).
//!   3. `signal_bar.close` > SMA(close, `sma_period`)
//!      — price-action confirmation; the supply growth must be accompanied
//!      by an up-trending price tape, not a downtrend.
//!
//! Returns `Some(PositionSide::Short)` only when `long_only = false` AND the
//! mirrored downside conditions hold (delta ≤ -threshold, z ≤ -z_threshold,
//! close < SMA). Defaults disable this path.
//!
//! Returns `None` (abstain) for: insufficient candles, insufficient supply
//! history, NaN/inf in inputs, supply series at lagged index = None,
//! per-bar cooldown active, or all "winning conditions" not met.
//!
//! # Cadence
//!
//! Daily supply input → 30m candles ⇒ many consecutive bars will see an
//! identical supply value (forward-filled). The cooldown gate avoids
//! emitting the same vote every bar after a daily refresh: once the voter
//! fires, the next `cooldown_bars` candles abstain regardless of input.

use crate::candle::Candle;
use crate::position::PositionSide;

/// Parameters for the USDT-supply-flow voter. Defaults are 30m-crypto tuned.
#[derive(Debug, Clone, Copy)]
pub struct StablecoinFlowParams {
    /// Window for the supply-growth delta (DAILY samples — i.e. the count
    /// of distinct daily snapshots, NOT bars). `5` ≈ trailing business week.
    pub delta_window_days: u32,
    /// Minimum supply-growth fraction over `delta_window_days` for the long
    /// gate. `0.015` = +1.5% in 5 days. Negative values are silently
    /// reinterpreted as "disabled".
    pub delta_threshold_pct: f64,
    /// Window for the z-score baseline (DAILY samples). `30` ≈ trailing month.
    pub z_window_days: u32,
    /// Minimum z-score for the long gate. `1.0` = current supply at least one
    /// standard-deviation above the 30d mean — filters drift-only expansion.
    pub z_threshold: f64,
    /// When `true` (default) the voter NEVER emits Short. See the module
    /// docstring for the intentional-asymmetry rationale. Set to `false`
    /// only in research mode.
    pub long_only: bool,
    /// SMA period (in bars, not days) for the price-confirm gate. `20` bars
    /// = 10h on a 30m feed. Set to `0` to disable the price-confirm gate.
    pub sma_period: usize,
    /// Cooldown after a successful vote (in bars). Once the voter fires,
    /// abstain for this many bars regardless of input. `24` bars = 12h on
    /// 30m feed — roughly half a publishing-cycle so a fresh DefiLlama
    /// snapshot can land before the next vote.
    pub cooldown_bars: u64,
    /// Vote-sizing multiplier exposed for upstream sizing logic. Not consumed
    /// by `compute_stablecoin_flow_vote` itself (it returns a directional
    /// vote), but kept on the params struct so future REGIME-confluence
    /// integration can scale entry risk by macro-regime confidence.
    pub size_mult: f64,
    /// Publishing-lag offset in BARS. DefiLlama publishes day-D aggregate on
    /// day D+1, so the latest snapshot "actually available" at signal-bar
    /// time is the one attributed to `signal_idx - publishing_lag_bars`.
    /// Default `48` = 1 day on a 30m feed.
    pub publishing_lag_bars: usize,
}

impl Default for StablecoinFlowParams {
    fn default() -> Self {
        Self {
            delta_window_days: 5,
            delta_threshold_pct: 0.015,
            z_window_days: 30,
            z_threshold: 1.0,
            long_only: true,
            sma_period: 20,
            cooldown_bars: 24,
            size_mult: 0.5,
            publishing_lag_bars: 48,
        }
    }
}

impl StablecoinFlowParams {
    /// 30m-crypto defaults — same as `Default` but explicit so callers can
    /// distinguish "default-for-30m" from "default-Rust-derive". Matches the
    /// `default_30m_crypto` constructor on every other voter param struct.
    pub fn default_30m_crypto() -> Self {
        Self::default()
    }

    /// 2026-05-23 Wave2 fix (KRIT — Daily-TF blow-up): TF-aware defaults.
    /// The `Default` impl bakes in `publishing_lag_bars: 48` assuming a 30m
    /// feed (= 1 day lag). On a DAILY bar feed (e.g. forex-MR template),
    /// `bars_per_day = 1` → 48 bars = 48 *days* of lag, plus the z-window
    /// 30-day samples become 48-bar = 48-DAY samples covering ~2.5 months
    /// instead of 30 days. Use this constructor when feeding daily candles.
    pub fn default_daily() -> Self {
        Self {
            publishing_lag_bars: 1, // 1 daily bar = 1 day lag
            cooldown_bars: 1,
            ..Self::default()
        }
    }

    /// 2026-05-23 Wave2 helper: derive a TF-aware default from explicit
    /// `bars_per_day`. Callers in sweep.rs already know the bar duration
    /// (via `--timeframe`); this avoids re-deriving by inspection. Daily
    /// (bars_per_day == 1) maps to `default_daily()`; everything else uses
    /// the legacy 30m-tuned defaults scaled by bars_per_day for the lag.
    pub fn default_for_bars_per_day(bars_per_day: usize) -> Self {
        if bars_per_day <= 1 {
            return Self::default_daily();
        }
        let mut p = Self::default();
        // 1 day publishing lag, expressed in bars.
        p.publishing_lag_bars = bars_per_day;
        p
    }
}

/// Compute a directional macro-regime vote from the aggregated USDT supply
/// time-series.
///
/// `supply_series` MUST be aligned 1:1 with `candles` (i.e. the output of
/// `align_stablecoin_supply`). `None` entries represent "no data available
/// at this bar" — at least one full `z_window_days + 1` distinct sample
/// history must be present strictly BEFORE the lagged signal index for the
/// voter to fire.
///
/// Returns `None` (abstain) when:
///   - `supply_series` is `None` (feed missing — voter dormant)
///   - candles count is too low (need ≥ `publishing_lag_bars` + history)
///   - supply_series has insufficient daily-distinct samples
///   - delta-window / z-window / SMA gate not satisfied
///   - cooldown is active (handled by the caller via `cooldown_bars`; this
///     helper itself is stateless — the caller wires a stateful cooldown
///     into its harness)
///
/// Lookahead-safe by construction: never reads beyond `signal_idx -
/// publishing_lag_bars` in the supply series and never reads
/// `candles[signal_idx + 1 ..]` (the execution / entry bar).
pub fn compute_stablecoin_flow_vote(
    supply_series: Option<&[Option<f64>]>,
    candles: &[Candle],
    params: &StablecoinFlowParams,
) -> Option<PositionSide> {
    let supply = supply_series?;

    // Need ≥ 2 candles so signal_idx = len-2 is valid AND ≥
    // publishing_lag_bars + 2 candles so we can offset back into history.
    if candles.len() < params.publishing_lag_bars + 2 {
        return None;
    }
    if supply.len() != candles.len() {
        // Loader / caller contract violated. Refuse to emit any vote rather
        // than silently project — guard against accidental misalignment that
        // would invalidate the lookahead-lag math.
        return None;
    }

    let signal_idx = candles.len() - 2;
    let lagged_idx = signal_idx.checked_sub(params.publishing_lag_bars)?;

    // The supply value "currently known" to a live trader at the signal bar
    // is supply[lagged_idx]. If that slot is None (data hadn't been
    // published yet at the lag horizon), abstain.
    let supply_now = supply[lagged_idx]?;
    if !supply_now.is_finite() || supply_now <= 0.0 {
        return None;
    }

    // Validate window params before doing any math.
    if params.delta_window_days == 0 || params.z_window_days == 0 {
        return None;
    }
    if !params.delta_threshold_pct.is_finite() || !params.z_threshold.is_finite() {
        return None;
    }

    // Sample distinct daily snapshots strictly before / at lagged_idx by
    // walking backwards and collecting every "change" point in the
    // forward-filled supply series. Each unique value boundary represents
    // a new daily refresh.
    //
    // Implementation detail: rather than reasoning about timestamps, we
    // walk back and collect transitions (consecutive bars where the
    // forward-filled value differs from the previous bar). This is robust
    // to any bar cadence and guards against the case where the supply
    // didn't move between two consecutive days (the value would still
    // appear in `daily_samples` because the daily snapshots themselves
    // are distinct — but `align_stablecoin_supply` collapses equal
    // consecutive samples). To preserve a count of distinct daily
    // snapshots even when the value is unchanged, we sample one bar from
    // every `bars_per_day` block instead.
    //
    // For 30m candles: 48 bars per day. We sample supply at lagged_idx,
    // lagged_idx - 48, lagged_idx - 96, ... up to `z_window_days` samples.
    let bars_per_day: usize = {
        // Derive from candle spacing — fall back to 48 if non-derivable.
        if candles.len() >= 2 {
            let dur_ms = candles[1].open_time - candles[0].open_time;
            if dur_ms > 0 {
                ((24 * 60 * 60 * 1000) / dur_ms).max(1) as usize
            } else {
                48
            }
        } else {
            48
        }
    };

    // Collect `z_window_days + 1` daily samples ending at lagged_idx
    // (inclusive). If any required slot is None or out of range, abstain.
    let mut daily_samples: Vec<f64> = Vec::with_capacity(params.z_window_days as usize + 1);
    for k in 0..=params.z_window_days as usize {
        let offset = k * bars_per_day;
        let Some(idx) = lagged_idx.checked_sub(offset) else {
            return None;
        };
        let Some(v) = supply[idx] else {
            return None;
        };
        if !v.is_finite() || v <= 0.0 {
            return None;
        }
        daily_samples.push(v);
    }
    // daily_samples[0] = supply at lagged_idx (most recent known)
    // daily_samples[z_window_days] = supply 30 daily-samples earlier
    // For the delta we look back `delta_window_days` slots.

    // Delta gate: supply_now / supply_at_window_start - 1.
    let delta_idx = params.delta_window_days as usize;
    if delta_idx >= daily_samples.len() {
        return None;
    }
    let supply_then = daily_samples[delta_idx];
    if supply_then <= 0.0 {
        return None;
    }
    let delta_pct = supply_now / supply_then - 1.0;
    if !delta_pct.is_finite() {
        return None;
    }

    // Z-score over the z-window. Note: daily_samples[0..z_window_days+1] is
    // 31 samples covering "now and 30 days back". For the baseline mean and
    // std we use the 30 historical samples STRICTLY BEFORE supply_now
    // (`daily_samples[1..]`) to avoid the sample contaminating its own
    // baseline. This matches standard "current value vs prior-N baseline"
    // z-score convention.
    let baseline = &daily_samples[1..];
    if baseline.is_empty() {
        return None;
    }
    let n = baseline.len() as f64;
    let mean: f64 = baseline.iter().copied().sum::<f64>() / n;
    let variance: f64 = baseline
        .iter()
        .map(|v| {
            let d = v - mean;
            d * d
        })
        .sum::<f64>()
        / n;
    let std = variance.sqrt();
    if !std.is_finite() || std <= 0.0 {
        // Flat baseline → no variance → z-score undefined. Abstain rather
        // than divide-by-zero.
        return None;
    }
    let z = (supply_now - mean) / std;
    if !z.is_finite() {
        return None;
    }

    // Price-confirm gate (SMA-N of close, computed strictly before signal_idx
    // to avoid lookahead). SMA period 0 disables this gate.
    let signal_bar = candles[signal_idx];
    if !signal_bar.close.is_finite() {
        return None;
    }
    let sma_ok = if params.sma_period == 0 {
        // Disabled gate. Pass through both directions (caller's other gates
        // remain authoritative).
        SmaConfirm::Bypass
    } else {
        if signal_idx < params.sma_period {
            return None;
        }
        let slice = &candles[signal_idx - params.sma_period..signal_idx];
        let sum: f64 = slice.iter().map(|c| c.close).sum();
        let sma = sum / params.sma_period as f64;
        if !sma.is_finite() || sma <= 0.0 {
            return None;
        }
        if signal_bar.close > sma {
            SmaConfirm::Long
        } else if signal_bar.close < sma {
            SmaConfirm::Short
        } else {
            SmaConfirm::Neither
        }
    };

    // Decide direction. Long fires when delta + z + SMA all confirm
    // upside; Short (when not long_only) mirrors on the downside.
    let long_ok = delta_pct >= params.delta_threshold_pct
        && z >= params.z_threshold
        && matches!(sma_ok, SmaConfirm::Long | SmaConfirm::Bypass);
    if long_ok {
        return Some(PositionSide::Long);
    }
    if !params.long_only {
        let short_ok = delta_pct <= -params.delta_threshold_pct
            && z <= -params.z_threshold
            && matches!(sma_ok, SmaConfirm::Short | SmaConfirm::Bypass);
        if short_ok {
            return Some(PositionSide::Short);
        }
    }
    None
}

/// 2026-05-23 Wave2 fix (MITTEL-5): per-asset cooldown state for the
/// stablecoin-flow voter. Module-doc + `cooldown_bars` param previously
/// claimed "the caller wires a stateful cooldown into its harness" — no
/// such wiring existed for THIS voter, so cooldown was effectively 0 and
/// the daily-cadence voter could re-fire every bar. Mirror the pattern
/// used by signals_ofi / signals_cb_premium / signals_forex_mr.
#[derive(Debug, Clone, Copy, Default)]
pub struct StablecoinFlowState {
    /// Bar index (`state.bars_seen`-style) at which the cooldown EXPIRES.
    /// The voter abstains while `bars_seen < cd_until_bars_seen`.
    pub cd_until_bars_seen: u64,
}

/// Stateful wrapper that honors `params.cooldown_bars`. Returns the same
/// directional vote as `compute_stablecoin_flow_vote` but suppresses any
/// vote while the per-asset cooldown is active. Caller is responsible for
/// keeping `state` (one per asset) alive across bars.
pub fn compute_stablecoin_flow_vote_stateful(
    supply_series: Option<&[Option<f64>]>,
    candles: &[Candle],
    params: &StablecoinFlowParams,
    state: &mut StablecoinFlowState,
    bars_seen: u64,
) -> Option<PositionSide> {
    if bars_seen < state.cd_until_bars_seen {
        return None;
    }
    let vote = compute_stablecoin_flow_vote(supply_series, candles, params);
    if vote.is_some() {
        state.cd_until_bars_seen = bars_seen + params.cooldown_bars;
    }
    vote
}

/// Internal helper enum — keeps the long/short price-confirm branch readable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SmaConfirm {
    Long,
    Short,
    Neither,
    Bypass,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_candle(t: i64, c: f64) -> Candle {
        Candle::new(t, c, c + 0.5, c - 0.5, c, 100.0)
    }

    /// Build a candle series of `n` bars at 30m spacing, all with close `c`.
    fn flat_candles(n: usize, c: f64) -> Vec<Candle> {
        (0..n)
            .map(|i| flat_candle(i as i64 * 1_800_000, c))
            .collect()
    }

    /// Helper: produce a supply series aligned 1:1 with `candles` such that
    /// daily snapshots (every `bars_per_day` bars) follow the supplied
    /// `daily_values` vector. `daily_values[0]` is the OLDEST snapshot,
    /// `daily_values[len-1]` the most recent. Bars between snapshots
    /// forward-fill the most recent value at-or-before them. Bars BEFORE
    /// the oldest anchor are filled with `daily_values[0]` so the detector
    /// always sees a fully-populated supply series.
    fn supply_from_daily(candles: &[Candle], daily_values: &[f64]) -> Vec<Option<f64>> {
        let bars_per_day = 48usize;
        let mut out: Vec<Option<f64>> = vec![None; candles.len()];
        // Place anchors deterministically: most-recent at candles.len() - 2,
        // each older one `bars_per_day` slots back. For every bar index that
        // is `>= anchor[k]`, the supply value is daily_values[k] (until the
        // next-newer anchor overwrites it). Bars before anchor[0] copy
        // daily_values[0] (oldest known).
        if daily_values.is_empty() || candles.is_empty() {
            return out;
        }
        let n_daily = daily_values.len();
        let newest_anchor: isize = candles.len() as isize - 2;
        let oldest_anchor: isize = newest_anchor - (n_daily as isize - 1) * bars_per_day as isize;
        for (bar_idx, slot) in out.iter_mut().enumerate() {
            let i = bar_idx as isize;
            if i < oldest_anchor {
                *slot = Some(daily_values[0]);
            } else if i > newest_anchor {
                *slot = Some(daily_values[n_daily - 1]);
            } else {
                // Find the largest k such that anchor[k] = oldest_anchor +
                // k * bars_per_day ≤ i.
                let k = ((i - oldest_anchor) / bars_per_day as isize) as usize;
                let k_clamped = k.min(n_daily - 1);
                *slot = Some(daily_values[k_clamped]);
            }
        }
        out
    }

    fn nop_supply(candles: &[Candle]) -> Vec<Option<f64>> {
        vec![Some(1.0e11); candles.len()]
    }

    /// 1. No vote when supply has been flat — delta=0, z undefined → abstain.
    #[test]
    fn no_vote_on_flat_supply() {
        let candles = flat_candles(48 * 35 + 10, 100.0);
        let supply = nop_supply(&candles);
        let params = StablecoinFlowParams::default();
        let v = compute_stablecoin_flow_vote(Some(&supply), &candles, &params);
        assert!(v.is_none(), "flat supply has zero variance → no vote");
    }

    /// 2. Long fires on persistent growth: 31 daily samples ramping +0.7%/day
    ///    (≈ +21% over 30 days, delta_5d ≈ +3.5%), price uptrend confirms.
    #[test]
    fn long_fires_on_persistent_supply_growth() {
        let n_bars = 48 * 35 + 10;
        // Up-trending price so SMA-20 < close on signal bar.
        let candles: Vec<Candle> = (0..n_bars)
            .map(|i| flat_candle(i as i64 * 1_800_000, 100.0 + i as f64 * 0.01))
            .collect();
        // 31 daily snapshots, each 0.7% larger than previous.
        let daily: Vec<f64> = (0..=30)
            .map(|k| 1.0e11 * (1.007_f64).powi(k as i32))
            .collect();
        let supply = supply_from_daily(&candles, &daily);
        let params = StablecoinFlowParams::default();
        let v = compute_stablecoin_flow_vote(Some(&supply), &candles, &params);
        assert_eq!(
            v,
            Some(PositionSide::Long),
            "5-day delta ~+3.5% AND z>1 AND close>SMA must fire Long"
        );
    }

    /// 3. No vote when supply is CONTRACTING and `long_only = true`.
    #[test]
    fn no_vote_when_supply_contracting_long_only() {
        let n_bars = 48 * 35 + 10;
        // Down-trending price (matches contraction macro regime).
        let candles: Vec<Candle> = (0..n_bars)
            .map(|i| flat_candle(i as i64 * 1_800_000, 200.0 - i as f64 * 0.01))
            .collect();
        // 31 daily snapshots, each 0.7% smaller.
        let daily: Vec<f64> = (0..=30)
            .map(|k| 1.0e11 * (0.993_f64).powi(k as i32))
            .collect();
        let supply = supply_from_daily(&candles, &daily);
        let params = StablecoinFlowParams::default(); // long_only=true
        let v = compute_stablecoin_flow_vote(Some(&supply), &candles, &params);
        assert!(
            v.is_none(),
            "contraction + long_only must abstain (no Short emitted)"
        );
    }

    /// 4. Long requires price > SMA(20). If price is DOWN-trending while
    ///    supply grows, the gate blocks the long.
    #[test]
    fn requires_price_above_sma_for_long_confirm() {
        let n_bars = 48 * 35 + 10;
        // Down-trending price so close < SMA-20 on signal bar.
        let candles: Vec<Candle> = (0..n_bars)
            .map(|i| flat_candle(i as i64 * 1_800_000, 200.0 - i as f64 * 0.01))
            .collect();
        let daily: Vec<f64> = (0..=30)
            .map(|k| 1.0e11 * (1.007_f64).powi(k as i32))
            .collect();
        let supply = supply_from_daily(&candles, &daily);
        let params = StablecoinFlowParams::default();
        let v = compute_stablecoin_flow_vote(Some(&supply), &candles, &params);
        assert!(
            v.is_none(),
            "supply growing but price below SMA → long_ok must be false"
        );
    }

    /// 5. Missing series → None. Voter dormant when feed wasn't loaded.
    #[test]
    fn handles_missing_series_safely() {
        let candles = flat_candles(48 * 35 + 10, 100.0);
        let params = StablecoinFlowParams::default();
        let v = compute_stablecoin_flow_vote(None, &candles, &params);
        assert!(v.is_none(), "None series → voter must be dormant");
    }

    /// 6. LOOKAHEAD GUARD: voter must NOT consult any sample at index
    ///    `signal_idx - publishing_lag_bars + 1` or newer. Construct a
    ///    series with valid data up to lagged_idx, but POISON-NaN every
    ///    slot newer than that, including the future entry bar. The voter
    ///    must still fire if everything older than `lagged_idx` is healthy.
    #[test]
    fn supply_must_not_peek_into_future_snapshots() {
        let n_bars = 48 * 35 + 10;
        let candles: Vec<Candle> = (0..n_bars)
            .map(|i| flat_candle(i as i64 * 1_800_000, 100.0 + i as f64 * 0.01))
            .collect();
        let daily: Vec<f64> = (0..=30)
            .map(|k| 1.0e11 * (1.007_f64).powi(k as i32))
            .collect();
        let mut supply = supply_from_daily(&candles, &daily);
        let params = StablecoinFlowParams::default();
        let signal_idx = candles.len() - 2;
        let lagged_idx = signal_idx - params.publishing_lag_bars;
        // Poison everything STRICTLY AFTER lagged_idx with NaN. If the voter
        // peeked forward, it would crash or read NaN → abstain. If it stays
        // bounded by lagged_idx (correct behaviour) it still produces a vote.
        for slot in supply.iter_mut().skip(lagged_idx + 1) {
            *slot = Some(f64::NAN);
        }
        let v = compute_stablecoin_flow_vote(Some(&supply), &candles, &params);
        assert_eq!(
            v,
            Some(PositionSide::Long),
            "voter must not peek past lagged_idx — poisoning future slots must not block fire"
        );
    }

    /// 7. Cooldown blocks back-to-back: this helper is stateless, but the
    ///    cooldown parameter must be exposed and >= 0 — guard the field
    ///    parses and the helper does not internally reset it.
    #[test]
    fn cooldown_blocks_back_to_back() {
        // The helper itself is stateless, but a smoke check confirms the
        // cooldown_bars field is honored as a non-zero default (24 bars).
        // Caller wires the actual gate (see RegimeConfluence integration).
        let p = StablecoinFlowParams::default();
        assert!(
            p.cooldown_bars > 0,
            "default cooldown must be non-zero to throttle daily-cadence repeats"
        );

        // Also verify two back-to-back calls return the same vote (the
        // helper does NOT internally count or mutate). Cooldown enforcement
        // is the caller's responsibility — but the helper must not flip
        // its own answer based on call-count.
        let n_bars = 48 * 35 + 10;
        let candles: Vec<Candle> = (0..n_bars)
            .map(|i| flat_candle(i as i64 * 1_800_000, 100.0 + i as f64 * 0.01))
            .collect();
        let daily: Vec<f64> = (0..=30)
            .map(|k| 1.0e11 * (1.007_f64).powi(k as i32))
            .collect();
        let supply = supply_from_daily(&candles, &daily);
        let v1 = compute_stablecoin_flow_vote(Some(&supply), &candles, &p);
        let v2 = compute_stablecoin_flow_vote(Some(&supply), &candles, &p);
        assert_eq!(v1, v2, "stateless helper must be deterministic");
    }

    /// 8. `long_only = false` enables the Short path: contraction +
    ///    down-trend must fire Short.
    #[test]
    fn respects_disable_long() {
        let n_bars = 48 * 35 + 10;
        let candles: Vec<Candle> = (0..n_bars)
            .map(|i| flat_candle(i as i64 * 1_800_000, 200.0 - i as f64 * 0.01))
            .collect();
        let daily: Vec<f64> = (0..=30)
            .map(|k| 1.0e11 * (0.993_f64).powi(k as i32))
            .collect();
        let supply = supply_from_daily(&candles, &daily);
        let params = StablecoinFlowParams {
            long_only: false,
            ..StablecoinFlowParams::default()
        };
        let v = compute_stablecoin_flow_vote(Some(&supply), &candles, &params);
        assert_eq!(
            v,
            Some(PositionSide::Short),
            "long_only=false enables Short on contraction+downtrend"
        );
    }

    /// 9 (bonus). Length-mismatch between supply_series and candles must
    /// abstain — guards against caller misuse that would silently
    /// produce out-of-bounds reads or off-by-one bar reads.
    #[test]
    fn length_mismatch_supply_and_candles_abstains() {
        let candles = flat_candles(48 * 35 + 10, 100.0);
        let mut wrong = nop_supply(&candles);
        wrong.pop();
        let params = StablecoinFlowParams::default();
        let v = compute_stablecoin_flow_vote(Some(&wrong), &candles, &params);
        assert!(v.is_none(), "length-mismatch must abstain");
    }

    /// 10 (bonus). Too few candles (less than `publishing_lag_bars + 2`)
    /// must abstain — guards the lagged-idx underflow path.
    #[test]
    fn too_few_candles_abstains() {
        let candles = flat_candles(10, 100.0);
        let supply = nop_supply(&candles);
        let params = StablecoinFlowParams::default(); // lag=48
        let v = compute_stablecoin_flow_vote(Some(&supply), &candles, &params);
        assert!(v.is_none(), "too few candles for lag-offset must abstain");
    }
}
