// 2026-05-14 Detector #36 — Top-Trader Long/Short Follow Voter (smart-money).
//
// Hypothesis: when the Binance `/futures/data/topLongShortAccountRatio` series
// for a flagship symbol (BTC) prints an unusually long-skewed ratio
// (≥ 1 + `long_threshold`) over `persistence_bars` consecutive samples AND the
// "top" cohort is sufficiently divergent from the GLOBAL accounts series, the
// implication is that informed positioning is leaning bullish. Mirror the
// direction (smart-money FOLLOW). Symmetric short on the downside.
//
// Contrast with the existing Detector #35 (`signals_lsr_contrarian.rs`) which
// reads the GLOBAL accounts series and votes CONTRARIAN. This voter consults
// the TOP accounts series specifically, and the gate is FOLLOW not contrarian.
// To prevent overlap with retail noise, the divergence filter requires
// `|top_ls - global_ls| ≥ min_divergence`.
//
// Lookahead-safety contract (mirrors all 2026-05-13/14 detectors):
//   - Signal bar is `candles.len() - 2` (the just-closed bar).
//   - The persistence window is the LAST N samples of the top-LS feed where
//     `feed.len() == candles.len()` — we read `top_ls[signal_idx - N + 1
//     ..= signal_idx]`. The ENTRY bar's L/S sample (`top_ls[signal_idx + 1]`)
//     is never touched.
//   - SMA confirmation reads the rolling window strictly BEFORE the signal
//     bar (`top_ls[signal_idx - sma_period ..= signal_idx - 1]`) → the
//     direction-confirming mean is independent of the bar that triggered the
//     gate.
//   - The dedicated test `top_ls_must_not_read_entry_bar_ratio` asserts that
//     permuting the LSR value at `bar_idx == signal_idx + 1` does NOT change
//     the vote.
//
// Symbol-allowlist gate: most setups only run this on BTCUSDT (deep enough
// account base on the "top traders" tier). When `asset.symbol` is absent from
// the allowlist the voter returns None unconditionally — the gate cannot
// accidentally fire on a low-liquidity altcoin where the top-trader series
// is dominated by 1-2 whales.
//
// 2026-05-14 — pure helper, no engine state. RegimeConfluence wires it as a
// voter inside the consensus tally; the anchor PollSignal still comes from
// R28V6 / Breakout / MR.

use crate::candle::Candle;
use crate::config::AssetConfig;
use crate::position::PositionSide;

#[derive(Debug, Clone)]
pub struct TopTraderLsParams {
    /// Binance polling cadence in hours (1 in production). Kept as metadata
    /// so the loader's bar-attribution math can ratify the assumed cadence
    /// downstream. The voter itself consumes the already-aligned series.
    pub period_hours: u32,
    /// Long gate: `top_ls ≥ 1 + long_threshold` for every bar in the
    /// persistence window. 0.05 → ratio ≥ 1.05.
    pub long_threshold: f64,
    /// Short gate: `top_ls ≤ 1 - short_threshold` for every bar in the
    /// persistence window. 0.10 → ratio ≤ 0.90. Asymmetric default reflects
    /// the crypto long-bias prior (rarely deep-short on whales).
    pub short_threshold: f64,
    /// Number of consecutive bars whose top-LS sample must satisfy the gate.
    /// Filters single-bar spikes. 3 → 3h persistence at 1h polling cadence.
    pub persistence_bars: usize,
    /// Minimum `|top_ls - global_ls|` to clear the divergence filter. Forces
    /// the vote to fire only when top traders are decoupled from retail.
    pub min_divergence: f64,
    /// Confirmation SMA period (in feed samples). The trailing SMA of the
    /// top-LS series must be in agreement with the side of the gate:
    ///   - Long vote: `sma ≥ 1` (top traders net-long on average).
    ///   - Short vote: `sma ≤ 1` (top traders net-short on average).
    /// 0 → SMA confirmation disabled (no-op).
    pub sma_period: usize,
    /// State-keeping caller's anti-spam window in bars. The pure helper does
    /// not consult it — RegimeConfluence callers may install a cooldown table
    /// keyed by `asset.symbol` to throttle same-side emits.
    pub cooldown_bars: u64,
    /// Size multiplier passed downstream to risk-sizing. Top-trader follow is
    /// a secondary signal so 0.5 keeps it from dominating risk budget when it
    /// agrees with R28V6.
    pub size_mult: f64,
    /// Whitelist of symbols the voter is permitted to fire on. Empty list
    /// means "all symbols allowed" — this matches the rest of the panel's
    /// no-filter default. The recommended live config is
    /// `["BTCUSDT".into()]`.
    pub symbol_allowlist: Vec<String>,
}

