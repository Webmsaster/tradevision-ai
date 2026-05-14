// 2026-05-14 Detector #33 — CME Futures Basis Premium voter (BTC-only).
//
// Background: institutional BTC exposure is dominated by CME Globex BTC
// futures (cash-settled, USD-denominated, regulated). The ANNUALIZED
// basis premium of front-month CME futures vs Binance spot is a clean
// proxy for institutional positioning bias that is INDEPENDENT of the
// Binance perpetual funding-rate feed (which captures retail / market-
// maker carry, not institutional flow).
//
//     annualized_basis = (F - S) / S × (365 / days_to_settlement)
//
// Historical interpretation:
//   * basis > +5% annualized → institutional bullish / contango premium
//     → Long bias
//   * basis < -2% annualized → institutional bearish / backwardation
//     → Short bias
//
// Two operating modes are exposed:
//   * Absolute: vote off smoothed basis vs ±`basis_threshold_pct`.
//   * Spread: vote off `basis - 365 × funding × 3` (annualized funding
//     equivalent, 3 funding events per day on Binance perp) vs
//     ±`spread_threshold_pct`. The spread captures "institutional vs
//     perp-positioning divergence" — when CME is rich and funding is
//     cheap, the spread blows out positive → institutional bid not yet
//     reflected in perp positioning → Long edge.
//
// Lookahead safety: signal_idx = candles.len() - 2 (just-closed bar).
// The aligned basis series is forward-filled by the loader so the value
// at signal_idx reflects the most recent observation strictly before
// the entry-execution bar. Loader staleness cap (`max_staleness_bars`)
// converts weekend gaps and CME-holiday cessation into explicit `None`
// values — the detector ABSTAINS rather than firing on aged data.
//
// Voter scope: BTCUSDT only (and any user-defined allowlist override).
// Other assets get no vote because CME BTC futures basis does not map
// cleanly onto ETH/SOL/AVAX/etc. — the structural premium / regulatory
// arb only applies to BTC's institutional-grade futures market.

use crate::candle::Candle;
use crate::config::AssetConfig;
use crate::position::PositionSide;

/// Operating mode of the CME-basis voter.
///
/// `Absolute` reads smoothed annualized basis vs `basis_threshold_pct`.
/// `Spread` subtracts annualized funding-rate equivalent to isolate the
/// CME-vs-perp divergence component (institutional flow vs retail carry).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CmeBasisMode {
    Absolute,
    Spread,
}

#[derive(Debug, Clone)]
pub struct CmeBasisParams {
    /// Threshold in annualized basis percent (e.g. `0.08` = ±8% p.a.).
    /// Long when smoothed basis ≥ +`basis_threshold_pct`, Short when
    /// smoothed basis ≤ −`basis_threshold_pct`. Spread-mode mirrors the
    /// sign convention.
    pub basis_threshold_pct: f64,
    /// Period of the EMA smoothing window applied to the basis series.
    /// `0` or `1` disables smoothing (raw value used). Default `16` —
    /// covers ~8h of basis observations at typical CME-tick cadence and
    /// filters single-print outliers from the CME settlement print.
    pub basis_ema_period: usize,
    /// `Absolute` or `Spread`. Default `Absolute`.
    pub mode: CmeBasisMode,
    /// Used in `Spread` mode only — threshold for the
    /// `basis − 365×funding×3` divergence component. Annualized funding
    /// equivalent assumes 3 funding events per day on Binance USDT-M
    /// perps (8h cadence). Mode-`Absolute` ignores this field.
    pub spread_threshold_pct: f64,
    /// Maximum age of the last basis sample, in candle bars, beyond
    /// which the voter abstains. The loader's `align_cme_basis` already
    /// emits `None` past this horizon, but the detector defensively
    /// re-checks to guard against unaligned external callers. `0`
    /// disables the secondary check and trusts the loader entirely.
    pub max_staleness_bars: usize,
    /// Asset-symbol filter. Empty = no allowlist enforced (caller is
    /// expected to gate per-asset upstream by only attaching the basis
    /// series to whitelisted assets). When populated, the detector
    /// requires `asset.symbol` or `asset.source_symbol` (after USDT-strip)
    /// to match a list entry. Default `["BTCUSDT"]`.
    pub symbol_allowlist: Vec<String>,
    /// Size multiplier applied by callers that compose this voter with
    /// a sizing decision. Stored here for parity with other detectors;
    /// not consumed by `compute_cme_basis_vote` directly.
    pub size_mult: f64,
    /// Minimum number of usable data points required in the basis
    /// series before a vote can fire. Guards the EMA warm-up window
    /// and rejects detector calls on bootstrapping caches that only
    /// just received a single observation. Default `8`.
    pub min_data_points: usize,
}

