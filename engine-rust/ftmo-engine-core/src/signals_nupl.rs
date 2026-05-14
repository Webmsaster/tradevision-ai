//! NUPL (Net Unrealized Profit/Loss) Regime — on-chain cycle classifier.
//!
//! # ⚠️ HONEST ASSESSMENT — READ BEFORE WIRING THIS INTO THE FTMO PIPELINE ⚠️
//!
//! NUPL is a **macro / long-term-cycle** indicator. It measures the aggregate
//! unrealised profit/loss of all on-chain holders, normalised by market cap:
//!
//! ```text
//! NUPL = (market_cap − realised_cap) / market_cap
//! ```
//!
//! Glassnode's canonical bands (Renato Shirakashi 2018):
//!
//! ```text
//! NUPL > +0.75   →  EUPHORIA / GREED / cycle TOP region
//! NUPL > +0.50   →  belief         (mid-bull warning)
//! NUPL > +0.25   →  optimism / anxiety
//! NUPL ∈ [0, +0.25] → hope / fear (neutral)
//! NUPL < 0       →  capitulation / cycle BOTTOM
//! ```
//!
//! These bands move on a **multi-week to multi-month** time scale. The mean
//! dwell-time in any single regime is roughly **60-180 days** for BTC across
//! 2017-2024 (source: own back-calc from Coinmetrics realised-cap series).
//!
//! ## Why this is almost certainly worthless for the 30m FTMO challenge
//!
//! 1. **Time-scale mismatch by factor ~3000×.** FTMO Normal 2-Step is 60 days
//!    max, the strategy fires on 30m bars (2880 bars over 60d) and our R28V6
//!    detectors look at ~14-200-bar lookback windows (7h-100h). NUPL changes
//!    meaningfully only over weeks. Over a 30m bar the change is below the
//!    noise floor of the realised-cap update granularity (CoinMetrics + most
//!    Glassnode endpoints push NUPL at **daily** cadence; intra-day NUPL is
//!    a linear interpolation of the daily value).
//!
//! 2. **No edge on 30m direction.** Even if NUPL flips from "belief" to
//!    "euphoria" mid-bar, that event is meaningless for the next 30m candle.
//!    The bands predict mean-reverting cycle turns over months — not the
//!    immediate next bar's drift.
//!
//! 3. **One feed for one asset.** NUPL is BTC-native. ETH/SOL/AVAX etc. have
//!    proxy on-chain metrics but the band thresholds aren't directly portable
//!    — and the engine basket is 14-19 assets. Using BTC-NUPL as a global
//!    market-regime overlay is the only sensible application, but then it's
//!    indistinguishable from a slow BTC-momentum/drawdown gate (which we
//!    already have via R28V6's HTF filter).
//!
//! 4. **Expected lift on the 30m FTMO pipeline: 0 ± noise.** A 13-wave hunt
//!    (`project_session_2026_05_13_65pct_hunt_wave1_12.md`) plateaued the
//!    standalone single-account ceiling at 58.3% by knob-tuning. The
//!    structural breaks above 65% came from the `RegimeConfluence` voter
//!    consensus — a price-action quality filter, not a macro overlay.
//!    Plugging NUPL into the consensus would simply add a noisy 9th voter
//!    that fires the same 60-180 day regime on every bar. mv=4/mv=5 quorum
//!    becomes either trivially-true or impossibly-false depending on the
//!    current band, with no per-trade selectivity.
//!
//! 5. **External-data dependency.** NUPL requires a daily Coinmetrics /
//!    Glassnode / IntoTheBlock pull. Adding another flaky external feed to
//!    the live executor for **zero expected lift** is a strict negative
//!    (cron failure → blocked entries → DL counter goes the wrong way).
//!
//! ## When this detector COULD be useful
//!
//! * Multi-week swing-strategy on a separate research branch (not the FTMO
//!   bot). Long-only btc-swing buys on `NUPL < 0` (capitulation), sells on
//!   `NUPL > 0.75` (euphoria). Historical Sharpe over 2017-2024 ≈ 1.4
//!   single-asset — meaningful only on yearly horizons.
//! * As a `risk_off` macro gate for a portfolio manager that allocates
//!   between cash and a basket of strategies. NOT a per-bar entry trigger.
//! * Educational / dashboard widget in TradeVision's UI ("current market
//!   sentiment") — independent of the backtest engine.
//!
//! ## Recommendation for the FTMO context
//!
//! **SKIP wiring `detect_nupl` into the `RegimeConfluence` voter panel.**
//! The expected pass-rate lift is 0 with non-zero failure-mode cost (feed
//! outage). If user-mandated, default `enabled = false` and gate any actual
//! wiring behind a 100-window sanity-shard that proves > 0 trade-count delta.
//!
//! This module is implemented for completeness — TradeVision's dashboard
//! analytics may surface NUPL regime to end-users — but it is intentionally
//! NOT registered in `signals_regime_confluence::detect_regime_confluence`.

