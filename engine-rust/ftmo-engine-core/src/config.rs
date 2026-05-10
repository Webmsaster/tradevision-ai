//! Engine config — port of `FtmoDaytrade24hConfig` from
//! `src/utils/ftmoDaytrade24h.ts`. Every optional field that the V4 engine
//! reads is represented; fields read only by the detector or by sister
//! engines (V5R) are stubbed via `serde(default)` so JSON payloads round-trip.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveCaps {
    /// Raw price-move % (same unit as live), e.g. 0.05 = 5%.
    #[serde(rename = "maxStopPct")]
    pub max_stop_pct: f64,
    /// ENGINE riskFrac (exposure), e.g. 0.4 ≈ 4% live loss at 5% stop & 2× lev.
    #[serde(rename = "maxRiskFrac")]
    pub max_risk_frac: f64,
}

impl Default for LiveCaps {
    fn default() -> Self {
        Self { max_stop_pct: 0.05, max_risk_frac: 0.4 }
    }
}

/// R29 Round 5 — CVD divergence entry. Bullish: price=lookback-low AND
/// CVD strictly above lookback-low. Bearish: price=lookback-high AND CVD
/// strictly below lookback-high. CVD = cumsum(2×takerBuyVolume − volume).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CvdEntry {
    #[serde(rename = "lookbackBars")]
    pub lookback_bars: u32,
}

/// R29 Round 5 — Volume-Imbalance entry. Long if takerBuyVolume/volume >= longMin
/// (extreme buyer aggression); short if ratio <= 1 - longMin.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct VolImbalanceEntry {
    #[serde(rename = "longMin")]
    pub long_min: f64,
}

/// R29 Round 5 — Volume-Profile POC mean-reversion entry. POC = close of
/// highest-volume bar within `windowBars`. Long if price is at least
/// `minDistFromPocPct` BELOW POC; short if above by same margin.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct VolPocEntry {
    #[serde(rename = "windowBars")]
    pub window_bars: u32,
    #[serde(rename = "minDistFromPocPct")]
    pub min_dist_from_poc_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AssetConfig {
    pub symbol: String,
    #[serde(default, rename = "sourceSymbol")]
    pub source_symbol: Option<String>,
    #[serde(default, rename = "tpPct")]
    pub tp_pct: Option<f64>,
    #[serde(default, rename = "stopPct")]
    pub stop_pct: Option<f64>,
    #[serde(default, rename = "riskFrac")]
    pub risk_frac: f64,
    #[serde(default, rename = "activateAfterDay")]
    pub activate_after_day: Option<u32>,
    #[serde(default, rename = "minEquityGain")]
    pub min_equity_gain: Option<f64>,
    #[serde(default, rename = "maxEquityGain")]
    pub max_equity_gain: Option<f64>,
    /// Per-asset time-exit override (in bars). Falls back to `cfg.hold_bars`.
    #[serde(default, rename = "holdBars")]
    pub hold_bars: Option<u32>,
    /// Invert long/short signals — used by Forex MR strategies and the
    /// V5_TREND family (every R28_V6/V5_TITANIUM asset has this enabled in
    /// `ftmoDaytrade24h.ts`, see V1 root config lines 6491-6604).
    #[serde(default, rename = "invertDirection")]
    pub invert_direction: bool,

    /// Drop short-direction signals entirely. The V5_TREND family runs
    /// long-only post-invert (so an "engine short" on a non-inverted asset
    /// or vice-versa is silently dropped). Mirrors `disableShort` in
    /// `ftmoDaytrade24h.ts:101` (every TREND asset has this true).
    #[serde(default, rename = "disableShort")]
    pub disable_short: bool,

    /// Per-asset N-consecutive-close trigger override; falls back to
    /// `cfg.trigger_bars`. Mirrors `asset.triggerBars ?? cfg.triggerBars`
    /// in `src/utils/ftmoDaytrade24h.ts:3608`. None = use cfg.trigger_bars.
    #[serde(default, rename = "triggerBars")]
    pub trigger_bars: Option<u32>,

    // ─── R67-r17/r18: per-asset broker costs (used by `compute_eff_pnl`) ──
    /// Round-trip commission in basis points. Subtracted from rawPnl as
    /// `costBp/10000`. Mirrors `ftmoDaytrade24h.ts` line 4273/4626.
    #[serde(default, rename = "costBp")]
    pub cost_bp: Option<f64>,
    /// One-side slippage in basis points; charged round-trip on the
    /// remaining (un-PTP-closed) fraction. Mirrors backtest line 4655/4665.
    #[serde(default, rename = "slippageBp")]
    pub slippage_bp: Option<f64>,
    /// Overnight swap in bp/day, charged per UTC-midnight crossing.
    /// Mirrors backtest line 4667-4694.
    #[serde(default, rename = "swapBpPerDay")]
    pub swap_bp_per_day: Option<f64>,

    // ─── R29 Round 5: order-flow / volume-profile entry triggers ──────
    #[serde(default, rename = "cvdEntry")]
    pub cvd_entry: Option<CvdEntry>,
    #[serde(default, rename = "volImbalanceEntry")]
    pub vol_imbalance_entry: Option<VolImbalanceEntry>,
    #[serde(default, rename = "volPocEntry")]
    pub vol_poc_entry: Option<VolPocEntry>,

    // ─── R29 Round 7: per-asset funding-rate filter overrides ─────────
    /// Per-asset override of `cfg.funding_rate_filter.max_funding_for_long`.
    #[serde(default, rename = "maxFundingForLong")]
    pub max_funding_for_long: Option<f64>,
    /// Per-asset override of `cfg.funding_rate_filter.min_funding_for_short`.
    #[serde(default, rename = "minFundingForShort")]
    pub min_funding_for_short: Option<f64>,
}