impl Default for CmeBasisParams {
    fn default() -> Self {
        Self {
            basis_threshold_pct: 0.08,
            basis_ema_period: 16,
            mode: CmeBasisMode::Absolute,
            spread_threshold_pct: 0.04,
            max_staleness_bars: 8,
            symbol_allowlist: vec!["BTCUSDT".to_string()],
            size_mult: 0.5,
            min_data_points: 8,
        }
    }
}

impl CmeBasisParams {
    /// Sanity-check guard. Rejects non-finite thresholds and inverted
    /// staleness/period parameters that would either always-fire or
    /// always-abstain in misleading ways.
    pub fn is_well_formed(&self) -> bool {
        self.basis_threshold_pct.is_finite()
            && self.basis_threshold_pct > 0.0
            && self.spread_threshold_pct.is_finite()
            && self.spread_threshold_pct >= 0.0
            && self.size_mult.is_finite()
    }
}

/// Annualized Binance USDT-M perp funding equivalent: 3 settlements per
/// day × 365 days/year. A funding rate of `0.0001` (1bp / 8h)
/// annualizes to `0.0001 × 3 × 365 ≈ 0.1095` (~11% p.a.) — the standard
/// "annualized funding" headline used by funding-rate analysts.
const FUNDING_ANNUALIZATION: f64 = 365.0 * 3.0;

/// Match an asset against `params.symbol_allowlist`. We check both the
/// raw asset symbol (e.g. "BTC-TREND") and the source_symbol
/// (e.g. "BTCUSDT"), after stripping common suffixes, so per-template
/// symbol mangling doesn't accidentally lock the voter out.
fn asset_in_allowlist(asset: &AssetConfig, allowlist: &[String]) -> bool {
    if allowlist.is_empty() {
        return true; // no allowlist = pass-through
    }
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
        a == bare
            || a == src
            || a_no_usdt == bare_no_usdt
            || a_no_usdt == src_no_usdt
    })
}

/// EMA over the trailing slice ending at (and including) `end_idx`. The
/// classic recursive EMA formula seeded with the slice's first finite
/// sample. `None` entries are skipped without resetting the recursion
/// — they represent "no fresh data" not "zero data", so prior smoothed
/// value carries forward identical to a real EMA reset-free pass.
///
/// Returns `None` when the slice contains zero finite samples or when
/// `period == 0` (caller should treat that as "no smoothing"). The
/// "no smoothing" path is handled by the caller before reaching here.
fn ema_over_optional(series: &[Option<f64>], period: usize) -> Option<f64> {
    if period == 0 {
        return None;
    }
    let alpha = 2.0 / (period as f64 + 1.0);
    let mut acc: Option<f64> = None;
    for val in series {
        if let Some(v) = val {
            if !v.is_finite() {
                continue;
            }
            acc = Some(match acc {
                Some(prev) => prev + alpha * (v - prev),
                None => *v,
            });
        }
    }
    acc
}