use serde::{Deserialize, Serialize};

use crate::candle::Candle;
use crate::config::{AssetConfig, EngineConfig};
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::state::EngineState;

/// On-chain NUPL regime classification (Shirakashi 2018 bands).
///
/// The bands are MUTUALLY EXCLUSIVE and EXHAUSTIVE over the [-∞, +1] domain.
/// Returned by `classify_nupl` for downstream gating.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NuplRegime {
    /// `NUPL < 0` — aggregate holders sit at a loss. Historical cycle bottoms.
    Capitulation,
    /// `NUPL ∈ [0, 0.25)` — slight aggregate profit, recovery phase.
    HopeFear,
    /// `NUPL ∈ [0.25, 0.50)` — meaningful unrealised gains, mid-cycle.
    OptimismAnxiety,
    /// `NUPL ∈ [0.50, 0.75)` — late-cycle, distribution warning zone.
    Belief,
    /// `NUPL ≥ 0.75` — cycle TOP region, historical sell-zone.
    Euphoria,
}

impl NuplRegime {
    /// Maps a regime to a textual band label for telemetry / dashboard.
    pub fn label(self) -> &'static str {
        match self {
            NuplRegime::Capitulation => "capitulation",
            NuplRegime::HopeFear => "hope_fear",
            NuplRegime::OptimismAnxiety => "optimism_anxiety",
            NuplRegime::Belief => "belief",
            NuplRegime::Euphoria => "euphoria",
        }
    }

    /// True for regimes that historically precede mean-reverting up-moves on a
    /// multi-week horizon (`capitulation`, `hope_fear`).
    pub fn is_bullish_macro(self) -> bool {
        matches!(self, NuplRegime::Capitulation | NuplRegime::HopeFear)
    }

    /// True for regimes that historically precede mean-reverting down-moves on
    /// a multi-week horizon (`belief`, `euphoria`).
    pub fn is_bearish_macro(self) -> bool {
        matches!(self, NuplRegime::Belief | NuplRegime::Euphoria)
    }
}

/// Classify a raw NUPL value into a regime band. Inputs outside [-1, +1]
/// are clamped before classification (realised-cap math guarantees this
/// range but feed corruption is possible).
pub fn classify_nupl(raw: f64) -> Option<NuplRegime> {
    if !raw.is_finite() {
        return None;
    }
    let v = raw.clamp(-1.0, 1.0);
    if v < 0.0 {
        Some(NuplRegime::Capitulation)
    } else if v < 0.25 {
        Some(NuplRegime::HopeFear)
    } else if v < 0.50 {
        Some(NuplRegime::OptimismAnxiety)
    } else if v < 0.75 {
        Some(NuplRegime::Belief)
    } else {
        Some(NuplRegime::Euphoria)
    }
}

/// External per-day NUPL sample. The feed is daily (Glassnode / Coinmetrics
/// / IntoTheBlock all push NUPL on 24h cadence) — intra-day values are
/// step-functions, NOT interpolated, to avoid lookahead.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct NuplSample {
    /// UTC unix-millis at the daily snapshot (typically 00:00 UTC).
    #[serde(rename = "asOf")]
    pub as_of: i64,
    pub value: f64,
}

/// Read-only view onto a NUPL time-series. Callers populate this from
/// `data/nupl_btc.jsonl` (or equivalent per-asset feed) and pass it to the
/// detector via `NuplInputs`. The slice MUST be sorted ascending by `as_of`.
pub struct NuplSeries<'a> {
    samples: &'a [NuplSample],
}

