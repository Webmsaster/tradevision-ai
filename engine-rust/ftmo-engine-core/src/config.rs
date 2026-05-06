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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Invert long/short signals — used by Forex MR strategies.
    #[serde(default, rename = "invertDirection")]
    pub invert_direction: bool,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CorrelationFilter {
    #[serde(rename = "maxOpenSameDirection")]
    pub max_open_same_direction: u32,
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

    #[serde(default, rename = "maxConcurrentTrades")]
    pub max_concurrent_trades: Option<u32>,

    #[serde(default, rename = "pauseAtTargetReached")]
    pub pause_at_target_reached: bool,

    /// R60 PASSLOCK flag — once profit target hits, force-close every
    /// position on the same bar to lock the realised gain.
    #[serde(default, rename = "closeAllOnTargetReached")]
    pub close_all_on_target_reached: bool,

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
            trigger_bars: 0,
            profit_target: 0.10,
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
            max_concurrent_trades: None,
            cross_asset_filter: None,
            cross_asset_filters_extra: None,
            vol_adaptive_tp_mult: None,
            ping_reliability: None,
            time_exit_enabled: false,
            pause_at_target_reached: true,
            close_all_on_target_reached: true,
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
        assert_eq!(cfg.profit_target, 0.10);
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
}
