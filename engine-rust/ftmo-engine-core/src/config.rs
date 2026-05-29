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
        Self {
            max_stop_pct: 0.05,
            max_risk_frac: 0.4,
        }
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

    /// 2026-05-13 Codex HIGH FIX (Fix 6): symmetric `disableLong` flag in
    /// TS `ftmoDaytrade24h.ts:99/663`. Several TS configs (e.g. FOREX-MR
    /// short-only baskets) set this true. Rust previously silently
    /// deserialized the field and DROPPED it, letting longs through that
    /// should have been blocked.
    #[serde(default, rename = "disableLong")]
    pub disable_long: bool,

    /// 2026-05-13 Codex HIGH FIX (Fix 6): TS `deactivateAfterDay`
    /// (`ftmoDaytrade24h.ts:218`, used in `ftmoLiveEngineV4.ts:1787-1792`)
    /// — assets stop firing entries once `state.day >= deactivateAfterDay`.
    /// Used to phase out a strategy mid-challenge.
    #[serde(default, rename = "deactivateAfterDay")]
    pub deactivate_after_day: Option<u32>,

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

    /// 2026-05-24 — per-asset hour gate (UTC). When `Some`, ONLY this list
    /// of hours allows entries on this asset; the cfg-level
    /// `allowed_hours_utc` is ignored for this asset. Enables disjoint
    /// time-scheduling between asset-clones (e.g. AMBER-side trading
    /// even hours, SHORT-side trading odd hours) — eliminates the
    /// same-bar long+short hedge problem of single-account hybrids
    /// without needing a hard mutex.
    #[serde(default, rename = "allowedHoursUtc")]
    pub allowed_hours_utc: Option<Vec<u32>>,
}

impl AssetConfig {
    /// Resolves the effective invert flag.
    ///
    /// 2026-05-24 Wave7 doc-honesty fix: prior comment claimed this mirrors
    /// TS `asset.invertDirection ?? cfg.invertDirection ?? false` exactly,
    /// but `invert_direction: bool` cannot distinguish "unset / use cfg"
    /// from "explicitly false". So the OR semantics here cannot honor TS's
    /// asset-overrides-cfg-with-false case. In practice no production
    /// template sets `cfg.invert_direction: true` (all use the default
    /// `false`), so the limitation is theoretical — but `signals_forex_mr`
    /// and similar callers that want to express "explicit non-invert"
    /// should rely on cfg-level `false` and per-asset `true`-or-`false`
    /// (which works). True asset-overrides-cfg-with-false would need a
    /// migration to `Option<bool>` and updates to all 56+ call sites.
    pub fn effective_invert_direction(&self, cfg: &EngineConfig) -> bool {
        self.invert_direction || cfg.invert_direction
    }
}