impl TopTraderLsParams {
    /// 30m-feed / 1h Binance-polling defaults, BTC-only. Matches the issue
    /// brief and the conservative risk budget recommended for new voters.
    pub fn default_btc_30m() -> Self {
        Self {
            period_hours: 1,
            long_threshold: 0.05,
            short_threshold: 0.10,
            persistence_bars: 3,
            min_divergence: 0.20,
            sma_period: 20,
            cooldown_bars: 12,
            size_mult: 0.5,
            symbol_allowlist: vec!["BTCUSDT".to_string()],
        }
    }
}

impl Default for TopTraderLsParams {
    fn default() -> Self {
        Self::default_btc_30m()
    }
}

/// Match an asset against the allowlist, checking BOTH the raw asset symbol
/// ("BTC-TREND") and the source_symbol ("BTCUSDT") after stripping the
/// "-TREND"/"USDT" suffixes. Caller guarantees the allowlist is non-empty.
/// Mirrors `signals_cme_basis::asset_in_allowlist`.
fn top_trader_allowlist_permits(asset: &AssetConfig, allowlist: &[String]) -> bool {
    let bare = asset.symbol.replace("-TREND", "").to_uppercase();
    let src = asset
        .source_symbol
        .clone()
        .unwrap_or_default()
        .to_uppercase();
    let bare_no_usdt = bare.replace("USDT", "");
    let src_no_usdt = src.replace("USDT", "");
    allowlist.iter().any(|s| {
        let a = s.to_uppercase();
        let a_no_usdt = a.replace("USDT", "");
        a == bare || a == src || a_no_usdt == bare_no_usdt || a_no_usdt == src_no_usdt
    })
}

