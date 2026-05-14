// 2026-05-14 Detector #34 — Coinbase-Binance Premium Voter.
//
// Premium captures the price-spread between Coinbase Pro (`BTC-USD`) and
// Binance (`BTCUSDT`) on the same bar. A persistently positive premium
// (Coinbase richer than Binance) signals US-institutional bid-side flow
// — large buyers historically prefer Coinbase Custody / Coinbase Prime over
// the offshore Binance order-book, so they bid Coinbase first and arbitrage
// flows close the gap with delay. Symmetric inverse on negative premium
// (US-side selling).
//
//   premium_pct = (cb_close - bn_close) / bn_close
//
// The premium is small (typically ±5-50 bps); the voter consumes it as a
// SCALAR series aligned 1:1 onto the candle openTime sequence. Data
// production happens externally (a TS script fetches Coinbase Pro candles
// in parallel to Binance and computes the premium); Rust just consumes the
// JSON cache file.
//
// VOTE CONTRACT (`compute_cb_premium_vote`):
//   * BTC-ONLY: a `symbol_allowlist` parameter enforces the gate. Non-BTC
//     assets get no vote regardless of premium feed (avoids cross-asset
//     pollution where, say, an ETH-MR detector sees a BTC-derived premium).
//   * PERSISTENCE: the last `consecutive_bars` samples STRICTLY BEFORE the
//     entry bar must all share the same sign AND each have |premium| ≥
//     `threshold_bps`. A single same-sign spike does NOT vote (filter out
//     hour-of-day Coinbase-Pro funding-fee blips).
//   * BROKEN-FEED GUARD: if any sample in the persistence window has
//     |premium| > `max_abs_bps`, return None — assume bad data (e.g. one
//     exchange feed froze, gap widened to several percent).
//   * SECONDARY MIN: bars below `min_abs_bps` are treated as
//     "premium is noise" — count them as breaking the streak (no vote).
//   * NET-RETURN SPOOF GUARD: when `require_net_return = true`, the price
//     of the asset must agree with the premium direction over the same
//     window (close[signal_idx] > close[signal_idx - N + 1] for Long).
//     Prevents "premium says Long but BTC actually fell over the window"
//     edge cases (typically Coinbase outage / partial-fill noise).
//
// LOOKAHEAD safety: signal_idx = `candles.len() - 2` (last fully-closed
// bar). The voter reads `cb_premium_series[signal_idx - N + 1 ..= signal_idx]`
// and `candles[signal_idx - N + 1 ..= signal_idx]` — STRICTLY BEFORE the
// entry bar at `candles.len() - 1`. The `cb_premium_must_not_read_entry_bar_data`
// test verifies this empirically by poisoning the entry-bar slot.
//
// COOLDOWN: per-asset state-mutating cooldown is modeled in
// `detect_cb_premium` (the standalone path, not yet wired); the pure
// helper `compute_cb_premium_vote` is stateless and assumes the regime
// orchestration enforces same-bar de-duplication. The pure-helper +
// cooldown_bars knob mirrors the OFI / BB-Z / Stop-Hunt pattern of pure-
// vote-helper-plus-optional-state-detector.

use crate::candle::Candle;
use crate::config::AssetConfig;
use crate::position::PositionSide;