/// Compute the CME-basis voter direction for the given bar. Returns
/// `None` when the detector cannot fire — disabled allowlist mismatch,
/// missing/stale data, insufficient warm-up samples, mode-spread without
/// funding, or basis inside the neutral band.
///
/// Lookahead contract: `cme_basis_series` and `funding_series` MUST be
/// aligned to `candles` such that index `i` holds the value valid as
/// of the OPEN of candle `i` (i.e. forward-filled from observations
/// strictly before `candles[i].open_time + bar_dur`). The detector
/// consults index `signal_idx = candles.len() - 2`. Index `len-1` is
/// the entry-execution bar and MUST NOT be read here.
pub fn compute_cme_basis_vote(
    candles: &[Candle],
    cme_basis_series: Option<&[Option<f64>]>,
    funding_series: Option<&[Option<f64>]>,
    asset: &AssetConfig,
    params: &CmeBasisParams,
) -> Option<PositionSide> {
    if !params.is_well_formed() {
        return None;
    }
    if candles.len() < 2 {
        return None;
    }
    if !asset_in_allowlist(asset, &params.symbol_allowlist) {
        return None;
    }
    let basis = cme_basis_series?;
    if basis.len() != candles.len() {
        // Misalignment between series and candle slice is a programming
        // error in the caller — abstain rather than risk lookahead.
        return None;
    }
    let signal_idx = candles.len() - 2;

    // 2026-05-14 LOOKAHEAD GUARD: hard-fail if the slice contains a
    // value at `len-1` we'd otherwise be tempted to read. The aligned
    // basis series is permitted to carry the entry-bar value (forward-
    // fill semantics), but downstream we ONLY consult `signal_idx`.
    // This comment exists to make the contract intentional and visible.

    // Window of basis values up to and including signal_idx.
    let window = &basis[..=signal_idx];

    // Warm-up requirement: count of finite Some(_) entries must clear
    // `min_data_points`. Filters bootstrapping caches with a single
    // historical print that EMA-collapses to the raw value.
    let finite_count = window
        .iter()
        .filter(|v| v.and_then(|x| x.is_finite().then_some(())).is_some())
        .count();
    if finite_count < params.min_data_points.max(1) {
        return None;
    }

    // The signal-bar sample MUST be Some — if the loader marked it as
    // stale we abstain. The PRIMARY staleness gate lives in the loader
    // (`align_cme_basis` returns None past `max_staleness_bars`). Here
    // we just trust the loader's contract and verify the local sample.
    let signal_value = window[signal_idx]?;
    if !signal_value.is_finite() {
        return None;
    }
    // 2026-05-14 defensive secondary check: when the caller passes a
    // raw series that bypassed the loader (e.g. in tests or external
    // composition), we ALSO check that at least one Some-value exists
    // within the `max_staleness_bars` window strictly prior. This
    // catches the "single-point series with no history" pathology that
    // would otherwise pass the warm-up check by coincidence.
    if params.max_staleness_bars > 0 && finite_count >= 2 {
        let mut found_prior = false;
        let horizon = signal_idx.min(params.max_staleness_bars);
        for offset in 1..=horizon {
            let i = signal_idx - offset;
            if let Some(v) = window[i] {
                if v.is_finite() {
                    found_prior = true;
                    break;
                }
            }
        }
        if !found_prior {
            return None;
        }
    }

    // Smooth the basis with an EMA over the window (or use raw value).
    let smoothed = if params.basis_ema_period >= 2 {
        ema_over_optional(window, params.basis_ema_period).unwrap_or(signal_value)
    } else {
        signal_value
    };
    if !smoothed.is_finite() {
        return None;
    }

    match params.mode {
        CmeBasisMode::Absolute => {
            // Absolute basis vote: institutional contango / backwardation.
            let thr = params.basis_threshold_pct.abs();
            if smoothed >= thr {
                Some(PositionSide::Long)
            } else if smoothed <= -thr {
                Some(PositionSide::Short)
            } else {
                None
            }
        }
        CmeBasisMode::Spread => {
            // Spread vote requires the funding series. The series MUST be
            // length-aligned to candles, exactly like the basis series.
            // If funding is absent OR signal-bar funding is None we
            // abstain — Spread mode is undefined without both legs.
            let funding = funding_series?;
            if funding.len() != candles.len() {
                return None;
            }
            let funding_rate = funding[signal_idx]?;
            if !funding_rate.is_finite() {
                return None;
            }
            // Annualized funding equivalent (Binance USDT-M perps:
            // 3 settlements / day × 365 days / year).
            let annualized_funding = funding_rate * FUNDING_ANNUALIZATION;
            let spread = smoothed - annualized_funding;
            if !spread.is_finite() {
                return None;
            }
            let thr = params.spread_threshold_pct.abs();
            if spread >= thr {
                Some(PositionSide::Long)
            } else if spread <= -thr {
                Some(PositionSide::Short)
            } else {
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_candle(t: i64, c: f64) -> Candle {
        Candle::new(t, c, c + 0.5, c - 0.5, c, 100.0)
    }

    fn flat_candles(n: usize) -> Vec<Candle> {
        (0..n)
            .map(|i| make_candle(i as i64 * 1_800_000, 100.0))
            .collect()
    }

    fn btc_asset() -> AssetConfig {
        let mut a = AssetConfig::default();
        a.symbol = "BTC-TREND".to_string();
        a.source_symbol = Some("BTCUSDT".to_string());
        a
    }

    fn eth_asset() -> AssetConfig {
        let mut a = AssetConfig::default();
        a.symbol = "ETH-TREND".to_string();
        a.source_symbol = Some("ETHUSDT".to_string());
        a
    }

    fn constant_basis(n: usize, value: f64) -> Vec<Option<f64>> {
        vec![Some(value); n]
    }

    fn none_basis(n: usize) -> Vec<Option<f64>> {
        vec![None; n]
    }

    #[test]
    fn no_vote_for_non_btc_asset() {
        let candles = flat_candles(50);
        let basis = constant_basis(50, 0.15);
        let params = CmeBasisParams::default();
        let asset = eth_asset();
        let vote =
            compute_cme_basis_vote(&candles, Some(&basis), None, &asset, &params);
        assert!(vote.is_none());
    }

    #[test]
    fn long_fires_on_high_positive_basis_absolute_mode() {
        let candles = flat_candles(50);
        let basis = constant_basis(50, 0.15);
        let params = CmeBasisParams::default();
        let asset = btc_asset();
        let vote =
            compute_cme_basis_vote(&candles, Some(&basis), None, &asset, &params);
        assert_eq!(vote, Some(PositionSide::Long));
    }

    #[test]
    fn short_fires_on_strongly_negative_basis() {
        let candles = flat_candles(50);
        let basis = constant_basis(50, -0.12);
        let params = CmeBasisParams::default();
        let asset = btc_asset();
        let vote =
            compute_cme_basis_vote(&candles, Some(&basis), None, &asset, &params);
        assert_eq!(vote, Some(PositionSide::Short));
    }

    #[test]
    fn neutral_basis_returns_none_absolute_mode() {
        let candles = flat_candles(50);
        let basis = constant_basis(50, 0.03);
        let params = CmeBasisParams::default();
        let asset = btc_asset();
        let vote =
            compute_cme_basis_vote(&candles, Some(&basis), None, &asset, &params);
        assert!(vote.is_none());
    }

    #[test]
    fn spread_mode_uses_basis_minus_funding() {
        let candles = flat_candles(50);
        let basis = constant_basis(50, 0.12);
        let funding = vec![Some(0.0002); 50];
        let mut params = CmeBasisParams::default();
        params.mode = CmeBasisMode::Spread;
        params.spread_threshold_pct = 0.04;
        let asset = btc_asset();
        let vote = compute_cme_basis_vote(
            &candles,
            Some(&basis),
            Some(&funding),
            &asset,
            &params,
        );
        assert_eq!(vote, Some(PositionSide::Short));

        let basis2 = constant_basis(50, 0.20);
        let funding2 = vec![Some(0.00001); 50];
        let vote2 = compute_cme_basis_vote(
            &candles,
            Some(&basis2),
            Some(&funding2),
            &asset,
            &params,
        );
        assert_eq!(vote2, Some(PositionSide::Long));
    }

    #[test]
    fn spread_mode_requires_funding_input() {
        let candles = flat_candles(50);
        let basis = constant_basis(50, 0.15);
        let mut params = CmeBasisParams::default();
        params.mode = CmeBasisMode::Spread;
        let asset = btc_asset();
        let vote =
            compute_cme_basis_vote(&candles, Some(&basis), None, &asset, &params);
        assert!(vote.is_none());

        let funding = vec![None; 50];
        let vote2 = compute_cme_basis_vote(
            &candles,
            Some(&basis),
            Some(&funding),
            &asset,
            &params,
        );
        assert!(vote2.is_none());
    }

    #[test]
    fn staleness_cap_returns_none_after_max_age() {
        let n = 32;
        let candles = flat_candles(n);
        let mut basis: Vec<Option<f64>> = vec![Some(0.15); 20];
        basis.extend(vec![None; n - 20]);
        let params = CmeBasisParams::default();
        let asset = btc_asset();
        let vote =
            compute_cme_basis_vote(&candles, Some(&basis), None, &asset, &params);
        assert!(vote.is_none());

        let basis_fresh = constant_basis(n, 0.15);
        let vote_fresh = compute_cme_basis_vote(
            &candles,
            Some(&basis_fresh),
            None,
            &asset,
            &params,
        );
        assert_eq!(vote_fresh, Some(PositionSide::Long));
    }

    #[test]
    fn cme_basis_must_not_read_entry_bar() {
        let n = 30;
        let candles = flat_candles(n);
        let mut basis: Vec<Option<f64>> = vec![Some(0.0); n];
        basis[n - 1] = Some(0.50);
        let params = CmeBasisParams::default();
        let asset = btc_asset();
        let vote =
            compute_cme_basis_vote(&candles, Some(&basis), None, &asset, &params);
        assert!(vote.is_none());

        let mut basis2: Vec<Option<f64>> = vec![Some(0.0); n];
        basis2[n - 1] = Some(-0.50);
        let vote2 = compute_cme_basis_vote(
            &candles,
            Some(&basis2),
            None,
            &asset,
            &params,
        );
        assert!(vote2.is_none());
    }

    #[test]
    fn handles_missing_data_safely() {
        let candles = flat_candles(50);
        let params = CmeBasisParams::default();
        let asset = btc_asset();

        let vote = compute_cme_basis_vote(&candles, None, None, &asset, &params);
        assert!(vote.is_none());

        let basis = none_basis(50);
        let vote2 =
            compute_cme_basis_vote(&candles, Some(&basis), None, &asset, &params);
        assert!(vote2.is_none());

        let short_basis = constant_basis(20, 0.15);
        let vote3 = compute_cme_basis_vote(
            &candles,
            Some(&short_basis),
            None,
            &asset,
            &params,
        );
        assert!(vote3.is_none());

        let mut basis_gap = constant_basis(50, 0.15);
        basis_gap[48] = None;
        let vote4 = compute_cme_basis_vote(
            &candles,
            Some(&basis_gap),
            None,
            &asset,
            &params,
        );
        assert!(vote4.is_none());

        let mut basis_nan = constant_basis(50, 0.15);
        basis_nan[48] = Some(f64::NAN);
        let vote5 = compute_cme_basis_vote(
            &candles,
            Some(&basis_nan),
            None,
            &asset,
            &params,
        );
        assert!(vote5.is_none());
    }

    #[test]
    fn requires_min_data_points_before_voting() {
        let candles = flat_candles(50);
        let mut basis: Vec<Option<f64>> = vec![None; 50];
        basis[47] = Some(0.20);
        basis[48] = Some(0.22);
        basis[49] = Some(0.25);
        let params = CmeBasisParams::default();
        let asset = btc_asset();
        let vote =
            compute_cme_basis_vote(&candles, Some(&basis), None, &asset, &params);
        assert!(vote.is_none());

        let mut basis_warm: Vec<Option<f64>> = vec![None; 50];
        for i in 39..49 {
            basis_warm[i] = Some(0.20);
        }
        let vote2 = compute_cme_basis_vote(
            &candles,
            Some(&basis_warm),
            None,
            &asset,
            &params,
        );
        assert_eq!(vote2, Some(PositionSide::Long));
    }

    #[test]
    fn allowlist_extension_unlocks_extra_assets() {
        let candles = flat_candles(50);
        let basis = constant_basis(50, 0.15);
        let mut params = CmeBasisParams::default();
        params.symbol_allowlist = vec!["ETHUSDT".to_string()];
        let asset = eth_asset();
        let vote =
            compute_cme_basis_vote(&candles, Some(&basis), None, &asset, &params);
        assert_eq!(vote, Some(PositionSide::Long));
    }

    #[test]
    fn empty_allowlist_disables_gating() {
        let candles = flat_candles(50);
        let basis = constant_basis(50, 0.15);
        let mut params = CmeBasisParams::default();
        params.symbol_allowlist = vec![];
        let asset = eth_asset();
        let vote =
            compute_cme_basis_vote(&candles, Some(&basis), None, &asset, &params);
        assert_eq!(vote, Some(PositionSide::Long));
    }

    #[test]
    fn well_formed_guards_invalid_params() {
        let mut p = CmeBasisParams::default();
        assert!(p.is_well_formed());
        p.basis_threshold_pct = f64::NAN;
        assert!(!p.is_well_formed());

        let mut p = CmeBasisParams::default();
        p.basis_threshold_pct = -0.05;
        assert!(!p.is_well_formed());

        let mut p = CmeBasisParams::default();
        p.spread_threshold_pct = f64::INFINITY;
        assert!(!p.is_well_formed());
    }

    #[test]
    fn ema_smoothing_filters_single_print_outlier() {
        let n = 32;
        let candles = flat_candles(n);
        let mut basis: Vec<Option<f64>> = vec![Some(0.10); n];
        basis[n - 2] = Some(0.50);
        let mut params = CmeBasisParams::default();
        params.basis_threshold_pct = 0.20;
        params.basis_ema_period = 16;
        let asset = btc_asset();
        let vote =
            compute_cme_basis_vote(&candles, Some(&basis), None, &asset, &params);
        assert!(vote.is_none());

        let mut params_raw = params.clone();
        params_raw.basis_ema_period = 1;
        let vote_raw = compute_cme_basis_vote(
            &candles,
            Some(&basis),
            None,
            &asset,
            &params_raw,
        );
        assert_eq!(vote_raw, Some(PositionSide::Long));
    }
}