/// Returns a directional vote when the top-trader L/S persistence + divergence
/// + SMA confirmation contract is satisfied. Returns `None` when the contract
/// fails, any input is missing, the asset is not on the allowlist, or any
/// numerical guard fails.
///
/// `top_ls_series` and `global_ls_series` are forward-filled rate-feeds with
/// `len == candles.len()`. They are produced by `loader::align_top_ls` /
/// `loader::align_funding`-style alignment so the index correspondence is
/// guaranteed. `None` slots inside the series count as "no sample yet" and
/// short-circuit the persistence check.
pub fn compute_top_trader_ls_vote(
    top_ls_series: Option<&[Option<f64>]>,
    global_ls_series: Option<&[Option<f64>]>,
    candles: &[Candle],
    asset: &AssetConfig,
    params: &TopTraderLsParams,
) -> Option<PositionSide> {
    // ─── Symbol allowlist gate — short-circuit BEFORE any series math.
    // Empty allowlist intentionally treated as "all allowed" so the voter
    // can be re-purposed for backtest sweeps without editing config.
    // 2026-05-21 bug-find round: match BOTH asset.symbol ("BTC-TREND") and
    // source_symbol ("BTCUSDT") after suffix-strip. The prior exact-equals
    // on `asset.symbol` never matched the production basket (which uses the
    // "-TREND" form) so the voter silently abstained on every real asset —
    // only the "BTCUSDT" test fixtures matched. Mirror
    // `signals_cme_basis::asset_in_allowlist`.
    if !params.symbol_allowlist.is_empty()
        && !top_trader_allowlist_permits(asset, &params.symbol_allowlist)
    {
        return None;
    }
    if params.persistence_bars == 0 {
        return None;
    }
    if !params.long_threshold.is_finite()
        || !params.short_threshold.is_finite()
        || !params.min_divergence.is_finite()
    {
        return None;
    }
    let top = top_ls_series?;
    let global = global_ls_series?;
    if top.len() != candles.len() || global.len() != candles.len() {
        return None;
    }
    if candles.len() < params.persistence_bars + 1 {
        return None;
    }
    let signal_idx = candles.len().checked_sub(2)?;
    if signal_idx + 1 < params.persistence_bars {
        return None;
    }
    let window_start = signal_idx + 1 - params.persistence_bars;

    // ─── Persistence — every bar in [window_start ..= signal_idx] must
    // agree on the SAME direction. The first matching extreme picks the
    // candidate direction; mismatches inside the window abort.
    let mut direction: Option<PositionSide> = None;
    let long_hi = 1.0 + params.long_threshold;
    let short_lo = 1.0 - params.short_threshold;
    for i in window_start..=signal_idx {
        let v = top[i]?;
        if !v.is_finite() {
            return None;
        }
        let dir_this_bar = if v >= long_hi {
            PositionSide::Long
        } else if v <= short_lo {
            PositionSide::Short
        } else {
            // Bar is inside the deadband — no persistent extreme.
            return None;
        };
        match direction {
            None => direction = Some(dir_this_bar),
            Some(prev) if prev == dir_this_bar => {}
            // Direction flip mid-window → no persistence.
            _ => return None,
        }
    }
    let dir = direction?;

    // ─── Divergence vs retail/global on the SIGNAL bar. The two series can
    // both forward-fill stale values on bars where Binance hadn't emitted a
    // sample yet, so the comparison is informative only when BOTH have
    // landed at least one event.
    let top_at_signal = top[signal_idx]?;
    let global_at_signal = global[signal_idx]?;
    if !top_at_signal.is_finite() || !global_at_signal.is_finite() {
        return None;
    }
    let divergence = top_at_signal - global_at_signal;
    let aligned_long = dir == PositionSide::Long && divergence < params.min_divergence;
    let aligned_short = dir == PositionSide::Short && -divergence < params.min_divergence;
    if aligned_long || aligned_short {
        // Top + retail agree → no edge → skip.
        return None;
    }

    // ─── SMA confirmation — trailing mean of top-LS strictly BEFORE the
    // signal bar must agree with the proposed side. sma_period=0 disables.
    if params.sma_period > 0 {
        if signal_idx < params.sma_period {
            return None;
        }
        let mut sum = 0.0_f64;
        let mut count = 0usize;
        for j in (signal_idx - params.sma_period)..signal_idx {
            let Some(v) = top[j] else {
                return None;
            };
            if !v.is_finite() {
                return None;
            }
            sum += v;
            count += 1;
        }
        if count == 0 {
            return None;
        }
        let sma = sum / count as f64;
        if !sma.is_finite() {
            return None;
        }
        match dir {
            PositionSide::Long if sma < 1.0 => return None,
            PositionSide::Short if sma > 1.0 => return None,
            _ => {}
        }
    }

    // ─── Disable_long / disable_short policy. Mirror the same gate that
    // RegimeConfluence applies at the consensus output so this voter cannot
    // contribute a forbidden direction in the first place.
    if asset.disable_long && dir == PositionSide::Long {
        return None;
    }
    if asset.disable_short && dir == PositionSide::Short {
        return None;
    }
    Some(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::candle::Candle;

    fn candle(t: i64, c: f64) -> Candle {
        Candle::new(t, c, c + 0.5, c - 0.5, c, 100.0)
    }

    fn flat_candles(n: usize) -> Vec<Candle> {
        (0..n)
            .map(|i| candle(i as i64 * 1_800_000, 100.0))
            .collect()
    }

    fn btc_asset() -> AssetConfig {
        let mut a = AssetConfig::default();
        a.symbol = "BTCUSDT".to_string();
        a
    }

    fn alt_asset() -> AssetConfig {
        let mut a = AssetConfig::default();
        a.symbol = "DOGEUSDT".to_string();
        a
    }

    #[test]
    fn top_ls_no_vote_for_non_btc_asset() {
        // Symbol-allowlist gate: DOGEUSDT must short-circuit even when every
        // numerical condition is satisfied.
        let candles = flat_candles(60);
        let n = candles.len();
        let top: Vec<Option<f64>> = (0..n).map(|_| Some(1.10)).collect();
        let global: Vec<Option<f64>> = (0..n).map(|_| Some(0.80)).collect();
        let params = TopTraderLsParams::default_btc_30m();
        let v =
            compute_top_trader_ls_vote(Some(&top), Some(&global), &candles, &alt_asset(), &params);
        assert!(v.is_none(), "non-BTC asset must abstain via allowlist gate");
    }

    #[test]
    fn top_ls_long_fires_on_persistent_high_ratio() {
        // 3 consecutive bars at 1.08 (>= 1.05 long_threshold) + global at 0.80
        // (divergence = +0.28 > +0.20 min) + SMA period 20 of priors at 1.06
        // (>= 1.0) → Long.
        let candles = flat_candles(60);
        let n = candles.len();
        let mut top: Vec<Option<f64>> = (0..n).map(|_| Some(1.06)).collect();
        // signal_idx = n-2 = 58. Persistence window covers 56..=58.
        top[56] = Some(1.08);
        top[57] = Some(1.08);
        top[58] = Some(1.08);
        let global: Vec<Option<f64>> = (0..n).map(|_| Some(0.80)).collect();
        let params = TopTraderLsParams::default_btc_30m();
        let v =
            compute_top_trader_ls_vote(Some(&top), Some(&global), &candles, &btc_asset(), &params);
        assert_eq!(v, Some(PositionSide::Long));
    }

    #[test]
    fn top_ls_short_fires_on_persistent_low_ratio() {
        // Persistence window at 0.85 → <= 1-0.10 = 0.90 short gate.
        // Global at 1.20 → divergence = 0.85 - 1.20 = -0.35, |.| > 0.20.
        // SMA priors at 0.92 → < 1.0 → short SMA-confirm passes.
        let candles = flat_candles(60);
        let n = candles.len();
        let mut top: Vec<Option<f64>> = (0..n).map(|_| Some(0.92)).collect();
        top[56] = Some(0.85);
        top[57] = Some(0.85);
        top[58] = Some(0.85);
        let global: Vec<Option<f64>> = (0..n).map(|_| Some(1.20)).collect();
        let params = TopTraderLsParams::default_btc_30m();
        let v =
            compute_top_trader_ls_vote(Some(&top), Some(&global), &candles, &btc_asset(), &params);
        assert_eq!(v, Some(PositionSide::Short));
    }

    #[test]
    fn top_ls_divergence_filter_blocks_when_aligned_with_retail() {
        // Top-LS is high, but GLOBAL is ALSO high (small divergence) → no
        // edge → abstain. divergence = 1.10 - 1.00 = +0.10 < +0.20 min.
        let candles = flat_candles(60);
        let n = candles.len();
        let mut top: Vec<Option<f64>> = (0..n).map(|_| Some(1.08)).collect();
        top[56] = Some(1.10);
        top[57] = Some(1.10);
        top[58] = Some(1.10);
        let global: Vec<Option<f64>> = (0..n).map(|_| Some(1.00)).collect();
        let params = TopTraderLsParams::default_btc_30m();
        let v =
            compute_top_trader_ls_vote(Some(&top), Some(&global), &candles, &btc_asset(), &params);
        assert!(
            v.is_none(),
            "top+retail aligned long means no informational edge"
        );
    }

    #[test]
    fn top_ls_persistence_filter_blocks_single_spike() {
        // Only signal-bar prints the extreme — the two prior bars are inside
        // the deadband → persistence broken.
        let candles = flat_candles(60);
        let n = candles.len();
        let mut top: Vec<Option<f64>> = (0..n).map(|_| Some(1.02)).collect();
        // Persistence window = 56..=58. 56 + 57 inside deadband, 58 = spike.
        top[58] = Some(1.10);
        let global: Vec<Option<f64>> = (0..n).map(|_| Some(0.80)).collect();
        let params = TopTraderLsParams::default_btc_30m();
        let v =
            compute_top_trader_ls_vote(Some(&top), Some(&global), &candles, &btc_asset(), &params);
        assert!(v.is_none(), "single-bar spike must NOT fire");
    }

    #[test]
    fn top_ls_must_not_read_entry_bar_ratio() {
        // Lookahead guard. Build a known-positive case, then permute the
        // entry-bar sample (`signal_idx + 1`) and assert the vote is
        // unchanged. If the helper accidentally peeked at `top[n-1]` the
        // result would flip.
        let candles = flat_candles(60);
        let n = candles.len();
        let mut top: Vec<Option<f64>> = (0..n).map(|_| Some(1.06)).collect();
        top[56] = Some(1.08);
        top[57] = Some(1.08);
        top[58] = Some(1.08);
        let global: Vec<Option<f64>> = (0..n).map(|_| Some(0.80)).collect();
        let params = TopTraderLsParams::default_btc_30m();
        let baseline =
            compute_top_trader_ls_vote(Some(&top), Some(&global), &candles, &btc_asset(), &params);
        assert_eq!(baseline, Some(PositionSide::Long));
        // Permute the entry-bar sample to an extreme SHORT value. If the
        // helper reads it, the vote will either flip or vanish.
        let mut top_permuted = top.clone();
        top_permuted[n - 1] = Some(0.20);
        let permuted = compute_top_trader_ls_vote(
            Some(&top_permuted),
            Some(&global),
            &candles,
            &btc_asset(),
            &params,
        );
        assert_eq!(
            permuted, baseline,
            "entry-bar sample MUST NOT influence the vote"
        );
    }

    #[test]
    fn top_ls_handles_missing_data_safely() {
        let candles = flat_candles(60);
        // 1. top_ls is None entirely.
        let global: Vec<Option<f64>> = (0..candles.len()).map(|_| Some(0.80)).collect();
        let params = TopTraderLsParams::default_btc_30m();
        let v = compute_top_trader_ls_vote(None, Some(&global), &candles, &btc_asset(), &params);
        assert!(v.is_none(), "missing top-series must abstain");
        // 2. top_ls present but one entry inside the persistence window is None.
        let mut top: Vec<Option<f64>> = (0..candles.len()).map(|_| Some(1.06)).collect();
        top[57] = None; // gap inside the persistence window
        top[56] = Some(1.08);
        top[58] = Some(1.08);
        let v2 =
            compute_top_trader_ls_vote(Some(&top), Some(&global), &candles, &btc_asset(), &params);
        assert!(v2.is_none(), "None inside persistence window must abstain");
        // 3. Series length mismatch.
        let short_top: Vec<Option<f64>> = top.iter().take(5).cloned().collect();
        let v3 = compute_top_trader_ls_vote(
            Some(&short_top),
            Some(&global),
            &candles,
            &btc_asset(),
            &params,
        );
        assert!(v3.is_none(), "series-length mismatch must abstain");
    }

    #[test]
    fn top_ls_sma_confirm_required_for_long() {
        // Persistence window is bullish-extreme, divergence passes, but the
        // SMA-period 20 of the PRIOR bars sits below 1.0 → SMA-confirm fails.
        let candles = flat_candles(60);
        let n = candles.len();
        let mut top: Vec<Option<f64>> = (0..n).map(|_| Some(0.95)).collect();
        // Persistence window at 1.08 (>= 1.05 long gate).
        top[56] = Some(1.08);
        top[57] = Some(1.08);
        top[58] = Some(1.08);
        let global: Vec<Option<f64>> = (0..n).map(|_| Some(0.60)).collect();
        let params = TopTraderLsParams::default_btc_30m();
        let v =
            compute_top_trader_ls_vote(Some(&top), Some(&global), &candles, &btc_asset(), &params);
        assert!(v.is_none(), "trailing SMA below 1.0 must block a Long vote");
    }

    #[test]
    fn respects_disable_short() {
        // Setup: Short would fire by every other rule, but asset.disable_short
        // is true → must abstain.
        let candles = flat_candles(60);
        let n = candles.len();
        let mut top: Vec<Option<f64>> = (0..n).map(|_| Some(0.92)).collect();
        top[56] = Some(0.85);
        top[57] = Some(0.85);
        top[58] = Some(0.85);
        let global: Vec<Option<f64>> = (0..n).map(|_| Some(1.20)).collect();
        let params = TopTraderLsParams::default_btc_30m();
        let mut asset = btc_asset();
        asset.disable_short = true;
        let v = compute_top_trader_ls_vote(Some(&top), Some(&global), &candles, &asset, &params);
        assert!(v.is_none(), "disable_short asset MUST NOT vote Short");
    }
}