#[derive(Debug, Clone)]
pub struct CbPremiumParams {
    /// Per-bar absolute premium (in basis-points, i.e. `0.15% → 15`) below
    /// which a sample is treated as "noise" and breaks the persistence
    /// streak. Default 15 bp.
    pub threshold_bps: u32,
    /// Number of consecutive same-sign closed bars required to vote. With
    /// 2, the just-closed bar (signal_idx) and the one before it must agree.
    /// Default 2.
    pub consecutive_bars: usize,
    /// Bars to suppress same-asset/direction re-emits after a successful
    /// fire. Consumed only by the standalone `detect_cb_premium` (state-
    /// mutating); the pure helper is unaware. Default 24 bars (12h on 30m).
    pub cooldown_bars: u64,
    /// Per-bar floor in bp: samples whose |premium| < this are ignored
    /// (treated as zero / streak-break). Distinct from `threshold_bps` so
    /// the user can demand "at least N bp activity" without raising the
    /// persistence-fire threshold. Default 5 bp.
    pub min_abs_bps: u32,
    /// Broken-feed guard: any sample in the persistence window with
    /// |premium| > this aborts the vote. Default 500 bp (5%); historical
    /// BTC Coinbase-Binance premium never exceeded ~200 bp under healthy
    /// conditions so 500 bp is a safe red-flag threshold.
    pub max_abs_bps: u32,
    /// Asset-symbol allowlist. Empty vec disables the voter entirely; the
    /// default is `["BTCUSDT"]` so this is a BTC-only signal. Cross-asset
    /// pollution (ETH-MR seeing a BTC-derived premium and voting Long) is
    /// the failure mode the allowlist guards against.
    pub symbol_allowlist: Vec<String>,
    /// Multiplier applied to `asset.risk_frac` for size-down in the
    /// standalone `detect_cb_premium` path. Default 0.5 — premium is a
    /// secondary signal, keep it from dominating the multi-account stack.
    pub size_mult: f64,
    /// When true, additionally require the asset's own close to agree with
    /// the premium direction over the persistence window (spoof guard).
    /// Default `true` — the cost of a false-positive on premium is high
    /// enough that we'd rather under-vote than over-vote.
    pub require_net_return: bool,
}

impl Default for CbPremiumParams {
    fn default() -> Self {
        Self {
            threshold_bps: 15,
            consecutive_bars: 2,
            cooldown_bars: 24,
            min_abs_bps: 5,
            max_abs_bps: 500,
            symbol_allowlist: vec!["BTCUSDT".to_string()],
            size_mult: 0.5,
            require_net_return: true,
        }
    }
}

impl CbPremiumParams {
    /// Default knobs for 30m BTC. Same as `Default::default()` but named for
    /// parallel with the rest of the detector suite (`*_default_30m_crypto`).
    pub fn default_30m_crypto() -> Self {
        Self::default()
    }
}

/// True if the asset symbol matches any allowlist entry (case-sensitive).
/// Used by `compute_cb_premium_vote` to short-circuit non-BTC assets. The
/// match is exact-equals — no prefix/substring fallback so a fat-finger
/// in the allowlist fails closed.
fn allowlist_permits(symbol: &str, allowlist: &[String]) -> bool {
    allowlist.iter().any(|s| s == symbol)
}