impl AssetConfig {
    /// Resolves the effective invert flag, mirroring TS
    /// `asset.invertDirection ?? cfg.invertDirection ?? false`
    /// (`ftmoDaytrade24h.ts:3609`). Per-asset `true` always wins; if every
    /// asset leaves the field at its `false` default, run-config-level
    /// `cfg.invertDirection: true` flips the whole basket.
    pub fn effective_invert_direction(&self, cfg: &EngineConfig) -> bool {
        self.invert_direction || cfg.invert_direction
    }
}

/// Cross-asset filter — only allow signals if `symbol` is currently
/// trending in `direction`. Trend determined by EMA(fast_period) vs EMA(slow_period)
/// on `symbol`'s candle stream supplied at runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrossAssetFilter {
    pub symbol: String,
    /// Required direction — `"long"`, `"short"`, or `"any"` (just trend up OR down).
    #[serde(default = "default_cross_dir")]
    pub direction: String,
    #[serde(default = "default_fast_period", rename = "fastPeriod")]
    pub fast_period: u32,
    #[serde(default = "default_slow_period", rename = "slowPeriod")]
    pub slow_period: u32,
}

fn default_cross_dir() -> String {
    "any".to_string()
}
fn default_fast_period() -> u32 {
    9
}
fn default_slow_period() -> u32 {
    21
}

/// Volatility-adaptive TP multiplier (R60). Multiplies `tp_pct` by `factor`
/// when the per-bar ATR / close ratio crosses `atr_pct_above`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct VolAdaptiveTpMult {
    #[serde(rename = "atrPeriod")]
    pub atr_period: u32,
    #[serde(rename = "atrPctAbove")]
    pub atr_pct_above: f64,
    pub factor: f64,
}