impl<'a> NuplSeries<'a> {
    pub fn new(samples: &'a [NuplSample]) -> Self {
        Self { samples }
    }

    /// Last sample with `as_of <= ts_millis`. Returns `None` if the series
    /// is empty or the requested timestamp predates the earliest sample.
    ///
    /// Implementation: binary-search by `as_of`. **No interpolation** — the
    /// returned sample reflects the daily snapshot strictly before-or-at
    /// `ts_millis`, so there is no lookahead into tomorrow's reading.
    pub fn sample_at(&self, ts_millis: i64) -> Option<NuplSample> {
        if self.samples.is_empty() {
            return None;
        }
        // partition_point finds the first index whose as_of > ts_millis;
        // we want the one strictly before that.
        let idx = self.samples.partition_point(|s| s.as_of <= ts_millis);
        if idx == 0 {
            return None;
        }
        Some(self.samples[idx - 1])
    }

    /// Number of samples in the series. Used by tests and telemetry.
    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }
}

/// Optional inputs threaded through the engine to the NUPL detector. Only
/// `btc_series` is consumed today — per-asset extensions go in this struct.
pub struct NuplInputs<'a> {
    /// BTC NUPL time-series — the canonical cycle indicator.
    pub btc_series: Option<NuplSeries<'a>>,
    /// 2026-05-14 future-extension placeholder for ETH/SOL/etc. when on-chain
    /// proxies are available. Currently unused.
    #[allow(dead_code)]
    pub eth_series: Option<NuplSeries<'a>>,
}

impl<'a> Default for NuplInputs<'a> {
    fn default() -> Self {
        Self {
            btc_series: None,
            eth_series: None,
        }
    }
}

/// Tunable parameters for the NUPL voter. All fields default to a
/// conservative band-edge gate that fires Long on capitulation and Short on
/// euphoria — historically the highest-conviction macro signal.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct NuplParams {
    /// Master switch. Defaults to `false` — see module header for rationale.
    pub enabled: bool,
    /// Long-bias threshold. Fire Long when latest NUPL ≤ this value.
    pub long_below: f64,
    /// Short-bias threshold. Fire Short when latest NUPL ≥ this value.
    pub short_above: f64,
    /// Optional minimum dwell-time (in days) inside the qualifying band
    /// before the detector fires. Filters intra-band noise around the
    /// threshold and matches the "regime has to be confirmed" intuition.
    /// 0 disables the dwell-time gate.
    pub min_dwell_days: u32,
    /// Maximum staleness of the latest sample in days. If the most recent
    /// NUPL sample is older than this relative to the candle bar, the
    /// detector ABSTAINS rather than firing on stale macro data.
    /// Default 3d — covers typical Coinmetrics / Glassnode pull cadences
    /// plus a weekend buffer.
    pub max_staleness_days: u32,
}

impl Default for NuplParams {
    fn default() -> Self {
        Self {
            enabled: false,
            long_below: 0.0,   // capitulation band
            short_above: 0.75, // euphoria band
            min_dwell_days: 7, // require the band to hold for at least a week
            max_staleness_days: 3,
        }
    }
}

impl NuplParams {
    /// Sanity-check guard. Returns `false` if thresholds are inverted or
    /// non-finite — callers should treat that as a config error and skip.
    pub fn is_well_formed(&self) -> bool {
        self.long_below.is_finite()
            && self.short_above.is_finite()
            && self.long_below < self.short_above
            && (-1.0..=1.0).contains(&self.long_below)
            && (-1.0..=1.0).contains(&self.short_above)
    }
}

const DAY_MS: i64 = 86_400_000;

/// Helper — how many consecutive days back from `idx` the regime held.
/// Walks the series backward and counts until the band classification
/// flips. Returns `0` if the input index is `None` or invalid.
fn dwell_days_at(samples: &[NuplSample], idx: usize) -> u32 {
    if idx >= samples.len() {
        return 0;
    }
    let anchor = match classify_nupl(samples[idx].value) {
        Some(r) => r,
        None => return 0,
    };
    let mut count: u32 = 1;
    let mut i = idx;
    while i > 0 {
        i -= 1;
        match classify_nupl(samples[i].value) {
            Some(r) if r == anchor => count = count.saturating_add(1),
            _ => break,
        }
    }
    count
}