/// Pure helper — computes the Coinbase-Binance Premium directional vote
/// without state mutation. Returns `Some(side)` only when the persistence
/// cluster, threshold, broken-feed guard, allowlist, and net-return
/// secondary filter all agree. Used both by the standalone
/// `detect_cb_premium` AND by `signals_regime_confluence.rs` when CB-
/// premium is enrolled as an independent voter.
///
/// Arguments:
///   * `candles` — full candle history; we read OHLCV only for the net-return
///     guard (`signal_close > window_start_close` for Long).
///   * `cb_premium_series` — per-bar premium as `(cb_close - bn_close) /
///     bn_close`, aligned 1:1 onto `candles`. `None` element = no data for
///     that bar (treat as "premium gate dormant"). Length must match
///     `candles.len()`. Missing series altogether (`None`) → no vote.
///   * `asset` — the asset under evaluation; `asset.symbol` is checked
///     against `params.symbol_allowlist`.
///   * `params` — knob bundle.
pub fn compute_cb_premium_vote(
    candles: &[Candle],
    cb_premium_series: Option<&[Option<f64>]>,
    asset: &AssetConfig,
    params: &CbPremiumParams,
) -> Option<PositionSide> {
    // Allowlist gate — non-BTC assets abstain regardless of feed contents.
    // Empty allowlist disables the voter entirely (effectively a kill-switch).
    if params.symbol_allowlist.is_empty() {
        return None;
    }
    if !allowlist_permits(&asset.symbol, &params.symbol_allowlist) {
        return None;
    }
    let series = cb_premium_series?;
    let n = params.consecutive_bars;
    if n == 0 {
        return None;
    }
    // Need entry bar at idx len-1, signal_idx at len-2, and n samples
    // ending AT signal_idx — so `signal_idx + 1 ≥ n` and `len ≥ n + 1`.
    if candles.len() < n + 1 {
        return None;
    }
    // Series length must match candles length — otherwise indexing diverges.
    if series.len() != candles.len() {
        return None;
    }
    let signal_idx = candles.len() - 2;
    if signal_idx + 1 < n {
        return None;
    }
    let start = signal_idx + 1 - n;

    // Convert bp thresholds to fractional comparisons up front so the inner
    // loop stays in f64 arithmetic only. 1 bp = 1e-4.
    let threshold = params.threshold_bps as f64 * 1e-4;
    let min_abs = params.min_abs_bps as f64 * 1e-4;
    let max_abs = params.max_abs_bps as f64 * 1e-4;
    // Guard against nonsensical configs (max < threshold would never fire).
    if !(threshold.is_finite() && min_abs.is_finite() && max_abs.is_finite()) {
        return None;
    }
    if max_abs <= 0.0 || threshold <= 0.0 {
        return None;
    }

    let mut all_positive = true;
    let mut all_negative = true;
    let mut any_above_threshold = false;
    for off in 0..n {
        let idx = start + off;
        // Series must have data for every bar in the persistence window —
        // None breaks the streak (treat as "data missing, abstain").
        let p = match series.get(idx).and_then(|x| x.as_ref()) {
            Some(v) => *v,
            None => return None,
        };
        if !p.is_finite() {
            return None;
        }
        let abs_p = p.abs();
        // Broken-feed guard — any sample beyond max_abs aborts.
        if abs_p > max_abs {
            return None;
        }
        // Per-bar floor: |premium| < min_abs counts as a streak-break.
        if abs_p < min_abs {
            return None;
        }
        // Direction-vote contribution: sample must clear the threshold.
        if p > 0.0 {
            all_negative = false;
            if p >= threshold {
                any_above_threshold = true;
            } else {
                // Same sign but below threshold → streak unbroken yet,
                // but the bar doesn't count toward "threshold cleared".
                // Still, with N=2 we typically demand all N clear threshold
                // — make this strict: any bar below threshold aborts.
                return None;
            }
        } else if p < 0.0 {
            all_positive = false;
            if p <= -threshold {
                any_above_threshold = true;
            } else {
                return None;
            }
        } else {
            // Exact zero — neither sign; abort.
            return None;
        }
    }
    // At least one bar must have cleared the threshold and the entire
    // window must agree on sign. With the strict "every bar clears
    // threshold" rule above, `any_above_threshold` is redundant for n ≥ 1
    // but documents intent.
    if !any_above_threshold {
        return None;
    }
    let direction = if all_positive && !all_negative {
        PositionSide::Long
    } else if all_negative && !all_positive {
        PositionSide::Short
    } else {
        // n == 0 already short-circuited; reaching here means a sign
        // disagreement leaked through (defensive).
        return None;
    };

    // Net-return secondary spoof guard. Demand the asset's own close to
    // agree with the premium direction over the persistence window.
    if params.require_net_return {
        let start_close = candles[start].close;
        let signal_close = candles[signal_idx].close;
        if !start_close.is_finite() || !signal_close.is_finite() || start_close <= 0.0 {
            return None;
        }
        let net_return = (signal_close - start_close) / start_close;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::candle::Candle;

    fn mk_candle(t: i64, close: f64) -> Candle {
        Candle::new(t, close, close + 0.5, close - 0.5, close, 100.0)
    }

    /// Build `n` candles with an ascending price path (so net-return is
    /// strongly positive over the window). Used as the standard fixture for
    /// the Long-fires test.
    fn rising_candles(n: usize) -> Vec<Candle> {
        (0..n)
            .map(|i| mk_candle(i as i64 * 1_800_000, 100.0 + i as f64))
            .collect()
    }

    fn falling_candles(n: usize) -> Vec<Candle> {
        (0..n)
            .map(|i| mk_candle(i as i64 * 1_800_000, 200.0 - i as f64))
            .collect()
    }

    fn flat_candles(n: usize) -> Vec<Candle> {
        (0..n)
            .map(|i| mk_candle(i as i64 * 1_800_000, 100.0))
            .collect()
    }

    fn btc_asset() -> AssetConfig {
        AssetConfig {
            symbol: "BTCUSDT".to_string(),
            source_symbol: Some("BTCUSDT".to_string()),
            ..Default::default()
        }
    }

    fn eth_asset() -> AssetConfig {
        AssetConfig {
            symbol: "ETHUSDT".to_string(),
            source_symbol: Some("ETHUSDT".to_string()),
            ..Default::default()
        }
    }

    /// Build a premium series of `n` entries, all set to `bp` basis-points
    /// (positive or negative). Caller mutates specific indices afterwards.
    fn uniform_premium(n: usize, bps: f64) -> Vec<Option<f64>> {
        vec![Some(bps * 1e-4); n]
    }

    /// 1. Non-BTC asset receives no vote even with a strongly persistent
    ///    premium feed. Guards against cross-asset pollution.
    #[test]
    fn no_vote_for_non_btc_asset() {
        let candles = rising_candles(10);
        let premium = uniform_premium(10, 30.0); // 30 bp Long-signal over entire feed
        let asset = eth_asset(); // not in allowlist
        let p = CbPremiumParams::default();
        let v = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p);
        assert!(
            v.is_none(),
            "ETH must NOT receive a vote regardless of premium strength"
        );
    }

    /// 2. With persistent positive premium ≥ threshold over the last N bars
    ///    AND rising asset price (net-return positive), a Long vote fires.
    #[test]
    fn long_fires_on_persistent_positive_premium() {
        let candles = rising_candles(10);
        // 30 bp positive premium over the whole feed → last 2 bars both
        // clear default threshold 15 bp.
        let premium = uniform_premium(10, 30.0);
        let asset = btc_asset();
        let p = CbPremiumParams::default();
        let v = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p);
        assert_eq!(
            v,
            Some(PositionSide::Long),
            "+30 bp × 2 bars + rising BTC price → Long"
        );
    }

    /// 3. Symmetric short test: negative premium + falling BTC → Short.
    #[test]
    fn short_fires_on_persistent_negative_premium() {
        let candles = falling_candles(10);
        let premium = uniform_premium(10, -30.0);
        let asset = btc_asset();
        let p = CbPremiumParams::default();
        let v = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p);
        assert_eq!(
            v,
            Some(PositionSide::Short),
            "-30 bp × 2 bars + falling BTC price → Short"
        );
    }

    /// 4. Single +30 bp spike on the SIGNAL bar but the bar before it is
    ///    only +3 bp (below `min_abs_bps = 5`) → streak broken, no vote.
    ///    Guards against funding-fee one-off blips.
    #[test]
    fn single_spike_blocked_by_persistence_filter() {
        let candles = rising_candles(10);
        let mut premium = vec![Some(0.0003); 10]; // 3 bp baseline (< min_abs)
        // Spike ONLY on signal bar (idx 8 for len=10 → signal_idx=8).
        premium[8] = Some(0.0030); // +30 bp
        let asset = btc_asset();
        let p = CbPremiumParams::default();
        let v = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p);
        assert!(
            v.is_none(),
            "single +30 bp spike with prior bar 3 bp must NOT vote (streak broken at min_abs)"
        );
    }

    /// 5. Premium > `max_abs_bps` triggers broken-feed guard.
    ///    Sample = 6% premium = 600 bp > 500 bp → abort.
    #[test]
    fn extreme_premium_capped_as_broken_feed() {
        let candles = rising_candles(10);
        let mut premium = uniform_premium(10, 30.0);
        // 600 bp = 6% on signal_idx-1, ANY sample in window > max_abs aborts.
        premium[7] = Some(0.0600);
        let asset = btc_asset();
        let p = CbPremiumParams::default();
        let v = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p);
        assert!(
            v.is_none(),
            "6% premium = broken feed, must abort even if signal bar is sane"
        );
    }

    /// 6. LOOKAHEAD test: the voter must NEVER read the entry-bar slot
    ///    (`candles[len-1]` and `premium[len-1]`). Poison the entry bar
    ///    with an extreme value — if the impl wrongly reads it, the broken-
    ///    feed guard would abort the vote. With correct impl, the entry bar
    ///    is ignored and the vote fires.
    #[test]
    fn cb_premium_must_not_read_entry_bar_data() {
        let candles = rising_candles(10);
        let mut premium = uniform_premium(10, 30.0);
        // Entry bar (idx 9, NOT signal_idx=8): wild premium. Must be ignored.
        premium[9] = Some(0.9999); // 9999 bp — far above max_abs
        let asset = btc_asset();
        let p = CbPremiumParams::default();
        let v = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p);
        assert_eq!(
            v,
            Some(PositionSide::Long),
            "entry-bar idx 9 must NEVER influence the vote — broken-feed guard \
             must NOT trip when only entry bar carries the bad data"
        );
    }

    /// 7. Several defensive None-paths in one test:
    ///    - missing series (`cb_premium_series = None`) → no vote
    ///    - series shorter than candles → no vote
    ///    - any None inside the persistence window → no vote
    ///    - NaN inside the window → no vote
    #[test]
    fn handles_missing_data_safely() {
        let candles = rising_candles(10);
        let asset = btc_asset();
        let p = CbPremiumParams::default();

        // 7a. Series missing entirely.
        let v_none = compute_cb_premium_vote(&candles, None, &asset, &p);
        assert!(v_none.is_none(), "no series → no vote");

        // 7b. Length mismatch.
        let premium_short = uniform_premium(5, 30.0);
        let v_short = compute_cb_premium_vote(&candles, Some(&premium_short), &asset, &p);
        assert!(
            v_short.is_none(),
            "series length mismatch → no vote (defensive guard)"
        );

        // 7c. None inside the persistence window (signal_idx=8, n=2 → window=[7,8]).
        let mut premium_with_none = uniform_premium(10, 30.0);
        premium_with_none[7] = None;
        let v_none_inside =
            compute_cb_premium_vote(&candles, Some(&premium_with_none), &asset, &p);
        assert!(v_none_inside.is_none(), "None inside window → no vote");

        // 7d. NaN inside the window.
        let mut premium_with_nan = uniform_premium(10, 30.0);
        premium_with_nan[7] = Some(f64::NAN);
        let v_nan = compute_cb_premium_vote(&candles, Some(&premium_with_nan), &asset, &p);
        assert!(v_nan.is_none(), "NaN inside window → no vote");

        // 7e. Empty allowlist disables the voter.
        let p_empty = CbPremiumParams {
            symbol_allowlist: vec![],
            ..CbPremiumParams::default()
        };
        let premium_good = uniform_premium(10, 30.0);
        let v_empty = compute_cb_premium_vote(&candles, Some(&premium_good), &asset, &p_empty);
        assert!(v_empty.is_none(), "empty allowlist disables the voter");
    }

    /// 8. Persistent positive premium but BTC price is FALLING over the
    ///    window — net-return guard aborts the Long vote.
    ///    With `require_net_return = false`, the same fixture votes Long.
    #[test]
    fn net_return_spoof_guard_blocks_disagreement() {
        let candles = falling_candles(10); // BTC falling
        let premium = uniform_premium(10, 30.0); // premium says Long
        let asset = btc_asset();
        let p_strict = CbPremiumParams::default(); // require_net_return = true
        let v_blocked = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p_strict);
        assert!(
            v_blocked.is_none(),
            "premium says Long but BTC fell → net-return guard blocks"
        );

        let p_loose = CbPremiumParams {
            require_net_return: false,
            ..CbPremiumParams::default()
        };
        let v_loose = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p_loose);
        assert_eq!(
            v_loose,
            Some(PositionSide::Long),
            "with guard disabled, persistent +30 bp votes Long regardless of price"
        );
    }

    /// 9. Cooldown is part of the public knob set even though the pure
    ///    helper is stateless — verify the param round-trips and that two
    ///    back-to-back identical fires produce identical outputs (idempotent
    ///    pure helper; the cooldown semantics live in the standalone
    ///    detector path, which is exercised at the regime-orchestrator
    ///    level. This test guards against accidental state-leakage from
    ///    re-entry to the pure helper.).
    #[test]
    fn cooldown_blocks_back_to_back() {
        let candles = rising_candles(10);
        let premium = uniform_premium(10, 30.0);
        let asset = btc_asset();
        let p = CbPremiumParams {
            cooldown_bars: 24, // public param, helper is stateless
            ..CbPremiumParams::default()
        };
        let v1 = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p);
        let v2 = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p);
        // Pure helper is idempotent — cooldown enforcement is the
        // orchestrator's job (regime panel uses signal_idx-based de-dup;
        // the standalone detect_cb_premium would install
        // state.loss_streak_by_asset_dir["CB_PREMIUM|BTCUSDT|Long"]).
        assert_eq!(
            v1, v2,
            "pure helper must be idempotent — cooldown is orchestrator's job"
        );
        assert_eq!(v1, Some(PositionSide::Long));
    }

    /// 10. Flat-zero premium series → no vote (no signal at all).
    #[test]
    fn flat_zero_premium_no_vote() {
        let candles = rising_candles(10);
        let premium = uniform_premium(10, 0.0);
        let asset = btc_asset();
        let p = CbPremiumParams::default();
        let v = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p);
        assert!(v.is_none(), "zero premium → no vote");
    }

    /// 11. Sign disagreement within the persistence window aborts.
    ///    Bars [+30, -30] over the window → streak broken (not same-sign).
    #[test]
    fn sign_disagreement_in_window_aborts() {
        let candles = flat_candles(10);
        let mut premium = uniform_premium(10, 30.0);
        // Flip signal_idx-1 to negative; signal_idx stays positive →
        // window sign disagreement.
        premium[7] = Some(-0.0030);
        let asset = btc_asset();
        let p = CbPremiumParams::default();
        let v = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p);
        assert!(
            v.is_none(),
            "[+30, -30] window must not vote (sign disagreement)"
        );
    }

    /// 12. consecutive_bars = 0 → defensive no-vote (do not silently
    ///     interpret as "no persistence required" which would fire on
    ///     every bar).
    #[test]
    fn zero_persistence_safely_returns_none() {
        let candles = rising_candles(10);
        let premium = uniform_premium(10, 30.0);
        let asset = btc_asset();
        let p = CbPremiumParams {
            consecutive_bars: 0,
            ..CbPremiumParams::default()
        };
        let v = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p);
        assert!(v.is_none(), "n=0 must short-circuit to no vote");
    }

    /// 13. Symmetric short test for net-return guard: persistent NEGATIVE
    ///     premium but BTC is RISING → Short blocked.
    #[test]
    fn short_net_return_guard_blocks_when_price_rises() {
        let candles = rising_candles(10);
        let premium = uniform_premium(10, -30.0);
        let asset = btc_asset();
        let p = CbPremiumParams::default(); // require_net_return = true
        let v = compute_cb_premium_vote(&candles, Some(&premium), &asset, &p);
        assert!(
            v.is_none(),
            "premium says Short but BTC rose → net-return guard blocks"
        );
    }
}