/// Cross-asset filter — only allow signals if `symbol` is currently
/// trending in the configured direction(s). Trend determined by
/// EMA(fast) vs EMA(slow) on `symbol`'s candle stream supplied at runtime.
///
/// 2026-05-13 Codex HIGH FIX (Fix 7): TS source-of-truth
/// (`ftmoDaytrade24h.ts:837-862`) uses `emaFastPeriod` / `emaSlowPeriod`
/// plus four boolean blocker fields. Rust previously used `fastPeriod` /
/// `slowPeriod` (silently dropped TS-named fields on load) and a single
/// `direction` string. Now: serde aliases accept BOTH names, and the
/// TS-style boolean blockers are honored alongside the legacy `direction`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrossAssetFilter {
    pub symbol: String,
    /// Required direction — `"long"`, `"short"`, or `"any"` (just trend up OR down).
    /// Legacy Rust-only field. When skip-* booleans are set, takes precedence over `direction`.
    #[serde(default = "default_cross_dir")]
    pub direction: String,
    #[serde(
        default = "default_fast_period",
        rename = "fastPeriod",
        alias = "emaFastPeriod"
    )]
    pub fast_period: u32,
    #[serde(
        default = "default_slow_period",
        rename = "slowPeriod",
        alias = "emaSlowPeriod"
    )]
    pub slow_period: u32,
    /// 2026-05-13 Codex Fix 7: skip long signals when secondary is in downtrend
    /// (EMA-fast < EMA-slow on secondary). TS `skipLongsIfSecondaryDowntrend`.
    #[serde(default, rename = "skipLongsIfSecondaryDowntrend")]
    pub skip_longs_if_secondary_downtrend: bool,
    /// 2026-05-13 Codex Fix 7: skip short signals when secondary is in uptrend.
    /// TS `skipShortsIfSecondaryUptrend`.
    #[serde(default, rename = "skipShortsIfSecondaryUptrend")]
    pub skip_shorts_if_secondary_uptrend: bool,
    /// 2026-05-14 (detector-41): when `true`, invert the secondary-asset
    /// trend before applying the direction gate. Used to model
    /// inverse-correlated drivers such as DXY ↔ crypto: a *down*-trending DXY
    /// supports long crypto, an *up*-trending DXY supports short crypto.
    /// Default `false` preserves existing direct-correlation semantics.
    #[serde(default, rename = "inverseCorrelation")]
    pub inverse_correlation: bool,
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
    /// 2026-05-16 Phase 14 — Fractional-Kelly modifier. Default 1.0 = full
    /// Kelly. 0.5 = Half-Kelly (Thorp/Kelly criterion: ~75% of log-growth at
    /// ~25% of volatility). Multiplies the tier multiplier at apply-time so
    /// existing tier ladders remain semantically meaningful.
    #[serde(default = "default_kelly_fraction", rename = "fraction")]
    pub fraction: f64,
}

fn default_kelly_fraction() -> f64 {
    1.0
}

/// 2026-05-13 Codex HIGH FIX (Fix 8): TS `dayBasedRiskMultiplier` schema
/// from `ftmoLiveEngineV4.ts:1976-1981`. While `state.day <
/// conservativeFirstDays`, multiply effective risk by `conservativeFactor`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DayBasedRiskMultiplier {
    #[serde(rename = "conservativeFirstDays")]
    pub conservative_first_days: u32,
    #[serde(rename = "conservativeFactor")]
    pub conservative_factor: f64,
}

/// 2026-05-14 Detector #49 — Sharpe-ratio-optimized sizing modifier.
///
/// Computes a rolling per-trade Sharpe over the last `window_size` Kelly-PnL
/// entries (mean / std-dev, NOT annualized — the FTMO universe sizes per
/// trade so annualizing introduces a horizon term the modifier doesn't need)
/// then maps the result through a `SharpeTier` ladder. Tiers are sorted
/// descending by `sharpe_above`; the highest matching tier wins. Hysteresis
/// (`HYST=0.05`) prevents flicker, mirroring the Kelly-tier pattern in
/// `sizing.rs`.
///
/// Cap-down-only: the chosen `multiplier` is applied as
/// `factor = factor.min(multiplier)`. A tier with `multiplier > 1.0` is
/// therefore a no-op — by design, so an over-eager config can never inflate
/// risk on the back of recent Sharpe.
///
/// Lookahead-safe: the reference window is `state.kelly_pnls` filtered
/// strictly to `close_time < entry_time_ms`. The PnL of a trade that closed
/// at the entry-bar's open MUST NOT enter the Sharpe — `close_trade` writes
/// it on the SAME bar, so the strict-less filter is load-bearing.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SharpeTier {
    #[serde(rename = "sharpeAbove")]
    pub sharpe_above: f64,
    pub multiplier: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharpeSizing {
    #[serde(rename = "windowSize")]
    pub window_size: u32,
    #[serde(rename = "minTrades")]
    pub min_trades: u32,
    pub tiers: Vec<SharpeTier>,
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

/// Detector #20 — early defensive sizing when realized equity has already
/// reached a fraction of profit-target. Lookahead-safe: `state.equity` is
/// realized-only at the signal bar (only mutated in `close_trade` via
/// `state.equity *= 1.0 + pnl.eff_pnl`). When `state.equity - 1.0 >=
/// profit_target * progressFrac`, the sizing factor is capped at `factor`
/// — but ONLY if `factor` is smaller than the day-stage factor (override
/// never raises sizing, only lowers).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct EarlyDefensiveOnProgress {
    /// Trigger when state.equity - 1.0 >= profit_target * this_frac.
    #[serde(rename = "progressFrac")]
    pub progress_frac: f64,
    /// Override factor once trigger fires (replaces day-stage factor if smaller).
    pub factor: f64,
}