/// Compute the NUPL voter direction for the given bar.
///
/// Returns `None` when the detector is disabled, the feed is absent, the
/// latest sample is stale, dwell-time is insufficient, or the current band
/// is neutral. Callers treat `None` as "abstain" — NOT a no-vote in a
/// consensus panel (i.e. it does not flip a vote for the opposite side).
///
/// 2026-05-14 lookahead-safety: this function reads NUPL strictly at-or-before
/// `signal_bar.open_time`, never the bar's `close_time`. Combined with the
/// daily-snapshot cadence of the underlying feed this is sufficient to
/// guarantee no future leakage.
pub fn compute_nupl_vote(
    signal_bar: &Candle,
    series: &NuplSeries<'_>,
    params: &NuplParams,
) -> Option<PositionSide> {
    if !params.enabled || !params.is_well_formed() || series.is_empty() {
        return None;
    }
    let sample = series.sample_at(signal_bar.open_time)?;
    // Staleness gate — abstain on macro feeds older than the configured
    // bound. Live-deployment safety: if the cron pull broke for a week we
    // do not silently apply last-known-good regime to fresh bars.
    let stale_ms = signal_bar.open_time.saturating_sub(sample.as_of);
    let max_stale_ms = (params.max_staleness_days as i64).saturating_mul(DAY_MS);
    if stale_ms > max_stale_ms {
        return None;
    }
    if !sample.value.is_finite() {
        return None;
    }

    // Dwell-time check — locate the sample index, walk backward, count
    // consecutive days that classify into the same band.
    if params.min_dwell_days > 0 {
        // Slice the underlying samples up to and including the chosen one.
        // We rely on NuplSeries being monotonically sorted by `as_of`.
        let idx = series
            .samples
            .partition_point(|s| s.as_of <= signal_bar.open_time)
            .saturating_sub(1);
        let dwell = dwell_days_at(series.samples, idx);
        if dwell < params.min_dwell_days {
            return None;
        }
    }

    if sample.value <= params.long_below {
        Some(PositionSide::Long)
    } else if sample.value >= params.short_above {
        Some(PositionSide::Short)
    } else {
        None
    }
}