/// Bot ping reliability (R22). Each ping-day during the
/// pause-after-target phase is `Bernoulli(prob)`; failed pings advance
/// the calendar without satisfying min_trading_days.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PingReliability {
    pub probability: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PartialTakeProfit {
    #[serde(rename = "triggerPct")]
    pub trigger_pct: f64,
    #[serde(rename = "closeFraction")]
    pub close_fraction: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PartialTakeProfitLevel {
    #[serde(rename = "triggerPct")]
    pub trigger_pct: f64,
    #[serde(rename = "closeFraction")]
    pub close_fraction: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct BreakEven {
    pub threshold: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ChandelierExit {
    pub period: u32,
    pub mult: f64,
    #[serde(default, rename = "minMoveR")]
    pub min_move_r: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct AtrStop {
    pub period: u32,
    #[serde(rename = "stopMult")]
    pub stop_mult: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct AdaptiveSizingTier {
    #[serde(rename = "equityAbove")]
    pub equity_above: f64,
    pub factor: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TimeBoost {
    #[serde(rename = "afterDay")]
    pub after_day: u32,
    #[serde(rename = "equityBelow")]
    pub equity_below: f64,
    pub factor: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct KellyTier {
    #[serde(rename = "winRateAbove")]
    pub win_rate_above: f64,
    pub multiplier: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KellySizing {
    #[serde(rename = "windowSize")]
    pub window_size: u32,
    #[serde(rename = "minTrades")]
    pub min_trades: u32,
    pub tiers: Vec<KellyTier>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DrawdownShield {
    #[serde(rename = "belowEquity")]
    pub below_equity: f64,
    pub factor: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PeakDrawdownThrottle {
    #[serde(rename = "fromPeak")]
    pub from_peak: f64,
    pub factor: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct IntradayDailyLossThrottle {
    #[serde(rename = "softLossThreshold")]
    pub soft_loss_threshold: f64,
    #[serde(rename = "hardLossThreshold")]
    pub hard_loss_threshold: f64,
    #[serde(rename = "softFactor")]
    pub soft_factor: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct LossStreakCooldown {
    #[serde(rename = "afterLosses")]
    pub after_losses: u32,
    #[serde(rename = "cooldownBars")]
    pub cooldown_bars: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct MeanReversionSource {
    pub period: u32,
    pub oversold: f64,
    pub overbought: f64,
    #[serde(rename = "cooldownBars")]
    pub cooldown_bars: u64,
    #[serde(rename = "sizeMult")]
    pub size_mult: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DailyEquityGuardian {
    #[serde(rename = "triggerPct")]
    pub trigger_pct: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DayProgressiveTier {
    #[serde(rename = "dayAtLeast")]
    pub day_at_least: u32,
    pub factor: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ReentryAfterStop {
    #[serde(rename = "sizeMult")]
    pub size_mult: f64,
    #[serde(rename = "withinBars")]
    pub within_bars: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PeakTrailingStop {
    #[serde(rename = "trailDistance")]
    pub trail_distance: f64,
}

/// Per-position trailing-stop. Activates after unrealised P&L >=
/// `activate_pct`, then drags the dynamic stop `trail_pct` below the running
/// peak `close`. Mirrors `cfg.trailingStop` in `ftmoDaytrade24h.ts:587-590`,
/// processed bar-by-bar in `ftmoDaytrade24h.ts:4670-4691`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TrailingStop {
    #[serde(rename = "activatePct")]
    pub activate_pct: f64,
    #[serde(rename = "trailPct")]
    pub trail_pct: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CorrelationFilter {
    #[serde(rename = "maxOpenSameDirection")]
    pub max_open_same_direction: u32,
}

/// R29-R7: per-perp funding-rate crowdedness gate. The current funding rate
/// (8h-cycle, ~0.0001 = 1bp = 0.01%) for the asset is consulted at signal
/// time. Long entries are skipped when funding > `max_funding_for_long`
/// (longs would overpay shorts). Short entries are skipped when funding
/// < `min_funding_for_short` (shorts would overpay longs).
///
/// Per-asset overrides via `AssetConfig::max_funding_for_long` /
/// `AssetConfig::min_funding_for_short` shadow these top-level numbers.
///
/// Mirrors `FtmoDaytrade24hConfig.fundingRateFilter` in
/// `src/utils/ftmoDaytrade24h.ts` (lines 886-889 + 4219-4238 gate logic).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct FundingRateFilter {
    #[serde(default, rename = "maxFundingForLong")]
    pub max_funding_for_long: Option<f64>,
    #[serde(default, rename = "minFundingForShort")]
    pub min_funding_for_short: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    /// Cosmetic label used by state files / logs.
    #[serde(default)]
    pub label: String,

    pub leverage: f64,
    #[serde(rename = "tpPct")]
    pub tp_pct: f64,
    #[serde(rename = "stopPct")]
    pub stop_pct: f64,
    #[serde(rename = "holdBars")]
    pub hold_bars: u32,
    #[serde(rename = "triggerBars", default)]
    pub trigger_bars: u32,

    #[serde(rename = "profitTarget")]
    pub profit_target: f64,
    #[serde(rename = "maxDailyLoss")]
    pub max_daily_loss: f64,
    #[serde(rename = "maxTotalLoss")]
    pub max_total_loss: f64,
    #[serde(rename = "minTradingDays")]
    pub min_trading_days: u32,
    #[serde(rename = "maxDays")]
    pub max_days: u32,

    pub assets: Vec<AssetConfig>,

    /// Optional initial-balance override for sizing. V4 uses 1.0 internally
    /// and reports as fraction; live executor multiplies by real balance.
    #[serde(default = "default_start_balance", rename = "startBalance")]
    pub start_balance: f64,

    #[serde(default, rename = "challengeStartTs")]
    pub challenge_start_ts: Option<i64>,

    /// UTC hours (0..24) at which entries are allowed. None = always.
    #[serde(default, rename = "allowedHoursUtc")]
    pub allowed_hours_utc: Option<Vec<u32>>,
    /// Day-of-week (0=Sunday … 6=Saturday) at which entries are allowed.
    #[serde(default, rename = "allowedDowsUtc")]
    pub allowed_dows_utc: Option<Vec<u32>>,

    #[serde(default, rename = "liveCaps")]
    pub live_caps: Option<LiveCaps>,
    #[serde(default, rename = "atrStop")]
    pub atr_stop: Option<AtrStop>,
    #[serde(default, rename = "chandelierExit")]
    pub chandelier_exit: Option<ChandelierExit>,
    #[serde(default, rename = "breakEven")]
    pub break_even: Option<BreakEven>,
    #[serde(default, rename = "partialTakeProfit")]
    pub partial_take_profit: Option<PartialTakeProfit>,
    #[serde(default, rename = "partialTakeProfitLevels")]
    pub partial_take_profit_levels: Option<Vec<PartialTakeProfitLevel>>,
    #[serde(default, rename = "adaptiveSizing")]
    pub adaptive_sizing: Option<Vec<AdaptiveSizingTier>>,
    #[serde(default, rename = "timeBoost")]
    pub time_boost: Option<TimeBoost>,
    #[serde(default, rename = "kellySizing")]
    pub kelly_sizing: Option<KellySizing>,
    #[serde(default, rename = "drawdownShield")]
    pub drawdown_shield: Option<DrawdownShield>,
    #[serde(default, rename = "peakDrawdownThrottle")]
    pub peak_drawdown_throttle: Option<PeakDrawdownThrottle>,
    #[serde(default, rename = "intradayDailyLossThrottle")]
    pub intraday_daily_loss_throttle: Option<IntradayDailyLossThrottle>,
    #[serde(default, rename = "lossStreakCooldown")]
    pub loss_streak_cooldown: Option<LossStreakCooldown>,
    #[serde(default, rename = "correlationFilter")]
    pub correlation_filter: Option<CorrelationFilter>,
    #[serde(default, rename = "dailyPeakTrailingStop")]
    pub daily_peak_trailing_stop: Option<PeakTrailingStop>,
    #[serde(default, rename = "challengePeakTrailingStop")]
    pub challenge_peak_trailing_stop: Option<PeakTrailingStop>,
    #[serde(default, rename = "trailingStop")]
    pub trailing_stop: Option<TrailingStop>,

    #[serde(default, rename = "maxConcurrentTrades")]
    pub max_concurrent_trades: Option<u32>,

    #[serde(default, rename = "pauseAtTargetReached")]
    pub pause_at_target_reached: bool,

    /// R60 PASSLOCK flag — once profit target hits, force-close every
    /// position on the same bar to lock the realised gain.
    #[serde(default, rename = "closeAllOnTargetReached")]
    pub close_all_on_target_reached: bool,

    /// Run-config-level invert fallback. Mirrors `cfg.invertDirection ?? false`
    /// in `ftmoDaytrade24h.ts:3609` — per-asset `invertDirection` overrides
    /// this; templates that set every asset explicitly leave this `false`.
    #[serde(default, rename = "invertDirection")]
    pub invert_direction: bool,

    /// R29-R3.2: nominal bar duration in minutes for the run. Defaults to 30
    /// (matches the 30m-native R28_V6/V5_TITANIUM/AMBER family). Detectors
    /// that quote periods in *bars* (SMA fast/slow, ATR, RSI, prior-N return,
    /// CVD lookback) must scale by `bar_minutes / 30` so a 5m run gets the
    /// same time-window the 30m configs were tuned for. Templates set this
    /// alongside `hold_bars` etc. when constructing a non-30m variant.
    #[serde(default = "default_bar_minutes", rename = "barMinutes")]
    pub bar_minutes: u32,

    #[serde(default, rename = "fundingRateFilter")]
    pub funding_rate_filter: Option<FundingRateFilter>,

    #[serde(default, rename = "crossAssetFilter")]
    pub cross_asset_filter: Option<CrossAssetFilter>,
    #[serde(default, rename = "crossAssetFiltersExtra")]
    pub cross_asset_filters_extra: Option<Vec<CrossAssetFilter>>,
    #[serde(default, rename = "volAdaptiveTpMult")]
    pub vol_adaptive_tp_mult: Option<VolAdaptiveTpMult>,
    #[serde(default, rename = "pingReliability")]
    pub ping_reliability: Option<PingReliability>,
    /// Time-exit toggle — V4 disabled for parity with V4-Sim, V5R may enable.
    #[serde(default, rename = "timeExitEnabled")]
    pub time_exit_enabled: bool,

    // ─── V5R-only flags ───────────────────────────────────────────────
    #[serde(default, rename = "dailyEquityGuardian")]
    pub daily_equity_guardian: Option<DailyEquityGuardian>,
    #[serde(default, rename = "bypassLiveCaps")]
    pub bypass_live_caps: bool,
    #[serde(default, rename = "dayProgressiveSizing")]
    pub day_progressive_sizing: Option<Vec<DayProgressiveTier>>,
    #[serde(default, rename = "reentryAfterStop")]
    pub reentry_after_stop: Option<ReentryAfterStop>,
    #[serde(default, rename = "meanReversionSource")]
    pub mean_reversion_source: Option<MeanReversionSource>,
}

fn default_start_balance() -> f64 {
    100_000.0
}

fn default_bar_minutes() -> u32 {
    30
}

impl EngineConfig {
    /// Minimal R28_V6_PASSLOCK template — fills in the FTMO Step-1 baselines
    /// and the R60 close-all flag. `assets` is empty; caller must fill from
    /// `getActiveCfg()` parity with `src/utils/ftmoLiveSignalV231.ts`.
    pub fn r28_v6_passlock_template() -> Self {
        Self {
            label: "R28_V6_PASSLOCK".into(),
            leverage: 2.0,
            tp_pct: 0.04,
            stop_pct: 0.02,
            hold_bars: 24,
            // R28_V6 inherits `triggerBars: 1` from the V1 root config
            // (`ftmoDaytrade24h.ts:6484`). EVERY V5_TREND asset has
            // `invertDirection: true` + `disableShort: true` so the
            // effective rule is "1 green bar after up-trend slope → long;
            // shorts dropped entirely". `make_assets` sets these flags.
            trigger_bars: 1,
            // V1 root config (ftmoDaytrade24h.ts:6607) explicitly sets the
            // Step-1 target to 0.08 ("FTMO Step 1 target = 8% (not 10%)").
            // The 0.10 was wrong — produced overly easy targets in Rust sim.
            profit_target: 0.08,
            max_daily_loss: 0.05,
            max_total_loss: 0.10,
            min_trading_days: 4,
            max_days: 30,
            assets: vec![],
            start_balance: 100_000.0,
            challenge_start_ts: None,
            allowed_hours_utc: None,
            allowed_dows_utc: None,
            live_caps: Some(LiveCaps::default()),
            atr_stop: None,
            chandelier_exit: None,
            break_even: None,
            partial_take_profit: None,
            partial_take_profit_levels: None,
            adaptive_sizing: None,
            time_boost: None,
            kelly_sizing: None,
            drawdown_shield: None,
            peak_drawdown_throttle: None,
            intraday_daily_loss_throttle: None,
            loss_streak_cooldown: None,
            correlation_filter: None,
            daily_peak_trailing_stop: None,
            challenge_peak_trailing_stop: None,
            trailing_stop: None,
            max_concurrent_trades: None,
            funding_rate_filter: None,
            cross_asset_filter: None,
            cross_asset_filters_extra: None,
            vol_adaptive_tp_mult: None,
            ping_reliability: None,
            time_exit_enabled: false,
            pause_at_target_reached: true,
            close_all_on_target_reached: true,
            invert_direction: false,
            bar_minutes: 30,
            daily_equity_guardian: None,
            bypass_live_caps: false,
            day_progressive_sizing: None,
            reentry_after_stop: None,
            mean_reversion_source: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_is_passlock_shape() {
        let cfg = EngineConfig::r28_v6_passlock_template();
        // FTMO Step-1 target: 8% (set in V1 root in ftmoDaytrade24h.ts:6607).
        assert!((cfg.profit_target - 0.08).abs() < 1e-12);
        assert_eq!(cfg.max_daily_loss, 0.05);
        assert!(cfg.pause_at_target_reached);
        assert!(cfg.close_all_on_target_reached);
        assert_eq!(cfg.live_caps.as_ref().unwrap().max_risk_frac, 0.4);
    }

    #[test]
    fn round_trips_through_json() {
        let cfg = EngineConfig::r28_v6_passlock_template();
        let s = serde_json::to_string(&cfg).unwrap();
        let back: EngineConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(back.label, cfg.label);
        assert_eq!(back.profit_target, cfg.profit_target);
    }

    #[test]
    fn effective_invert_falls_back_to_cfg_level() {
        // Regression test for R29-R3.9 — TS does
        // `asset.invertDirection ?? cfg.invertDirection ?? false`
        // (`ftmoDaytrade24h.ts:3609`); Rust must honor the cfg-level fallback
        // when no per-asset override is set.
        let mut cfg = EngineConfig::r28_v6_passlock_template();
        cfg.invert_direction = true;
        let asset = AssetConfig { invert_direction: false, ..Default::default() };
        assert!(asset.effective_invert_direction(&cfg));

        // Per-asset `true` works when cfg fallback is off (existing path).
        let cfg2 = EngineConfig::r28_v6_passlock_template();
        let asset2 = AssetConfig { invert_direction: true, ..Default::default() };
        assert!(asset2.effective_invert_direction(&cfg2));

        // Both off → no invert.
        let asset3 = AssetConfig::default();
        assert!(!asset3.effective_invert_direction(&cfg2));
    }
}