/// 2026-05-14 Detector #48 — Time-Decay Sizing Modifier.
///
/// Applies an exponentially decaying sizing factor as the challenge approaches
/// `max_days`. The decay starts at `start_day` and accelerates linearly
/// toward `max_days`:
///
/// ```text
///   progress = (state.day - start_day) / (max_days - start_day)   // 0..1
///   raw      = max(exp(-decay * progress), min_factor)
/// ```
///
/// `mode` controls how `raw` interacts with the prior sizing factor:
///   - `Multiplicative` — `factor *= raw` (always shrinks, may compound).
///   - `CapDown` (default) — `factor = min(factor, raw)` (cap-only, never raises).
///
/// Cap-down mode is safer for stacking with other defensive throttles: a
/// misconfigured `factor: 2.0` cannot blow up sizing because the comparison
/// is monotone. The exp curve gives a smoother glide-path than discrete
/// day-tiers and is lookahead-safe (consults `state.day` only).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TimeDecaySizing {
    /// Exponential decay rate. Higher = faster cap-down toward `min_factor`.
    /// Typical: 0.7 → factor halves around day ≈ start_day + 0.99 × range.
    pub decay: f64,
    /// Day index at which decay starts. Earlier days run at 1.0.
    #[serde(rename = "startDay")]
    pub start_day: u32,
    /// Hard floor for the decay factor — guards against zero-sizing as
    /// `state.day` approaches `max_days`.
    #[serde(rename = "minFactor")]
    pub min_factor: f64,
    /// Composition rule against the prior sizing factor.
    pub mode: TimeDecayMode,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TimeDecayMode {
    /// `factor *= raw` — always shrinks, can compound with other multipliers.
    Multiplicative,
    /// `factor = min(factor, raw)` — caps DOWN only, monotone-safe.
    CapDown,
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

/// 2026-05-14 Detector #11 Phase-1 — Funding-Cost sizing modifier config.
///
/// When `Some`, signal-emit paths scale eff_risk by
/// `funding_cost_modifier(...)` (see `sizing.rs`). Asymmetric clamp: only
/// penalises pay-side, never bonus on receive-side. No-op (factor = 1.0)
/// when funding series is unavailable.
///
/// `alpha`: sensitivity (1.5 ≈ aggressive de-risk on +1σ pay-side spike)
/// `norm_window_buckets`: reference-window length in bars (720 ≈ 15 days
///   at 30min cadence; longer = more stable z-norm)
/// `min_factor`: floor for the modifier (0.4 ≈ keep at least 40% sizing
///   even on extreme pay-side spikes)
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FundingCostSizing {
    pub alpha: f64,
    #[serde(rename = "normWindowBuckets")]
    pub norm_window_buckets: u32,
    #[serde(rename = "minFactor")]
    pub min_factor: f64,
}

impl Default for FundingCostSizing {
    fn default() -> Self {
        Self {
            alpha: 1.5,
            norm_window_buckets: 720,
            min_factor: 0.4,
        }
    }
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
    /// 2026-05-13 Codex HIGH FIX (Fix 8): TS `dayBasedRiskMultiplier`
    /// (`ftmoLiveEngineV4.ts:1975-1981`) — early challenge days run with a
    /// `conservativeFactor` (typically 0.5) for `conservativeFirstDays` to
    /// preserve capital, then full risk-frac after the floor day. Rust
    /// previously dropped this field on load → over-sized in early days.
    #[serde(default, rename = "dayBasedRiskMultiplier")]
    pub day_based_risk_multiplier: Option<DayBasedRiskMultiplier>,
    /// 2026-05-14 Detector #49 — Sharpe-ratio-optimized sizing modifier.
    /// See `SharpeSizing` doc for semantics. Lives BETWEEN Kelly-block and
    /// Hard-Cap in `resolve_sizing_factor` so it can cap-down anything
    /// Kelly-or-earlier raised, but cannot exceed `HARD_CAP=4.0`.
    #[serde(default, rename = "sharpeSizing")]
    pub sharpe_sizing: Option<SharpeSizing>,
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

    /// 2026-05-23 HYBRID-MUTEX flag — when `cross_asset_filter` is set, force-
    /// close any open position whose direction opposes the current cross-asset
    /// trend (e.g. close longs when BNB flips bearish). Only fires when the
    /// cross-asset trend is non-neutral (clear bullish OR bearish via 3-way
    /// EMA stack). Designed for HYBRID long+short single-account templates
    /// that need true regime-mutex (else stale-side positions tank equity at
    /// regime flips). Off by default to preserve existing template behaviour.
    #[serde(default, rename = "regimeFlipCloseOpposite")]
    pub regime_flip_close_opposite: bool,

    /// 2026-05-23 POSITION-LEVEL MUTEX flag — block new entries whose
    /// direction opposes ANY currently-open position. True 1-side-at-a-time
    /// mutex across all assets (not just same asset). Designed for HYBRID
    /// long+short single-account templates: when AMBER has any long open,
    /// SHORTS entries skip; when SHORTS has any short open, AMBER entries
    /// skip. Off by default.
    #[serde(default, rename = "mutexLongShort")]
    pub mutex_long_short: bool,

    /// 2026-05-24 — Pyramid: allow a SECOND same-asset+same-direction
    /// entry when the existing position is already at least this much in
    /// profit (e.g. 0.02 = +2% unrealized). Bypasses the trade-exclusivity
    /// gate which normally blocks duplicate positions. The new entry uses
    /// `pyramid_size_mult × original_eff_risk` to limit added exposure.
    /// 0.0 / None = disabled (default). Mirrors the discretionary trader
    /// "scale into winning trades" pattern.
    #[serde(default, rename = "allowPyramidAfterProfitPct")]
    pub allow_pyramid_after_profit_pct: Option<f64>,
    /// Size multiplier for pyramid entries. Default 0.5 = half size.
    #[serde(default = "default_pyramid_size_mult", rename = "pyramidSizeMult")]
    pub pyramid_size_mult: f64,

    /// 2026-05-19 Pattern-D fix — when this many consecutive stop-loss
    /// exits occur within a single trading day, pause all new entries
    /// until the next day boundary. 0 = disabled (default). Typical
    /// effective values: 3-4 for V5_AMBER_MAX_PASSLOCK (per Round-2 deep-dive).
    /// Converts "early TL fast disaster" windows (Pattern D, 18 of 80
    /// fails) from terminal -10% TL into recoverable -5% DL-only.
    #[serde(default, rename = "maxConsecStopsPerDay")]
    pub max_consec_stops_per_day: u32,

    /// 2026-05-19 Pattern-C fix — trailing-DD-lock trigger. When realized
    /// equity reaches +X% (e.g. 0.05), arm a trailing DD floor. Floor =
    /// peak - floor_pct. If equity falls below floor, force-close all and
    /// stop trading. 0.0 = disabled. Uses state.equity (REALIZED), NOT
    /// state.mtm_equity (avoids fighting PASSLOCK like anti-reversal did).
    #[serde(default, rename = "trailDdLockTrigger")]
    pub trail_dd_lock_trigger: f64,
    #[serde(default, rename = "trailDdLockFloor")]
    pub trail_dd_lock_floor: f64,

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

    /// 2026-05-14 Detector #11 Phase-1 — see `FundingCostSizing` docstring.
    #[serde(default, rename = "fundingCostSizing")]
    pub funding_cost_sizing: Option<FundingCostSizing>,

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
    /// Detector #20 — equity-progress trigger that overrides day-stage
    /// sizing into defensive mode early, BEFORE the day counter catches up.
    /// Lookahead-safe: `state.equity` is realized-only. See struct doc.
    #[serde(default, rename = "earlyDefensiveOnProgress")]
    pub early_defensive_on_progress: Option<EarlyDefensiveOnProgress>,
    /// 2026-05-14 Detector #48 — see `TimeDecaySizing` docstring. None = no-op.
    #[serde(default, rename = "timeDecaySizing")]
    pub time_decay_sizing: Option<TimeDecaySizing>,
    #[serde(default, rename = "reentryAfterStop")]
    pub reentry_after_stop: Option<ReentryAfterStop>,
    #[serde(default, rename = "meanReversionSource")]
    pub mean_reversion_source: Option<MeanReversionSource>,
    /// 2026-05-29 BrightFunded daily-loss floor. When `true`, the daily floor is
    /// anchored to the PREVIOUS day's high-water-mark = `max(EoD balance, EoD
    /// equity) − max_daily_loss`, computed once at the day rollover and FROZEN
    /// for the whole day (it does NOT trail intraday highs). The breach is still
    /// checked INTRADAY (every bar, on `min(balance, equity)`), so this is not
    /// an "only at end-of-day" rule — it differs from FTMO solely in the floor's
    /// anchor (prev-EoD-HWM vs the current day-start × (1 − mdl)). Verified
    /// against the BrightFunded help-center. Default `false` = FTMO behavior.
    #[serde(default, rename = "dailyLossEodHwm")]
    pub daily_loss_eod_hwm: bool,
    /// 2026-05-29 Intra-bar drawdown check. When `true`, the DailyLoss /
    /// TotalLoss floors are also tested against the worst-case intra-bar MTM
    /// (bar low for longs, bar high for shorts) — not just the bar close — so a
    /// position that pierces the floor mid-bar and recovers by the close is
    /// still busted, matching a broker's real-time equity monitoring. Default
    /// `false` keeps the close-only behavior (FTMO parity). Pairs with
    /// `daily_loss_eod` to model BrightFunded: daily floor evaluated EoD on the
    /// close, the hard total floor still enforced intra-bar.
    #[serde(default, rename = "intrabarDdCheck")]
    pub intrabar_dd_check: bool,
}

fn default_start_balance() -> f64 {
    100_000.0
}

fn default_pyramid_size_mult() -> f64 {
    0.5
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
            day_based_risk_multiplier: None,
            sharpe_sizing: None,
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
            funding_cost_sizing: None,
            cross_asset_filter: None,
            cross_asset_filters_extra: None,
            vol_adaptive_tp_mult: None,
            ping_reliability: None,
            time_exit_enabled: false,
            pause_at_target_reached: true,
            close_all_on_target_reached: true,
            regime_flip_close_opposite: false,
            mutex_long_short: false,
            allow_pyramid_after_profit_pct: None,
            pyramid_size_mult: 0.5,
            max_consec_stops_per_day: 0,
            trail_dd_lock_trigger: 0.0,
            trail_dd_lock_floor: 0.0,
            invert_direction: false,
            bar_minutes: 30,
            daily_equity_guardian: None,
            daily_loss_eod_hwm: false,
            intrabar_dd_check: false,
            bypass_live_caps: false,
            day_progressive_sizing: None,
            early_defensive_on_progress: None,
            time_decay_sizing: None,
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
        let asset = AssetConfig {
            invert_direction: false,
            ..Default::default()
        };
        assert!(asset.effective_invert_direction(&cfg));

        // Per-asset `true` works when cfg fallback is off (existing path).
        let cfg2 = EngineConfig::r28_v6_passlock_template();
        let asset2 = AssetConfig {
            invert_direction: true,
            ..Default::default()
        };
        assert!(asset2.effective_invert_direction(&cfg2));

        // Both off → no invert.
        let asset3 = AssetConfig::default();
        assert!(!asset3.effective_invert_direction(&cfg2));
    }
}