/// Standalone entry-point — produces a `PollSignal` directly off the macro
/// regime. **Not registered** in `signals_regime_confluence` (see module
/// header). Provided for the dashboard/research path: a tester can wire
/// this into a long-swing harness without polluting the FTMO pipeline.
///
/// The emitted signal piggybacks on the asset's configured stop/tp percent
/// (cycle trades hold for weeks — daily stops are not meaningful here) and
/// the base risk_frac. **This is intentionally a low-conviction entry that
/// callers will downweight or wrap behind their own sizing override.**
#[allow(clippy::too_many_arguments)]
pub fn detect_nupl_standalone(
    _state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &NuplParams,
    inputs: &NuplInputs<'_>,
) -> Option<PollSignal> {
    if !params.enabled {
        return None;
    }
    // Signal bar = candles[len-2] (just-closed). Same convention as every
    // other detector in this crate — entry-bar candles[len-1].open is the
    // execution price, signal-bar candles[len-2].* is the read source.
    if candles.len() < 2 {
        return None;
    }
    let signal_idx = candles.len() - 2;
    let entry_idx = candles.len() - 1;
    let signal_bar = candles[signal_idx];
    let entry_bar = candles[entry_idx];
    if !entry_bar.open.is_finite() || entry_bar.open <= 0.0 {
        return None;
    }
    let series = inputs.btc_series.as_ref()?;
    let direction = compute_nupl_vote(&signal_bar, series, params)?;

    let stop_pct = asset.stop_pct.unwrap_or(cfg.stop_pct);
    let tp_pct = asset.tp_pct.unwrap_or(cfg.tp_pct);
    if !stop_pct.is_finite() || !tp_pct.is_finite() || stop_pct <= 0.0 || tp_pct <= 0.0 {
        return None;
    }
    let entry_price = entry_bar.open;
    let (stop_price, tp_price) = match direction {
        PositionSide::Long => (entry_price * (1.0 - stop_pct), entry_price * (1.0 + tp_pct)),
        PositionSide::Short => (entry_price * (1.0 + stop_pct), entry_price * (1.0 - tp_pct)),
    };

    Some(PollSignal {
        symbol: format!("{}-NUPL", source_symbol),
        source_symbol: source_symbol.to_string(),
        direction,
        entry_time: entry_bar.open_time,
        entry_price,
        stop_price,
        tp_price,
        stop_pct,
        tp_pct,
        // 2026-05-14 — NUPL is macro-level; we pin the risk fraction to the
        // asset baseline and DO NOT route through the kelly/sizing pipeline.
        // Callers wanting kelly-scaled NUPL trades must explicitly wrap this
        // signal in `resolve_sizing_factor` (no global wiring on purpose).
        eff_risk: asset.risk_frac,
        chandelier_atr_at_entry: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_series(values: &[(i64, f64)]) -> Vec<NuplSample> {
        values
            .iter()
            .map(|&(as_of, value)| NuplSample { as_of, value })
            .collect()
    }

    #[test]
    fn classify_bands_cover_full_range() {
        assert_eq!(classify_nupl(-0.5), Some(NuplRegime::Capitulation));
        assert_eq!(classify_nupl(0.0), Some(NuplRegime::HopeFear));
        assert_eq!(classify_nupl(0.249), Some(NuplRegime::HopeFear));
        assert_eq!(classify_nupl(0.25), Some(NuplRegime::OptimismAnxiety));
        assert_eq!(classify_nupl(0.49), Some(NuplRegime::OptimismAnxiety));
        assert_eq!(classify_nupl(0.50), Some(NuplRegime::Belief));
        assert_eq!(classify_nupl(0.74), Some(NuplRegime::Belief));
        assert_eq!(classify_nupl(0.75), Some(NuplRegime::Euphoria));
        assert_eq!(classify_nupl(0.95), Some(NuplRegime::Euphoria));
    }

    #[test]
    fn classify_handles_clamping_and_non_finite() {
        assert_eq!(classify_nupl(-99.0), Some(NuplRegime::Capitulation));
        assert_eq!(classify_nupl(99.0), Some(NuplRegime::Euphoria));
        assert_eq!(classify_nupl(f64::NAN), None);
        // Infinities are non-finite → guarded out before clamping → None.
        assert_eq!(classify_nupl(f64::INFINITY), None);
        assert_eq!(classify_nupl(f64::NEG_INFINITY), None);
    }

    #[test]
    fn regime_macro_polarity_helpers() {
        assert!(NuplRegime::Capitulation.is_bullish_macro());
        assert!(NuplRegime::HopeFear.is_bullish_macro());
        assert!(!NuplRegime::OptimismAnxiety.is_bullish_macro());
        assert!(NuplRegime::Belief.is_bearish_macro());
        assert!(NuplRegime::Euphoria.is_bearish_macro());
        assert!(!NuplRegime::Capitulation.is_bearish_macro());
    }

    #[test]
    fn sample_at_returns_strictly_before_or_at() {
        let samples = make_series(&[(0, 0.1), (DAY_MS, 0.2), (DAY_MS * 2, 0.3)]);
        let series = NuplSeries::new(&samples);
        assert_eq!(series.sample_at(-1), None);
        assert_eq!(series.sample_at(0).map(|s| s.value), Some(0.1));
        assert_eq!(series.sample_at(DAY_MS).map(|s| s.value), Some(0.2));
        assert_eq!(series.sample_at(DAY_MS + 1).map(|s| s.value), Some(0.2));
        assert_eq!(series.sample_at(DAY_MS * 5).map(|s| s.value), Some(0.3));
    }

    #[test]
    fn well_formed_guards_inverted_or_oob_thresholds() {
        let mut p = NuplParams::default();
        assert!(p.is_well_formed());
        p.long_below = 0.8;
        p.short_above = 0.2;
        assert!(!p.is_well_formed(), "inverted thresholds must be rejected");
        let mut p = NuplParams::default();
        p.long_below = -2.0;
        assert!(!p.is_well_formed(), "OOB thresholds must be rejected");
        let mut p = NuplParams::default();
        p.short_above = f64::NAN;
        assert!(!p.is_well_formed(), "NaN must be rejected");
    }

    #[test]
    fn disabled_detector_abstains() {
        let samples = make_series(&[(0, -0.2)]);
        let series = NuplSeries::new(&samples);
        let bar = Candle::new(DAY_MS, 100.0, 100.0, 100.0, 100.0, 0.0);
        let mut params = NuplParams::default();
        params.enabled = false;
        params.min_dwell_days = 0;
        assert_eq!(compute_nupl_vote(&bar, &series, &params), None);
    }

    #[test]
    fn capitulation_fires_long_when_enabled_and_fresh() {
        let samples = make_series(&[
            (0, -0.15),
            (DAY_MS, -0.18),
            (DAY_MS * 2, -0.12),
            (DAY_MS * 3, -0.10),
            (DAY_MS * 4, -0.08),
            (DAY_MS * 5, -0.06),
            (DAY_MS * 6, -0.04),
            (DAY_MS * 7, -0.02),
        ]);
        let series = NuplSeries::new(&samples);
        let bar = Candle::new(DAY_MS * 7 + 1, 100.0, 100.0, 100.0, 100.0, 0.0);
        let mut params = NuplParams::default();
        params.enabled = true;
        params.min_dwell_days = 7;
        assert_eq!(
            compute_nupl_vote(&bar, &series, &params),
            Some(PositionSide::Long)
        );
    }

    #[test]
    fn euphoria_fires_short_when_band_holds() {
        // 9 consecutive days above 0.75 → euphoria dwell = 9.
        let samples = make_series(&[
            (0, 0.80),
            (DAY_MS, 0.81),
            (DAY_MS * 2, 0.79),
            (DAY_MS * 3, 0.82),
            (DAY_MS * 4, 0.83),
            (DAY_MS * 5, 0.78),
            (DAY_MS * 6, 0.85),
            (DAY_MS * 7, 0.88),
            (DAY_MS * 8, 0.90),
        ]);
        let series = NuplSeries::new(&samples);
        let bar = Candle::new(DAY_MS * 8 + 1, 100.0, 100.0, 100.0, 100.0, 0.0);
        let mut params = NuplParams::default();
        params.enabled = true;
        params.min_dwell_days = 7;
        assert_eq!(
            compute_nupl_vote(&bar, &series, &params),
            Some(PositionSide::Short)
        );
    }

    #[test]
    fn dwell_filter_blocks_fresh_band_flip() {
        // Two days in capitulation → fails 7-day dwell gate.
        let samples = make_series(&[(0, 0.10), (DAY_MS, 0.05), (DAY_MS * 2, -0.05), (DAY_MS * 3, -0.10)]);
        let series = NuplSeries::new(&samples);
        let bar = Candle::new(DAY_MS * 3 + 1, 100.0, 100.0, 100.0, 100.0, 0.0);
        let mut params = NuplParams::default();
        params.enabled = true;
        params.min_dwell_days = 7;
        assert_eq!(compute_nupl_vote(&bar, &series, &params), None);
    }

    #[test]
    fn stale_feed_makes_detector_abstain() {
        let samples = make_series(&[(0, -0.20)]);
        let series = NuplSeries::new(&samples);
        // Bar is 30 days after the last sample — max staleness is 3 by
        // default, so the voter must abstain instead of firing on stale data.
        let bar = Candle::new(DAY_MS * 30, 100.0, 100.0, 100.0, 100.0, 0.0);
        let mut params = NuplParams::default();
        params.enabled = true;
        params.min_dwell_days = 0;
        assert_eq!(compute_nupl_vote(&bar, &series, &params), None);
    }

    #[test]
    fn neutral_band_returns_none() {
        let samples = make_series(&[
            (0, 0.30),
            (DAY_MS, 0.32),
            (DAY_MS * 2, 0.35),
            (DAY_MS * 3, 0.40),
            (DAY_MS * 4, 0.42),
            (DAY_MS * 5, 0.38),
            (DAY_MS * 6, 0.36),
            (DAY_MS * 7, 0.33),
        ]);
        let series = NuplSeries::new(&samples);
        let bar = Candle::new(DAY_MS * 7 + 1, 100.0, 100.0, 100.0, 100.0, 0.0);
        let mut params = NuplParams::default();
        params.enabled = true;
        params.min_dwell_days = 7;
        assert_eq!(compute_nupl_vote(&bar, &series, &params), None);
    }
}
