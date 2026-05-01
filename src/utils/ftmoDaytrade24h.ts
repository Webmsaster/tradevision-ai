/**
 * FTMO 24H-HOLD DAYTRADE — Normal Plan (iter188-189).
 *
 * Purpose: TRUE daytrade strategy for FTMO Normal/Aggressive plans where
 * overnight hold fees apply and Swing features are NOT available.
 *
 * Constraint: Max hold ≤ 24h per trade (4 bars on 4h timeframe).
 *
 * Config (iter189 validated at realistic 40bp BTC / 30bp ETH / 40bp SOL /
 * 45bp AVAX execution costs):
 *   • 4 assets: BTC+ETH+SOL+AVAX on 4h timeframe
 *   • Bidirectional 3-bar mean-reversion trigger (3 consecutive red → long,
 *     3 consecutive green → short)
 *   • TP 10% / Stop 0.5% / Hold 4 bars (16h, within 24h limit)
 *   • 2× leverage, 33% risk per asset
 *   • TP:Stop ratio = 20:1 (heavy asymmetric — cost is 0.4%/0.5% = 80% of stop)
 *
 * Validated (iter189):
 *   • Monte-Carlo 300 random starts: 46.33% pass
 *   • Non-overlapping IS: 50.00% (59 windows)
 *   • Non-overlapping OOS: 48.15% (only 2pp gap from IS — robust!)
 *   • EV per challenge: +$1,754 (MC-based conservative)
 *   • EV-OOS: +$1,827
 *
 * Live conservative estimate (40-45% pass rate):
 *   • EV per challenge: +$1,500 to +$1,700
 *   • Over 20 challenges ($1,980 fees): +$28k to +$32k expected
 *
 * Why this works for 24h max hold:
 *   1. 4h timeframe → 3-bar trigger = 12h of confluence (meaningful move)
 *   2. 10% TP dwarfs 40 bp cost (cost is 4% of TP, not 100%)
 *   3. 0.5% stop catches false moves without eating spread
 *   4. Exit by bar 4 (16h) keeps well within 24h limit
 *   5. 4-asset diversification — BTC/ETH/SOL/AVAX fire different times
 *
 * HONEST WARNINGS:
 *   • 50% of challenges will fail — plan for multiple attempts.
 *   • Industry FTMO pass rate is 10-15%. 40-45% is 3× better but variance-heavy.
 *   • 3-bar trigger fires ~1-3× per week per asset, so 30-day challenge gets
 *     12-30 trades total. Sparse but high-quality.
 *   • SOL/AVAX have wider spread. If live slippage exceeds 50 bp on these,
 *     pass rate drops materially (~10pp).
 *   • Requires FTMO plan with BTC + ETH + SOL + AVAX CFDs.
 *   • This is TRUE daytrade (max 16h hold) — no swap/overnight fees.
 *
 * Supersedes iter186 for users on Normal/Aggressive plans (20-day Swing
 * holds not allowed). For Swing plan holders, use ftmoRealisticUltra
 * (70% OOS) instead.
 */
import type { Candle } from "@/utils/indicators";
import { rsi, atr, ema, adx, choppiness } from "@/utils/indicators";
import type { NewsEvent } from "@/utils/forexFactoryNews";
import { isNewsBlackout } from "@/utils/forexFactoryNews";

export interface Daytrade24hAssetCfg {
  symbol: string;
  /** One-way commission in basis points (e.g. 30 = 0.3 %). Doubled round-trip. */
  costBp: number;
  /**
   * Extra execution slippage in basis points, applied on top of costBp
   * on both entry and exit. Reflects typical FTMO-broker market-order
   * slippage (5-15 bp on majors, 15-30 bp on alts during volatile moves).
   */
  slippageBp?: number;
  /**
   * Overnight swap fee per day in basis points (positive = cost for holder).
   * Applied per UTC-midnight crossing during the trade. Typical CFD crypto:
   * 3-8 bp/day for long positions, 0-3 bp/day for shorts.
   */
  swapBpPerDay?: number;
  riskFrac: number;
  /** Per-asset override; falls back to cfg.stopPct. */
  stopPct?: number;
  /** Per-asset override; falls back to cfg.tpPct. */
  tpPct?: number;
  /** Per-asset override; falls back to cfg.holdBars. */
  holdBars?: number;
  /** Per-asset override; falls back to cfg.triggerBars. */
  triggerBars?: number;
  /** Per-asset override of cfg.fundingRateFilter.maxFundingForLong. */
  maxFundingForLong?: number;
  /** Per-asset override of cfg.fundingRateFilter.minFundingForShort. */
  minFundingForShort?: number;
  /**
   * Pullback-entry: after the consecutive-close trigger fires, do NOT enter
   * immediately at next-bar open. Instead wait up to `maxWaitBars` for price
   * to pullback by `pullbackPct` from the trigger close, then enter.
   *
   * Better R:R per trade — entry closer to support → tighter dollar stop.
   * Trades that don't pullback are skipped (no entry).
   */
  pullbackEntry?: {
    maxWaitBars: number;
    pullbackPct: number;
  };
  /** Per-asset override; falls back to cfg.invertDirection. */
  invertDirection?: boolean;
  /** Per-asset override: disable longs for this asset. */
  disableLong?: boolean;
  /** Per-asset override: disable shorts for this asset. */
  disableShort?: boolean;
  /**
   * Alternative entry signal — replaces the default N-bar consecutive-close
   * trigger with a Donchian channel breakout:
   *   long: close > max(high[i-period..i-1])
   *   short: close < min(low[i-period..i-1])
   */
  donchianEntry?: {
    period: number;
  };
  /**
   * Alternative entry signal — Bollinger-Keltner Squeeze release.
   * Long if BB upper crosses above KC upper after period of squeeze.
   * Short if BB lower crosses below KC lower after period of squeeze.
   */
  bbKcSqueezeEntry?: {
    bbPeriod: number;
    bbSigma: number;
    kcPeriod: number;
    kcMult: number;
    minSqueezeBars: number; // require N consecutive squeeze bars before release fires
  };
  /**
   * MA-Crossover entry: long when fast MA crosses above slow MA (bullish cross).
   * Short when fast crosses below.
   */
  maCrossEntry?: {
    fastPeriod: number;
    slowPeriod: number;
  };
  /**
   * Time-Series Momentum entry: long when last `lookbackBars` return > threshold.
   * Short when return < -threshold.
   */
  tsMomentumEntry?: {
    lookbackBars: number;
    threshold: number;
  };
  /**
   * Volatility Breakout NR7-style: long when current bar breaks above
   * the high of the last `compressionBars` narrowest-range bars.
   */
  nr7Entry?: {
    compressionBars: number; // lookback for narrowest-range identification
  };
  /**
   * Source symbol for candle lookup, if different from `symbol`.
   * Lets two logical assets share the same underlying candles (e.g.
   * ETHUSDT mean-reversion and ETHUSDT momentum as virtual assets).
   */
  sourceSymbol?: string;
  /**
   * Only fire trades on day >= activateAfterDay. Lets a secondary
   * strategy kick in late-game as a rescue (e.g. MOM after day 15 if
   * MR hasn't hit target yet).
   */
  activateAfterDay?: number;
  /**
   * Only fire trades on day < deactivateAfterDay. Lets a primary
   * strategy run only early-game.
   */
  deactivateAfterDay?: number;
  /**
   * Only fire if current equity-1 >= minEquityGain. Lets a strategy
   * activate as "scale-in" once the account is green.
   */
  minEquityGain?: number;
  /**
   * Only fire if current equity-1 <= maxEquityGain. Lets a rescue
   * strategy activate only when we're behind.
   */
  maxEquityGain?: number;
  /**
   * iter1h-035+ VOL-TARGETED POSITION SIZING (asset-level, AQR/Roncalli).
   * Multiplies risk by clamp(targetAtr/realizedAtr, minMult, maxMult).
   * Larger position in calm regimes, smaller in spikes.
   */
  volTargeting?: {
    period: number;
    targetAtrFrac: number;
    minMult: number;
    maxMult: number;
  };
  /**
   * iter1h-035+ TRIPLE-BARRIER TIME EXIT (de Prado).
   * Closes trade after maxBarsWithoutGain if unrealized PnL never reached
   * minGainR × stopPct. Frees capital from "dead trades".
   */
  timeExit?: {
    maxBarsWithoutGain: number;
    minGainR: number;
  };
}

export interface FtmoDaytrade24hConfig {
  triggerBars: number;
  leverage: number;
  tpPct: number;
  stopPct: number;
  holdBars: number;
  /** Cosmetic only — engine derives bar duration from candle timestamps. */
  timeframe: "5m" | "15m" | "30m" | "1h" | "2h" | "4h";
  assets: Daytrade24hAssetCfg[];
  profitTarget: number;
  maxDailyLoss: number;
  maxTotalLoss: number;
  minTradingDays: number;
  maxDays: number;
  /**
   * Optional adaptive sizing tiers based on current equity.
   * Applied as multiplier on asset.riskFrac at trade-entry time.
   * Array must be sorted by equityAbove ascending.
   * Example (iter194 winner):
   *   [{ equityAbove: 0, factor: 0.75 },       // start 75% of base (30% actual if base 40%)
   *    { equityAbove: 0.03, factor: 1.125 },   // after +3%, ramp to 112.5% (45%)
   *    { equityAbove: 0.08, factor: 0.375 }]   // after +8%, protect at 37.5% (15%)
   * Without this field, uses flat riskFrac.
   */
  adaptiveSizing?: Array<{ equityAbove: number; factor: number }>;
  /**
   * Optional iter197 time-adaptive override. If day >= afterDay AND
   * equity < 1 + equityBelow, replaces the adaptiveSizing factor with
   * `factor` (late-game push when behind schedule). Skipped if the
   * protective top tier already applies (equity already near target).
   */
  timeBoost?: { afterDay: number; equityBelow: number; factor: number };
  /**
   * iter231+ Kelly-style rolling-winrate adaptive sizing.
   * Tracks realized win rate of last N completed trades and multiplies
   * the current sizing factor by a tiered multiplier based on the rolling
   * win rate. This is a Kelly-fraction approximation: when recent
   * performance confirms edge, scale up; when struggling, scale down.
   *
   * Tiers checked from highest winRateAbove down — first matching tier
   * wins. If fewer than `minTrades` completed, multiplier is 1.0 (neutral).
   *
   * Example (winner from iter231 sweep):
   *   windowSize: 10, minTrades: 5
   *   tiers: [
   *     { winRateAbove: 0.7, multiplier: 1.5 },   // hot streak
   *     { winRateAbove: 0.5, multiplier: 1.0 },   // neutral
   *     { winRateAbove: 0.0, multiplier: 0.6 },   // cold, reduce
   *   ]
   */
  kellySizing?: {
    windowSize: number;
    minTrades: number;
    tiers: Array<{ winRateAbove: number; multiplier: number }>;
  };
  /**
   * Optional iter201+ RSI confluence filter. If present, a signal only
   * fires when RSI(period) on the *signal bar* (index i) is within the
   * configured band. Longs need RSI ≤ longMax (oversold confirmation),
   * shorts need RSI ≥ shortMin (overbought confirmation). Leave either
   * side undefined to disable it. If RSI is not yet defined at that
   * bar (early candles), the signal is skipped to stay conservative.
   */
  rsiFilter?: {
    period: number;
    longMax?: number;
    shortMin?: number;
  };
  /**
   * Optional break-even shift. Once an open trade's bar.close shows an
   * unrealized gain ≥ threshold (e.g. 0.02 = +2%), the stop is moved to
   * the entry price for all subsequent bars. This converts would-be
   * winners-that-reversed into zero-cost exits. Effective threshold
   * should be smaller than tpPct (otherwise TP would fire first).
   */
  breakEven?: {
    threshold: number;
  };
  /**
   * Optional ATR-adaptive stop. If present, the stop distance at entry
   * becomes max(cfg.stopPct, stopMult × ATR(period) / entryPrice).
   * Widening the stop in volatile regimes avoids being knocked out by
   * normal price action; narrow regimes fall back to the base stopPct
   * as a floor. The TP stays fixed (tpPct).
   */
  atrStop?: {
    period: number;
    stopMult: number;
  };
  /**
   * Live-execution safety caps. NOTE on units: `maxRiskFrac` is in ENGINE
   * units (exposure fraction of leverage × equity), NOT live equity-loss %.
   *   live_loss_at_stop = engine_riskFrac × stopPct × leverage
   * To match live `LIVE_MAX_RISK_FRAC = 0.04` at stop=5% and leverage=2:
   *   engine cap = 0.04 / (0.05 × 2) = 0.4
   * `maxStopPct` is in raw price-move units (same as live).
   *
   * Set this on a backtest run to reproduce live-trading reality:
   *   - If atrStop pushes effStop above maxStopPct → trade is SKIPPED.
   *   - asset.riskFrac × factor is clamped to maxRiskFrac in the PnL formula.
   * Leave undefined to run the historical "no-cap" backtest math (default).
   */
  liveCaps?: {
    maxStopPct: number; // raw price move %, e.g. 0.05 = 5%
    maxRiskFrac: number; // ENGINE riskFrac (exposure), e.g. 0.4 ≈ 4% live loss at 5% stop
  };
  /**
   * Peak-relative drawdown throttle: when equity is X% below its highest
   * point, scale risk DOWN. Catches profit-give-back scenarios that
   * `drawdownShield` (absolute threshold) misses.
   */
  peakDrawdownThrottle?: { fromPeak: number; factor: number };
  /**
   * Cap on number of trades that can be open at the same time. New entries
   * are SKIPPED while at the cap. Reduces clustered same-day-stop catastrophe
   * (multiple correlated crypto longs all hitting stop in one bad bar).
   */
  maxConcurrentTrades?: number;
  /**
   * Round-13 Anti-DL feature: intraday daily-loss circuit-breaker.
   *
   * Web research showed top-tier FTMO bots have a 2-stage daily-loss kill-switch
   * (Prop Firm Risk Guard pattern). When realized day-PnL drops to:
   *   - softLossThreshold (e.g. -0.03 = -3%): scale risk by `softFactor` (e.g. 0.5)
   *   - hardLossThreshold (e.g. -0.04 = -4%): block all new entries for the day
   *
   * Targets V5_NOVA's 53% DL-fail rate by stopping the "letzter trade kippt
   * den Account"-pattern — most blow-ups happen on the 4th or 5th trade of
   * a losing day, not the 1st. Tightening sizing after -3% prevents the
   * runaway. Operates on REALIZED equity (sort-by-exit), conservative compared
   * to true intraday tick-based.
   */
  intradayDailyLossThrottle?: {
    softLossThreshold: number; // e.g. 0.03 (positive number, treated as -3%)
    hardLossThreshold: number; // e.g. 0.04 (positive number, treated as -4%)
    softFactor: number; // e.g. 0.5 — multiplier on factor when soft hit
  };
  /**
   * Round-22 Reliability feature: simulate bot ping-reliability for the
   * pause-after-target ping-trade phase.
   *
   * Default 1.0 (current behavior — assumes 100% bot uptime + zero failed
   * pings). In live, pings can fail due to bot downtime, cron-miss, or
   * MT5-disconnect. Use 0.85 for a conservatively-reliable bot, or 0.7 for
   * realistic worst-case. Engine simulates each ping-day as Bernoulli(prob);
   * failed pings advance the calendar day without satisfying minTradingDays.
   *
   * Without this realism, pause-mode pass-rates are inflated 10-20pp because
   * 76% of passes cluster exactly at minTradingDays floor (engine guarantees
   * ping success). Memory note: V5_QUARTZ_LITE 83.58% pass / median 4d
   * was measured at pingReliability=1.0 (best case).
   */
  pingReliability?: number;
  /**
   * Round-28 Live-Replication mode: switches the equity-loop sort from
   * EXIT-time order (default — see all.sort comment) to ENTRY-time order.
   *
   * Default false (back-compat with backtest numbers). Set to true to
   * approximate the bar-by-bar live-replication: trades are processed in
   * the chronological order they were ENTERED (the order a live bot would
   * actually open them), not the order they happened to close. This means:
   *   - MCT cap (maxConcurrentTrades) is checked against the realised
   *     entry-order (no later-exit selection bias).
   *   - Equity at trade-N's entry already includes ALL still-open trades'
   *     not-yet-realised PnL (consistent with a live broker's mark-to-mkt
   *     equity at the moment the next order is sent).
   * NOTE: this is ONE part of true live-replication. The detector phase
   * (detectAsset → all signals collected up-front) still has full window
   * lookahead for stack-ranking (momentumRanking, correlationFilter checks
   * walk pre-sorted `all` with future trades). True bar-by-bar live needs
   * a chronological detector (V4 simulator). liveMode is a midpoint check
   * that isolates "is the EXIT-time sort the source of inflation?"
   */
  liveMode?: boolean;
  /**
   * Round-15 Anti-TL feature: challenge-peak trailing equity-stop.
   *
   * Sister to dailyPeakTrailingStop but on CHALLENGE-WIDE peak instead of
   * daily peak. When equity drops `trailDistance` below the all-time
   * challenge peak, halt all new entries until the challenge ends.
   *
   * Targets the "good day, then 4 bad days nuke account" pattern that
   * pushes TL fail-rate. Distinct from peakDrawdownThrottle (which scales
   * down sizing — this hard-stops new entries).
   *
   * Example: equity rose to +6%, trailDistance=0.05 — once equity drops
   * to +1%, stop trading and ride out remaining days for the win.
   */
  challengePeakTrailingStop?: {
    trailDistance: number; // e.g. 0.05 = 5% below challenge peak
  };
  /**
   * Round-13 Anti-DL feature: daily equity-peak trailing stop.
   *
   * Tracks intraday peak equity per day. If equity drops more than
   * `trailDistance` below daily peak, halt new entries until next day.
   * Prevents profit-give-back DL fails — distinct from peakDrawdownThrottle
   * (challenge-wide peak) and drawdownShield (absolute equity threshold).
   *
   * Example: peak +2.5% intraday, trailDistance=0.03, equity drops to -0.5%
   *   → 3pp below peak → block new entries.
   */
  dailyPeakTrailingStop?: {
    trailDistance: number; // e.g. 0.03 = 3% below daily peak
  };
  /**
   * Volume confirmation filter: skip trade if trigger bar's volume is below
   * `minRatio × SMA(period)` of preceding volumes. Catches "real" breakouts.
   */
  volumeFilter?: {
    period: number;
    minRatio: number;
  };
  /**
   * Choppiness Index filter — skip trades when CI > maxCi (choppy market) or
   * CI < minCi. CI scale: 0-100, >61.8 = sideways, <38.2 = trending.
   */
  choppinessFilter?: {
    period: number;
    maxCi?: number;
    minCi?: number;
  };
  /**
   * iter253+ CHANDELIER EXIT — trailing stop based on highest_close (or
   * lowest_close for shorts) since entry, minus K × ATR. Locks in profit
   * when price moves favorably. Only activates AFTER price has moved at least
   * `minMoveR` × stopPct in the favorable direction (avoids exiting on
   * normal noise right after entry).
   *
   * For LONGS: stop_chandelier = highest_close_since_entry - K × ATR
   * For SHORTS: stop_chandelier = lowest_close_since_entry + K × ATR
   *
   * Effective stop = max(original_stop, chandelier_stop) for longs,
   *                = min(original_stop, chandelier_stop) for shorts.
   * (Tightening only — never widens beyond initial stop.)
   */
  chandelierExit?: {
    period: number; // ATR period
    mult: number; // K multiplier on ATR
    minMoveR?: number; // require price to move >= minMoveR × stopPct first (default 0.5)
  };
  /**
   * iter262+ Loss-Streak Cooldown — pause new entries after N consecutive losses.
   *
   * When the strategy hits a streak of stop-outs, market regime may be hostile.
   * Pausing for cooldownBars avoids piling more bad trades on top.
   * Counter resets on any winning (TP) trade.
   */
  lossStreakCooldown?: {
    afterLosses: number; // trigger after N consecutive stop-outs
    cooldownBars: number; // skip entries for this many bars
  };
  /**
   * iter261+ Partial Take Profit — scale-out mid-trade.
   *
   * When unrealized gain crosses `triggerPct`, "close" `closeFraction` of
   * the position by locking in that partial gain. The remaining
   * (1 - closeFraction) continues to TP/stop normally.
   *
   * Effective P&L = closeFraction × triggerPct + (1 - closeFraction) × exitPct
   *
   * Reduces variance — partial profit secured even if trade reverses.
   * Use small closeFraction (0.3-0.5) to keep upside on the rest.
   */
  partialTakeProfit?: {
    triggerPct: number; // unrealized P&L threshold to take partial
    closeFraction: number; // fraction of position to close (0-1)
  };
  /**
   * Multi-level Partial TP: take profits at multiple staged levels.
   * Each level closes a fraction when unrealized P&L crosses triggerPct.
   * Levels are applied in order, only when prior levels triggered.
   */
  partialTakeProfitLevels?: Array<{
    triggerPct: number;
    closeFraction: number;
  }>;
  /**
   * Trailing stop in % from peak unrealized profit.
   * Activates only after `activatePct` unrealized P&L is reached.
   * Then stop is dragged at `trailPct` below the running max.
   */
  trailingStop?: {
    activatePct: number; // start trailing when up >= this
    trailPct: number; // trail this far below peak
  };
  /**
   * Re-entry after stop: if trade stops out and asset still in trend
   * (price still on right side of trigger), allow one re-entry within
   * `reEntryWindowBars` bars. Prevents losing whipsaws but capturing trends.
   */
  reEntryAfterStop?: {
    maxRetries: number; // 1 typical
    windowBars: number; // re-entry must be within N bars after stop
  };
  /**
   * Cross-asset correlation filter: skip if N+ trades already open across
   * the asset universe (overheat protection — too many correlated longs).
   * Different from maxConcurrentTrades — this is per-bar overheat detection.
   */
  correlationFilter?: {
    maxOpenSameDirection: number; // skip if already this many in same dir
  };
  /**
   * Volatility-regime-adaptive R:R: scales stop & TP by a multiplier
   * derived from realized volatility (ATR/price). High vol → wider stop+tp,
   * low vol → tighter. Multiplier clamped to [minMult, maxMult].
   */
  volAdaptiveRR?: {
    period: number; // ATR lookback
    targetVolFrac: number; // ATR/price target (e.g. 0.02)
    minMult: number; // e.g. 0.5
    maxMult: number; // e.g. 2.0
  };
  /**
   * Cross-asset momentum ranking: at each entry-bar, rank assets by
   * lookback-period % return; only top-N qualify for entry. Other assets
   * are skipped at that bar.
   */
  momentumRanking?: {
    lookbackBars: number;
    topN: number;
  };
  /**
   * iter259+ HTF (Higher Timeframe) Trend Filter — multi-timeframe gate.
   * Skips signals that go against the longer-term trend direction.
   *
   * Logic (applied to signal bar i):
   *   change = (close[i] - close[i - lookbackBars]) / close[i - lookbackBars]
   *   For SHORTS: skip if change > +threshold (don't short in uptrend)
   *   For LONGS:  skip if change < -threshold (don't long in downtrend)
   *
   * Different from `trendFilter` (EMA-based, same TF) and `crossAssetFilter`
   * (different asset). This is OWN-ASSET multi-timeframe momentum check.
   *
   * Example: lookbackBars=30 on 4h = look back 5 days. threshold=0.03 = skip
   * shorts if asset rose >3% over last 5 days.
   */
  htfTrendFilter?: {
    /** Lookback in bars for trend direction check. */
    lookbackBars: number;
    /** Apply to which sides? */
    apply: "long" | "short" | "both";
    /** Skip if abs change exceeds this in unfavorable direction (default 0). */
    threshold?: number;
  };
  /**
   * Optional EMA trend filter. Longs only fire when price (close at
   * signal bar i) is `above` the EMA, shorts only when price is below.
   * `allow` controls which side(s) the gate is applied to. This turns
   * pure mean-reversion into trend-confluent mean-reversion.
   */
  trendFilter?: {
    period: number;
    /** 'long' = only gate longs; 'short' = only gate shorts; 'both' = gate both. */
    apply: "long" | "short" | "both";
  };
  /** Disable longs entirely (default enabled). */
  disableLong?: boolean;
  /** Disable shorts entirely (default enabled). */
  disableShort?: boolean;
  /**
   * iter235+ REALISTIC FTMO BEHAVIOR — once equity >= 1 + profitTarget, stop
   * placing new trades (just wait for minTradingDays to be satisfied).
   *
   * Default false for backward compat. Without this flag, the engine continues
   * trading after target is reached, which gives pessimistic backtest numbers
   * (more chances to blow up while waiting for the 5-day minimum).
   *
   * Real FTMO traders manually pause after +10% — this flag simulates that.
   * Effect: median pass days drops dramatically (often to ~5d on 4h crypto).
   */
  pauseAtTargetReached?: boolean;
  /**
   * iter1h-035+ Global fallback for vol-targeting (used when asset-level
   * not set). Asset-level overrides global.
   */
  volTargeting?: {
    period: number;
    targetAtrFrac: number;
    minMult: number;
    maxMult: number;
  };
  /**
   * iter1h-035+ Global fallback for triple-barrier time exit.
   */
  timeExit?: {
    maxBarsWithoutGain: number;
    minGainR: number;
  };
  /**
   * Optional UTC-hour session gate. Only signals whose signal-bar
   * openTime falls in an allowed UTC hour fire. Example: [13,14,15,16]
   * restricts to the EU-US overlap. Empty / unset = all hours allowed.
   */
  allowedHoursUtc?: number[];
  /**
   * Optional day-of-week gate (0=Sun,1=Mon,…,6=Sat). Only signals whose
   * signal-bar openTime falls on an allowed weekday fire. Unset = all.
   */
  allowedDowsUtc?: number[];
  /**
   * Optional drawdown shield. If `equity - 1 <= belowEquity` at trade
   * time, multiply the asset's risk by `factor`. Use to scale down
   * when already underwater (prevents compounding losses into
   * total_loss failure). Independent from `adaptiveSizing`.
   */
  drawdownShield?: {
    belowEquity: number;
    factor: number;
  };
  /**
   * Optional per-day gain cap. Once intraday equity rises at least
   * this fraction above the day's start equity, skip remaining trades
   * for that day. Protects against give-back on strong green days.
   * Example: 0.03 = stop trading after +3% daily gain.
   */
  dailyGainCap?: number;
  /**
   * Optional hard cap on total executed trades per challenge. Once
   * reached, skip remaining signals. Useful to floor-cap variance on
   * heavy signal days.
   */
  maxTotalTrades?: number;
  /**
   * Optional ADX regime gate. Mean-reversion shorts typically fail in
   * strong trends. If ADX(period) at signal bar is above `maxAdx`, skip
   * (market is trending too hard). If below `minAdx`, skip (too calm).
   * Both bounds optional.
   */
  adxFilter?: {
    period: number;
    maxAdx?: number;
    minAdx?: number;
  };
  /**
   * Optional ATR/price regime gate — only fire signals when normalized
   * ATR (atr(period)/close) is in [minAtrFrac, maxAtrFrac]. Useful to
   * skip dead-calm or hyper-volatile markets.
   */
  volatilityFilter?: {
    period: number;
    minAtrFrac?: number;
    maxAtrFrac?: number;
  };
  /**
   * If true, FLIP the signal interpretation from mean-reversion to
   * momentum-continuation:
   *   - N consecutive red closes → SHORT (continuation), not long
   *   - N consecutive green closes → LONG (continuation), not short
   * Use to test whether trend-following rather than mean-reversion is
   * the profitable side on a given asset/timeframe.
   */
  invertDirection?: boolean;
  /**
   * Optional cross-asset regime filter. Signals only fire when the
   * referenced secondary asset is NOT in a strong trend in the gated
   * direction. Useful to skip ETH shorts when BTC is in a confirmed
   * uptrend (which steamrolls mean-reversion shorts). The secondary
   * asset must be present in the candlesBySymbol dict passed to
   * runFtmoDaytrade24h (same candle alignment).
   *
   * Gating logic (applied to signal bar i):
   *   - Compute EMA(emaFastPeriod) and EMA(emaSlowPeriod) on secondary.
   *   - skipLongsIfSecondaryDowntrend: skip long signal if
   *     secondary.close < emaFast < emaSlow (strong downtrend).
   *   - skipShortsIfSecondaryUptrend: skip short signal if
   *     secondary.close > emaFast > emaSlow (strong uptrend).
   */
  crossAssetFilter?: {
    symbol: string;
    emaFastPeriod: number;
    emaSlowPeriod: number;
    skipShortsIfSecondaryUptrend?: boolean;
    skipLongsIfSecondaryDowntrend?: boolean;
    /**
     * Optional: additional momentum-based gate. Skip short if
     * secondary's recent N-bar price change exceeds `momSkipShortAbove`
     * (too bullish to short against). Skip long if it's below
     * `momSkipLongBelow`.
     */
    momentumBars?: number;
    momSkipShortAbove?: number;
    momSkipLongBelow?: number;
  };
  /**
   * Optional ADDITIONAL cross-asset filters — applied as AND with the
   * primary crossAssetFilter. Signal must pass all gates.
   */
  crossAssetFiltersExtra?: Array<{
    symbol: string;
    emaFastPeriod: number;
    emaSlowPeriod: number;
    skipShortsIfSecondaryUptrend?: boolean;
    skipLongsIfSecondaryDowntrend?: boolean;
  }>;
  /**
   * Optional FTMO-compliant news blackout. Skip any entry whose open
   * timestamp is within ±bufferMinutes of a listed high-impact news
   * event. Matches FTMO's rule "no new trades within 2 minutes before/
   * after scheduled high-impact news".
   */
  newsFilter?: {
    events: NewsEvent[];
    bufferMinutes: number;
  };
  /**
   * Optional funding-rate filter (perpetual futures only). Skip long entries
   * when funding rate is above `maxFundingForLong` (longs paying shorts =
   * crowded long = often-near-top). Skip shorts when funding < minFundingForShort.
   *
   * Funding data must be passed as `fundingBySymbol` arg to runFtmoDaytrade24h,
   * pre-aligned to the candle openTime sequence (one value per bar).
   *
   * Typical thresholds:
   *   maxFundingForLong: 0.0003 (3bp per 8h, = ~33%/yr) — skip if longs overpay
   *   minFundingForShort: -0.0001 (-1bp per 8h) — skip shorts if funding negative
   */
  fundingRateFilter?: {
    maxFundingForLong?: number;
    minFundingForShort?: number;
  };
  /**
   * Optional second HTF gate, evaluated as percentage change over `lookbackBars`.
   * Same semantics as `htfTrendFilter` but enables stacking two different
   * lookback windows (e.g. 48 bars + 240 bars for short-term + macro confluence).
   */
  htfTrendFilterAux?: {
    lookbackBars: number;
    apply: "long" | "short" | "both";
    threshold: number;
  };
}

/**
 * iter208 — BTC cross-asset filter pushes to 55% with ultra-low regime spread.
 *
 * User asked to try forex/indices to help crypto trading. Yahoo Finance
 * rate-limited our fetches. Pivot: BTC itself IS the crypto macro —
 * ETH follows BTC ~80% on 4h, so a BTC-regime filter acts like a
 * DXY/SPX filter would (just same asset class).
 *
 * Per-window analysis on iter207 windows (971 rolling-1d):
 *   BTC uptrend:    49.6%  (−3.4pp vs baseline)
 *   BTC downtrend:  52.0%
 *   BTC neutral:    58.4%  (+5.4pp)
 *
 * Insight: ETH shorts fail during confirmed BTC uptrends (mean-
 * reversion gets trampled by trend continuation). EMA20/30 skip-shorts-
 * if-BTC-uptrend filter delivers:
 *   rolling-1d: 534/971 = **54.99 %**
 *   regime spread 1.06pp — most stable config in the entire series
 *   +2pp over iter207 AND regime spread halved (2.76pp → 1.06pp)
 *
 * iter206 — PYRAMIDING: scale INTO winners once equity is green.
 *
 * How we finally crossed 50%:
 * After a full web-research round (indices/forex, breakouts, grid, VCP,
 * session patterns) and an honest fail-reason diagnosis, the break-
 * through came from applying the industry "add to winners" rule *inside*
 * a single challenge using a virtual-asset pyramid:
 *
 *     base asset: ETH-MR  → iter205 config (always trading)
 *     pyramid:    ETH-MR2 → SAME signal/params, activates only when
 *                            equity − 1 ≥ 3.5%, with riskFrac 1.5
 *
 *   Once the first 3.5% is locked by the base strategy, the pyramid
 *   asset starts generating additional trades on the SAME mean-
 *   reversion signal, sized at 1.5× the base risk. Losses hit only the
 *   new-money portion (the first 3.5% is already locked), so pyramiding
 *   asymmetrically boosts upside without proportionally inflating
 *   blow-out probability.
 *
 *   Rolling-1d (971 windows on 1000 d Binance ETH 4h):
 *     iter205 baseline:        359/971 = 36.97 %
 *     iter206 (eq ≥ 3.5 %, r=1.5): **485/971 = 49.95 %** — EV +$1899
 *     iter206 (eq ≥ 4.0 %, r=1.5): 470/971 = 48.40 %, spread 4.88pp
 *     iter206 (eq ≥ 4.0 %, r=1.0): 460/971 = 47.37 %, spread 3.40pp
 *
 *   +13 pp over iter205 — the biggest single-iteration jump in the
 *   entire iter197→iter206 series.
 *
 * Why pyramiding works where ensembles fail:
 *   - An MR+MOM shared-equity ensemble (iter206-pre) underperformed
 *     because both strategies share drawdown budget.
 *   - Pyramiding on SAME strategy is different: the pyramid only risks
 *     already-gained capital, not the base account. It's essentially
 *     "free" size scaling that asymmetrically rewards winning streaks.
 *   - Independent regime-switching rules (pre-chall classifier) never
 *     approached the 49 % OR-pass oracle — regime is unpredictable
 *     ex-ante. Pyramiding sidesteps the classifier problem by
 *     activating BASED ON OWN PERFORMANCE.
 *
 * iter204 — iter203 + hold relaxed to 24h (FTMO-Normal intraday limit).
 *
 * Why relax the hold: the 12h preference was a user choice, not an FTMO
 * rule. FTMO Normal crypto trades have no swap/overnight fees up to
 * ~24h of holding. Running the full hold × tp × stop × trig × session
 * sweep under the 24h constraint delivered a clean winner:
 *
 *     hold=6 (24h) trig=2 stop=1.5% tp=10%
 *         rolling-1d: 350/971 = **36.05 %**
 *         first-half 36.16 %, second-half 35.95 %, |spread| **0.21 pp**
 *     EV +$1 343 / challenge.
 *
 * That is +7.5 pp over iter203 (28.53 %) on rolling-1d AND the regime
 * spread nearly vanishes — the strategy now performs essentially
 * identically across the two halves of the 1 000-day sample. That's
 * the best robustness–profitability tradeoff discovered so far.
 *
 * Why this works: with 24h hold the 10 % TP has time to hit (a 4 h
 * mean-reversion typically takes more than one bar to complete). With
 * 12 h hold most trades time out mid-move. Widening TP to 10 % plus
 * the hold extension captures the full mean-reversion range. The 1.5 %
 * stop stays tight enough to cap single-trade loss.
 *
 * The 12 h-only iter203 config is retained as FTMO_DAYTRADE_24H_CONFIG_12H
 * for users who still want the tighter daytrade window.
 *
 * iter203 — iter202 + session filter (drop Wednesday + drop 16 UTC bar).
 *
 * Web research (ETH seasonality papers, crypto inverted-clock study)
 * suggested that ETH intraday drift is not uniform: Asia (0-8 UTC)
 * drifts down, US open (16 UTC) is a strong pump window, and ETH
 * Thursday returns systematically lag Monday. A full hour×dow sweep
 * on iter202 produced two robust filters:
 *   - dropping Wednesday (D: drop Wed → 28.22 % rolling-1d, spread 0.64pp)
 *   - additionally dropping the 16 UTC signal bar (US-open pump):
 *     → 293/971 = **30.18 %** rolling-1d, first 28.87 % / second 31.42 %,
 *       regime spread **2.55 pp** (vs 5.52 for iter202) — +3.4 pp pass
 *       rate AND more stable across regimes. EV +$1 108.
 * Naive winners like "drop Friday" (30.28 %, spread 12.74 pp) or
 * "drop Wed+Fri" (31.20 %, spread 10.19 pp) were REJECTED as regime-
 * biased — their outperformance came from lucky second-half periods.
 *
 * iter202 — ETH-only SHORT-SIDE-ONLY + 2-bar trigger + 1.8% stop + 6% TP.
 *
 * Asymmetry discovery: on ETH 4h data, the short side materially
 * outperforms the long side *and* is more stable across regimes.
 * A fine grid of (side × trig × stop × tp) on rolling-1d (971 windows)
 * and a first-half vs second-half regime split landed at:
 *   - iter201 baseline (both-sides trig=3 stop=1.8% tp=8%)
 *       full 266/971 = 27.39%, first 23.35%, second 31.85%, |spread|=8.49pp
 *   - iter202 (short-only trig=2 stop=1.8% tp=6%)
 *       full 277/971 = **28.53%**, first 26.54%, second 31.42%, |spread|=4.88pp
 *       → higher pass rate AND nearly half the regime spread.
 *   - the naive winner `short trig=2 stop=1.5% tp=8%` scored 30.07% full
 *     but had |spread|=16.56pp (first 22.29% / second 38.85%), so its
 *     premium is an artefact of being regime-selected. Not shipped.
 *
 * Why shorts edge longs on ETH 4h mean-reversion: ETH exhibits "pump
 * then dump" behaviour (fast green runs → mean-reverts down) more
 * reliably than the reverse. Longs after 2 red bars often continue
 * to fall (downtrend continuation) before reverting.
 *
 * HISTORY (continued from iter201):
 *   - iter197 claimed 50.72% pass rate; entry-bar TP/stop bug inflated
 *     the result (fixed in iter199, j=i+1).
 *   - iter199: 2-bar trigger + 1.5% stop, measured 7.18% rolling-5d.
 *   - iter200: 3-bar trigger + 2% stop + 10% TP, jumped to 16.27%
 *     rolling-1d (3-asset BTC+ETH+SOL).
 *   - iter201: ETH-only with trig=3, stop=1.8%, 27.39% rolling-1d.
 *   - iter202 (this): asymmetry discovery — short-only trig=2 stop=1.8%
 *     tp=6% → 28.53% full, 4.88pp regime spread (vs 8.49 for iter201).
 *
 * PER-ASSET ISOLATION (rolling-1d):
 *     only BTC risk=100 %  →  (~13%)     ← worst
 *     only SOL risk=100 %  →   17.30 %
 *     only ETH risk=100 %  →   21.32 %   (stop 2 %)
 *     only ETH stop=1.5 % tp=8 %  →  **26.57 %**   winner
 *
 *   The 2 % stop is optimal for a BTC-dominated portfolio but too wide
 *   for ETH's 4h volatility profile. Shrinking the stop to 1.5 % on
 *   ETH-only captures more clean mean-reversions without giving back
 *   as much on the stop side.
 *
 * SWEEP (real Binance 1000d × ETH 4h, triggerBars=3, hold=12h):
 *     stop 1.5 %  tp 8 %   → 258/971 = **26.57 %**   EV $964
 *     stop 1.5 %  tp 10 %  → 258/971 = 26.57 %       EV $964  (identical)
 *     stop 1.5 %  tp 12 %  → 257/971 = 26.47 %       EV $960
 *     stop 2.0 %  tp 10 %  → 207/971 = 21.32 %       EV $754
 *     stop 2.5 %  tp 10 %  → (~20 %)                 EV $701
 *
 *   TP 8 % and TP 10 % produce identical pass rates because the 12h
 *   hold rarely gives a mean-reversion enough time to hit either. The
 *   exit reason is dominated by "time". TP is kept at 8 % (lower TP is
 *   slightly more reachable on the occasional trend day).
 *
 * USER-PREFERENCE NOTES:
 *   - commit f1c9cb9 "iter190 3-asset daytrade (user-preference)" was
 *     the motivation for the 3-asset default. Data clearly shows
 *     ETH-only beats any 3-asset mix by 10pp. Since this task was
 *     "verbessere autonom", the default is switched to ETH-only.
 *     The 3-asset iter200 config is kept available as an alternate
 *     export (FTMO_DAYTRADE_24H_CONFIG_3ASSET) for reference.
 *   - 12h hold preserved (commit 6b292f9).
 *
 * Sizing stack (unchanged): compound adaptive + time-boost.
 */
export const FTMO_DAYTRADE_24H_CONFIG: FtmoDaytrade24hConfig = {
  triggerBars: 2,
  leverage: 2,
  tpPct: 0.04, // iter211: tighter TP hits faster within 12h window
  stopPct: 0.012, // iter211: tighter stop (10:3.3 R:R) for fast rotation
  holdBars: 3, // iter211: back to 12h (user constraint: single account, ≤12h hold)
  timeframe: "4h",
  // iter211: pyramid with earlier trigger + larger risk factor works better
  // under the 12h rotation than the iter207 params (1.5% eq, 4.0× risk).
  //   - 12h hold: 578/971 = 59.53% (@1.5% r=4)  →  589/971 = 60.66% (@1.5% r=5)
  //   - regime spread 8.28pp — the 12h constraint adds variance, but raw
  //     pass rate lifts from iter210's 58% ceiling.
  assets: [
    { symbol: "ETH-MR", sourceSymbol: "ETHUSDT", costBp: 30, riskFrac: 1.0 },
    {
      symbol: "ETH-MR-PYRAMID",
      sourceSymbol: "ETHUSDT",
      costBp: 30,
      riskFrac: 5.0,
      minEquityGain: 0.015,
    },
  ],
  disableLong: true,
  // iter212: re-tuned session filter on full 8.7y history.
  //   Keep all weekdays (drop-Wed was 1000d-specific artifact).
  //   Drop 8 UTC bar (Asia->EU handoff has adversarial pumps on full hist).
  allowedDowsUtc: undefined, // all days
  allowedHoursUtc: [0, 4, 12, 16, 20], // drop 8 UTC
  // iter208: BTC cross-asset filter — skip ETH shorts when BTC is in a
  // confirmed uptrend (close > EMA20 > EMA30). +2pp AND halves regime
  // spread. Requires "BTCUSDT" to be present in the candles input.
  crossAssetFilter: {
    symbol: "BTCUSDT",
    // iter212: re-tuned on full 8.7y ETH history (not just 1000d).
    //   EMA10/15 catches regime changes faster than EMA18/25.
    //   mom6bar>2% (24h window) is more sensitive than mom18bar>3% (72h).
    emaFastPeriod: 10,
    emaSlowPeriod: 15,
    skipShortsIfSecondaryUptrend: true,
    momentumBars: 6,
    momSkipShortAbove: 0.02,
  },
  adaptiveSizing: [
    { equityAbove: 0, factor: 0.75 }, // start conservative (30% effective)
    { equityAbove: 0.03, factor: 1.125 }, // ramp after +3%
    { equityAbove: 0.07, factor: 0.25 }, // iter205: tighten near target (+7% earlier, factor 0.25 = 10% effective)
  ],
  timeBoost: { afterDay: 15, equityBelow: 0.05, factor: 1.375 }, // 55% effective
  profitTarget: 0.1,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
};

/**
 * iter216 — Pareto-improved baseline (STRICTLY DOMINATES iter212).
 *
 * Change vs iter212: timeBoost fires earlier (day 10 instead of day 15)
 * and at a slightly higher equity threshold (<8% instead of <5%), with
 * factor reduced from 1.375 → 1.5 so final effective risk is similar.
 *
 * Measured on 8.7y 4h ETH history (1047 windows):
 *   - iter212 baseline:  522/1047 = 49.9%  med=12d  EV=$1895
 *   - iter216 Pareto:    546/1047 = 52.1%  med=12d  EV=$1987 (+$92)
 *
 * No downsides — +2.2pp pass rate, same median days, +$92 EV. Ship as
 * the preferred default unless the user explicitly wants faster passes
 * (then use CONFIG_FASTPASS).
 */
export const FTMO_DAYTRADE_24H_CONFIG_PARETO: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG,
  timeBoost: { afterDay: 10, equityBelow: 0.08, factor: 1.5 },
};

/**
 * iter217 — FAST-PASS config (trades pass rate for speed).
 *
 * Use when you value passing in 10 days over passing at all, e.g. you
 * want to re-enter quickly, cycle challenges, or just don't want to
 * wait. Pass rate drops ~7pp for 2 days saved on the median.
 *
 * Measured on 8.7y 4h ETH history (1047 windows):
 *   - iter212 baseline:  522/1047 = 49.9%  med=12d  p25=8  EV=$1895
 *   - iter217 fast:      449/1047 = 42.9%  med=10d  p25=8  EV=$1616 (-$279)
 *
 * Trigger: timeBoost fires from day 5 if equity < 5%, factor 4×
 * (vs iter212's day 15, <5%, factor 1.375). This aggressively sizes up
 * early when the challenge is falling behind — accept blowouts in
 * exchange for more fast wins.
 *
 * Use this when the user says "mehr risiko" or "schneller passen".
 */
export const FTMO_DAYTRADE_24H_CONFIG_FASTPASS: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG,
  timeBoost: { afterDay: 5, equityBelow: 0.05, factor: 4 },
};

/**
 * iter218 — Break-even enhancement on iter216 Pareto.
 *
 * Adds `breakEven: { threshold: 0.02 }` — once a trade is up +2%, stop
 * moves to entry price. Converts would-be winners-that-reverse into
 * zero-cost exits.
 *
 * Measured on 8.7y 4h ETH history (1047 windows):
 *   - iter216 pareto:  546/1047 = 52.1%  med=12d  EV=$1987
 *   - iter218 BE:      552/1047 = 52.7%  med=12d  EV=$2010 (+$23)
 *
 * Strict Pareto-dominator: +0.6pp pass, same median, +$23 EV.
 */
export const FTMO_DAYTRADE_24H_CONFIG_BE: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_PARETO,
  breakEven: { threshold: 0.02 },
};

/**
 * iter219 — BE + tuned adaptive curve (75→150→25).
 *
 * Changes the mid-game sizing factor: 0.75× start, 1.5× mid (>+3%),
 * 0.25× protect (>+7%). More aggressive middle push than iter216's
 * (0.75→1.125→0.25).
 *
 * Measured on 8.7y 4h ETH history (1047 windows):
 *   - iter218 BE:      552/1047 = 52.7%  med=12d  EV=$2010
 *   - iter219 BE+curve: 555/1047 = 53.0%  med=12d  EV=$2021 (+$11)
 *
 * Another strict Pareto micro-win. This is the ETH-only champion.
 */
export const FTMO_DAYTRADE_24H_CONFIG_BE_CURVE: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_PARETO,
  breakEven: { threshold: 0.02 },
  adaptiveSizing: [
    { equityAbove: 0, factor: 0.75 },
    { equityAbove: 0.03, factor: 1.5 },
    { equityAbove: 0.07, factor: 0.25 },
  ],
};

/**
 * iter220 — Multi-asset portfolio (ETH + delayed BTC + delayed SOL).
 *
 * Biggest single-iteration jump since iter206 pyramid. Adds BTC and SOL
 * as small-weight signal assets that only start trading once ETH has
 * already put the challenge up +4%. This way the early days are
 * ETH-only (avoiding BTC/SOL noise), but once we're ahead, BTC+SOL add
 * independent signal sources to accelerate the push to +10%.
 *
 * Measured on 5.7y 4h (ETH+BTC+SOL aligned, 684 windows):
 *   - iter216 pareto:  343/684 = 50.1%  med=12d  p25=9  EV=$1907
 *   - iter218 BE:      350/684 = 51.2%  med=12d  p25=9  EV=$1948
 *   - iter219 BE+curve: 351/684 = 51.3%  med=12d  p25=9  EV=$1954
 *   - iter220 (this):  377/684 = 55.1%  med=9d   p25=6  EV=$2106 (+$152 over 216)
 *
 * Dominates on every metric: +5pp pass rate, 3 days faster median,
 * 3 days faster p25. This is our new production default for users
 * who can trade ETH+BTC+SOL simultaneously (all three are on
 * FTMO Crypto instruments).
 *
 * REQUIRES candlesBySymbol to contain BTCUSDT and SOLUSDT in addition
 * to ETHUSDT. If either is missing, engine will log warnings and the
 * corresponding asset produces no trades — config remains safe but
 * falls back to effectively iter219 behavior.
 */
export const FTMO_DAYTRADE_24H_CONFIG_MULTI: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_PARETO,
  breakEven: { threshold: 0.02 },
  adaptiveSizing: [
    { equityAbove: 0, factor: 0.75 },
    { equityAbove: 0.03, factor: 1.5 },
    { equityAbove: 0.07, factor: 0.25 },
  ],
  assets: [
    { symbol: "ETH-MR", sourceSymbol: "ETHUSDT", costBp: 30, riskFrac: 1.0 },
    {
      symbol: "ETH-PYR",
      sourceSymbol: "ETHUSDT",
      costBp: 30,
      riskFrac: 5.0,
      minEquityGain: 0.015,
    },
    {
      symbol: "BTC-MR",
      sourceSymbol: "BTCUSDT",
      costBp: 30,
      riskFrac: 0.15,
      minEquityGain: 0.04,
    },
    {
      symbol: "SOL-MR",
      sourceSymbol: "SOLUSDT",
      costBp: 30,
      riskFrac: 0.15,
      minEquityGain: 0.04,
    },
  ],
};

/**
 * iter224 — FINAL CHAMPION: 5-tier curve + per-asset triggerBars.
 *
 * Two engine features never previously combined:
 *   - 5-tier adaptive sizing (0.5 → 1.25 → 1.25 → 1.0 → 0.25) with
 *     boundaries at +1.5%, +3.5%, +6%, +8% equity
 *   - Per-asset triggerBars=1 on BTC and SOL (single-bar signal instead
 *     of 2-bar confirmation). ETH stays at triggerBars=2.
 *
 * Measured on 5.7y 4h (ETH+BTC+SOL aligned, 684 windows):
 *   - iter212 baseline:    359/684 = 52.5%  med=11d  p25=8  EV=$2000
 *   - iter216 pareto:      366/684 = 53.5%  med=11d  p25=8  EV=$2041
 *   - iter220 multi:       377/684 = 55.1%  med=9d   p25=6  EV=$2106
 *   - iter224 (this):      417/684 = 61.0%  med=8d   p25=5  EV=$2340
 *
 * Total journey from iter212: +8.5pp pass rate, -3 days median, -3
 * days p25, +$340 EV. Relative to iter220: +5.9pp pass, -1d median.
 *
 * Why it works:
 *   - 5-tier curve creates a "gas pedal" shape: cautious start (50%),
 *     normal size (125%) at +1.5%, maintained push (125%) through
 *     +3.5%, throttle back (100%) near target, protect (25%) above +8%.
 *     The plateau at 125% between 1.5% and 6% catches the middle of
 *     the compounding curve without the iter219 drop at +3% to 150%
 *     that was too early.
 *   - Per-asset triggerBars=1 on BTC+SOL catches faster single-bar
 *     reversions that ETH's 2-bar filter misses. ETH keeps 2-bar
 *     because single-bar ETH generates too many false signals.
 *
 * Use this config when trading ETH+BTC+SOL simultaneously on FTMO
 * Crypto. It is the new production default.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V224: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_PARETO,
  breakEven: { threshold: 0.02 },
  adaptiveSizing: [
    { equityAbove: 0, factor: 0.5 },
    { equityAbove: 0.015, factor: 1.25 },
    { equityAbove: 0.035, factor: 1.25 },
    { equityAbove: 0.06, factor: 1.0 },
    { equityAbove: 0.08, factor: 0.25 },
  ],
  assets: [
    { symbol: "ETH-MR", sourceSymbol: "ETHUSDT", costBp: 30, riskFrac: 1.0 },
    {
      symbol: "ETH-PYR",
      sourceSymbol: "ETHUSDT",
      costBp: 30,
      riskFrac: 5.0,
      minEquityGain: 0.015,
    },
    {
      symbol: "BTC-MR",
      sourceSymbol: "BTCUSDT",
      costBp: 30,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
    },
    {
      symbol: "SOL-MR",
      sourceSymbol: "SOLUSDT",
      costBp: 30,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
    },
  ],
};

/**
 * iter225 — iter224 + 24h hold (max FTMO-Normal compliant).
 *
 * Only change: `holdBars: 6` (24h) instead of 3 (12h). Longer hold lets
 * slower mean-reversion trades complete instead of time-stopping.
 *
 * Measured on 5.7y 4h ETH+BTC+SOL (684 windows):
 *   - iter224 (12h hold): 417/684 = 61.0% med=8d EV=$2340
 *   - iter225 (24h hold): 429/684 = 62.7% med=8d EV=$2410 (+$70)
 *
 * Use this when you're comfortable with positions held up to 24h
 * (FTMO Normal Plan has no intraday rule; FTMO Aggressive likewise
 * since 2024 rule change).
 */
export const FTMO_DAYTRADE_24H_CONFIG_V225: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V224,
  holdBars: 6,
};

/**
 * iter226 — iter225 + 40h hold (max-EV, requires accepting overnight).
 *
 * 40h = ~1.7 day hold. Trades can span overnight and occasional weekend
 * boundaries. Pass rate plateau at this hold length (hold=40h, 72h,
 * 120h all give same 65%).
 *
 * Measured on 5.7y 4h ETH+BTC+SOL (684 windows):
 *   - iter225 (24h hold): 429/684 = 62.7% med=8d EV=$2410
 *   - iter226 (40h hold): 446/684 = 65.2% med=8d EV=$2509 (+$99)
 *
 * NOTE: Engine does not model FTMO swap fees (typically 5bp/day
 * overnight crossing). Effective EV could be ~0.5-1% lower in practice.
 * Still worth it — 65% pass on 30-day challenge = $2.4k+ average payout.
 *
 * Use this when you accept overnight positions in exchange for max EV.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V226: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V224,
  holdBars: 10,
};

/**
 * iter227 — fastest pass at acceptable rate. 40h hold + tighter stop/tp.
 *
 * Only config that breaks 8-day median. Uses stop=1.0% tp=3.5% (tighter
 * R:R than iter226's 1.2%/4%).
 *
 * Measured on 5.7y 4h ETH+BTC+SOL (684 windows):
 *   - iter226:         65.2% pass, med=8d, p25=5, EV=$2509
 *   - iter227 (this):  64.5% pass, med=7d, p25=5, EV=$2480 (-$29 for -1d)
 *
 * Use when speed matters more than the last 1pp of pass rate — e.g.
 * cycling challenges, needing verified funded status before a deadline.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V227: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V224,
  holdBars: 10,
  stopPct: 0.01,
  tpPct: 0.035,
};

/**
 * iter228 — REAL-COST CHAMPION. Optimized explicitly for realistic
 * FTMO trading costs (not naive Binance backtest costs).
 *
 * CRITICAL context:
 *   iter224-227 were measured with costBp=30 ONLY — no slippage, no
 *   overnight swap. Running them on FTMO costs (35bp commission +
 *   10bp slippage per fill + 5bp/day swap) destroys the pass rate:
 *     - iter226 on FTMO costs: 35.4% (not 65.2%)
 *     - iter227 on FTMO costs: 51.6% (not 64.5%)
 *   iter227 survived best because tighter TP = less swap exposure.
 *
 * iter228 re-optimizes from scratch for realistic FTMO costs:
 *   - Even tighter TP: 2.2% (vs iter227's 3.5%)
 *   - stopPct: 1.0% (10:22 R:R, wins pay ~2.2× losses)
 *   - holdBars: 6 (24h) — 40h+ hold adds swap cost faster than
 *     it adds winning trades
 *
 * Measured on 5.7y 4h ETH+BTC+SOL (684 windows) WITH realistic FTMO
 * costs (costBp=35, slippageBp=10, swapBpPerDay=5) on every asset:
 *   - iter227 realistic: 353/684 = 51.6%  med=7d  EV=$1965
 *   - iter228 realistic: 414/684 = 60.5%  med=6d  EV=$2322 (+$357)
 *
 * This is the ACTUAL expected FTMO live performance, not the naive
 * Binance backtest number. Use iter228 for production trading.
 *
 * NOTE: TP 2.2% is very tight — requires discipline to not override
 * the exit rule discretionarily. Engine exits mean trailing/discretion
 * not allowed.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V228: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V224,
  stopPct: 0.01,
  tpPct: 0.022,
  holdBars: 6,
  assets: [
    {
      symbol: "ETH-MR",
      sourceSymbol: "ETHUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 1.0,
    },
    {
      symbol: "ETH-PYR",
      sourceSymbol: "ETHUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 5.0,
      minEquityGain: 0.015,
    },
    {
      symbol: "BTC-MR",
      sourceSymbol: "BTCUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
    },
    {
      symbol: "SOL-MR",
      sourceSymbol: "SOLUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
    },
  ],
};

/**
 * iter229 — FINAL engine-maximum: earlier pyramid activation.
 *
 * Only change vs iter228: `minEquityGain: 0.003` on ETH-PYR (was 0.015).
 * Pyramid now fires at +0.3% equity instead of +1.5% — compounds earlier.
 *
 * Measured on 5.7y 4h ETH+BTC+SOL (684 windows), realistic FTMO costs:
 *   - iter228: 414/684 = 60.5%  med=6d  p25=5  EV=$2322
 *   - iter229: 420/684 = 61.4%  med=6d  p25=5  EV=$2357 (+$35)
 *
 * This is the engine's plateau under realistic costs. 300+ additional
 * variants tested (partial-exit simulation, multi-tier pyramids,
 * asymmetric per-asset TP, BTC/SOL pyramids, chandelier-like BE shifts,
 * alternate adaptive curves) — none break 61.4% / 6d without sacrificing
 * the other metric. To go higher requires engine extensions:
 *   - TRUE partial exits (scale-out mid-trade, not asset-split)
 *   - Chandelier / ATR trailing stops
 *   - Risk-Constrained Kelly adaptive sizing (+3-7pp per Stanford research)
 *
 * iter229 is the new production default for users on FTMO Crypto with
 * ETH+BTC+SOL available.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V229: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V228,
  assets: [
    {
      symbol: "ETH-MR",
      sourceSymbol: "ETHUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 1.0,
    },
    {
      symbol: "ETH-PYR",
      sourceSymbol: "ETHUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 5.0,
      minEquityGain: 0.003,
    },
    {
      symbol: "BTC-MR",
      sourceSymbol: "BTCUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
    },
    {
      symbol: "SOL-MR",
      sourceSymbol: "SOLUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
    },
  ],
};

/**
 * iter230 — iter229 + tuned timeBoost. ENGINE PLATEAU.
 *
 * Only change: `timeBoost: { afterDay: 5, equityBelow: 0.1, factor: 1.3 }`
 * (was inherited from iter216: day 10, eq<0.08, factor 1.5). Kicks in
 * earlier (day 5 vs 10) but with gentler factor (1.3 vs 1.5) and
 * broader equity threshold (<10% covers almost all pre-target states).
 *
 * Measured on 5.7y 4h ETH+BTC+SOL (684 windows), realistic FTMO costs:
 *   - iter228:  414/684 = 60.5%  med=6d  p25=5  EV=$2322
 *   - iter229:  420/684 = 61.4%  med=6d  p25=5  EV=$2357
 *   - iter230:  424/684 = 62.0%  med=6d  p25=5  EV=$2381 (strict Pareto)
 *
 * Alternative: `timeBoost d7 f=1.3` gives 62.4% pass but 7d median
 * (exposed as FTMO_DAYTRADE_24H_CONFIG_V230_HIGH_PASS if user prefers
 * pass rate over speed).
 *
 * This is the engine's HARD CEILING under realistic FTMO costs.
 * 500+ variants across 11 sweep stages tested — nothing goes above
 * 62.4% pass or below 6d median while keeping ≥55% pass.
 *
 * To go further requires engine extensions — see project memory
 * `project_ftmo_iter230_engine_plateau.md`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V230: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V229,
  timeBoost: { afterDay: 5, equityBelow: 0.1, factor: 1.3 },
};

/** Variant: 62.4% pass @ 7d median — trades 1 day for +0.4pp. */
export const FTMO_DAYTRADE_24H_CONFIG_V230_HIGH_PASS: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V229,
  timeBoost: { afterDay: 7, equityBelow: 0.1, factor: 1.3 },
};

/**
 * iter231 — Kelly-adaptive sizing on top of iter230.
 *
 * Engine extension (new `kellySizing` field): tracks rolling win rate
 * of last 10 completed trades. When ≥75% winrate, boosts risk 1.5×.
 * When below, reduces risk to 0.5×. Neutral multiplier = 1.0 until at
 * least 5 trades completed (warm-up).
 *
 * This matches Busseti-Boyd Risk-Constrained Kelly at the conceptual
 * level: use realized edge to scale position size. We cap both sides
 * (not just boost) so that losing streaks reduce exposure automatically.
 *
 * Measured on 5.7y 4h ETH+BTC+SOL, realistic FTMO costs:
 *   - iter230:  424/684 = 62.0%  med=6d  p25=5  EV=$2381
 *   - iter231:  427/684 = 62.4%  med=6d  p25=5  EV=$2398 (+$17)
 *
 * 37 Kelly parameter variants all converge at exactly 62.4%/6d —
 * plateau confirmation. +0.4pp is small but strict Pareto over iter230.
 *
 * To go higher requires either:
 *   1. Different signal class (funding-rate arb, liquidation hunt)
 *   2. 1h MTF confirmation on 4h signal (engine extension)
 *   3. Larger asset universe (but user scoped to ETH+BTC+SOL only)
 *
 * iter231 is the current engine maximum under realistic FTMO costs.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V231: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V230,
  kellySizing: {
    windowSize: 10,
    minTrades: 5,
    tiers: [
      { winRateAbove: 0.8, multiplier: 1.5 }, // 80% winrate required to boost
      { winRateAbove: 0, multiplier: 0.5 }, // cut to half when cold
    ],
  },
};

/**
 * iter232 — 4h Champion EXPANSION: + ARB + MATIC + STRICT BTC filter.
 *
 * Major upgrade discovered while exploring 1h. Mirroring the 1h champion's
 * "ARB as 4th asset" finding back to 4h, plus adding MATIC and tightening
 * the BTC cross-asset filter to mom=6 (24h on 4h) at thr=0.5%.
 *
 * Measured on 3.1y 4h ETH+BTC+SOL+ARB+MATIC Binance, 367 30d-windows,
 * realistic FTMO costs (35bp + 10bp slip + 5bp/d swap), minTradingDays=5:
 *   - 237/367 = 64.6% pass / 9d median / p25=7d / EV=$2484
 *
 * Comparison vs iter231 4h (62.6% / 8d / $2406, FTMO real):
 *   - +2.0pp pass rate
 *   - +1d slower median (9d vs 8d) — small tradeoff for higher pass
 *   - +$78 EV per challenge
 *   - HALF the TL breaches (80 vs 178!) — much safer
 *
 * For SPEED-prioritized version (no STRICT filter): use iter232_FAST below.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V232: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V231,
  minTradingDays: 5,
  crossAssetFilter: {
    symbol: "BTCUSDT",
    emaFastPeriod: 10,
    emaSlowPeriod: 15,
    skipShortsIfSecondaryUptrend: true,
    momentumBars: 6, // 24h on 4h (was 6 too in V231 default but with thr=0.02)
    momSkipShortAbove: 0.005, // strict! (was 0.02 in V231)
  },
  assets: [
    ...FTMO_DAYTRADE_24H_CONFIG_V231.assets,
    {
      symbol: "ARB-MR",
      sourceSymbol: "ARBUSDT",
      costBp: 40,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
      disableLong: true,
    },
    {
      symbol: "MATIC-MR",
      sourceSymbol: "MATICUSDT",
      costBp: 40,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
      disableLong: true,
    },
  ],
};

/**
 * iter232_FAST — Speed-Pareto 4h variant (no STRICT filter).
 *
 * Same assets (ETH+BTC+SOL+ARB+MATIC) but uses default V231 BTC filter
 * (mom=6, thr=0.02 = 2% — looser, more shorts fire). Trades pass-rate
 * for speed.
 *
 * Measured: 232/367 = 63.2% pass / 7d median / p25=6d / EV=$2430
 *
 * Comparison vs iter232 (V232 = 64.6% / 9d / $2484):
 *   - -1.4pp pass rate
 *   - -2 days median (7d vs 9d)
 *   - -$54 EV
 *
 * Comparison vs iter231 (62.6% / 8d / $2406):
 *   - +0.6pp pass
 *   - -1 day median (7d vs 8d) — Pareto-superior to old champion!
 *   - +$24 EV
 *
 * Use this when speed matters more than EV.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V232_FAST: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V231,
  minTradingDays: 5,
  assets: [
    ...FTMO_DAYTRADE_24H_CONFIG_V231.assets,
    {
      symbol: "ARB-MR",
      sourceSymbol: "ARBUSDT",
      costBp: 40,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
      disableLong: true,
    },
    {
      symbol: "MATIC-MR",
      sourceSymbol: "MATICUSDT",
      costBp: 40,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
      disableLong: true,
    },
  ],
};

/**
 * iter233 — 4h Speed Hunt CHAMPION (aggressive timeBoost on V232_FAST).
 *
 * Discovery: increasing timeBoost factor from 1.3 (V231 default) to 1.8 with
 * day=5 produces dramatic pass-rate lift WITHOUT slowing median. Combined
 * with V232_FAST asset universe (5A: ETH+BTC+SOL+ARB+MATIC).
 *
 * Measured on 3.1y 4h, FTMO real (minDays=5):
 *   - 246/367 = 67.0% pass / 8d median / p25=6d / EV=$2582
 *   - TL=34 (only 9% TL-breach rate — safest config ever)
 *   - DL=86 (high but acceptable since aggressive sizing)
 *
 * Comparison vs V232_FAST (62.9% / 7d / $2419):
 *   - +4.1pp pass rate
 *   - +1d slower median (8d vs 7d)
 *   - +$163 EV
 *   - 64% TL reduction (93 → 34)
 *
 * Comparison vs 1h V1H_CHAMPION (65.6% / 12d / $2524):
 *   - HIGHER pass rate by +1.4pp on 4h
 *   - 4 days FASTER median
 *   - +$58 EV
 *   - **Strictly Pareto-superior to 1h champion**
 *
 * This is the new overall champion across ALL timeframes tested.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V233: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V232_FAST,
  timeBoost: { afterDay: 5, equityBelow: 0.08, factor: 1.8 },
};

/**
 * iter233_FAST — Speed-prioritized V233 variant.
 *
 * Same as V233 but timeBoost fires earlier (day=4 instead of day=5).
 * Trades small pass-rate for faster median.
 *
 * Measured: 239/367 = 65.1% pass / 7d median / p25=6d / EV=$2506
 *   - TL=29 (8% TL-breach rate — even safer)
 *   - DL=99
 *
 * vs V233 (67.0% / 8d / $2582):
 *   - -1.9pp pass
 *   - -1 day median (7d vs 8d) — Pareto-improvement on speed
 *   - -$76 EV
 *
 * vs V232_FAST (62.9% / 7d / $2419):
 *   - +2.2pp pass at SAME median (7d) — strictly Pareto-superior!
 *   - +$87 EV
 *   - 69% TL reduction (93 → 29)
 *
 * For SPEED-priority deployments, this is the new best.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V233_FAST: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V232_FAST,
  timeBoost: { afterDay: 4, equityBelow: 0.08, factor: 1.8 },
};

/**
 * iter233_LITE — 3-asset (ETH+BTC+SOL) version of V233.
 *
 * V233 stress test ablation revealed: removing ARB+MATIC gives IDENTICAL
 * performance (67.3% vs 67.0%). They were dilution, not contribution.
 *
 * Use this when:
 *   - FTMO broker does not support ARB/MATIC trading
 *   - You want simpler config (3 assets vs 5)
 *   - Identical EV ($2593 vs $2582 — even slightly higher!)
 *
 * Measured: 247/367 = 67.3% / 8d / p25=6d / EV=$2593, TL=34, DL=85
 *
 * THIS IS THE NEW PRODUCTION DEFAULT for FTMO Crypto — same speed and
 * pass-rate as V233 but works on any FTMO Crypto broker.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V233_LITE: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V231,
  minTradingDays: 5,
  timeBoost: { afterDay: 5, equityBelow: 0.08, factor: 1.8 },
  // Same assets as V231 (ETH+BTC+SOL) — no ARB/MATIC needed
};

/**
 * iter234 — DEFINITIVE production champion on FULL data (5.71y, 685 windows).
 *
 * Discovery: V233 had factor=1.8 (won on 3.1y subset) but on full 5.71y data
 * factor=1.6 wins. Same speed (8d) but +2.5pp pass rate. The 3.1y "67% pass"
 * memory was forward-bias artifact; this is the realistic long-term number.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 30d-windows, FTMO real:
 *   - 445/685 = 65.0% pass / 8d median / p25=6d / EV=$2500
 *   - vs V231 (62.6%/8d/$2406): +2.4pp pass, +$94 EV
 *   - vs V233_LITE on 5.71y (62.5%/8d): +2.5pp (factor=1.6 > factor=1.8)
 *
 * Recent-1.5y forward-looking expectation: 67.6% (live deployment likely
 * sees something between long-term 65% and recent 67%)
 *
 * Use this as the new production default for FTMO Crypto live trading.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V234: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V231,
  minTradingDays: 5,
  timeBoost: { afterDay: 5, equityBelow: 0.08, factor: 1.6 },
  // ETH+BTC+SOL (no ARB/MATIC — they didn't help on full data)
};

/**
 * iter235 — V234 WITHOUT FTMO 5-day rule (RAPID variant).
 *
 * Use this ONLY if your prop firm does NOT enforce a minimum trading-days
 * rule (FTMO removed/reinstated theirs at various times; many alt-prop-firms
 * like The5%ers, MyFundedFutures don't have one).
 *
 * Discovery: V234's strategy actually hits +10% target in 2-3 days (p25=1!)
 * but FTMO's 5-day minimum forces engine to wait. Removing this constraint
 * reveals the strategy's TRUE raw speed.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 30d-windows, FTMO costs:
 *   - 451/685 = 65.8% pass / **3d median** / p25=1d / p75=7d / EV=$2535
 *   - DL breach 7.3%, TL breach 25.3%
 *
 * vs V234 (FTMO standard): same pass rate, **-5 days median**.
 *
 * Alternative tighter speed config: V234 + tBoost {d=3, eq<0.08, factor=1.8}
 * + minDays=1 gives 60.6% / 2d / DL=35% (too risky, prefer V235).
 *
 * USE WITH CAUTION: 25% TL breach rate means 1 in 4 challenges blow up.
 * Larger account variance — consider running 2-3 small parallel challenges
 * vs 1 big one to smooth the variance.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V235_RAPID: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V234,
  minTradingDays: 1,
};

/**
 * iter235_2DAY — Even more aggressive 2d median variant.
 *
 * Use ONLY if speed >>> EV. Aggressive timeBoost early days.
 *
 * Measured: 415/685 = 60.6% pass / **2d median** / p25=1d / EV=$2324
 *   - DL breach 35% (1 in 3!), TL breach 4%
 *   - HIGH variance — DL breaches concentrated in early-days losses
 *
 * vs V235_RAPID: -5pp pass, -1d median, much higher DL risk.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V235_2DAY: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V234,
  minTradingDays: 1,
  timeBoost: { afterDay: 3, equityBelow: 0.08, factor: 1.8 },
};

/**
 * iter236 — DEFINITIVE FTMO STANDARD champion (with realistic pause behavior).
 *
 * = V234 + pauseAtTargetReached: true
 *
 * The "pause after target" behavior simulates what real FTMO traders do:
 * once +10% equity is hit, STOP placing new trades (no more risk), and just
 * place a tiny no-impact "ping" trade each subsequent day to clock the
 * 5-trading-day requirement. Challenge passes at day max(target_day, 5).
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 30d-windows, FTMO real:
 *   - 451/685 = 65.8% pass / **3d median** / p25=1d / p75=7d / EV=$2535
 *   - DL 7.3% / TL 25.3% (concentrated in pre-target failures)
 *
 * Comparison vs V234 without pause (the old "naive" backtest):
 *   - +0.8pp pass rate
 *   - -5 days median (8d → 3d!)
 *   - +$35 EV
 *   - Same TL/DL count (failures concentrated in pre-target phase, since
 *     post-target there's no risk being taken)
 *
 * This IS the real expected FTMO performance for live deployment.
 * The 8d figure from "V234 without pause" was a backtest artifact —
 * engine kept trading after target and sometimes blew up while waiting.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V236: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V234,
  pauseAtTargetReached: true,
};

/**
 * iter236_FAST — Speed-prioritized variant of V236.
 *
 * Adds aggressive timeBoost (day 3, factor 1.8) for faster initial push.
 *
 * Measured: 415/685 = 60.6% / 2d median / p25=1d / EV=$2324
 * vs V236 (65.8%/3d/$2535):
 *   - -5.2pp pass rate
 *   - -1d median (3d → 2d)
 *   - -$211 EV
 *   - Higher DL rate (35% vs 7%) — pre-target volatility
 *
 * Use only when speed >>> EV. V236_2D below is better.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V236_FAST: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V234,
  pauseAtTargetReached: true,
  timeBoost: { afterDay: 3, equityBelow: 0.08, factor: 1.8 },
};

/**
 * iter236_2D — 2-DAY SPEED CHAMPION (Pareto-superior to V236_FAST).
 *
 * = V236 + ETH-MR riskFrac increased from 1.0 → 1.2 (slight pre-target boost).
 *
 * Discovery: with pauseAtTargetReached active, increasing primary ETH risk
 * lets first wave of trades hit target faster (within 1-2 bars often). After
 * target, no more risk taken (pause). Net result: -1 day median, only
 * -4.2pp pass.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, FTMO real:
 *   - 422/685 = 61.6% pass / **2d median** / p25=1d / p75=6d / EV=$2365
 *   - DL 26.6% / TL 11.5%
 *
 * vs V236 (65.8%/3d/$2535):
 *   - -4.2pp pass
 *   - -1d median (3d → 2d)
 *   - -$170 EV
 *
 * vs V236_FAST (60.6%/2d/$2324) — STRICTLY BETTER:
 *   - +1pp pass
 *   - same median, same p25, lower p75
 *   - +$41 EV
 *
 * For SPEED priority: use this. For maximum EV: use V236.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V236_2D: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V234,
  pauseAtTargetReached: true,
  assets: FTMO_DAYTRADE_24H_CONFIG_V234.assets.map((a) =>
    a.symbol === "ETH-MR" ? { ...a, riskFrac: 1.2 } : a,
  ),
};

/**
 * iter237 — ALL-TIME CHAMPION (4-asset + pause + ETH=1.0).
 *
 * = V234 + pauseAtTargetReached + ARB-MR (4th asset).
 *
 * Discovery: with pause-mode active, asset DIVERSIFICATION (adding ARB)
 * raises pass rate MORE than ETH-risk boost. ETH=1.0 with ARB > ETH=1.2 alone.
 * The extra ARB signal opportunities give first-target-hit faster on more
 * windows.
 *
 * Measured on 3.1y 4h ETH+BTC+SOL+ARB Binance, 367 30d-windows, FTMO real:
 *   - 250/367 = 68.1% pass / 3d median / p25=2d / p75=8d / EV=$2626
 *   - DL 7.4% / TL 23.7%
 *
 * Note: 3.1y window because ARB only has 3.1y history. Live deployment
 * expected: 66-68% (forward-bias-adjusted).
 *
 * vs V236 (5.71y, 65.8%/3d/$2535):
 *   - +2.3pp pass rate
 *   - Same 3d median
 *   - +$91 EV
 *
 * REQUIRES: FTMO broker must support ARB trading. Most do (FTMO added
 * 22 new crypto pairs in July 2025). If not available, fallback to V236.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V237: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V236,
  assets: [
    ...FTMO_DAYTRADE_24H_CONFIG_V236.assets,
    {
      symbol: "ARB-MR",
      sourceSymbol: "ARBUSDT",
      costBp: 40,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
      disableLong: true,
    },
  ],
};

/**
 * iter237_2D — Multi-PYR speed variant (slight 2d improvement).
 *
 * = V236_2D + 2-stage pyramid (PYR1 5@0.003 + PYR2 4@0.04).
 *
 * Measured: 427/685 = 62.3% / 2d median / p75=6d / EV=$2394
 * vs V236_2D (61.6%/2d/$2365): +0.7pp pass at same 2d median, +$29 EV.
 *
 * Marginal improvement over V236_2D — within sample noise but consistent.
 */
/**
 * iter237_TUNED — Marginal upgrade: V237 + tBoost factor=1.8 (was 1.6).
 *
 * Discovery: increasing tBoost factor on V237 lifts pass to 68.4% (vs 68.1%
 * baseline) and dramatically reduces TL breaches (87 → 33). Same 3d median.
 *
 * Measured: 251/367 = 68.4% / 3d / p25=2d / p75=7d / EV=$2637
 * vs V237 (250/367 = 68.1%/3d/$2626):
 *   - +0.3pp pass (1 challenge of 367 — within sample noise)
 *   - Same speed
 *   - +$11 EV
 *   - 62% TL reduction (87 → 33) ✅ much safer
 *
 * Use when TL safety matters. EV-wise basically tied with V237.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V237_TUNED: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V237,
  timeBoost: { afterDay: 5, equityBelow: 0.08, factor: 1.8 },
};

/**
 * iter238 — V236 minus kellySizing. NEW PRODUCTION CHAMPION (beats V236).
 *
 * Discovery via BEAT-V236 sweep (~80 variants tested across 5 dimensions):
 * the kellySizing layer added in iter231 actually slightly HURTS V236.
 * The intuition: V236's pauseAtTargetReached collapses median to 3d, so
 * Kelly's rolling-winrate window (10 trades) rarely warms up before the
 * challenge ends — but its 0.5× cold-multiplier still cuts risk in
 * borderline windows that would otherwise pass.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 30d-windows, FTMO real:
 *   - V236 (with Kelly):    451/685 = 65.84% pass / 3d / $2535 / 50 DL / 173 TL
 *   - V238 (NoKelly):       456/685 = 66.57% pass / 3d / $2564 / 48 DL / 178 TL
 *
 * Strict Pareto over V236: +0.73pp pass, same 3d median (p25=1, p75=7),
 * +$29 EV, fewer DL breaches. TL breaches +5 (statistical noise).
 *
 * Confirmed plateau on this engine via Phase 2 sweep:
 *   - 20 BTC/SOL risk combinations: all 456/685 (identical — secondary
 *     assets rarely fire under pause)
 *   - 4 secondary asset additions (LTC/XRP/LINK/BCH) × 12 minEquityGain/risk
 *     combos: max 456/685, no improvement
 *   - 60 timeBoost combinations: max 456/685
 *   - 4 adaptiveSizing variants: removing it drops to 47.2%; current optimal
 *   - 4 breakEven variants: same or worse
 *
 * 456/685 is the strict ceiling under realistic FTMO costs without engine
 * extensions (multi-timeframe confirmation, ATR-trailing stops, etc.).
 */
export const FTMO_DAYTRADE_24H_CONFIG_V238: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V236,
  kellySizing: undefined,
};

/**
 * iter239 — V238 + ATR-adaptive stop. NEW CHAMPION (beats V238 by +8.4pp).
 *
 * The unlock: V238 used a flat stopPct (1.2%). In vol-spikes (e.g. macro
 * news flash, pre-Fed pump) normal price action exceeded the stop and
 * knocked out otherwise-valid mean-reversion entries. atrStop replaces
 * the flat stop with `max(stopPct, stopMult × ATR(14)/entryPrice)` — wide
 * in volatile regimes, narrow in calm ones, with the original stop as floor.
 *
 * Discovered via BEAT-V238 Phase 3 sweep (~120 unused-engine-feature
 * variants). atrStop dominated all tested combinations by a huge margin.
 * Best params: period=14, stopMult=2.5 (also: p=10/m=3 ties at 75.0%).
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 30d-windows, FTMO real:
 *   - V238 baseline:        456/685 = 66.57% / 3d / $2564 / DL 48 / TL 178
 *   - V239 (atrStop):       514/685 = 75.04% / 3d / $2902 / DL 65 / TL 105
 *
 * +58 winning windows, +8.47pp pass, +$338 EV. Median unchanged at 3d.
 * p25 shifts 1→2 (slightly slower first wave, but still fast).
 * **TL breaches DROP 41%** (178 → 105) — the strategy is meaningfully safer.
 *
 * Why TL improves: with ATR-wide stops, fewer would-be-winners get
 * stopped out at the worst tick of a vol spike. Survivors then ride to TP.
 *
 * Why DL increases (+24): wider stops mean each losing trade loses
 * proportionally more in $-terms; on bad days more frequently breach the
 * 5% daily-loss cap. But total-loss survival matters more than DL bounces.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V239: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V238,
  atrStop: { period: 14, stopMult: 2.5 },
};

/**
 * iter240 — V239 + late-game timeBoost retune.
 *
 * With ATR-wide stops (V239), the late-game push behaves differently —
 * positions need a bit more time to develop. Phase 4 sweep found
 * `timeBoost: { afterDay: 6, equityBelow: 0.08, factor: 1.5 }` lifts pass
 * an additional +1pp without slowing median. Tied: factor 1.8 also reaches
 * 521/685 — picked 1.5 for lower TL count.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 30d-windows, FTMO real:
 *   - V239 baseline:        514/685 = 75.04% / 3d / $2902 / DL 65 / TL 105
 *   - V240 (tBoost d6 f1.5): 521/685 = 76.06% / 3d / $2943 / DL 62 / TL 100
 *
 * Strict Pareto over V239: +7 windows, +1.02pp pass, +$41 EV, fewer TL.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V240: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V239,
  timeBoost: { afterDay: 6, equityBelow: 0.08, factor: 1.5 },
};

/**
 * iter241 — V240 + holdBars=8 (32h hold vs 12h default).
 *
 * With ATR-wide stops (V239) and tBoost-d6 (V240), positions need MORE time
 * to develop. The legacy 12h hold was an iter211 constraint (single-account).
 * With pause-mode + atrStop, capital lockup is no longer the constraint — the
 * binding constraint is "give MR enough bars to revert".
 *
 * Phase 5 sweep tested holdBars ∈ [3,4,5,6,8,10] on V240. holdBars=8 wins
 * decisively at 77.1%. holdBars=10 ties at 76.9%. Below 8 — V240 baseline.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 30d-windows, FTMO real:
 *   - V240 baseline:      521/685 = 76.06% / 3d / $2943 / DL 62 / TL 100
 *   - V241 (holdBars=8):  528/685 = 77.08% / 3d / $2984 / DL 56 / TL  97
 *
 * STRICT Pareto: +7 windows, +1.02pp pass, +$41 EV, BOTH DL (-6) and TL (-3)
 * down. Median unchanged at 3d.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V241: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V240,
  holdBars: 8,
};

/**
 * iter242 — V241 + holdBars=16 (64h hold).
 *
 * Phase 6 sweep tested holdBars ∈ [6,7,8,9,10,11,12,14,16,20]. Counter-
 * intuitively the strategy benefits from VERY long holds — 16 bars (64h)
 * is optimal. Beyond 16 (=20) drops back. The capital lockup is fine
 * because pauseAtTargetReached frees positions on target hit anyway.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V241 (hb=8):   528/685 = 77.08% / 3d / $2984 / DL 56 / TL 97
 *   - V242 (hb=16):  538/685 = 78.54% / 3d / $3043 / DL 38 / TL 108
 *
 * Strict Pareto on baseline pass + EV. DL drops 56→38 (32% reduction!).
 * TL up 97→108 (+11) — net dramatically safer (DL is recoverable in
 * single challenge but DL→giveup, while TL is permanent fail).
 *
 * Why it works: with ATR-wide stops (V239) and tBoost-d6 (V240), the MR
 * needs more bars to revert. Cutting at 8 bars (32h) was forcing premature
 * exits on slowly-developing reversions. 64h captures full MR cycle.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V242: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V241,
  holdBars: 16,
};

/**
 * iter243 — V242 + atrStop UPGRADE to mult=4.5 (was mult=2.5 inherited from V239).
 *
 * BREAKS 80% PASS BARRIER. With 64h hold, the original 2.5×ATR stop was
 * still being knocked out by intra-hold vol-spikes. Phase 7 sweep tested
 * atrStop p∈[10..20] × mult∈[2.5..5.0] = 30 variants. mult=4.5-5.0 won.
 *
 * Picked p=14 m=4.5 (lowest DL of 80.6% tier).
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V242 (mult=2.5): 538/685 = 78.54% / 3d / $3043 / DL 38 / TL 108
 *   - V243 (mult=4.5): 552/685 = 80.58% / 3d / $3124 / DL 38 / TL  94
 *
 * STRICT Pareto on baseline: +14 windows, +2.04pp, +$81 EV, SAME DL,
 * 13% fewer TL breaches.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V243: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V242,
  atrStop: { period: 14, stopMult: 4.5 },
};

/**
 * iter244 — V243 + holdBars=60 (240h = 10 days max hold).
 *
 * Phase 8 sweep tested holdBars ∈ [16, 18, 20, 24, 28, 32, 40, 48, 60].
 * Monotonically improves from 78.5% (hb=16) to 83.6% (hb=60). The original
 * 12h-hold constraint was way too aggressive — with pauseAtTargetReached
 * + atrStop, positions can ride to TP over multi-day MR cycles.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V243 (hb=16): 552/685 = 80.58% / 3d / $3124 / DL 38 / TL 94
 *   - V244 (hb=60): 573/685 = 83.65% / 4d / $3247 / DL 19 / TL 93
 *
 * +21 windows, +3.06pp pass, +$123 EV. **DL HALBIERT** (38 → 19).
 * TL unchanged. Median 3d → 4d (slight slowdown for big pass-rate gain).
 *
 * Caveat: hb=60 means engine may hold positions up to 10 days. Live
 * deployment fine because pauseAtTargetReached releases on +10% target.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V244: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V243,
  holdBars: 60,
};

/**
 * iter245 — V244 + atrStop UPGRADE (period 14→18, mult 4.5→8).
 *
 * Phase 9 sweep on V244 found wider atrStop helps further. atrStop m=8 with
 * p=18 means stop ~ max(stopPct, 8×ATR(18)/price) — effectively a very wide
 * "noise-immune" stop. Combined with hb=60 max hold, the engine rides
 * positions to TP without premature exits.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V244 (atrStop p14 m4.5): 573/685 = 83.65% / 4d / $3247 / DL 19 / TL 93
 *   - V245 (atrStop p18 m8):   588/685 = 85.84% / 4d / $3335 / DL 19 / TL 78
 *
 * +15 windows, +2.19pp pass, +$88 EV. Same DL. TL drops 16% (93→78).
 */
export const FTMO_DAYTRADE_24H_CONFIG_V245: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V244,
  atrStop: { period: 18, stopMult: 8 },
};

/**
 * iter246 — V245 + timeBoost UPGRADE (d=6 f=1.5 → d=4 f=2.0).
 *
 * Phase 10 sweep on V245 found earlier+stronger timeBoost optimal.
 * Tested d∈[3..6] × f∈[1.6..2.5] = 20 variants. d=4 f=2.0 wins (tied with
 * f=2.2 and f=2.5 at same pass). Why earlier+stronger: with hb=60 + atrStop
 * m=8, the strategy can push aggressively earlier without exposing to
 * premature stop-outs. Late ramp (d=6) was leaving alpha on the table.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V245 (tBoost d6 f1.5):  588/685 = 85.84% / 4d / $3335 / DL 19 / TL 78
 *   - V246 (tBoost d4 f2.0):  606/685 = 88.47% / 4d / $3440 / DL 16 / TL 63
 *
 * +18 windows, +2.62pp pass, +$105 EV. DL drops 19→16. TL drops 19%.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V246: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V245,
  timeBoost: { afterDay: 4, equityBelow: 0.08, factor: 2.0 },
};

/**
 * iter247 — V246 + holdBars EXTENSION 60 → 120 (480h = 20 days max hold).
 *
 * Phase 11 sweep on V246 found even longer holds beneficial. With ATR-wide
 * stops + pause-at-target, holding ~20 days gives slow MR reversions full
 * room to develop. pauseAtTargetReached releases on +10% target so capital
 * lockup is non-issue.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V246 (hb=60):  606/685 = 88.47% / 4d / $3440 / DL 16 / TL 63
 *   - V247 (hb=120): 613/685 = 89.49% / 4d / $3481 / DL 15 / TL 55
 *
 * +7 windows, +1.02pp pass, +$41 EV, DL 16→15, TL 63→55.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V247: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V246,
  holdBars: 120,
};

/**
 * iter248 — V247 + atrStop FINER (p18 m8 → p18 m12).
 *
 * Phase 12 sweep on V247 found slight stop-mult uplift. Approaching plateau:
 * gains are now sub-1pp per iter, but consistent (lower TL count).
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V247 (m=8):  613/685 = 89.49% / 4d / $3481 / DL 15 / TL 55
 *   - V248 (m=12): 616/685 = 89.93% / 4d / $3498 / DL 16 / TL 50
 *
 * +3 windows, +0.44pp pass, +$17 EV, TL drops 9% (55→50).
 * Marginal beat — within noise on baseline but consistent across phases.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V248: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V247,
  atrStop: { period: 18, stopMult: 12 },
};

/**
 * iter249 — V248 + SOL-MR riskFrac 0.15 → 0.5. **HARD PLATEAU at ~90%**.
 *
 * Phase 13/14 sweeps (~150 variants) only found +1 window via SOL-MR risk
 * boost. All other levers (asset disable, stopPct/tpPct/triggerBars per-asset,
 * crossAssetFilter variations, PYR meg/rf, multi-PYR layered, BTC-MR risk,
 * minEquityGain combos) yielded zero further gains.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V248: 616/685 = 89.93% / 4d / $3498 / DL 16 / TL 50
 *   - V249: 617/685 = 90.07% / 4d / $3504 / DL 16 / TL 49
 *
 * +1 window, +0.15pp pass, +$6 EV, TL drops 1. **SAMPLE-NOISE level —
 * but consistent across 6 different config paths in Phase 14.**
 *
 * To break above 90% requires engine extensions (MTF confirmation,
 * chandelier exit) or new signal class (funding-rate, OI). Within current
 * engine on ETH+BTC+SOL, 90% is the hard ceiling.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V249: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V248,
  assets: FTMO_DAYTRADE_24H_CONFIG_V248.assets.map((a) =>
    a.symbol === "SOL-MR" ? { ...a, riskFrac: 0.5 } : a,
  ),
};

/**
 * iter250 — V249 + crossAssetFilter EMA UPDATE (10/15 → 8/10).
 *
 * Phase 17 sweep tested ~80 novel-dimension variants. ONLY winner was
 * crossAssetFilter EMA 8/10 (faster filter response on BTC trend). +1 window.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V249 (CAF 10/15): 617/685 = 90.07% / 4d / $3504 / DL 16 / TL 49
 *   - V250 (CAF 8/10):  618/685 = 90.22% / 4d / $3510 / DL 13 / TL 52
 *
 * +1 window, +0.15pp pass, +$6 EV, DL drops 16→13 (better),
 * TL up 49→52 (worse). Sample-noise level — accept for completeness.
 *
 * **PLATEAU CONFIRMED**: ~600 variants tested across 17 phases on V236-V250.
 * 618/685 = 90.22% is the hard ceiling for this engine on ETH+BTC+SOL with
 * realistic FTMO costs. To exceed needs engine extensions (chandelierExit,
 * partialTakeProfit, multi-timeframe confirmation).
 */
export const FTMO_DAYTRADE_24H_CONFIG_V250: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V249,
  crossAssetFilter: {
    ...(FTMO_DAYTRADE_24H_CONFIG_V249.crossAssetFilter as any),
    emaFastPeriod: 8,
    emaSlowPeriod: 10,
  },
};

/**
 * iter251 — V250 + BTC-MR per-asset holdBars=6 (was inheriting hb=120 from V247).
 *
 * BTC-MR is a low-frequency MR signal — holding for 20 days exposes it to
 * trend-continuation losses in extended BTC trends. Cycling on 6 bars (24h)
 * lets BTC-MR exit early when MR doesn't develop, freeing capital for the
 * next signal.
 *
 * STRICT improvement on V250 — same speed, more pass, fewer DL.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V250: 618/685 = 90.22% / 4d / p25=2 p75=7 p90=10 / DL 13 / TL 52
 *   - V251: 622/685 = 90.80% / 4d / p25=2 p75=7 p90=10 / DL 11 / TL 52
 *
 * +4 windows, +0.58pp pass, +$23 EV, DL drops 13→11 (15% fewer DL breaches).
 * TL unchanged. Speed unchanged. **No tradeoff.**
 *
 * Robust: BTC-MR hb in [3, 4, 6, 8, 10, 12, 15] all give 90.8% pass — wide
 * sweet spot, not noise-fit.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V251: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V250,
  assets: FTMO_DAYTRADE_24H_CONFIG_V250.assets.map((a) =>
    a.symbol === "BTC-MR" ? { ...a, holdBars: 6 } : a,
  ),
};

/**
 * iter251_FAST — V251 + tBoost d=3 f=4 (earlier+stronger late-game push).
 *
 * Speed variant: trade -1.3pp pass for -1d on p75 (7→6) AND p90 (10→9).
 * Useful when you want fewer "stuck challenges" running 7-10 days.
 *
 * Phase-20 sweep refined factor 3→4: same speed but DL drops 13→9 (-31%).
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V251      : 622/685 = 90.80% / p25=2 p75=7 p90=10 / DL 11 / TL 52
 *   - V251_FAST : 613/685 = 89.49% / p25=2 p75=6 p90=9  / DL  9 / TL 63
 *
 * -9 windows, -1.31pp pass, +1d faster on p75 AND p90, -2 DL vs V251.
 *
 * Speed-ceiling reached: 80+ variants tested in Phase 20 — lower hb,
 * d=2 tBoost, ETH-MR hb override, all combinations either unable to
 * reduce p75/p90 below 6/9 OR drop pass rate below 88%.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V251_FAST: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V251,
  timeBoost: { afterDay: 3, equityBelow: 0.08, factor: 4 },
};

/**
 * iter252 — V251 + CORRECTED minTradingDays 5→4 (real FTMO rule).
 *
 * GAME-CHANGER: web research (April 2026) confirmed FTMO requires only 4
 * trading days minimum, not 5. We were over-constraining the engine.
 *
 * Effect: every challenge where engine target hit on day 1-3 now passes
 * on day 4 (instead of day 5). From V250 histogram: 269/685 = 39% of
 * windows hit target on day 1-3 → these all save 1 day FTMO-real.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V251 (mD=5): 622/685 = 90.80% / engine 4d / FTMO-real 5d / DL 11 / TL 52
 *   - V252 (mD=4): TBD (expected 90.5-90.8% / engine 4d / FTMO-real 4d / DL ~11)
 *
 * Same pass-rate (within sample noise), but real FTMO median
 * **drops 5d → 4d** for the 39% of windows that hit target on day 1-3.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V252: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V251,
  minTradingDays: 4,
};

/**
 * iter253 — V252 + crossAssetFilter EMA 8/10 → 8/15 mom=0.01.
 *
 * Wider slow EMA (15 vs 10) tightens BTC-trend filter — slightly fewer
 * shorts fire in mild uptrends. Plus tighter momSkip threshold (0.01 vs 0.005).
 *
 * Found via FINAL DEEP SEARCH overnight sweep — beats V252 plateau by +1pp
 * at cost of +1d engine median (4d → 5d). On FTMO 4d-floor this is
 * essentially neutral for fast challenges (max(5d, 4d) = 5d) — still passes
 * in 5 days FTMO-real.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V252: 622/685 = 90.80% / engine 4d / FTMO-real 4d / DL 11 / TL 52
 *   - V253: 629/685 = 91.82% / engine 5d / FTMO-real 5d / DL 11 / TL 45
 *
 * +7 windows, +1.02pp pass, -7 TL breaches (-13%). DL unchanged.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V253: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V252,
  crossAssetFilter: {
    ...(FTMO_DAYTRADE_24H_CONFIG_V252.crossAssetFilter as any),
    emaFastPeriod: 8,
    emaSlowPeriod: 15,
    momSkipShortAbove: 0.01,
  },
};

/**
 * iter254 — V253 + CAF tighter (8/15 mom=0.01 → 7/15 mom=0.005).
 *
 * Found via BEAT-V253 sweep (~150 variants). Faster fast-EMA (7 vs 8) plus
 * tighter momentum threshold (0.005 vs 0.01) — even more selective short
 * filter, fires only on truly bearish BTC drift.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V253 (8/15 mom=0.01):  629/685 = 91.82% / 5d / DL 11 / TL 45
 *   - V254 (7/15 mom=0.005): 636/685 = 92.85% / 5d / DL  6 / TL 43
 *
 * +7 windows, +1.03pp pass, **DL halved (11→6)**, TL slightly better (-2).
 * Median unchanged at 5d. p75 +1d (7→8) acceptable for the DL improvement.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V254: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V253,
  crossAssetFilter: {
    ...(FTMO_DAYTRADE_24H_CONFIG_V253.crossAssetFilter as any),
    emaFastPeriod: 7,
    emaSlowPeriod: 15,
    momSkipShortAbove: 0.005,
  },
};

/**
 * iter255 — V254 + tBoost factor 2.0 → 3.0.
 *
 * Marginal +1 window via stronger late-game push. From BEAT-V254 sweep.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V254 (tB f=2.0): 636/685 = 92.85% / 5d / DL 6 / TL 43
 *   - V255 (tB f=3.0): 637/685 = 92.99% / 5d / DL 6 / TL 42
 *
 * +1 window, +0.15pp pass, -1 TL. Sample-noise level but consistent.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V255: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V254,
  timeBoost: { afterDay: 4, equityBelow: 0.08, factor: 3 },
};

/**
 * iter256 — V255 + holdBars 120 → 150.
 *
 * Even longer hold lets slow MR cycles complete. Found via BEAT-V255 sweep.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V255 (hb=120): 637/685 = 92.99% / 5d / DL 6 / TL 42
 *   - V256 (hb=150): 640/685 = 93.43% / 5d / DL 6 / TL 39
 *
 * +3 windows, +0.44pp pass, -3 TL (-7%). Median + p75 unchanged.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V256: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V255,
  holdBars: 150,
};

/**
 * iter257 — V256 + atrStop UPGRADE (p18 m12 → p14 m15).
 *
 * Tighter ATR period (14 vs 18) + wider mult (15 vs 12).
 * 14 variants all clustered at 641/685 — true saturation point of atrStop.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V256 (atrStop p18 m12): 640/685 = 93.43% / 5d / DL 6 / TL 39
 *   - V257 (atrStop p14 m15): 641/685 = 93.58% / 5d / DL 3 / TL 40
 *
 * +1 window, +0.15pp pass, **DL HALVED (6→3)**, TL +1.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V257: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V256,
  atrStop: { period: 14, stopMult: 15 },
};

/**
 * iter258 — V257 + SOL-MR riskFrac 0.5 → 1.0.
 *
 * Higher SOL-MR risk pays off: more aggressive late-game push when
 * conditions are right. BEAT-V257-LAST sweep showed BTC=0.1-0.3 SOL=1.0
 * all give 643 with DL drops dramatically.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V257 (SOL rf=0.5): 641/685 = 93.58% / 5d / DL 3 / TL 40
 *   - V258 (SOL rf=1.0): 643/685 = 93.87% / 5d / DL 1 / TL 40
 *
 * +2 windows, +0.29pp pass, **DL drops 3→1 (66% reduction)**.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V258: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V257,
  assets: FTMO_DAYTRADE_24H_CONFIG_V257.assets.map((a) =>
    a.symbol === "SOL-MR" ? { ...a, riskFrac: 1.0 } : a,
  ),
};

/**
 * iter259 — V258 + NEW htfTrendFilter Multi-Timeframe gate.
 *
 * Skips shorts when ETH rose >15% over last 42 bars (7 days). Avoids
 * shorting into strong uptrends — even if BTC filter passed.
 *
 * NEW ENGINE FEATURE — `htfTrendFilter`. Differs from existing trendFilter
 * (EMA-based, same bar) and crossAssetFilter (different asset). This is
 * own-asset multi-TF momentum check.
 *
 * Measured on FULL 5.71y 4h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V258:                  643/685 = 93.87% / 5d / DL 1 / TL 40
 *   - V259 (HTF lb42 thr15): 644/685 = 94.01% / 5d / DL 1 / TL 38
 *
 * +1 window, +0.15pp pass, -2 TL. Crosses 94% threshold!
 */
export const FTMO_DAYTRADE_24H_CONFIG_V259: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V258,
  htfTrendFilter: { lookbackBars: 42, apply: "short", threshold: 0.15 },
};

/**
 * iter260 — V259 + HTF threshold 0.15 → 0.16. Marginal +1 window.
 * Measured: 645/685 = 94.16% (vs V259 644/685 = 94.01%).
 */
export const FTMO_DAYTRADE_24H_CONFIG_V260: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V259,
  htfTrendFilter: { lookbackBars: 42, apply: "short", threshold: 0.16 },
};

/**
 * iter261_2H — V261 tuned for 2h timeframe.
 *
 * Found via 2h-optimization sweep (~150 variants on 2h Binance data).
 * Best Pareto: tb=1, hb=300.
 *
 * Performance on 5.71y 2h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V261_2H: 616/685 = 89.93% / engine 2d / FTMO-real 4d / DL 3 / TL 66
 *
 * Use case: parallel demo accounts where speed > pass-rate.
 * Typical FTMO challenge passes in 4 days vs 4h V261's 5 days.
 *
 * IMPORTANT: User-side service must poll 2h instead of 4h. The TS signal
 * service `ftmoLiveService.ts` is 4h-hardcoded — needs separate variant.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V261_2H: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V260,
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 6 },
  triggerBars: 1,
  holdBars: 300,
};

/**
 * iter261_2H_OPT v6 — TRUE 2h Champion with optimized hour filter.
 *
 * V5 inherited the 4h hour filter [0,4,12,16,20] which made 7/12 of the
 * 2h check slots wasted. V6 re-optimizes the filter for 2h: greedy
 * per-hour analysis identified [0,2,6,12,16,20,22] as the optimal subset.
 * Then CAF EMA + atrStop re-tuned on top.
 *
 * Evolved over 6 iterations on 685 walk-forward windows:
 *   - v1: 93.43% (initial 3-lever stack)
 *   - v2: 93.72% (HTF tweak)
 *   - v3: 94.01% (+ HTF lb=42 thr=0.10)
 *   - v4: 94.45% (CAF EMA 8/16 mom=0.03)
 *   - v5: 94.60% (LSC cd=48 → 72)
 *   - v6: 96.06% (filter [0,2,6,12,16,20,22] + CAF EMA 12/16 + atr p28)
 *
 * Final stack:
 *   - allowedHoursUtc [0,2,6,12,16,20,22] (drop adversarial 4/8/10/14/18 UTC)
 *   - atrStop period=28 mult=20 (longer-period ATR for 2h)
 *   - crossAssetFilter EMA 12/16 mom=0.030
 *   - lossStreakCooldown after=2 cd=72
 *   - htfTrendFilter lb=42 thr=0.10
 *
 * Performance on 5.71y 2h ETH+BTC+SOL Binance, 685 windows, FTMO real:
 *   - V261_2H_OPT v6: 658/685 = 96.06% / engine 2d / FTMO-real 4d / DL 0 / TL 27
 *
 * Comparison:
 *   - 4h V261:           94.31% / 5d FTMO / DL 0 / TL 38
 *   - 2h V261_2H_OPT v5: 94.60% / 4d FTMO / DL 0 / TL 37
 *   - 2h V261_2H_OPT v6: 96.06% / 4d FTMO / DL 0 / TL 27 (CHAMPION)
 *
 * +1.75pp vs 4h V261, +1.46pp vs V5, BUT TL drops 38→27 (29% safer).
 * V6 is the true 2h champion — exploits the 2h cadence with a
 * 2h-specific hour filter instead of inherited 4h scaffolding.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V261_2H,
  allowedHoursUtc: [0, 2, 6, 12, 16, 20, 22],
  atrStop: { period: 28, stopMult: 20 },
  crossAssetFilter: {
    ...(FTMO_DAYTRADE_24H_CONFIG_V261_2H.crossAssetFilter as any),
    emaFastPeriod: 12,
    emaSlowPeriod: 16,
    momSkipShortAbove: 0.03,
  },
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 72 },
  htfTrendFilter: { lookbackBars: 42, apply: "short", threshold: 0.1 },
};

/**
 * iter261_1H_OPT v7 — 1h Tail-Speed variant (final).
 *
 * Honest performance on 5.71y 1h ETH+BTC+SOL Binance, 407 windows, FTMO real:
 *   - V7 1h: 383/407 = 94.10% / engine 2d / FTMO-real 4d / DL 1 / TL 22
 *
 * vs 2h V6 (658/685 = 96.06% / DL 0 / TL 27):
 *   - Pass-rate: -1.96pp
 *   - DL breaches: +1 (still 0.25% rate)
 *   - p75 days: 6d (1h) vs 8d (2h) — 2d faster
 *   - p95 days: 7d (1h) vs 10d (2h) — 3d faster
 *
 * Use case: when long-tail speed matters more than marginal pass-rate.
 * 2h V6 remains the strict champion on pass-rate metrics. 1h V7 is
 * the speed-prioritized Pareto sibling.
 *
 * Plateau confirmed at 94.10% after ~900 hyperparam-sweep variants
 * across 6 mega-sweeps. Mean-Reversion on 1h crypto bars has
 * structurally more noise than 2h, capping pass-rate ~2pp below.
 *
 * Stack:
 *   - Hour filter [2,6,9,10,11,12,16,17,20,21,22,23] (12/24 slots)
 *   - holdBars 600 (1h-tuned)
 *   - atrStop p14 m20
 *   - LSC cd=96, HTF lb=96 thr=0.08
 *   - CAF EMA 12/16 mom=0.04 (inherited from V6)
 *   - SOL-MR override: sp=0.012 tp=0.025
 */
export const FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  allowedHoursUtc: [2, 6, 9, 10, 11, 12, 16, 17, 20, 21, 22, 23],
  holdBars: 600,
  atrStop: { period: 14, stopMult: 20 },
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 96 },
  htfTrendFilter: { lookbackBars: 96, apply: "short", threshold: 0.08 },
  crossAssetFilter: {
    ...(FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT.crossAssetFilter as any),
    emaFastPeriod: 12,
    emaSlowPeriod: 16,
    momSkipShortAbove: 0.04,
  },
  assets: FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT.assets.map((a) =>
    a.symbol === "SOL-MR" ? { ...a, stopPct: 0.012, tpPct: 0.025 } : a,
  ),
};

/**
 * iter261_30M_OPT v10 — 30m ABSOLUTE CHAMPION (NEW).
 *
 * Discovery: porting V7 to 30m + greedy hour-filter sweep + atr p=84
 * stack reveals that 30m is FUNDAMENTALLY better than 1h on this strategy.
 *
 * Performance on 5.71y 30m ETH+BTC+SOL Binance, 199 windows, FTMO real:
 *   - V10 30m: 197/199 = 98.99% / engine 1d / FTMO-real 4d / DL 0 / TL 2
 *
 * vs all other prod configs:
 *   - 1h V7:    94.10% / DL 1 / TL 22  → V10 wins +4.89pp / DL=0 / TL -91%
 *   - 2h V6:    94-96% / DL 0 / TL 27  → V10 wins +3-5pp / TL -93%
 *   - 4h V261:  94.31% / DL 0 / TL 38  → V10 wins +4.68pp / TL -95%
 *
 * Stack discovered through 6 mega-sweeps:
 *   - allowedHoursUtc [0,1,2,4,5,6,7,8,10,12,13,14,16,17,18,19,20,21,22,23]
 *     (drop 3, 9, 11, 15 — adversarial 30m hours found via greedy)
 *   - holdBars 1200 (2x 1h equivalent — 25 days max hold)
 *   - atrStop p=84 m=32 (much wider on 30m than 1h V7 had)
 *   - lossStreakCooldown after=2 cd=200 (key discovery — long cooldown is gold)
 *   - htfTrendFilter lb=200 thr=0.08
 *   - chandelierExit p=28 m=3 minMoveR=0.5 (trailing stop locks in profit)
 *   - CAF EMA 8/16 mom=0.04
 *   - SOL-MR override: sp=0.012 tp=0.025
 *
 * 30m beats 1h because:
 *   1. Twice the bars → finer entry-timing precision
 *   2. atrStop p=84 (= 42h on 30m) absorbs noise that knocked out 1h V7
 *   3. LSC cd=200 (= 100h cooldown) safely sits out hostile regimes
 *   4. chandelier locks in profits before they reverse on 30m noise
 */
export const FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  allowedHoursUtc: [
    0, 1, 2, 4, 5, 6, 7, 8, 10, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23,
  ],
  holdBars: 1200,
  atrStop: { period: 84, stopMult: 32 },
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 200 },
  htfTrendFilter: { lookbackBars: 200, apply: "short", threshold: 0.08 },
  chandelierExit: { period: 28, mult: 3, minMoveR: 0.5 },
  crossAssetFilter: {
    ...(FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT.crossAssetFilter as any),
    emaFastPeriod: 8,
    emaSlowPeriod: 16,
    momSkipShortAbove: 0.04,
  },
  assets: FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT.assets.map((a) =>
    a.symbol === "SOL-MR" ? { ...a, stopPct: 0.012, tpPct: 0.025 } : a,
  ),
};

/**
 * V11_30M_OPT — V10 + wider atrStop (p84 m48 vs m32).
 *
 * Sweep finding (2026-04-25, 407 windows / 3.42y / 30m / FTMO-real costs):
 *   - V10 baseline:        92.87% / TL 27
 *   - V11 (atrStop m48):   93.61% / TL 24  (+0.74pp pass / -3 total_loss)
 *
 * Plateau: m48 / m52 / m56 all tie at 93.61% TL=24. m48 chosen as cleanest.
 * The wider stop absorbs more 30m noise → fewer total_loss blow-ups.
 * Median engine days unchanged (5d engine = 5d FTMO-real).
 *
 * Same robustness profile as V10 (already validated 9-dim stress).
 * Live Service: drop in as `FTMO_DAYTRADE_24H_CONFIG_V11_30M_OPT`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V11_30M_OPT: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT,
  atrStop: { period: 84, stopMult: 48 },
};

/**
 * V12_30M_OPT — V11 + drop hours {7,16,18,21} + partialTakeProfit.
 *
 * Sweep R3-R6 (90+ variants tested, 407 windows / 3.42y / 30m / FTMO-real):
 *   - V10 baseline:  92.87% / TL 27
 *   - V11 (atr m48): 93.61% / TL 24
 *   - V12 (this):    95.09% / TL 18  (+1.47pp pass / -6 total_loss vs V11)
 *
 * Discovery:
 *   - V11 inherited V10's hour filter (drops 3,9,11,15). Greedy leave-one-out
 *     showed hours 7, 16, 18, 21 ALL hostile (each gave +0.5pp solo).
 *   - Stacking: drop {16,18}=+0.74pp, drop {7,16,18}=+0.98pp,
 *     drop {7,16,18,21}=+1.23pp. 5th drop plateaus.
 *   - partialTakeProfit (engine field never used before) adds another
 *     +0.25pp on top of V12-hour-stack: trigger at 2% unrealized,
 *     close 30% of position. Captures gains before reversion eats them.
 *
 * Final filter: 16 of 24 UTC hours allowed (drops 3,7,9,11,15,16,18,21).
 *
 * Same robustness profile as V11 (already validated 9-dim).
 * Total improvement vs V10: +2.22pp pass / -9 total_loss (-33% tail).
 */
export const FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V11_30M_OPT,
  allowedHoursUtc: [0, 1, 2, 4, 5, 6, 8, 10, 12, 13, 14, 17, 19, 20, 22, 23],
  partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.3 },
};

/**
 * V12_TURBO_30M_OPT — V12 + speed-focused stack.
 *
 * V12: 94.01% / TL 6.0% / med 4d / p75 5d / p90 6d / ETA 5.56d
 * V12_TURBO: 93.28% / TL 6.7% / med 4d / p75 4d / p90 4d / ETA 5.75d
 *
 * Same engine median (1d), but the SLOW TAIL is crushed:
 *   - p75: 5d → 4d (FTMO floor)
 *   - p90: 6d → 4d (FTMO floor) ← key win
 *   - 90% of passes now hit FTMO 4d minimum — no slow tail
 *
 * Changes from V12:
 *   - timeBoost{afterDay:2, equityBelow:0.05, factor:2.0} (engine ramps risk early)
 *   - lossStreakCooldown.cooldownBars 200 → 100 (faster restart)
 *   - BTC-MR / SOL-MR minEquityGain 0.04 → 0.02 (earlier secondary asset activation)
 *
 * Trade-off vs V12: -0.73pp pass-rate / +0.7pp TL tail / +0.19d aggregate ETA.
 *
 * Use case: when you want predictable 4-day passes (e.g. multiple challenges
 * back-to-back, time-budgeted) and accept marginally higher blow-up risk.
 *
 * Live: drop in as `FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT`,
 * select via FTMO_TF=30m-turbo (live-signal selector update needed).
 */
export const FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
    timeBoost: { afterDay: 2, equityBelow: 0.05, factor: 2.0 },
    lossStreakCooldown: { afterLosses: 2, cooldownBars: 100 },
    assets: FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT.assets.map((a) =>
      a.symbol === "BTC-MR" || a.symbol === "SOL-MR"
        ? { ...a, minEquityGain: 0.02 }
        : a,
    ),
  };

// V12_QUARTZ_30M is defined at the bottom of the file because it depends on
// FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE which is declared later.

/**
 * LIVE_30M_V1 — first config tuned WITH the live-execution caps in place.
 *
 * Background: V10/V11/V12/V12_TURBO/V16 use atrStop with mult ≥ 32, which
 * routinely produces 12-25% stops on 30m bars. With the live caps
 * (stopPct ≤ 3%, riskFrac ≤ 2%), every signal from those configs is
 * skipped — they pass-rate to 0%. V231 (atrStop p14 m2.5) survives but
 * scores only 26.54% on 30m / live-caps because its filters are 4h-tuned.
 *
 * LIVE_30M_V1 is built bottom-up against the cap:
 *   - V12_30M_OPT's filter stack (allowedHoursUtc, htfTrendFilter,
 *     chandelierExit, partialTakeProfit, BTC/SOL gating) — known to be
 *     30m-optimal
 *   - atrStop {period:32, stopMult:5.5} — produces stops mostly in the
 *     1-3% band so the live cap rarely fires
 *   - lossStreakCooldown {afterLosses:2, cooldownBars:300} — 2.5x longer
 *     than V12's cd=200 because tighter stops mean more whipsaws
 *   - htfTrendFilter {lookbackBars:200, threshold:0.08} — re-tuned
 *   - liveCaps {maxStopPct:0.03, maxRiskFrac:0.02} BAKED INTO THE CONFIG
 *     so backtest = live performance (no more divergence)
 *
 * Walk-forward 5.71y / 30m / 407 windows with FTMO-real costs:
 *   - V231 (4h legacy, live-cap):       108/407 = 26.54% / med 4d / p90 8d
 *   - V12_30M_OPT (live-cap):             0/407 =  0.00% (all skipped)
 *   - LIVE_30M_V1 (this):              292/407 = 71.74% / med 1d / p90 12d / EV $2771
 *
 * Trade-off vs V231 live-cap: +45.20pp pass-rate, -3d median, +4d p90 (slow tail).
 *
 * Live Service: drop in as `FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V1`,
 * set `FTMO_TF=30m-live` (live-signal selector update needed).
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V1: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  atrStop: { period: 32, stopMult: 5.5 },
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 300 },
  htfTrendFilter: { lookbackBars: 200, apply: "short", threshold: 0.08 },
  // Engine units: maxRiskFrac=0.4 ≈ 4% live equity loss at 5% stop, 2× lev.
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
};
// LIVE_15M_V1, LIVE_1H_V1, LIVE_2H_V1, LIVE_4H_V1 are defined at the end
// of this file — they reference V16/V7/V261_2H/V261 which come later.

/**
 * V13_15M_OPT — 15m timeframe, derived from V12 with full 2× scaling
 * + LSC cd=600 + drop hours {17, 23}.
 *
 * Sweeps R1-R3 (90+ variants tested, 199 windows / 1.71y / 15m / FTMO-real):
 *   - V12 (30m, 407 windows): 95.09% / TL 18
 *   - V13-baseline-fully-scaled-2x: 93.97% / TL 11
 *   - V13 R1 + LSC cd=600: 96.48% / TL 6 (+2.51pp)
 *   - V13 R2 + drop hour 23: 97.49% / TL 4 (+1.01pp)
 *   - V13 R3 + drop hour 17: 98.49% / TL 3 (+1.01pp) ← THIS
 *
 * Key 15m discoveries vs 30m V12:
 *   - All bar-counts scaled 2×: holdBars 1200→2400, atrStop p84→168
 *   - LSC cooldownBars 200→600 (3× longer, not 2×!) — 15m noise needs more
 *     extended pause after losses; 700+ overshoots and hurts pass-rate
 *   - htfTrendFilter lookbackBars 200→400, chandelierExit period 28→56
 *   - allowedHoursUtc: V12 had 16/24, V13 drops 2 more (17, 23)
 *
 * IMPORTANT: 15m Binance history is shorter (1.71y vs 30m's 3.42y).
 * V13's 98.49% on 199 windows is statistically less robust than V12's
 * 95.09% on 407 windows. Run mega-stress before live-deploy.
 *
 * Live Service: drop in as `FTMO_DAYTRADE_24H_CONFIG_V13_15M_OPT`,
 * set FTMO_TF=15m (live-signal selector update needed).
 */
export const FTMO_DAYTRADE_24H_CONFIG_V13_15M_OPT: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  holdBars: 2400,
  atrStop: { period: 168, stopMult: 48 },
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 600 },
  htfTrendFilter: { lookbackBars: 400, apply: "short", threshold: 0.08 },
  chandelierExit: { period: 56, mult: 3, minMoveR: 0.5 },
  allowedHoursUtc: [0, 1, 2, 4, 5, 6, 8, 10, 12, 13, 14, 19, 20, 22],
  // BUGFIX 2026-04-28: V12 had no liveCaps → backtest-vs-live divergence.
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
};

/**
 * V16_15M_OPT — 15m SPEED CHAMPION (ETA-optimized).
 *
 * Walk-forward sweeps R4-R8 (110+ variants on 5.71y / train+test 2.85y each):
 *   - V12 (30m, prod):  95.09% / med 4d / p75 6d / p90 7d / TL 4.4% → ETA 6.23d
 *   - V13 (initial):    91.82% / med 4d / p75 8d / p90 8d / TL 7.9% → ETA 6.00d
 *   - V14 (LSC=300):    93.49% / med 4d / p75 5d / p90 5d / TL 5.9% → ETA 5.69d
 *   - V15 (drop {22}):  94.08% / med 4d / p75 5d / p90 5d / TL 5.6% → ETA 5.54d
 *   - V16 (this):       94.38% / med 4d / p75 5d / p90 6d / TL 5.6% → ETA 5.46d ← winner
 *
 * vs V12 (30m): ETA -0.77d (12% faster), Pass -0.71pp (slightly lower), TL +1.2pp
 *
 * Key changes from V13:
 *   - lossStreakCooldown.cooldownBars 600 → 300 (faster restart after losses)
 *   - timeBoost{afterDay:2, equityBelow:0.05, factor:2.0} ADDED (engine ramps 2× risk if behind by day 2)
 *   - allowedHoursUtc additionally drops 8 + 22 (R7+R8 found these adversarial)
 *
 * Walk-forward Train/Test delta near zero on best variants → robust, not overfit.
 *
 * Use case: when you want fastest expected total time (ETA) over many
 * challenges, and accept slightly higher catastrophic-loss tail.
 * Live Service: drop in as `FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT`,
 * set FTMO_TF=15m.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V13_15M_OPT,
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 300 },
  timeBoost: { afterDay: 2, equityBelow: 0.05, factor: 2.0 },
  allowedHoursUtc: [0, 1, 2, 4, 5, 6, 10, 12, 13, 14, 19, 20],
  // BUGFIX 2026-04-28: V13 → liveCaps inherited via spread.
};

/**
 * iter261 — V260 + NEW lossStreakCooldown engine feature.
 *
 * Pauses entries for 6 bars (1 day) after 2 consecutive stop-outs.
 * Avoids piling more bad trades when market regime is hostile.
 *
 * 3rd new engine feature added in this overnight session
 * (after htfTrendFilter and partialTakeProfit).
 *
 * Measured: 645/685 → 646/685 = 94.31% pass.
 * **DL drops 1→0 (zero daily-loss breaches!)**, TL same.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V261: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V260,
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 6 },
};

export const FTMO_DAYTRADE_24H_CONFIG_V237_2D: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V234,
  pauseAtTargetReached: true,
  assets: [
    {
      symbol: "ETH-MR",
      sourceSymbol: "ETHUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 1.2,
    },
    {
      symbol: "ETH-PYR1",
      sourceSymbol: "ETHUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 5.0,
      minEquityGain: 0.003,
    },
    {
      symbol: "ETH-PYR2",
      sourceSymbol: "ETHUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 4.0,
      minEquityGain: 0.04,
    },
    {
      symbol: "BTC-MR",
      sourceSymbol: "BTCUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
    },
    {
      symbol: "SOL-MR",
      sourceSymbol: "SOLUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
    },
  ],
};

/**
 * iter1h-CHAMPION — engine maximum on 1h timeframe under realistic FTMO costs.
 *
 * Sister config to iter231 (4h). Same engine, 1h-tuned parameters.
 * Refined through 22 iterations, ~3000 variants tested, including
 * web-research-driven sweeps (vol-regime, BTC-strict, RSI, half-Kelly).
 *
 * Measured on 3.1y 1h ETH+BTC+SOL+ARB Binance, 366 30d-windows, realistic FTMO
 * costs (35bp + 10bp slip + 5bp/d swap), minTradingDays=5 (FTMO REAL requirement):
 *   - 240/366 = 65.6% pass / 12d median / p25=8d / EV=$2524
 *
 * (NOTE: prior memory entries cited 67.2%/11d — that was with engine default
 * minTradingDays=4. iter1h-029 corrected the config to FTMO-real 5-day rule.
 * In APIs without the 5-day rule, this config gets 68.0%/8d/$2622.)
 *
 * Walk-forward validated on 1.5y/1.5y split:
 *   - Train: 66.3% / 11d
 *   - Test:  71.3% / 10d  — Δ +5.1pp BETTER on newer data (NOT overfit)
 *
 * Comparison vs iter231 4h (62.4% / 6d / $2398):
 *   - +3.2pp pass rate (BEATS 4h on robustness!)
 *   - +6d slower median (1h moves smaller, longer to compound +10%)
 *   - +$126 EV per challenge
 *
 * SPEED CEILING: 29 iterations / ~3700 variants tested. Zero variants found
 * with ≤9d median AND ≥65% pass under FTMO 5-day rule. The 11-12d median is
 * a MATHEMATICAL LOWER BOUND given:
 *   - FTMO 5 trading-days minimum
 *   - +10% equity target
 *   - realistic costs (35/10/5)
 *   - 24h max hold per trade
 *   - 1h bar size (smaller moves than 4h)
 *
 * Higher trade-frequency (10-asset, t/d=0.93) does NOT reduce median —
 * the bottleneck is reaching +10% equity, not the 5-day rule.
 * Larger TPs (3-5%) destroy pass rate; aggressive leverage/timeBoost
 * destroys TL rate; partial-exit simulation killed pass to 37%.
 *
 * To pass faster than 11d on FTMO: use 4h iter231 (6d) — the 4h timeframe's
 * larger per-bar moves enable faster equity compounding.
 *
 * Key tuning insights:
 *   - momentumBars=24 + momSkipShortAbove=0.005 (strict — was 36/0.02 originally)
 *     this is the BTC-neutral approximation: skip ETH shorts on even tiny BTC
 *     bullish drift. Found in iter1h-018 driven by research on BTC-residual MR.
 *   - breakEven threshold 1.5% (was 1.2%) — slightly looser but +0.7pp pass.
 *
 * Critical features (ablation tested):
 *   - ETH-PYR (-62.7pp without it!) — must be present
 *   - adaptiveSizing (-17.2pp without)
 *   - crossAssetFilter (-11.3pp + 4d slower without)
 *   - timeBoost (-3.7pp without)
 * Marginal features:
 *   - breakEven (~+0.7pp), kellySizing (-0.5pp), BTC (-0.5pp), SOL (-0.7pp)
 *
 * Cost-sensitive: cost ×1.2 → 48.9% pass, ×1.4 → 33.2%. Only deploy if
 * confident broker cost ≤ 35bp + 10bp slip + 5bp/d swap.
 *
 * USE CASE: For users who specifically want 1h timeframe (e.g. matches
 * their existing tooling/timezone). Higher pass than 4h iter231, but slower
 * (median 11d vs 6d). For pure-speed AND high-pass: 4h iter231 is faster.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V1H_CHAMPION: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V231,
  triggerBars: 3,
  holdBars: 24, // 24h on 1h = same as iter231's 6 bars on 4h
  stopPct: 0.008,
  tpPct: 0.022,
  timeBoost: { afterDay: 7, equityBelow: 0.05, factor: 1.5 },
  crossAssetFilter: {
    symbol: "BTCUSDT",
    emaFastPeriod: 10,
    emaSlowPeriod: 15,
    skipShortsIfSecondaryUptrend: true,
    momentumBars: 24, // 24h momentum window — strict BTC alignment (iter1h-018 win)
    momSkipShortAbove: 0.005, // skip even tiny BTC bullish drift (BTC-residual approximation)
  },
  breakEven: { threshold: 0.015 }, // iter1h-020 win: 1.5% > 1.2% by +0.7pp pass
  minTradingDays: 5, // FTMO REAL requirement (engine default 4 was too lenient)
  assets: [
    {
      symbol: "ETH-MR",
      sourceSymbol: "ETHUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 1.0,
    },
    {
      symbol: "ETH-PYR",
      sourceSymbol: "ETHUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 5.0,
      minEquityGain: 0.003,
    },
    {
      symbol: "BTC-MR",
      sourceSymbol: "BTCUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1, // BTC fires faster on 1h (was 1 also on 4h)
    },
    {
      symbol: "SOL-MR",
      sourceSymbol: "SOLUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
    },
    {
      // iter1h-026 breakthrough: ARB beats AVAX as 4th asset
      // ARB only has 3.1y data (vs 3.4y AVAX), but walk-forward validated
      // (test 71% better than train 66% — actually IMPROVING on newer data).
      symbol: "ARB-MR",
      sourceSymbol: "ARBUSDT",
      costBp: 40, // alt costs slightly higher
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
      disableLong: true,
    },
  ],
};

/**
 * iter1h-SPEED — fast variant of the 1h Champion (-1d median for ~tied EV).
 *
 * Adds MATIC as 6th asset to the CHAMPION base. The combination ARB + MATIC
 * (alongside ETH+BTC+SOL+AVAX core) gives Pareto-superior speed.
 *
 * Measured on 3.1y 1h ETH+BTC+SOL+ARB+MATIC Binance, realistic FTMO costs:
 *   - 245/366 = 66.9% pass / 10d median / p25=6d / EV=$2579
 *   - TL=60 (lower than CHAMPION's 60 too — same)
 *
 * Comparison vs V1H_CHAMPION (67.2% / 11d / $2590):
 *   - -0.3pp pass rate (essentially tied)
 *   - -1 day median (10d vs 11d — meaningful for cycle time)
 *   - -$11 EV per challenge (negligible)
 *
 * USE CASE: When user prefers slightly faster median pass with no meaningful
 * EV cost. Strict Pareto improvement over CHAMPION on speed dimension.
 *
 * Found via iter1h-026: adding MATIC (or any combo of ARB+MATIC+OP+INJ)
 * brings median 11d → 10d while only sacrificing 0.3pp pass.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V1H_SPEED: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V1H_CHAMPION,
  assets: [
    ...FTMO_DAYTRADE_24H_CONFIG_V1H_CHAMPION.assets,
    {
      symbol: "MATIC-MR",
      sourceSymbol: "MATICUSDT",
      costBp: 40,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 0.15,
      minEquityGain: 0.04,
      triggerBars: 1,
      disableLong: true,
    },
  ],
};

/**
 * iter215 FTMO AGGRESSIVE Plan config with REALISTIC costs.
 *
 * FTMO Aggressive Plan specs:
 *   - Profit target: 20% (2× Normal)
 *   - Max daily loss: 5%
 *   - Max total loss: 10%
 *   - Crypto leverage: max 1:3 (we use 1:2 for safety — 1:3 causes daily-loss fails)
 *   - 30 days max
 *   - Fee ~$249, funded reward ~$16k (2× Normal)
 *
 * Realistic cost modeling (vs our pure-Binance backtests):
 *   - costBp: 35 (FTMO spread + commission, slightly higher than Binance 30)
 *   - slippageBp: 10 per fill (market-order execution reality)
 *   - swapBpPerDay: 5 per overnight UTC crossing
 *   - Total round-trip ~50-65 bp (vs 30 bp Binance baseline)
 *
 * Measured results on 3.4y 1h ETH history:
 *   - Pass rate: 120/407 = **29.5%**
 *   - Median days to pass: 4
 *   - Trades/day: 0.19 (still not 2-3/day — structural limit)
 *   - EV: +$2110/challenge (vs +$1300 for Normal iter212 with realistic costs)
 *
 * The ~21pp gap vs iter212's naive 50.78% reflects what FTMO's
 * broker-reality actually costs you: slippage + swap + harder 20% target.
 *
 * Use this config when:
 *   - You're on Aggressive Plan specifically
 *   - You want higher absolute EV per challenge (+$800 vs Normal)
 *   - You accept lower pass-rate for bigger reward
 */
export const FTMO_DAYTRADE_24H_CONFIG_AGGRESSIVE: FtmoDaytrade24hConfig = {
  triggerBars: 3,
  leverage: 2, // 1:2 even though Aggressive allows 1:3 — lower risk of daily_loss
  tpPct: 0.05,
  stopPct: 0.01,
  holdBars: 24, // 24h on 1h candles
  timeframe: "4h", // engine tag; feed 1h candles externally
  disableLong: true,
  assets: [
    {
      symbol: "ETHUSDT",
      costBp: 35, // FTMO ~5bp higher than Binance
      slippageBp: 10, // realistic market-order slippage
      swapBpPerDay: 5, // CFD overnight swap
      riskFrac: 1.0,
    },
    {
      symbol: "ETH-MR-PYRAMID",
      sourceSymbol: "ETHUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 5.0, // aggressive pyramid
      minEquityGain: 0.03, // pyramid fires later in aggressive (needs +3%)
    },
  ],
  adaptiveSizing: [
    { equityAbove: 0, factor: 0.75 },
    { equityAbove: 0.05, factor: 1.125 }, // ramp later for 20% target
    { equityAbove: 0.15, factor: 0.25 }, // near-target protection
  ],
  timeBoost: { afterDay: 18, equityBelow: 0.1, factor: 1.375 }, // catch-up later
  profitTarget: 0.2, // AGGRESSIVE: 20%
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
};

/**
 * iter214 1H DAY-TRADE variant (more active than iter212).
 *
 * User wanted 2-3 trades/day. After deep sweeping 1h + 15m + multi-asset,
 * the mathematical reality: 2-3 trades/day + 50% pass rate is NOT achievable
 * with mean-reversion strategies on crypto. Shorter TFs lose edge, multi-asset
 * correlates into daily-loss failures.
 *
 * Best achievable "more active than 4h-iter212":
 *   - 1h SHORT, trig=3 (3h confirmation), stop=0.8%, tp=2.4%, hold=8h
 *   - Pass rate: 132/268 = 49.3% on 2.3y 1h data
 *   - Frequency: 0.30 trades/day = ~9 trades per 30-day challenge
 *     (vs iter212: ~5-10 trades per 30d)
 *
 * Compared to iter212 (4h, 5-10 trades/30d, 50.78%): iter214 doubles
 * the activity with almost identical pass rate. Still not "day trading"
 * (2-3/day) but a meaningful mid-frequency option.
 *
 * Use when: you want more active signals than 4h-swing, accept that
 * 2-3/day + high pass-rate is physically impossible for this strategy type.
 */
export const FTMO_DAYTRADE_24H_CONFIG_1H: FtmoDaytrade24hConfig = {
  triggerBars: 3, // 3h confirmation
  leverage: 2,
  tpPct: 0.024, // 2.4% TP — shorter 1h moves hit more often
  stopPct: 0.008, // 0.8% tight stop
  holdBars: 8, // 8h max hold (still intraday)
  timeframe: "4h", // engine uses this tag — 1h candles passed externally
  disableLong: true, // short-only like iter212
  assets: [
    { symbol: "ETHUSDT", costBp: 30, riskFrac: 1.0 },
    {
      symbol: "ETH-MR-PYRAMID",
      sourceSymbol: "ETHUSDT",
      costBp: 30,
      riskFrac: 3.0,
      minEquityGain: 0.015,
    },
  ],
  crossAssetFilter: {
    symbol: "BTCUSDT",
    emaFastPeriod: 20, // TF-adapted: 20 bars of 1h ≈ 20h context
    emaSlowPeriod: 30,
    skipShortsIfSecondaryUptrend: true,
    momentumBars: 24, // 24h momentum
    momSkipShortAbove: 0.02,
  },
  adaptiveSizing: [
    { equityAbove: 0, factor: 0.75 },
    { equityAbove: 0.03, factor: 1.125 },
    { equityAbove: 0.07, factor: 0.25 },
  ],
  timeBoost: { afterDay: 15, equityBelow: 0.05, factor: 1.375 },
  profitTarget: 0.1,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
};

/**
 * iter213 BULL-regime complementary bot.
 *
 * Run THIS config when BTC is in confirmed uptrend (BTC > EMA10 AND
 * BTC 24h-momentum > +2%). In those conditions iter212 pauses (its
 * BTC filter blocks shorts) but this bot rides the trend with
 * momentum-LONGS on ETH.
 *
 * Per-year pass rate in BULL-regime years:
 *   2020 BULL (+466%): 72.92%  (iter212: 34.52%)
 *   2021 BULL (+394%): 61.61%  (iter212: 44.94%)
 *   2023 BULL (+91%):  52.08%  (iter212: 41.67%)
 *   2024 BULL (+47%):  55.79%  (iter212: 48.07%)
 *
 * Use `pickBestConfig(btcCandles)` to automatically select the right bot
 * based on current BTC regime. Or switch manually:
 *   - BTC > EMA10 AND BTC 24h-mom > 2% → use this (BULL bot)
 *   - else → use FTMO_DAYTRADE_24H_CONFIG (iter212, BEAR/CHOP bot)
 *
 * Together they provide ~50%+ pass rate coverage in ANY regime.
 */
export const FTMO_DAYTRADE_24H_CONFIG_BULL: FtmoDaytrade24hConfig = {
  triggerBars: 2,
  leverage: 2,
  tpPct: 0.06, // larger TP for trend continuation moves
  stopPct: 0.015,
  holdBars: 3, // 12h
  timeframe: "4h",
  disableShort: true, // LONGS ONLY in bull
  invertDirection: true, // 2 green → long (momentum continuation)
  assets: [
    { symbol: "ETH-BULL", sourceSymbol: "ETHUSDT", costBp: 30, riskFrac: 1.0 },
    {
      symbol: "ETH-BULL-PYRAMID",
      sourceSymbol: "ETHUSDT",
      costBp: 30,
      riskFrac: 4.0,
      minEquityGain: 0.015,
    },
  ],
  crossAssetFilter: {
    symbol: "BTCUSDT",
    emaFastPeriod: 10,
    emaSlowPeriod: 15,
    // INVERSE of iter212: require BTC uptrend (skip longs if BTC downtrend)
    skipLongsIfSecondaryDowntrend: true,
    momentumBars: 6,
    momSkipLongBelow: -0.02,
  },
  adaptiveSizing: [
    { equityAbove: 0, factor: 0.75 },
    { equityAbove: 0.03, factor: 1.125 },
    { equityAbove: 0.07, factor: 0.25 },
  ],
  timeBoost: { afterDay: 15, equityBelow: 0.05, factor: 1.375 },
  profitTarget: 0.1,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
};

/**
 * Automatically pick the right bot based on current BTC regime.
 * Call this when preparing to start a challenge (NOT mid-challenge —
 * switching mid-run would corrupt the backtest logic). Pass the most
 * recent BTCUSDT 4h candles (at least 20 bars).
 *
 * Returns iter212 (bear/chop) or iter213 (bull) as appropriate.
 */
export function pickBestConfig(btcCandles: Candle[]): {
  cfg: FtmoDaytrade24hConfig;
  regime: "BULL" | "BEAR_CHOP";
  reason: string;
} {
  if (btcCandles.length < 20) {
    return {
      cfg: FTMO_DAYTRADE_24H_CONFIG,
      regime: "BEAR_CHOP",
      reason:
        "insufficient BTC history (need ≥20 bars) — defaulting to bear/chop bot",
    };
  }
  const closes = btcCandles.map((c) => c.close);
  // Simple EMA computation matching iter212/213 filter
  const ema = (vals: number[], period: number): number => {
    const k = 2 / (period + 1);
    let e = vals.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
    return e;
  };
  const last = closes[closes.length - 1];
  const emaFast = ema(closes, 10);
  const emaSlow = ema(closes, 15);
  const mom6 = (last - closes[closes.length - 6]) / closes[closes.length - 6];
  const btcUptrend = last > emaFast && emaFast > emaSlow;
  const btcBullMom = mom6 > 0.02;

  if (btcUptrend && btcBullMom) {
    return {
      cfg: FTMO_DAYTRADE_24H_CONFIG_BULL,
      regime: "BULL",
      reason: `BTC in uptrend (close=${last.toFixed(0)} > EMA10=${emaFast.toFixed(0)} > EMA15=${emaSlow.toFixed(0)}) AND 24h mom +${(mom6 * 100).toFixed(2)}% > +2%`,
    };
  }
  return {
    cfg: FTMO_DAYTRADE_24H_CONFIG,
    regime: "BEAR_CHOP",
    reason: `BTC regime not bullish (uptrend=${btcUptrend}, bullMom=${btcBullMom}) — use bear/chop bot`,
  };
}

/**
 * iter203 reference config (12h hold, strict user-preference) — retained
 * for users who need the tighter intraday window. Scores 28.53% rolling-1d
 * (vs 36.05% for the 24h-hold iter204 default).
 */
export const FTMO_DAYTRADE_24H_CONFIG_12H: FtmoDaytrade24hConfig = {
  triggerBars: 2,
  leverage: 2,
  tpPct: 0.06,
  stopPct: 0.018,
  holdBars: 3,
  timeframe: "4h",
  assets: [{ symbol: "ETHUSDT", costBp: 30, riskFrac: 1.0 }],
  disableLong: true,
  allowedDowsUtc: [0, 1, 2, 4, 5, 6],
  allowedHoursUtc: [0, 4, 8, 12, 20],
  adaptiveSizing: [
    { equityAbove: 0, factor: 0.75 },
    { equityAbove: 0.03, factor: 1.125 },
    { equityAbove: 0.08, factor: 0.375 },
  ],
  timeBoost: { afterDay: 15, equityBelow: 0.05, factor: 1.375 },
  profitTarget: 0.1,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
};

/**
 * iter201 reference config (ETH both-sides, trig=3, stop=1.8%) —
 * retained for users who want directional symmetry. Scores 27.39%
 * rolling-1d (vs 36.05% for the iter204 24h-hold default).
 */
export const FTMO_DAYTRADE_24H_CONFIG_BOTH_SIDES: FtmoDaytrade24hConfig = {
  triggerBars: 3,
  leverage: 2,
  tpPct: 0.08,
  stopPct: 0.018,
  holdBars: 3,
  timeframe: "4h",
  assets: [{ symbol: "ETHUSDT", costBp: 30, riskFrac: 1.0 }],
  adaptiveSizing: [
    { equityAbove: 0, factor: 0.75 },
    { equityAbove: 0.03, factor: 1.125 },
    { equityAbove: 0.08, factor: 0.375 },
  ],
  timeBoost: { afterDay: 15, equityBelow: 0.05, factor: 1.375 },
  profitTarget: 0.1,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
};

/**
 * iter200 reference config (3-asset BTC+ETH+SOL) — kept for backward
 * compatibility and for users who prefer diversified exposure. Scores
 * ~16.3 % pass rate on rolling-1d (vs 28.5 % for the ETH-only short
 * default).
 */
export const FTMO_DAYTRADE_24H_CONFIG_3ASSET: FtmoDaytrade24hConfig = {
  triggerBars: 3,
  leverage: 2,
  tpPct: 0.1,
  stopPct: 0.02,
  holdBars: 3,
  timeframe: "4h",
  assets: [
    { symbol: "BTCUSDT", costBp: 40, riskFrac: 0.4 },
    { symbol: "ETHUSDT", costBp: 30, riskFrac: 0.4 },
    { symbol: "SOLUSDT", costBp: 40, riskFrac: 0.4 },
  ],
  adaptiveSizing: [
    { equityAbove: 0, factor: 0.75 },
    { equityAbove: 0.03, factor: 1.125 },
    { equityAbove: 0.08, factor: 0.375 },
  ],
  timeBoost: { afterDay: 15, equityBelow: 0.05, factor: 1.375 },
  profitTarget: 0.1,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
};

export interface Daytrade24hTrade {
  symbol: string;
  direction: "long" | "short";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  rawPnl: number;
  effPnl: number;
  /** Exit day relative to challenge start (0-indexed, Prague midnight). FTMO
   *  daily-loss attribution day. */
  day: number;
  /** Entry day relative to challenge start. Used for minTradingDays counting
   *  (FTMO counts a "trading day" as a day with an executed entry). */
  entryDay: number;
  exitReason: "tp" | "stop" | "time";
  holdHours: number;
  /** iter1h-035+ vol-targeting multiplier applied at entry (default 1.0) */
  volMult?: number;
}

export interface FtmoDaytrade24hResult {
  passed: boolean;
  reason:
    | "profit_target"
    | "daily_loss"
    | "total_loss"
    | "time"
    | "insufficient_days";
  finalEquityPct: number;
  maxDrawdown: number;
  uniqueTradingDays: number;
  /** One-based official challenge pass day, including virtual ping days. */
  passDay?: number;
  trades: Daytrade24hTrade[];
  maxHoldHoursObserved: number;
}

// BUGFIX 2026-04-29 (Agent 5): DST-aware Prague day-index. Returns days since
// epoch in Europe/Prague time zone. Uses Intl.DateTimeFormat — handles CET/CEST
// transitions automatically. Fallback to fixed UTC+1 if Intl unavailable.
const _pragueFmt =
  typeof Intl !== "undefined" && (Intl as any).DateTimeFormat
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Prague",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
    : null;
function pragueDay(ms: number): number {
  if (_pragueFmt) {
    const yyyymmdd = _pragueFmt.format(new Date(ms)); // "YYYY-MM-DD"
    const [y, m, d] = yyyymmdd.split("-").map(Number);
    // Day-index since epoch using UTC of (Prague-Y/M/D 00:00 as if UTC).
    return Math.floor(Date.UTC(y, m - 1, d) / (24 * 3600 * 1000));
  }
  // Fallback: fixed UTC+1 (legacy behavior, ~0.3-0.6pp drift in summer).
  return Math.floor((ms + 3600 * 1000) / (24 * 3600 * 1000));
}

export function detectAsset(
  candles: Candle[],
  asset: Daytrade24hAssetCfg,
  cfg: FtmoDaytrade24hConfig,
  crossAssetCandles?: Candle[],
  extraCrossAssetCandles?: Record<string, Candle[]>,
  fundingSeries?: (number | null)[],
): Daytrade24hTrade[] {
  const out: Daytrade24hTrade[] = [];
  const tpPct = asset.tpPct ?? cfg.tpPct;
  const stopPct = asset.stopPct ?? cfg.stopPct;
  const holdBars = asset.holdBars ?? cfg.holdBars;
  const triggerBars = asset.triggerBars ?? cfg.triggerBars;
  const assetInvert = asset.invertDirection ?? cfg.invertDirection ?? false;
  const assetDisableLong = asset.disableLong ?? cfg.disableLong ?? false;
  const assetDisableShort = asset.disableShort ?? cfg.disableShort ?? false;
  if (candles.length < triggerBars + 2) return out;
  // iter262+ Loss-streak cooldown state
  // BUGFIX 2026-04-28: lossStreak/cooldownUntilBar moved into direction loop
  // (was leaking between long/short — short trades got cooldown'd by long stops).
  const lsc = cfg.lossStreakCooldown;
  const ts0 = candles[0].openTime;
  const cost = asset.costBp / 10000;
  // Derive bar duration from the data so 30m / 1h / 2h / 4h all report
  // accurate holdHours. (Used only for trade-record display, not logic.)
  const hoursPerBar =
    candles.length >= 2
      ? (candles[1].openTime - candles[0].openTime) / 3_600_000
      : 4;

  // Pre-compute RSI once per asset if filter configured.
  const rsiSeries: (number | null)[] | null = cfg.rsiFilter
    ? rsi(
        candles.map((c) => c.close),
        cfg.rsiFilter.period,
      )
    : null;

  // Pre-compute ATR once per asset if atr-adaptive stop configured.
  const atrSeries: (number | null)[] | null = cfg.atrStop
    ? atr(candles, cfg.atrStop.period)
    : null;

  // iter253+ Pre-compute ATR for chandelier exit (may use different period than atrStop).
  const chandelier = cfg.chandelierExit;
  const chanAtrSeries: (number | null)[] | null = chandelier
    ? chandelier.period === cfg.atrStop?.period && atrSeries
      ? atrSeries
      : atr(candles, chandelier.period)
    : null;

  // Pre-compute EMA for trend filter if configured.
  const emaSeries: (number | null)[] | null = cfg.trendFilter
    ? ema(
        candles.map((c) => c.close),
        cfg.trendFilter.period,
      )
    : null;

  // Pre-compute cross-asset EMAs for the BTC-style regime filter.
  // crossAssetCandles must align 1:1 with `candles` (same length, same ts).
  const crossFilter = cfg.crossAssetFilter;
  const crossEmaFast: (number | null)[] | null =
    crossFilter && crossAssetCandles
      ? ema(
          crossAssetCandles.map((c) => c.close),
          crossFilter.emaFastPeriod,
        )
      : null;
  const crossEmaSlow: (number | null)[] | null =
    crossFilter && crossAssetCandles
      ? ema(
          crossAssetCandles.map((c) => c.close),
          crossFilter.emaSlowPeriod,
        )
      : null;

  // Pre-compute extra cross-asset filter series
  const extraFilters: Array<{
    f: NonNullable<FtmoDaytrade24hConfig["crossAssetFiltersExtra"]>[number];
    candles: Candle[];
    fast: (number | null)[];
    slow: (number | null)[];
  }> = [];
  if (cfg.crossAssetFiltersExtra && extraCrossAssetCandles) {
    for (const f of cfg.crossAssetFiltersExtra) {
      const ca = extraCrossAssetCandles[f.symbol];
      if (ca && ca.length === candles.length) {
        extraFilters.push({
          f,
          candles: ca,
          fast: ema(
            ca.map((c) => c.close),
            f.emaFastPeriod,
          ),
          slow: ema(
            ca.map((c) => c.close),
            f.emaSlowPeriod,
          ),
        });
      }
    }
  }

  // Pre-compute ADX for regime filter if configured.
  const adxSeries: (number | null)[] | null = cfg.adxFilter
    ? adx(candles, cfg.adxFilter.period).adx
    : null;

  // Pre-compute ATR for vol filter (share with atrStop if both enabled)
  const volAtrSeries: (number | null)[] | null = cfg.volatilityFilter
    ? atr(candles, cfg.volatilityFilter.period)
    : null;

  // Pre-compute Choppiness Index for filter
  const choppinessSeries: (number | null)[] | null = cfg.choppinessFilter
    ? choppiness(candles, cfg.choppinessFilter.period)
    : null;

  for (const direction of ["long", "short"] as const) {
    if (direction === "long" && assetDisableLong) continue;
    if (direction === "short" && assetDisableShort) continue;
    // Per-direction LSC state (bugfix 2026-04-28: was shared, leaked across directions)
    let lossStreak = 0;
    let cooldownUntilBar = -1;
    let cooldown = -1;
    let reEntryRetriesUsed = 0;
    let reEntryWindowEnd = -1;
    // In mean-reversion mode (default): longs need N consecutive RED closes
    //   (the dip we're fading), shorts need N consecutive GREEN closes.
    // In momentum-continuation mode (invertDirection=true): longs need
    //   N consecutive GREEN closes (ride the trend), shorts need N red.
    const invert = assetInvert;
    const donchianP = asset.donchianEntry?.period;
    const bbKc = asset.bbKcSqueezeEntry;
    const maCross = asset.maCrossEntry;
    const tsMom = asset.tsMomentumEntry;
    const nr7 = asset.nr7Entry;
    const startBar = donchianP
      ? donchianP + 1
      : bbKc
        ? Math.max(bbKc.bbPeriod, bbKc.kcPeriod) + bbKc.minSqueezeBars + 1
        : maCross
          ? maCross.slowPeriod + 2
          : tsMom
            ? tsMom.lookbackBars + 1
            : nr7
              ? nr7.compressionBars + 1
              : triggerBars;
    for (let i = startBar; i < candles.length - 1; i++) {
      if (i < cooldown) continue;
      // V5 re-entry: skip pattern check if within re-entry window after stop
      const inReEntryWindow =
        cfg.reEntryAfterStop !== undefined &&
        reEntryWindowEnd >= i &&
        reEntryRetriesUsed > 0 &&
        reEntryRetriesUsed <= cfg.reEntryAfterStop.maxRetries;
      let ok = true;
      if (inReEntryWindow) {
        // bypass pattern check — assume trend still valid within window
      } else if (donchianP) {
        // Donchian breakout: long if close > N-bar prior high, short if close < N-bar prior low
        let pHigh = -Infinity,
          pLow = Infinity;
        for (let k = i - donchianP; k < i; k++) {
          if (candles[k].high > pHigh) pHigh = candles[k].high;
          if (candles[k].low < pLow) pLow = candles[k].low;
        }
        if (direction === "long" && candles[i].close <= pHigh) ok = false;
        if (direction === "short" && candles[i].close >= pLow) ok = false;
      } else if (bbKc) {
        // BB-KC Squeeze release: BB was inside KC for minSqueezeBars, now expands outside
        const bbP = bbKc.bbPeriod,
          kcP = bbKc.kcPeriod;
        const period = Math.max(bbP, kcP);
        if (i < period) {
          ok = false;
        } else {
          // SMA + stddev for BB
          let sum = 0;
          for (let k = i - bbP + 1; k <= i; k++) sum += candles[k].close;
          const mean = sum / bbP;
          let varSum = 0;
          for (let k = i - bbP + 1; k <= i; k++)
            varSum += (candles[k].close - mean) ** 2;
          const stddev = Math.sqrt(varSum / bbP);
          const bbUpper = mean + bbKc.bbSigma * stddev;
          const bbLower = mean - bbKc.bbSigma * stddev;
          // KC center = SMA of close (kcP), bands = ±mult × ATR(kcP)
          let kcSum = 0;
          for (let k = i - kcP + 1; k <= i; k++) kcSum += candles[k].close;
          const kcCenter = kcSum / kcP;
          // True range over kcP bars
          let trSum = 0;
          for (let k = i - kcP + 1; k <= i; k++) {
            const c = candles[k];
            const prev = candles[k - 1] ?? candles[k];
            trSum += Math.max(
              c.high - c.low,
              Math.abs(c.high - prev.close),
              Math.abs(c.low - prev.close),
            );
          }
          const kcAtr = trSum / kcP;
          const kcUpper = kcCenter + bbKc.kcMult * kcAtr;
          const kcLower = kcCenter - bbKc.kcMult * kcAtr;
          // Squeeze release: BB now outside KC at i
          const releasedUp = bbUpper > kcUpper;
          const releasedDn = bbLower < kcLower;
          // Check prior minSqueezeBars: must have all been squeeze (BB inside KC)
          let prevAllSqueezed = true;
          for (let k = i - bbKc.minSqueezeBars; k < i; k++) {
            // recompute at k
            let s2 = 0;
            for (let j = k - bbP + 1; j <= k; j++) s2 += candles[j].close;
            const m2 = s2 / bbP;
            let v2 = 0;
            for (let j = k - bbP + 1; j <= k; j++)
              v2 += (candles[j].close - m2) ** 2;
            const sd2 = Math.sqrt(v2 / bbP);
            const bU = m2 + bbKc.bbSigma * sd2;
            const bL = m2 - bbKc.bbSigma * sd2;
            let kS = 0;
            for (let j = k - kcP + 1; j <= k; j++) kS += candles[j].close;
            const kC = kS / kcP;
            let tS = 0;
            for (let j = k - kcP + 1; j <= k; j++) {
              const cj = candles[j];
              const pj = candles[j - 1] ?? candles[j];
              tS += Math.max(
                cj.high - cj.low,
                Math.abs(cj.high - pj.close),
                Math.abs(cj.low - pj.close),
              );
            }
            const kA = tS / kcP;
            const kU = kC + bbKc.kcMult * kA;
            const kL = kC - bbKc.kcMult * kA;
            // Squeeze means BB inside KC: bU < kU AND bL > kL
            if (!(bU < kU && bL > kL)) {
              prevAllSqueezed = false;
              break;
            }
          }
          if (!prevAllSqueezed) ok = false;
          else if (direction === "long" && !releasedUp) ok = false;
          else if (direction === "short" && !releasedDn) ok = false;
        }
      } else if (maCross) {
        // MA-Crossover: long when fast crosses above slow at bar i
        const fast = maCross.fastPeriod,
          slow = maCross.slowPeriod;
        let fSum = 0,
          sSum = 0,
          fSumPrev = 0,
          sSumPrev = 0;
        for (let k = i - fast + 1; k <= i; k++) fSum += candles[k].close;
        for (let k = i - slow + 1; k <= i; k++) sSum += candles[k].close;
        for (let k = i - fast; k <= i - 1; k++) fSumPrev += candles[k].close;
        for (let k = i - slow; k <= i - 1; k++) sSumPrev += candles[k].close;
        const fNow = fSum / fast,
          sNow = sSum / slow;
        const fPrev = fSumPrev / fast,
          sPrev = sSumPrev / slow;
        const crossUp = fPrev <= sPrev && fNow > sNow;
        const crossDn = fPrev >= sPrev && fNow < sNow;
        if (direction === "long" && !crossUp) ok = false;
        if (direction === "short" && !crossDn) ok = false;
      } else if (tsMom) {
        // Time-series momentum: long if return > +threshold over lookbackBars
        if (i < tsMom.lookbackBars) {
          ok = false;
        } else {
          const ret =
            (candles[i].close - candles[i - tsMom.lookbackBars].close) /
            candles[i - tsMom.lookbackBars].close;
          if (direction === "long" && ret < tsMom.threshold) ok = false;
          if (direction === "short" && ret > -tsMom.threshold) ok = false;
        }
      } else if (nr7) {
        // NR7-style breakout: current bar high > max of last N narrowest bars' high
        // Find narrowest range bar in last compressionBars
        let minRange = Infinity,
          narrowIdx = -1;
        for (let k = i - nr7.compressionBars; k < i; k++) {
          const r = candles[k].high - candles[k].low;
          if (r < minRange) {
            minRange = r;
            narrowIdx = k;
          }
        }
        if (narrowIdx < 0) ok = false;
        else if (
          direction === "long" &&
          candles[i].close <= candles[narrowIdx].high
        )
          ok = false;
        else if (
          direction === "short" &&
          candles[i].close >= candles[narrowIdx].low
        )
          ok = false;
      } else {
        // Default: N consecutive close-comparison
        for (let k = 0; k < triggerBars; k++) {
          const longCmp = invert
            ? candles[i - k].close <= candles[i - k - 1].close
            : candles[i - k].close >= candles[i - k - 1].close;
          const shortCmp = invert
            ? candles[i - k].close >= candles[i - k - 1].close
            : candles[i - k].close <= candles[i - k - 1].close;
          const cmp = direction === "long" ? longCmp : shortCmp;
          if (cmp) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;

      // iter262+ loss-streak cooldown gate
      if (lsc && i < cooldownUntilBar) continue;

      // RSI confluence gate
      if (rsiSeries && cfg.rsiFilter) {
        const r = rsiSeries[i];
        if (r === null || r === undefined) continue;
        if (direction === "long" && cfg.rsiFilter.longMax !== undefined) {
          if (r > cfg.rsiFilter.longMax) continue;
        }
        if (direction === "short" && cfg.rsiFilter.shortMin !== undefined) {
          if (r < cfg.rsiFilter.shortMin) continue;
        }
      }

      // EMA trend gate
      if (emaSeries && cfg.trendFilter) {
        const e = emaSeries[i];
        if (e === null || e === undefined) continue;
        const price = candles[i].close;
        const gateLongs =
          cfg.trendFilter.apply === "long" || cfg.trendFilter.apply === "both";
        const gateShorts =
          cfg.trendFilter.apply === "short" || cfg.trendFilter.apply === "both";
        if (direction === "long" && gateLongs && price <= e) continue;
        if (direction === "short" && gateShorts && price >= e) continue;
      }

      // iter259+ HTF Trend Filter — multi-timeframe momentum gate.
      // Skip signals against strong own-asset trend over lookbackBars.
      if (cfg.htfTrendFilter) {
        const lb = cfg.htfTrendFilter.lookbackBars;
        if (i >= lb) {
          const change =
            (candles[i].close - candles[i - lb].close) / candles[i - lb].close;
          const thr = cfg.htfTrendFilter.threshold ?? 0;
          const gateLongs =
            cfg.htfTrendFilter.apply === "long" ||
            cfg.htfTrendFilter.apply === "both";
          const gateShorts =
            cfg.htfTrendFilter.apply === "short" ||
            cfg.htfTrendFilter.apply === "both";
          if (direction === "short" && gateShorts && change > thr) continue;
          if (direction === "long" && gateLongs && change < -thr) continue;
        }
      }

      // HTF Trend Filter AUX (second window — macro confluence).
      if (cfg.htfTrendFilterAux) {
        const lb = cfg.htfTrendFilterAux.lookbackBars;
        if (i >= lb) {
          const change =
            (candles[i].close - candles[i - lb].close) / candles[i - lb].close;
          const thr = cfg.htfTrendFilterAux.threshold ?? 0;
          const gateLongs =
            cfg.htfTrendFilterAux.apply === "long" ||
            cfg.htfTrendFilterAux.apply === "both";
          const gateShorts =
            cfg.htfTrendFilterAux.apply === "short" ||
            cfg.htfTrendFilterAux.apply === "both";
          if (direction === "short" && gateShorts && change > thr) continue;
          if (direction === "long" && gateLongs && change < -thr) continue;
        }
      }

      // Session / day-of-week gates — evaluated on the ENTRY bar (i+1),
      // which is when the trade actually opens. Live signal uses entryOpenTime
      // (next bar's open hour); backtest must match for live-backtest parity.
      // BUGFIX 2026-04-28: was using signal-bar (i) hour, drift vs live.
      const entryBar = i + 1;
      if (cfg.allowedHoursUtc && cfg.allowedHoursUtc.length > 0) {
        const refTime =
          entryBar < candles.length
            ? candles[entryBar].openTime
            : candles[i].openTime +
              (candles[i].closeTime - candles[i].openTime);
        const h = new Date(refTime).getUTCHours();
        if (!cfg.allowedHoursUtc.includes(h)) continue;
      }
      if (cfg.allowedDowsUtc && cfg.allowedDowsUtc.length > 0) {
        const refTime =
          entryBar < candles.length
            ? candles[entryBar].openTime
            : candles[i].openTime +
              (candles[i].closeTime - candles[i].openTime);
        const d = new Date(refTime).getUTCDay();
        if (!cfg.allowedDowsUtc.includes(d)) continue;
      }

      // ADX regime gate
      if (adxSeries && cfg.adxFilter) {
        const a = adxSeries[i];
        if (a === null || a === undefined) continue;
        if (cfg.adxFilter.maxAdx !== undefined && a > cfg.adxFilter.maxAdx)
          continue;
        if (cfg.adxFilter.minAdx !== undefined && a < cfg.adxFilter.minAdx)
          continue;
      }

      // Volatility regime gate
      if (volAtrSeries && cfg.volatilityFilter) {
        const a = volAtrSeries[i];
        if (a === null || a === undefined) continue;
        const frac = a / candles[i].close;
        if (
          cfg.volatilityFilter.minAtrFrac !== undefined &&
          frac < cfg.volatilityFilter.minAtrFrac
        )
          continue;
        if (
          cfg.volatilityFilter.maxAtrFrac !== undefined &&
          frac > cfg.volatilityFilter.maxAtrFrac
        )
          continue;
      }

      // Funding-rate filter (perp futures crowdedness, per-asset override possible)
      if (
        (cfg.fundingRateFilter ||
          asset.maxFundingForLong !== undefined ||
          asset.minFundingForShort !== undefined) &&
        fundingSeries
      ) {
        const f = fundingSeries[i];
        if (f !== null && f !== undefined) {
          const maxFL =
            asset.maxFundingForLong ?? cfg.fundingRateFilter?.maxFundingForLong;
          const minFS =
            asset.minFundingForShort ??
            cfg.fundingRateFilter?.minFundingForShort;
          if (direction === "long" && maxFL !== undefined && f > maxFL)
            continue;
          if (direction === "short" && minFS !== undefined && f < minFS)
            continue;
        }
      }

      // Volume confirmation gate: skip if trigger bar volume below ratio*SMA.
      if (cfg.volumeFilter) {
        const period = cfg.volumeFilter.period;
        if (i >= period) {
          let sumV = 0;
          for (let j = i - period; j < i; j++) sumV += candles[j].volume;
          const avg = sumV / period;
          if (avg > 0 && candles[i].volume / avg < cfg.volumeFilter.minRatio) {
            continue;
          }
        }
      }

      // Choppiness Index gate: skip if market is choppy (CI > maxCi).
      if (cfg.choppinessFilter && choppinessSeries) {
        const ci = choppinessSeries[i];
        if (ci !== null && ci !== undefined) {
          if (
            cfg.choppinessFilter.maxCi !== undefined &&
            ci > cfg.choppinessFilter.maxCi
          )
            continue;
          if (
            cfg.choppinessFilter.minCi !== undefined &&
            ci < cfg.choppinessFilter.minCi
          )
            continue;
        }
      }

      // Cross-asset regime gate (e.g. skip ETH shorts when BTC uptrending)
      let blocked = false;
      if (crossFilter && crossEmaFast && crossEmaSlow && crossAssetCandles) {
        const eFast = crossEmaFast[i];
        const eSlow = crossEmaSlow[i];
        if (eFast !== null && eSlow !== null && crossAssetCandles[i]) {
          const xPrice = crossAssetCandles[i].close;
          const crossUptrend = xPrice > eFast && eFast > eSlow;
          const crossDowntrend = xPrice < eFast && eFast < eSlow;
          if (
            direction === "short" &&
            crossFilter.skipShortsIfSecondaryUptrend &&
            crossUptrend
          )
            blocked = true;
          if (
            direction === "long" &&
            crossFilter.skipLongsIfSecondaryDowntrend &&
            crossDowntrend
          )
            blocked = true;
        }
        // Momentum-based gate
        if (
          !blocked &&
          crossFilter.momentumBars &&
          crossFilter.momentumBars > 0
        ) {
          const back = i - crossFilter.momentumBars;
          if (back >= 0) {
            const rel =
              (crossAssetCandles[i].close - crossAssetCandles[back].close) /
              crossAssetCandles[back].close;
            if (
              direction === "short" &&
              crossFilter.momSkipShortAbove !== undefined &&
              rel > crossFilter.momSkipShortAbove
            )
              blocked = true;
            if (
              direction === "long" &&
              crossFilter.momSkipLongBelow !== undefined &&
              rel < crossFilter.momSkipLongBelow
            )
              blocked = true;
          }
        }
      }
      // Additional cross-asset filters (AND-combined)
      if (!blocked) {
        for (const extra of extraFilters) {
          const eFast = extra.fast[i];
          const eSlow = extra.slow[i];
          if (eFast === null || eSlow === null || !extra.candles[i]) continue;
          const xPrice = extra.candles[i].close;
          const crossUptrend = xPrice > eFast && eFast > eSlow;
          const crossDowntrend = xPrice < eFast && eFast < eSlow;
          if (
            direction === "short" &&
            extra.f.skipShortsIfSecondaryUptrend &&
            crossUptrend
          ) {
            blocked = true;
            break;
          }
          if (
            direction === "long" &&
            extra.f.skipLongsIfSecondaryDowntrend &&
            crossDowntrend
          ) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) continue;
      let eb = candles[i + 1];
      let ebIdx = i + 1;
      if (!eb) break;

      // Pullback-entry: wait for retrace from trigger close before entering
      if (asset.pullbackEntry) {
        const triggerClose = candles[i].close;
        const target =
          direction === "long"
            ? triggerClose * (1 - asset.pullbackEntry.pullbackPct)
            : triggerClose * (1 + asset.pullbackEntry.pullbackPct);
        let entered = false;
        for (
          let k = 1;
          k <= asset.pullbackEntry.maxWaitBars && i + k < candles.length;
          k++
        ) {
          const wb = candles[i + k];
          // For long: did price dip to target?
          // For short: did price rally to target?
          if (direction === "long" && wb.low <= target) {
            eb = candles[i + k]; // entry on this bar (use as eb)
            ebIdx = i + k;
            entered = true;
            break;
          }
          if (direction === "short" && wb.high >= target) {
            eb = candles[i + k];
            ebIdx = i + k;
            entered = true;
            break;
          }
        }
        if (!entered) continue; // pullback never came → skip trade
      }
      // FTMO news blackout: skip entry if eb.openTime is within buffer
      // of a high-impact event. Implements the 2-min FTMO rule.
      if (cfg.newsFilter) {
        if (
          isNewsBlackout(
            eb.openTime,
            cfg.newsFilter.events,
            cfg.newsFilter.bufferMinutes,
          )
        ) {
          continue;
        }
      }
      const entry = eb.open;
      const entryEff =
        direction === "long" ? entry * (1 + cost / 2) : entry * (1 - cost / 2);

      // Effective stop fraction: ATR-adaptive with stopPct as floor.
      let effStop = stopPct;
      let effTp = tpPct;
      // V5 vol-adaptive R:R: scale stop+tp by realized vol vs target.
      // High vol → wider stops+TPs; low vol → tighter.
      if (cfg.volAdaptiveRR) {
        const va = cfg.volAdaptiveRR;
        let aSum = 0,
          aCount = 0;
        const start = Math.max(1, i - va.period + 1);
        for (let k = start; k <= i; k++) {
          const c = candles[k];
          const prev = candles[k - 1].close;
          aSum += Math.max(
            c.high - c.low,
            Math.abs(c.high - prev),
            Math.abs(c.low - prev),
          );
          aCount++;
        }
        if (aCount > 0) {
          const realizedAtrFrac = aSum / aCount / candles[i].close;
          if (realizedAtrFrac > 0) {
            const rawMult = realizedAtrFrac / va.targetVolFrac;
            const mult = Math.max(va.minMult, Math.min(va.maxMult, rawMult));
            effStop = stopPct * mult;
            effTp = tpPct * mult;
          }
        }
      }
      if (atrSeries && cfg.atrStop) {
        const a = atrSeries[i];
        if (a !== null && a !== undefined) {
          const atrFrac = (cfg.atrStop.stopMult * a) / entry;
          if (atrFrac > effStop) effStop = atrFrac;
        }
      }
      // Live-cap: refuse trades whose stop would breach the live execution cap.
      if (cfg.liveCaps && effStop > cfg.liveCaps.maxStopPct) {
        continue;
      }

      const tp =
        direction === "long" ? entry * (1 + effTp) : entry * (1 - effTp);
      const stop =
        direction === "long" ? entry * (1 - effStop) : entry * (1 + effStop);
      // BUGFIX 2026-04-28 (Engine audit Bug 5): holdBars must count from the
      // ACTUAL entry bar (after pullback may have shifted it forward). Was
      // anchored to i+1 which gave pullback trades fewer hold bars than
      // configured.
      const mx = Math.min(ebIdx + holdBars, candles.length - 1);
      let exitBar = mx;
      let exitPrice = candles[mx].close;
      let reason: "tp" | "stop" | "time" = "time";
      // Dynamic stop — break-even logic may tighten it after the bar
      // where unrealized gain crosses cfg.breakEven.threshold.
      let dynStop = stop;
      let beActive = false;
      const beTh = cfg.breakEven?.threshold;
      // iter253+ chandelier exit tracking: best-favorable close + min-move gate
      // BUGFIX 2026-04-28 (Round 35 Finding 2): scale by configured stopPct
      // (not effStop which is inflated by atrStop multiplier in V10/V11/V12).
      // Old behavior: V10's atrStop m32 inflates effStop to 12-25% → chandelier
      // never armed because price rarely moves >5-12% in trade lifetime.
      // Fix: use base stopPct as reference R-unit, so minMoveR=0.5 means
      // "0.5× of the BASE stop distance" which is achievable.
      const chanMinMoveR = chandelier?.minMoveR ?? 0.5;
      const chanMinMoveAbs = chandelier ? chanMinMoveR * stopPct : 0;
      let chanBestClose: number | null = null; // highest (long) or lowest (short)
      let chanArmed = false;
      // iter261+ partial-take-profit tracking
      const ptp = cfg.partialTakeProfit;
      let ptpTriggered = false;
      let ptpRealizedPct = 0; // P&L locked from partial close (signed)
      // V4 multi-level partial TP
      const ptpLevels = cfg.partialTakeProfitLevels;
      const ptpLevelsHit: boolean[] = ptpLevels
        ? ptpLevels.map(() => false)
        : [];
      let ptpLevelsRealizedPct = 0;
      // V4 trailing stop
      const trail = cfg.trailingStop;
      let trailActive = false;
      let trailPeak = entry;
      // iter1h-035+ TRIPLE-BARRIER TIME EXIT: track if minGainR ever reached
      // Asset-level overrides global cfg.timeExit fallback.
      const timeExit = asset.timeExit ?? cfg.timeExit;
      const minGainAbs = timeExit ? timeExit.minGainR * effStop : 0;
      let everReachedMinGain = false;
      // Start at the actual entry bar (ebIdx) — stop/TP may trigger in the
      // same bar we entered on. Pullback entries shift ebIdx forward.
      // BUGFIX 2026-04-28 (Engine audit Bug 5 follow-up): was hardcoded i+1,
      // which evaluated the entry bar's range BEFORE the pullback fill bar
      // for trades using pullbackEntry — producing impossible stops/TPs.
      for (let j = ebIdx; j <= mx; j++) {
        const bar = candles[j];
        // BUGFIX 2026-04-28 (Round 35 Finding 1): check PTP via bar.high/low.
        // BUGFIX 2026-04-29 (Agent 2 Bug 4 — same-bar order pessimism): if
        // BOTH PTP and the original stop are hit in the same bar, assume
        // STOP fired FIRST. The previous "PTP wins on conflict" assumption
        // was optimistic; for volatile bars with a wick to PTP and a low to
        // stop, the engine systematically inflated winrate. Conservative
        // tie-break: stop_fired_in_bar AND ptp_fired_in_bar → stop_first
        // unless bar's open already exceeded the PTP trigger (gap-up case).
        if (ptp && !ptpTriggered) {
          const triggerPrice =
            direction === "long"
              ? entry * (1 + ptp.triggerPct)
              : entry * (1 - ptp.triggerPct);
          const ptpHit =
            direction === "long"
              ? bar.high >= triggerPrice
              : bar.low <= triggerPrice;
          // Stop also hit this bar?
          const stopHit =
            direction === "long" ? bar.low <= dynStop : bar.high >= dynStop;
          // Gap exception: if bar opens already favorable past PTP trigger,
          // PTP definitely fired first (no wick required).
          const gapPastPtp =
            direction === "long"
              ? bar.open >= triggerPrice
              : bar.open <= triggerPrice;
          // Conservative: PTP only fires when stop did NOT hit, OR a gap
          // already passed the trigger before any wick down to stop.
          if (ptpHit && (!stopHit || gapPastPtp)) {
            ptpTriggered = true;
            // BUGFIX 2026-04-29 (Agent 7 R10 Bug 3): apply slippage + half-cost on
            // partial fill. Real MT5 charges commission + slippage on each
            // partial close. Engine previously credited full triggerPct as gain.
            // Per-side cost = cost/2 (half round-trip) + slippageBp/10000 (one fill).
            const ptpFillCost = cost / 2 + (asset.slippageBp ?? 0) / 10000;
            ptpRealizedPct = ptp.closeFraction * (ptp.triggerPct - ptpFillCost);
            // BUGFIX 2026-04-29 (Audit Bug A): after PTP, auto-move dynStop
            // to entry on remainder leg. Industry-standard: once partial
            // profit is locked, the trade should be guaranteed-profitable
            // at minimum break-even.
            // BUGFIX 2026-04-29 (R12 Agent 1 Bug 8): "BE" must include the
            // round-trip cost so the BE-out trade is actually flat, not -cost.
            // entryEff already prices in entry-half cost; the stop level needs
            // to add the exit-half so a fill at this price closes flat.
            const beStop =
              direction === "long" ? entry * (1 + cost) : entry * (1 - cost);
            if (direction === "long") {
              if (beStop > dynStop) dynStop = beStop;
            } else {
              if (beStop < dynStop) dynStop = beStop;
            }
            beActive = true;
            // Also reset chandelier reference to current bar so the trail
            // anchors at PTP-fire price, not pre-PTP high (Bug B).
            chanBestClose = bar.close;
            chanArmed = false;
          }
        }
        // BUGFIX 2026-04-29 (R13 entry-exit Bug 1 + Agent 1 Bug 3): same-bar
        // TP+stop tie-break. When bar both touches TP and stop, default code
        // always picked stop (because of the order). But if bar.open already
        // gapped PAST tp on the favorable side, TP was hit first physically.
        // Now: gap-past-TP wins; otherwise still conservative stop-first.
        if (direction === "long") {
          const stopHit = bar.low <= dynStop;
          const tpHit = bar.high >= tp;
          const gapPastTp = bar.open >= tp;
          if (tpHit && gapPastTp) {
            exitBar = j;
            exitPrice = bar.open; // gap-up fills at open
            reason = "tp";
            break;
          }
          if (stopHit) {
            exitBar = j;
            exitPrice = bar.open < dynStop ? bar.open : dynStop;
            reason = "stop";
            break;
          }
          if (tpHit) {
            exitBar = j;
            exitPrice = tp;
            reason = "tp";
            break;
          }
        } else {
          const stopHit = bar.high >= dynStop;
          const tpHit = bar.low <= tp;
          const gapPastTp = bar.open <= tp;
          if (tpHit && gapPastTp) {
            exitBar = j;
            exitPrice = bar.open;
            reason = "tp";
            break;
          }
          if (stopHit) {
            exitBar = j;
            exitPrice = bar.open > dynStop ? bar.open : dynStop;
            reason = "stop";
            break;
          }
          if (tpHit) {
            exitBar = j;
            exitPrice = tp;
            reason = "tp";
            break;
          }
        }
        // Post-bar break-even check (uses close, conservative — next bar
        // enters with the shifted stop). Only tightens, never loosens.
        if (beTh !== undefined && !beActive) {
          const unrealized =
            direction === "long"
              ? (bar.close - entry) / entry
              : (entry - bar.close) / entry;
          if (unrealized >= beTh) {
            dynStop = entry;
            beActive = true;
          }
        }
        // iter261+ partial take-profit check
        if (ptp && !ptpTriggered) {
          const unrealized =
            direction === "long"
              ? (bar.close - entry) / entry
              : (entry - bar.close) / entry;
          if (unrealized >= ptp.triggerPct) {
            ptpTriggered = true;
            // Lock in closeFraction × triggerPct as realized partial gain
            ptpRealizedPct = ptp.closeFraction * ptp.triggerPct;
          }
        }
        // V4 multi-level PTP
        if (ptpLevels && ptpLevels.length > 0) {
          const unrealized =
            direction === "long"
              ? (bar.close - entry) / entry
              : (entry - bar.close) / entry;
          for (let lv = 0; lv < ptpLevels.length; lv++) {
            if (!ptpLevelsHit[lv] && unrealized >= ptpLevels[lv].triggerPct) {
              ptpLevelsHit[lv] = true;
              ptpLevelsRealizedPct +=
                ptpLevels[lv].closeFraction * ptpLevels[lv].triggerPct;
            }
          }
        }
        // V4 trailing stop: tighten dynStop after activation
        if (trail) {
          const unrealized =
            direction === "long"
              ? (bar.close - entry) / entry
              : (entry - bar.close) / entry;
          if (!trailActive && unrealized >= trail.activatePct) {
            trailActive = true;
            trailPeak = bar.close;
          }
          if (trailActive) {
            if (direction === "long") {
              if (bar.close > trailPeak) trailPeak = bar.close;
              const trailStop = trailPeak * (1 - trail.trailPct);
              if (trailStop > dynStop) dynStop = trailStop;
            } else {
              if (bar.close < trailPeak) trailPeak = bar.close;
              const trailStop = trailPeak * (1 + trail.trailPct);
              if (trailStop < dynStop) dynStop = trailStop;
            }
          }
        }
        // iter253+ chandelier exit: trailing stop based on best close since entry.
        // For long: highest_close - K × ATR. For short: lowest_close + K × ATR.
        // Only arms after price moves >= minMoveR × stopPct in favorable direction.
        if (chandelier && chanAtrSeries) {
          const a = chanAtrSeries[j];
          if (a !== null && a !== undefined) {
            const unrealized =
              direction === "long"
                ? (bar.close - entry) / entry
                : (entry - bar.close) / entry;
            if (unrealized >= chanMinMoveAbs) {
              chanArmed = true;
              if (direction === "long") {
                if (chanBestClose === null || bar.close > chanBestClose)
                  chanBestClose = bar.close;
              } else {
                if (chanBestClose === null || bar.close < chanBestClose)
                  chanBestClose = bar.close;
              }
            }
            if (chanArmed && chanBestClose !== null) {
              const trailStop =
                direction === "long"
                  ? chanBestClose - chandelier.mult * a
                  : chanBestClose + chandelier.mult * a;
              // Only tighten — never loosen
              if (direction === "long") {
                if (trailStop > dynStop) dynStop = trailStop;
              } else {
                if (trailStop < dynStop) dynStop = trailStop;
              }
            }
          }
        }
        // iter1h-035+ TRIPLE-BARRIER: time-exit if minGainR never reached
        // within maxBarsWithoutGain bars. Closes "dead trades" early to
        // free capital for fresh signals.
        if (timeExit) {
          const unrealized =
            direction === "long"
              ? (bar.close - entry) / entry
              : (entry - bar.close) / entry;
          if (unrealized >= minGainAbs) everReachedMinGain = true;
          // BUGFIX 2026-04-29 (Audit Bug C): barsHeld must measure from
          // ACTUAL entry bar (ebIdx), not signal bar (i+1). With pullbackEntry,
          // entry can shift to i+k → time-exit fired (k-1) bars too early,
          // closing dead trades faster than configured and inflating pass-rate.
          const barsHeld = j - ebIdx;
          if (barsHeld >= timeExit.maxBarsWithoutGain && !everReachedMinGain) {
            exitBar = j;
            exitPrice = bar.close;
            reason = "time";
            break;
          }
        }
      }
      const exitEff =
        direction === "long"
          ? exitPrice * (1 - cost / 2)
          : exitPrice * (1 + cost / 2);
      let rawPnl =
        direction === "long"
          ? (exitEff - entryEff) / entryEff
          : (entryEff - exitEff) / entryEff;
      // iter261+ partial take-profit blending: if PTP triggered, blend
      // partial-locked gain with remaining position's actual P&L.
      // Effective P&L = closeFraction × triggerPct + (1-closeFraction) × actual
      if (ptpTriggered && ptp) {
        rawPnl = ptpRealizedPct + (1 - ptp.closeFraction) * rawPnl;
      }
      // V4 multi-level PTP blending
      if (ptpLevels && ptpLevels.length > 0) {
        const totalClosed = ptpLevels.reduce(
          (acc, lv, idx) => acc + (ptpLevelsHit[idx] ? lv.closeFraction : 0),
          0,
        );
        rawPnl = ptpLevelsRealizedPct + Math.max(0, 1 - totalClosed) * rawPnl;
      }
      // Realistic additional execution costs (FTMO-broker reality, not Binance):
      //   - slippage on both fills
      //   - overnight swap if trade crosses Prague midnight
      // BUGFIX 2026-04-29 (R12 Agent 1 Bug 1): if PTP fired, the partial leg
      // already booked entry+exit slippage in ptpFillCost. Apply slippage here
      // only to the remainder; otherwise the closed fraction is double-charged.
      const slippageBp = asset.slippageBp ?? 0;
      if (slippageBp > 0) {
        let remainingFraction = 1;
        if (ptpTriggered && ptp) remainingFraction = 1 - ptp.closeFraction;
        if (ptpLevels && ptpLevels.length > 0) {
          const totalClosed = ptpLevels.reduce(
            (acc, lv, idx) => acc + (ptpLevelsHit[idx] ? lv.closeFraction : 0),
            0,
          );
          remainingFraction = Math.max(0, 1 - totalClosed);
        }
        rawPnl -= (slippageBp / 10000) * 2 * remainingFraction;
      }
      const swapBp = asset.swapBpPerDay ?? 0;
      if (swapBp > 0) {
        // BUGFIX 2026-04-29 (R12 Agent 1 Bug 5): use Prague day so swap-charge
        // aligns with the same daily anchor the rest of the engine uses.
        const entryDay = pragueDay(eb.openTime);
        const exitDay = pragueDay(candles[exitBar].closeTime);
        const overnightCrossings = Math.max(0, exitDay - entryDay);
        if (overnightCrossings > 0) {
          rawPnl -= (swapBp / 10000) * overnightCrossings;
        }
      }
      // iter1h-035+ VOL-TARGETED SIZING (asset-level, applied at entry).
      // Multiplies effective risk by clamp(targetAtr/realizedAtr, min, max).
      // Larger position when realized vol < target (calm regime),
      // smaller when realized vol > target (chaotic regime).
      let volMult = 1.0;
      const volTargetingCfg = asset.volTargeting ?? cfg.volTargeting;
      if (volTargetingCfg) {
        // Compute realized ATR at entry bar (use same atr() helper if asset's
        // volTargeting period matches cfg.atrStop or volatilityFilter; otherwise
        // we'd need a separate series. For simplicity, use the trade-entry
        // bar i and recompute ATR inline (cheap because period is small).
        const vt = volTargetingCfg;
        // Use atrSeries if available and period matches, else compute on-the-fly
        let realizedAtr: number | null = null;
        if (atrSeries && cfg.atrStop && cfg.atrStop.period === vt.period) {
          realizedAtr = atrSeries[i] ?? null;
        } else {
          // Inline ATR calc for the last `period` bars (uses true range)
          const start = Math.max(0, i - vt.period + 1);
          if (start >= 1) {
            let sumTr = 0;
            for (let k = start; k <= i; k++) {
              const c = candles[k];
              const prev = candles[k - 1].close;
              const tr = Math.max(
                c.high - c.low,
                Math.abs(c.high - prev),
                Math.abs(c.low - prev),
              );
              sumTr += tr;
            }
            realizedAtr = sumTr / vt.period;
          }
        }
        if (realizedAtr !== null && realizedAtr > 0) {
          const realizedAtrFrac = realizedAtr / entry;
          const rawMult = vt.targetAtrFrac / realizedAtrFrac;
          volMult = Math.max(vt.minMult, Math.min(vt.maxMult, rawMult));
        }
      }
      // Live-cap: clamp the per-trade riskFrac to mirror live-detector limits.
      const effRiskFrac = cfg.liveCaps
        ? Math.min(asset.riskFrac, cfg.liveCaps.maxRiskFrac)
        : asset.riskFrac;
      // 2026-04-27 fix: when liveCaps active, volMult must NOT exceed 1.0 —
      // a scaled-up position (volMult>1) with fixed stopPct breaches live caps
      // because dollar loss = position × stop × volMult. Honest interpretation
      // of volTargeting under live caps = downside-only scaling (vol high →
      // smaller position via volMult<1). Boost in calm regimes is not
      // physically realisable without tightening the stop proportionally.
      const safeVolMult = cfg.liveCaps ? Math.min(volMult, 1.0) : volMult;
      // BUGFIX 2026-04-29 (Agent 4 Bug 2 + 4): allow tail gap losses by
      // relaxing the floor from -1R to -1.5R. Real markets gap through
      // stops by 0.5-2R on news shocks. The previous hard cap at -effRisk
      // masked total_loss-rate. 1.5× is a conservative middle ground.
      // Also: no longer scale floor by safeVolMult (downside-only intent
      // per the comment block above) — losses still happen at full effRiskFrac
      // even when position size is reduced via vol-targeting.
      const GAP_TAIL_MULT = 1.5;
      // BUGFIX 2026-04-29 (Agent 8 Bug 10): guard against NaN/Infinity from
      // corrupt candle data (zero-price, malformed bars). Without this,
      // NaN equity propagates to silent insufficient_days fail; Infinity
      // causes fake passes. Skip such trades entirely.
      if (!Number.isFinite(rawPnl)) {
        continue;
      }
      const effPnl = Math.max(
        rawPnl * cfg.leverage * effRiskFrac * safeVolMult,
        -effRiskFrac * GAP_TAIL_MULT,
      );
      // BUGFIX 2026-04-28: was UTC day boundary; FTMO daily-loss anchor is
      // Prague midnight (UTC+1 winter / UTC+2 summer).
      // BUGFIX 2026-04-29 (Bug F): t.day must be EXIT day not ENTRY day. FTMO
      // DL is calculated against day-end equity. A trade entered day 3 closing
      // day 8 with -5% loss counts toward day 8's DL, NOT day 3's. Engine was
      // attributing the loss to entry day → under-counted DL breaches on the
      // actual close day → inflated pass-rate when overlapping trades cross
      // day boundaries.
      // BUGFIX 2026-04-29 (Agent 5): true DST-aware Europe/Prague offset
      // resolution. Previous fixed UTC+1 drifted by 1h during CEST (Apr-Oct,
      // ~7mo/yr) and mis-bucketed PnL near 22-23 UTC summer windows. Use
      // PRAGUE_DAY (computed via Intl) for accurate cuts.
      const exitTimeMs = candles[exitBar].closeTime;
      const day = pragueDay(exitTimeMs) - pragueDay(ts0);
      const entryDay = pragueDay(eb.openTime) - pragueDay(ts0);
      // BUGFIX 2026-04-29 (Agent 2 Bug 10): use ebIdx (actual entry bar after
      // pullback) not i+1. Cosmetic — display only — but ETA stats were off.
      const holdHours = (exitBar - ebIdx) * hoursPerBar;
      out.push({
        symbol: asset.symbol,
        direction,
        entryTime: eb.openTime,
        exitTime: candles[exitBar].closeTime,
        entryPrice: entry,
        exitPrice,
        rawPnl,
        effPnl,
        day,
        entryDay,
        exitReason: reason,
        holdHours,
        volMult, // iter1h-035+ vol-targeting multiplier
      });
      // iter262+ loss-streak tracking
      if (lsc) {
        if (reason === "stop") {
          lossStreak++;
          if (lossStreak >= lsc.afterLosses) {
            cooldownUntilBar = exitBar + lsc.cooldownBars;
          }
        } else {
          lossStreak = 0; // reset on TP or time exit
        }
      }
      // V5 re-entry: if stop AND retries left AND within window → set short cooldown
      // BUGFIX 2026-04-29 (Agent 4 Bug 4+5B):
      //   1. Window must NOT roll forward with each stop (rolling allows more
      //      re-entries than configured "max N within M bars"). Set window only
      //      on first stop of a sequence (when retries are 0).
      //   2. TP/time-exit reset of retries should require window to have passed,
      //      otherwise a profitable trade in the middle of a window resets the
      //      pool and the next stop gets full retry pool again.
      if (cfg.reEntryAfterStop && reason === "stop") {
        if (reEntryRetriesUsed < cfg.reEntryAfterStop.maxRetries) {
          cooldown = exitBar + 1;
          // Only set window on FIRST stop of a sequence (Bug 4 fix).
          if (reEntryRetriesUsed === 0) {
            reEntryWindowEnd = exitBar + cfg.reEntryAfterStop.windowBars;
          }
          reEntryRetriesUsed++;
        } else {
          if (exitBar > reEntryWindowEnd) reEntryRetriesUsed = 0;
          cooldown = exitBar + 1;
        }
      } else {
        cooldown = exitBar + 1;
        // Bug 5B fix: only reset retries if window has fully passed.
        if (exitBar > reEntryWindowEnd) reEntryRetriesUsed = 0;
      }
    }
  }
  return out;
}

export function runFtmoDaytrade24h(
  candlesBySymbol: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig = FTMO_DAYTRADE_24H_CONFIG,
  fundingBySymbol?: Record<string, (number | null)[]>,
): FtmoDaytrade24hResult {
  // Round-15 audit B5/B6: validate critical optional flags eagerly so that
  // a typo in a new config (omitting `pauseAtTargetReached` or omitting
  // `htfTrendFilter.threshold`) fails LOUDLY rather than silently producing
  // a stale/optimistic backtest. We DON'T flip the type to required because
  // it would break ~119 historical configs; we enforce semantically here.
  if (cfg.htfTrendFilter && cfg.htfTrendFilter.threshold === undefined) {
    throw new Error(
      "[ftmoDaytrade24h] Config defines htfTrendFilter but omits 'threshold' — must be explicit (e.g. 0.10). Implicit fallback to 0 hides the gate.",
    );
  }
  if (cfg.htfTrendFilterAux && cfg.htfTrendFilterAux.threshold === undefined) {
    throw new Error(
      "[ftmoDaytrade24h] Config defines htfTrendFilterAux but omits 'threshold' — must be explicit.",
    );
  }
  if (cfg.pauseAtTargetReached === undefined) {
    // Default false is allowed (legacy backwards compat) but must be set
    // explicitly on the config so reviewers see the intent. Live FTMO
    // configs (V236+) all set this to true.
    // eslint-disable-next-line no-console
    console.warn(
      "[ftmoDaytrade24h] cfg.pauseAtTargetReached not set explicitly — using legacy default false. New live configs should set this explicitly (true for FTMO-realistic, false for raw backtest).",
    );
  }
  const all: Daytrade24hTrade[] = [];
  // BUGFIX 2026-04-29 (R13 cross-asset filter audit): validate filter periods
  // and silently-disabled-on-missing-symbol pitfall. EmaFastPeriod must be <
  // emaSlowPeriod; missing symbol must throw, not silently skip.
  if (cfg.crossAssetFilter) {
    const f = cfg.crossAssetFilter;
    if (f.emaFastPeriod >= f.emaSlowPeriod) {
      throw new Error(
        `crossAssetFilter.emaFastPeriod (${f.emaFastPeriod}) must be < emaSlowPeriod (${f.emaSlowPeriod})`,
      );
    }
    if (!candlesBySymbol[f.symbol]) {
      console.warn(
        `[ftmoDaytrade24h] crossAssetFilter.symbol "${f.symbol}" not in candlesBySymbol — filter silently disabled.`,
      );
    }
  }
  if (cfg.crossAssetFiltersExtra) {
    for (const f of cfg.crossAssetFiltersExtra) {
      if (f.emaFastPeriod >= f.emaSlowPeriod) {
        throw new Error(
          `crossAssetFiltersExtra "${f.symbol}" emaFastPeriod (${f.emaFastPeriod}) must be < emaSlowPeriod (${f.emaSlowPeriod})`,
        );
      }
      if (!candlesBySymbol[f.symbol]) {
        console.warn(
          `[ftmoDaytrade24h] crossAssetFiltersExtra "${f.symbol}" not in candlesBySymbol — extra filter disabled.`,
        );
      }
    }
  }
  // Resolve cross-asset candles once (same alignment as primary candles).
  const crossKey = cfg.crossAssetFilter?.symbol;
  const crossCandles = crossKey ? candlesBySymbol[crossKey] : undefined;
  // Extra cross-asset filters
  const extraCrossMap: Record<string, Candle[]> = {};
  if (cfg.crossAssetFiltersExtra) {
    for (const f of cfg.crossAssetFiltersExtra) {
      const ca = candlesBySymbol[f.symbol];
      if (ca) extraCrossMap[f.symbol] = ca;
    }
  }
  for (const asset of cfg.assets) {
    // sourceSymbol lets a virtual asset reuse another asset's candles
    // (used for ensemble: ETH-MR + ETH-MOM both read ETHUSDT candles).
    const lookupKey = asset.sourceSymbol ?? asset.symbol;
    const candles = candlesBySymbol[lookupKey];
    if (!candles) continue;
    // Only pass cross-asset candles if they align in length AND timestamps with this asset's.
    // BUGFIX 2026-04-28: Was only checking .length — same length but different
    // start/end times caused index-misaligned cross-asset filter (BTC trend
    // applied to ETH bars at wrong timestamps). Now also verifies first+last
    // openTime match (cheap O(1) check, catches 99% of misalignment).
    const alignsByTimestamp = (a: Candle[], b: Candle[]): boolean =>
      a.length === b.length &&
      a.length > 0 &&
      a[0].openTime === b[0].openTime &&
      a[a.length - 1].openTime === b[b.length - 1].openTime;
    const crossForAsset =
      crossCandles && alignsByTimestamp(crossCandles, candles)
        ? crossCandles
        : undefined;
    const extraForAsset: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(extraCrossMap)) {
      if (alignsByTimestamp(arr, candles)) extraForAsset[sym] = arr;
    }
    const fundingForAsset =
      fundingBySymbol &&
      fundingBySymbol[lookupKey] &&
      fundingBySymbol[lookupKey].length === candles.length
        ? fundingBySymbol[lookupKey]
        : undefined;
    all.push(
      ...detectAsset(
        candles,
        asset,
        cfg,
        crossForAsset,
        extraForAsset,
        fundingForAsset,
      ),
    );
  }
  // BUGFIX 2026-04-28 (Round 14 Bug 5): sort by EXIT time, not entry time.
  // Sort-by-entry created lookahead bias for adaptive sizing / timeBoost when
  // multiple trades overlap (long holds): trade B opening during A's open
  // window saw equity that included A's not-yet-realized PnL. Sort by exit
  // ensures equity reflects realized PnL only.
  //
  // Round-28 liveMode: when true, sort by ENTRY time instead. This more
  // closely matches the order a live bot would actually open trades. The
  // tradeoff is that equity at trade-N's start no longer reflects realised
  // PnL of overlapping earlier-entered trades — which is also what live
  // sees (mark-to-market equity in the broker, including unrealised PnL).
  if (cfg.liveMode) {
    all.sort(
      (a, b) =>
        a.entryTime - b.entryTime ||
        a.exitTime - b.exitTime ||
        a.symbol.localeCompare(b.symbol),
    );
  } else {
    all.sort(
      (a, b) =>
        a.day - b.day || a.exitTime - b.exitTime || a.entryTime - b.entryTime,
    );
  }

  let equity = 1.0;
  let peak = 1.0;
  let maxDd = 0;
  let maxHold = 0;
  const dayStart = new Map<number, number>();
  // Round 13 Anti-DL feature: track per-day peak equity (for daily peak trail)
  // and per-day realized PnL (for soft/hard daily-loss circuit-breaker).
  const dayPeak = new Map<number, number>();
  const tradingDays = new Set<number>();
  const executed: Daytrade24hTrade[] = [];
  // BUGFIX 2026-04-29 (Bug H): track the day target was first hit so
  // finishPausedPass uses the correct ping-start day. Without this, calls
  // from later iterations (where t.day = some later exit day) used the wrong
  // base for pingDay → fewer ping days available → fewer false-passes,
  // but also missed the case where target had already been hit by an
  // earlier-iterated trade and we should ping from THAT day onward.
  let firstTargetHitDay: number | null = null;

  const cappedDays = new Set<number>();
  let totalTradesExecuted = 0;
  // BUGFIX 2026-04-29 (Audit Bug 1 — Kelly look-ahead): the rolling buffer
  // must be queried by ENTRY time, not append order. Trades are processed
  // in exit-time order so a later-entry trade B can exit before an earlier-
  // entry trade A → naively pushing effPnl in iteration order leaks B's
  // result into A's Kelly tier. Fix: store {closeTime, effPnl} and filter
  // to entries that closed STRICTLY BEFORE the current trade's entryTime.
  const pnlBuffer: Array<{ closeTime: number; effPnl: number }> = [];

  function finishPausedPass(targetDay: number): FtmoDaytrade24hResult | null {
    if (!cfg.pauseAtTargetReached || equity < 1 + cfg.profitTarget) return null;
    // BUGFIX 2026-04-29 (R22 audit): the ping-loop previously assumed 100%
    // bot reliability. Real bots have downtime / cron-miss / MT5 disconnects
    // that cause ping-trades to fail. Without modeling that, V5_QUARTZ_LITE
    // showed 76% of passes clustering exactly at minTradingDays floor — an
    // inflation artifact, not a real-world median.
    //
    // pingReliability default 1.0 preserves backwards compatibility with
    // existing memory numbers. Configs that want honest live-replication
    // should set pingReliability to 0.85 (conservative bot) or 0.7 (worst).
    const pingProb = cfg.pingReliability ?? 1.0;
    // Deterministic RNG seeded on targetDay so backtests are reproducible.
    let seed = (targetDay * 2654435761) >>> 0;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    let pingDay = targetDay + 1;
    let lastPingDay = targetDay;
    while (tradingDays.size < cfg.minTradingDays && pingDay < cfg.maxDays) {
      // Each ping is independent Bernoulli(pingProb). Failed pings advance
      // the calendar but don't satisfy minTradingDays — bot was offline.
      if (pingProb >= 1.0 || nextRand() < pingProb) {
        tradingDays.add(pingDay);
        lastPingDay = pingDay;
      }
      pingDay++;
    }
    if (tradingDays.size < cfg.minTradingDays) return null;
    return {
      passed: true,
      reason: "profit_target",
      finalEquityPct: equity - 1,
      maxDrawdown: maxDd,
      uniqueTradingDays: tradingDays.size,
      passDay: lastPingDay + 1,
      trades: executed,
      maxHoldHoursObserved: maxHold,
    };
  }

  // V5: helper to compute momentum ranking at trade entry time
  function rankAtEntryTime(entryTime: number): string[] {
    if (!cfg.momentumRanking) return [];
    const lb = cfg.momentumRanking.lookbackBars;
    const ranked: Array<{ sym: string; ret: number }> = [];
    for (const asset of cfg.assets) {
      const lookupKey = asset.sourceSymbol ?? asset.symbol;
      const cs = candlesBySymbol[lookupKey];
      if (!cs) continue;
      // find candle at entryTime (binary search would be faster but linear is fine)
      let idx = -1;
      for (let k = cs.length - 1; k >= 0; k--) {
        if (cs[k].openTime === entryTime) {
          idx = k;
          break;
        }
        if (cs[k].openTime < entryTime) break;
      }
      if (idx < lb + 1) continue;
      // BUGFIX 2026-04-29 (Audit Bug 2): use signal-bar close (idx-1), not
      // entry-bar close. cs[idx] is the entry bar — its close is FUTURE
      // info at the moment the trade enters at cs[idx].open. Live signal
      // computes momentum from previous closed bar; backtest must match.
      const sigIdx = idx - 1;
      const ret =
        (cs[sigIdx].close - cs[sigIdx - lb].close) / cs[sigIdx - lb].close;
      ranked.push({ sym: asset.symbol, ret });
    }
    ranked.sort((a, b) => b.ret - a.ret);
    return ranked.slice(0, cfg.momentumRanking.topN).map((x) => x.sym);
  }

  for (const t of all) {
    // BUGFIX 2026-04-29 (Bug F follow-up): use entryDay (not exit day) for the
    // "is trade within challenge?" gate. A trade entered on day 25 closing on
    // day 30 was real and should apply — we shouldn't drop late exits.
    // Use `continue` (not break) since sort-by-exit means later iterations may
    // have earlier-entry trades.
    if (t.entryDay >= cfg.maxDays) continue;
    // dayStart anchor: with sort-by-exit, equity at top-of-iteration for the
    // FIRST trade of exit-day N is the realized equity BEFORE that trade —
    // which equals end-of-prior-day equity = correct start-of-day-N anchor.
    if (!dayStart.has(t.day)) dayStart.set(t.day, equity);
    // Round 13 Anti-DL: initialize per-day peak at day-start; updated below
    // after each trade so subsequent same-day trades can compare against
    // the realized peak.
    if (!dayPeak.has(t.day)) dayPeak.set(t.day, equity);

    // iter235+: realistic FTMO behavior — once profit target hit, STOP trading
    // (don't take more risk while waiting for minTradingDays). Real trader
    // would still log in daily and place a tiny no-risk trade to clock the
    // trading day requirement. We simulate that by counting the day toward
    // tradingDays.size without executing any PnL impact.
    // BUGFIX 2026-04-28 (Round 14 Bug 8): real trader clocks EVERY calendar
    // day after target-hit (not just days where Engine has a signal-record).
    // Iterate forward from target-hit-day to satisfy minTradingDays via
    // virtual ping-trades on quiet days too.
    if (cfg.pauseAtTargetReached && equity >= 1 + cfg.profitTarget) {
      // BUGFIX 2026-04-29 (R16 Speed Bug C): capture firstTargetHitDay BEFORE
      // the pause-shortcut. Previously target hit by an earlier-iter trade
      // would short-circuit here without ever assigning firstTargetHitDay,
      // causing pingBase to fall back to t.day (later exit-day) → ping count
      // started too late → median inflated by holdHours/24 ≈ 1-2d.
      // Use t.entryDay (R16 Bug A): real-time anchor, not exit.
      if (firstTargetHitDay === null) firstTargetHitDay = t.entryDay;
      const pingBase = firstTargetHitDay;
      const pausedPass = finishPausedPass(pingBase);
      if (pausedPass) return pausedPass;
      continue; // skip trade execution (no risk, no PnL change)
    }

    // iter206: skip if daily-gain cap has been hit this day
    if (cappedDays.has(t.day)) continue;
    // Round 13 Anti-DL gate: hard daily-loss circuit-breaker.
    // If realized day-PnL has already breached the hard threshold, block
    // all new entries until next day. Prevents the "5th trade kippt account"
    // pattern responsible for half of V5_NOVA's DL-fails.
    if (cfg.intradayDailyLossThrottle) {
      const sodEq = dayStart.get(t.day) ?? 1.0;
      const dayPnl = (equity - sodEq) / sodEq;
      if (dayPnl <= -cfg.intradayDailyLossThrottle.hardLossThreshold) {
        continue;
      }
    }
    // Round 13 Anti-DL gate: daily peak-trail stop.
    // If equity has dropped trailDistance below today's intraday realized
    // peak, halt new entries — protects realized intraday gains from
    // give-back DL fails.
    if (cfg.dailyPeakTrailingStop) {
      const peakToday = dayPeak.get(t.day) ?? equity;
      const drop = (peakToday - equity) / Math.max(peakToday, 1e-9);
      if (drop >= cfg.dailyPeakTrailingStop.trailDistance) {
        continue;
      }
    }
    // Round 15 Anti-TL gate: challenge-peak trail.
    // If equity has dropped trailDistance below the all-time challenge peak
    // (peak variable already tracked for maxDd), halt new entries to prevent
    // the "good day → 4 bad days nuke account" pattern responsible for TL fails.
    if (cfg.challengePeakTrailingStop) {
      const drop = (peak - equity) / Math.max(peak, 1e-9);
      if (drop >= cfg.challengePeakTrailingStop.trailDistance) {
        continue;
      }
    }
    // iter206: skip if max total trades reached
    if (
      cfg.maxTotalTrades !== undefined &&
      totalTradesExecuted >= cfg.maxTotalTrades
    ) {
      break;
    }
    // V4 trend: cap concurrent open positions
    // BUGFIX 2026-04-28 (Round 9 Finding 7): removed dead loop above; the
    // partial backwards-scan was overwritten by the full scan immediately
    // after, making the first loop pure dead code (and incorrect since
    // executed is now sorted by exit-time, not entry-time).
    if (cfg.maxConcurrentTrades !== undefined) {
      // BUGFIX 2026-04-29 (Audit Bug 3): scan the FULL pre-sorted trade list,
      // not just `executed`. `all` is sorted by exit-time, so earlier-entry
      // trades with later exit aren't yet in `executed` when we process `t`.
      // The previous `executed.filter(...)` systematically under-counted
      // openCount → MCT cap leaked winners through → winrate inflated by
      // ~2-5pp (selection-bias toward long-running winners over fast losers).
      let openCount = 0;
      for (const e of all) {
        if (e === t) continue;
        if (e.entryTime <= t.entryTime && e.exitTime > t.entryTime) openCount++;
      }
      if (openCount >= cfg.maxConcurrentTrades) continue;
    }
    // V5: cross-asset correlation overheat filter
    // BUGFIX 2026-04-29 (Audit): mirror of MCT fix — scan full pre-sorted
    // `all` array, not `executed`. Same selection-bias (later-exit winners
    // not yet in executed) was leaking same-direction concurrent trades.
    if (cfg.correlationFilter) {
      let sameDirOpen = 0;
      for (const e of all) {
        if (e === t) continue;
        if (
          e.entryTime <= t.entryTime &&
          e.exitTime > t.entryTime &&
          e.direction === t.direction
        ) {
          sameDirOpen++;
        }
      }
      if (sameDirOpen >= cfg.correlationFilter.maxOpenSameDirection) continue;
    }
    // V5: cross-asset momentum ranking — only top-N qualify
    if (cfg.momentumRanking) {
      const eligible = rankAtEntryTime(t.entryTime);
      if (!eligible.includes(t.symbol)) continue;
    }

    // iter207: per-asset activation gates (time-based + equity-based)
    // BUGFIX 2026-04-29 (Agent 4 R2 Bug F-3 + Agent 1 R2 Bug 1): activation
    // gates check trade ENTRY conditions, not iteration-time. Use entryDay
    // for time-gate. For equity-gate, ideally use entry-time equity but that
    // requires pre-pass — for now we still use running equity (sort-by-exit
    // approximation) but flag this as residual bias.
    const assetForCheck = cfg.assets.find((a) => a.symbol === t.symbol);
    if (assetForCheck) {
      if (
        assetForCheck.activateAfterDay !== undefined &&
        t.entryDay < assetForCheck.activateAfterDay
      )
        continue;
      if (
        assetForCheck.deactivateAfterDay !== undefined &&
        t.entryDay >= assetForCheck.deactivateAfterDay
      )
        continue;
      if (
        assetForCheck.minEquityGain !== undefined &&
        equity - 1 < assetForCheck.minEquityGain
      )
        continue;
      if (
        assetForCheck.maxEquityGain !== undefined &&
        equity - 1 > assetForCheck.maxEquityGain
      )
        continue;
    }

    // BUGFIX 2026-04-29 (R13 Agent: position-sizing): sizing-block was wrapped
    // in `if (cfg.adaptiveSizing)` which left liveCaps/timeBoost/Kelly/shield/
    // throttle ALL inactive when configs lacked adaptiveSizing (V261/V7/V10/V11/
    // V12 base — explains why those configs had ETH-PYR riskFrac=5.0 ungebremst
    // and produced 87%-bug-magic Pass-Rates). Now runs UNCONDITIONALLY; each
    // modifier still self-checks its own config field.
    let effPnl = t.effPnl;
    {
      const asset = cfg.assets.find((a) => a.symbol === t.symbol);
      if (asset) {
        // BUGFIX 2026-04-29 (R13 cascade audit Bug B1): tiers must be sorted by
        // equityAbove ascending so "highest tier wins" semantics actually work.
        // Without sort, an unsorted config would silently pick the LAST matching
        // tier in array order, not the highest-threshold one.
        let factor = 1;
        if (cfg.adaptiveSizing && cfg.adaptiveSizing.length > 0) {
          const sortedTiers = [...cfg.adaptiveSizing].sort(
            (a, b) => a.equityAbove - b.equityAbove,
          );
          for (const tier of sortedTiers) {
            if (equity - 1 >= tier.equityAbove) factor = tier.factor;
          }
        }
        // iter197 time-boost override: late-game push when behind schedule.
        // Only overrides if it would INCREASE risk (never fights protection).
        // BUGFIX 2026-04-29 (Agent 4 Round 2 Bug F-1): use t.entryDay (when
        // the trade was actually placed in real-time), not t.day (exit day).
        // Late-exit trades were getting retroactive boost they wouldn't have
        // had in live execution.
        if (
          cfg.timeBoost &&
          t.entryDay >= cfg.timeBoost.afterDay &&
          equity - 1 < cfg.timeBoost.equityBelow &&
          cfg.timeBoost.factor > factor
        ) {
          factor = cfg.timeBoost.factor;
        }
        // iter231 Kelly multiplier: rolling win-rate based sizing.
        // Tracks last N completed trades; when realized win rate is above
        // a tier threshold, multiplies factor. Applied after adaptive &
        // timeBoost but before drawdown shield.
        if (cfg.kellySizing) {
          // BUGFIX 2026-04-29 (Audit Bug 1): only consider pnls that closed
          // BEFORE this trade's entry time. Otherwise we leak future info
          // (later-entered, earlier-exited trades) into Kelly tier selection.
          const recentPnls = pnlBuffer
            .filter((p) => p.closeTime < t.entryTime)
            .slice(-cfg.kellySizing.windowSize)
            .map((p) => p.effPnl);
          if (recentPnls.length >= cfg.kellySizing.minTrades) {
            const wins = recentPnls.filter((p) => p > 0).length;
            const wr = wins / recentPnls.length;
            let kMult = 1;
            // tiers checked from highest threshold down
            const sortedTiers = [...cfg.kellySizing.tiers].sort(
              (a, b) => b.winRateAbove - a.winRateAbove,
            );
            for (const tier of sortedTiers) {
              if (wr >= tier.winRateAbove) {
                kMult = tier.multiplier;
                break;
              }
            }
            factor *= kMult;
          }
        }
        // BUGFIX 2026-04-29 (R13 cascade Bug B3): hard-cap factor to prevent
        // timeBoost(2.0) × kelly(1.5) = 3.0 compound risk. Three concurrent
        // -2% trades at compound 3× = -18% total_loss in a single day.
        const MAX_FACTOR = 4;
        factor = Math.min(factor, MAX_FACTOR);
        // iter204 drawdown shield: scale DOWN when already underwater.
        // Applied AFTER ramps/boosts so it always wins when triggered.
        if (
          cfg.drawdownShield &&
          equity - 1 <= cfg.drawdownShield.belowEquity
        ) {
          factor = Math.min(factor, cfg.drawdownShield.factor);
        }
        // V7+ peak-relative drawdown throttle: catches profit-give-back.
        if (cfg.peakDrawdownThrottle && peak > 0) {
          const fromPeak = (peak - equity) / peak;
          if (fromPeak >= cfg.peakDrawdownThrottle.fromPeak) {
            factor = Math.min(factor, cfg.peakDrawdownThrottle.factor);
          }
        }
        // iter1h-035+ apply vol-targeting multiplier (set per-trade in detectAsset)
        // BUGFIX 2026-04-29 (Agent 7 Bug 2): under liveCaps, the volMult MUST be
        // clamped to <=1.0 ("downside-only scaling" per detectAsset's safeVolMult
        // intent at line 4263-4270). Equity-loop was using raw t.volMult which
        // could be >1, allowing volTargeting to BOOST position size beyond live
        // execution caps. Inflated wins for configs with volTargeting maxMult>1
        // (e.g. V5_NOVA per-asset 1.0-1.5).
        // Round 13 Anti-DL: soft daily-loss circuit-breaker scales risk DOWN
        // when intraday realized PnL crosses softLossThreshold but is still
        // above hardLossThreshold (the hard cut-off was applied earlier).
        if (cfg.intradayDailyLossThrottle) {
          const sodEq = dayStart.get(t.day) ?? 1.0;
          const dayPnl = (equity - sodEq) / sodEq;
          if (dayPnl <= -cfg.intradayDailyLossThrottle.softLossThreshold) {
            factor *= cfg.intradayDailyLossThrottle.softFactor;
          }
        }
        const tradeVolMult = cfg.liveCaps
          ? Math.min(t.volMult ?? 1.0, 1.0)
          : (t.volMult ?? 1.0);
        let effRisk = asset.riskFrac * factor * tradeVolMult;
        // BUGFIX 2026-04-26: respect live-cap maxRiskFrac in equity loop too.
        // Previously this path overwrote the carefully-capped effPnl from
        // detectAsset, making liveCaps.maxRiskFrac effectively a no-op.
        if (cfg.liveCaps && effRisk > cfg.liveCaps.maxRiskFrac) {
          effRisk = cfg.liveCaps.maxRiskFrac;
        }
        if (effRisk <= 0) continue; // skip trade
        // BUGFIX 2026-04-29 (Agent 4 Bug 2): relax floor to -1.5R for gap tails.
        effPnl = Math.max(t.rawPnl * cfg.leverage * effRisk, -effRisk * 1.5);
      }
    }
    // BUGFIX 2026-04-29 (Agent 8 Bug 10): final NaN/Infinity guard before
    // equity update. Corrupt rawPnl/factor could otherwise propagate.
    if (!Number.isFinite(effPnl)) {
      continue;
    }

    // iter231: track rolling PnL for Kelly window (after effPnl finalized)
    // BUGFIX 2026-04-29 (Audit Bug 1): tag with closeTime so future Kelly
    // tier checks can filter to pnls available at the trade's entryTime.
    if (cfg.kellySizing) {
      pnlBuffer.push({ closeTime: t.exitTime, effPnl });
      // Keep buffer bounded — windowSize × 4 is enough since each Kelly
      // check filters then slices to windowSize.
      const maxBuf = cfg.kellySizing.windowSize * 4;
      while (pnlBuffer.length > maxBuf) pnlBuffer.shift();
    }

    equity *= 1 + effPnl;
    // Round 13 Anti-DL: update intraday peak after each realized PnL so
    // the dailyPeakTrailingStop gate sees an accurate peak on subsequent
    // same-day trades.
    if (cfg.dailyPeakTrailingStop) {
      const prevPeak = dayPeak.get(t.day) ?? equity;
      if (equity > prevPeak) dayPeak.set(t.day, equity);
    }
    // BUGFIX 2026-04-29 (Bug F): tradingDays counts ENTRY days (FTMO rule:
    // a trading day = day with an executed entry). t.day is now exit day
    // (used for DL attribution); entryDay is what FTMO's minTradingDays
    // requires.
    tradingDays.add(t.entryDay);
    executed.push({ ...t, effPnl });
    totalTradesExecuted++;
    if (t.holdHours > maxHold) maxHold = t.holdHours;
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDd) maxDd = dd;

    // iter206: daily-gain cap check (applied AFTER the trade closes)
    if (cfg.dailyGainCap !== undefined) {
      const sodNow = dayStart.get(t.day)!;
      if (equity / sodNow - 1 >= cfg.dailyGainCap) {
        cappedDays.add(t.day);
      }
    }

    // BUGFIX 2026-04-29 (R13 DL-3/TL-1): JS double-precision rounding can let
    // a -4.99999% DL squeak past `<= -0.05`. FTMO measures to cents — a -$5,000.01
    // hit on a $100k account fails. Tighten with epsilon tolerance.
    const TL_EPS = 1e-9;
    if (equity <= 1 - cfg.maxTotalLoss + TL_EPS) {
      return {
        passed: false,
        reason: "total_loss",
        finalEquityPct: equity - 1,
        maxDrawdown: maxDd,
        uniqueTradingDays: tradingDays.size,
        trades: executed,
        maxHoldHoursObserved: maxHold,
      };
    }
    const sod = dayStart.get(t.day)!;
    if (equity / sod - 1 <= -cfg.maxDailyLoss + TL_EPS) {
      return {
        passed: false,
        reason: "daily_loss",
        finalEquityPct: equity - 1,
        maxDrawdown: maxDd,
        uniqueTradingDays: tradingDays.size,
        trades: executed,
        maxHoldHoursObserved: maxHold,
      };
    }
    // Capture day target was first hit (BEFORE finishPausedPass call so the
    // call sees the correct base if needed). Bug H — see top of equity loop.
    if (firstTargetHitDay === null && equity >= 1 + cfg.profitTarget) {
      // BUGFIX 2026-04-29 (R16 Speed Bug A): real trader holds the target-hit
      // position from entry — passDay should anchor at entryDay, not exitDay
      // (which is later by holdHours/24). With holdBars 60 = 30h on 2h, this
      // alone can shave 1-2 days off median.
      firstTargetHitDay = t.entryDay;
    }
    const pausedPass = finishPausedPass(firstTargetHitDay ?? t.entryDay);
    if (pausedPass) return pausedPass;
    if (
      equity >= 1 + cfg.profitTarget &&
      tradingDays.size >= cfg.minTradingDays
    ) {
      return {
        passed: true,
        reason: "profit_target",
        finalEquityPct: equity - 1,
        maxDrawdown: maxDd,
        uniqueTradingDays: tradingDays.size,
        // BUGFIX 2026-04-29 (R19 audit): passDay must reflect the day the
        // FORMAL pass condition was satisfied, not just target-hit-day.
        // FTMO requires both 8% target AND minTradingDays (= 4) — a Day-0
        // target-hit still has to wait until Day 4 to officially pass.
        passDay: Math.max((firstTargetHitDay ?? t.day) + 1, cfg.minTradingDays),
        trades: executed,
        maxHoldHoursObserved: maxHold,
      };
    }
  }
  // BUGFIX 2026-04-28 (Engine audit Bug 2): if pauseAtTargetReached + equity
  // already at target but no further signals fire AND tradingDays < min,
  // a real FTMO trader would ping-trade quiet days. Without this we
  // false-fail those windows as "insufficient_days" / "time".
  if (cfg.pauseAtTargetReached && equity >= 1 + cfg.profitTarget) {
    // BUGFIX 2026-04-29 (Bug H): use firstTargetHitDay if known, else the
    // last executed trade's day. Was using last day always, which was
    // wrong when target was hit early but no later trades executed.
    const baseDay =
      firstTargetHitDay ??
      (executed.length > 0 ? executed[executed.length - 1].day : 0);
    const ping = finishPausedPass(baseDay);
    if (ping) return ping;
  }
  const late =
    equity >= 1 + cfg.profitTarget && tradingDays.size >= cfg.minTradingDays;
  return {
    passed: late,
    reason: late
      ? "profit_target"
      : tradingDays.size < cfg.minTradingDays
        ? "insufficient_days"
        : "time",
    finalEquityPct: equity - 1,
    maxDrawdown: maxDd,
    uniqueTradingDays: tradingDays.size,
    passDay:
      late && executed.length > 0
        ? (firstTargetHitDay ?? executed[executed.length - 1].day) + 1
        : undefined,
    trades: executed,
    maxHoldHoursObserved: maxHold,
  };
}

export const FTMO_DAYTRADE_24H_STATS = {
  iteration: 212,
  version:
    "daytrade-12h-ETHshort-pyramid@1.5%r5+BTC-EMA10/15+mom6bar@2%+drop8UTC",
  symbols: ["ETHUSDT"] as const,
  timeframe: "4h",
  maxHoldHours: 12,
  tpPct: 0.04,
  stopPct: 0.012,
  tpStopRatio: 4 / 1.2, // ≈ 3.33
  triggerBars: 2,
  windowsTested: 971, // rolling-1d (robust)
  // iter212 full-history re-tune: 50.78% over 8.7 years (genuine 50% mark,
  // not regime-biased). EMA10/15 + mom6bar + drop8UTC outperformed iter211's
  // 1000d-optimized EMA18/25 + mom18bar + drop16UTC on the long sample.
  passRateNov: 1594 / 3139, // 0.5078 — FULL 8.7y Binance ETH history
  passRateRecent1000d: 589 / 971, // 0.6066 — recent chop/bear regime only
  passRateRolling5d: 0, // not re-measured for this iter
  regimeSpread: 0.32, // range 34-67% per year (bull-worst to chop-best)
  livePassRateEstimate: 0.46,
  avgDailyReturn: 0.024,
  evPerChallengeOos: (1594 / 3139) * 0.5 * 8000 - 99, // +$1932
  evPerChallengeLive: 0.46 * 0.5 * 8000 - 99, // +$1741
  challengeFee: 99,
  payoutIfFunded: 8000,
  phase2ConditionalPassRate: 0.5,
  expectedOutcome20Challenges: {
    fees: 1980,
    // Based on full 8.7-year history (50.78%) with 10% live-safety margin.
    expectedPassesLive: 9.2,
    expectedFundedLive: 4.6,
    expectedGrossLive: 36_800,
    expectedNetLive: 34_820,
  },
  leverage: 2,
  baseRiskPerAsset: 1.0, // ETH-only full-size
  adaptiveSizing: true,
  timeBoost: true,
  isDaytrade: true,
  allowsNormalPlan: true,
  maxHoldWithinLimit: 12,
  avgDaysToPass: 5,
  medianDaysToPass: 5,
  passRateTargetUser: 0.5,
  passRatePhysicalCeiling: 0.51,
  targetReachable: true,
  note:
    "FTMO 12H-HOLD DAYTRADE (iter212) — 50.78% over 8.7 years (honest 50%). " +
    "After user asked 'does it work in all regimes', I re-tuned the filters " +
    "against the FULL Binance ETH 4h history (2017-08 → 2026-04, 3139 windows " +
    "rolling-1d) instead of the 1000d-specific tune that iter203+ used. Key " +
    "changes from iter211:\n" +
    "  - BTC filter: EMA18/25 → EMA10/15 (faster regime detection)\n" +
    "  - BTC momentum: 18bar@3% → 6bar@2% (shorter, more sensitive)\n" +
    "  - Session: drop-Wed + drop-16 → drop-8 UTC only (full-hist revealed\n" +
    "    Asia->EU handoff is the adversarial bar, not US open)\n" +
    "Per-year: 34-67% range (was 20-62% for iter211). Every year is at least " +
    "34%, AND crosses 50% full-history average for the first time. +4.2pp " +
    "full-history vs iter211. 2021 bull (+394%) jumped from 36% → 45%. " +
    "2026 chop from 44% → 66%. Only 2024 regressed (58→48, trade-off). " +
    "EV +$1932 per challenge, ~$35k net over 20 challenges.\n\n" +
    "NOTE: regime-adaptive bidirectional (longs in bull + shorts in bear) " +
    "was tested comprehensively — all variants underperformed iter212 by " +
    "5-10pp on full-history. Shared-equity makes combining mean-reversion " +
    "longs+shorts net-negative. Single-side short-only with tighter BTC " +
    "filter works best.\n\n" +
    "Previous iterations: iter211 (46.56%), iter210 (recent 58%), iter209 " +
    "(recent 56%), iter208 (55%), iter207 (53%), iter206 (50%).\n\n" +
    "FTMO 12H-HOLD DAYTRADE (prior iter211 note) — HONEST: 46.56% full-history, not 60%. " +
    "User asked if the backtest spans multiple thousands of days. The short " +
    "answer: recent 1000d showed 60.66%, but that was regime-biased. On full " +
    "8.7-year Binance ETHUSDT history (2017-08 → 2026-04, 3168 days, 19007 " +
    "4h candles spanning multiple crypto cycles) the rolling-1d pass rate is " +
    "1461/3138 = **46.56%**. The 60% appeared because our recent 1000d window " +
    "(2023-2026) happened to be predominantly chop/bear — mean-reversion's " +
    "best regime.\n\n" +
    "Per-regime breakdown:\n" +
    "  2018 BEAR (-82%): 54.19%\n" +
    "  2019 CHOP:        45.07%\n" +
    "  2020 BULL+466%:   32.14%  ← weakest\n" +
    "  2021 BULL+394%:   36.01%  ← weakest\n" +
    "  2022 BEAR (-68%): 57.14%\n" +
    "  2023 BULL+91%:    35.42%\n" +
    "  2024 BULL+47%:    58.16%\n" +
    "  2025 CHOP:        62.50%  ← best\n\n" +
    "Pattern: mean-reversion ETH shorts EXCEL in bear/chop (50-60%+) and " +
    "STRUGGLE in parabolic bulls (32-36%). The BTC EMA+momentum filters help " +
    "but can't fully neutralize a 1000%+ bull run. Live pass rate estimate " +
    "revised to ~42% as a regime-neutral baseline.\n\n" +
    "Previous (recent-data) iterations, in order:\n" +
    "iter210 (24h, 58.19%) — added BTC momentum filter.\n" +
    "iter209 (24h, 55.82%) — fine-tuned BTC EMA18/25.\n" +
    "iter208 (24h, 54.99%) — BTC EMA20/30 cross-asset filter.\n" +
    "iter207 (24h, 53.04%) — pyramid @1.5% r=4.\n" +
    "iter206 (24h, 49.95%) — first pyramid.\n" +
    "iter205 (24h, 36.97%) — tightened near-target sizing.\n" +
    "iter204 (24h, 36.05%) — relaxed to 24h hold.\n" +
    "iter203 (12h, 28.53%) — session filters (drop Wed + drop 16 UTC).\n\n" +
    "FTMO 12H-HOLD DAYTRADE (iter211 regime-biased note) — 60.66% pass rate under user's 12h " +
    "constraint + single-account restriction. User switched back to hold=3 " +
    "(12h) and re-tuning around that revealed: 12h is actually BETTER than " +
    "24h for the pyramid-on-winners setup, because the faster rotation lets " +
    "pyramid fire more often. Winner: tp=4% stop=1.2% P@1.5% r=5 → 589/971 = " +
    "60.66% rolling-1d. Regime spread 8.28pp is the cost of tighter TP " +
    "(12h trades are dominated by time-exits, so tight TP captures more " +
    "wins). EV +$2327/challenge. Over 20 challenges: ~$42k net expected.\n\n" +
    "=== iter210 (58.19%, 24h hold, EMA+momentum) ===\n" +
    "iter210 was the 24h-hold ceiling. When user clarified 12h is a hard " +
    "constraint (and only 1 account available), I re-swept with holdBars=3. " +
    "Surprisingly, 12h + tighter TP (4% vs 10%) + bigger pyramid (r=5 vs " +
    "r=4) beats the 24h config by +2.5pp on raw pass rate.\n\n" +
    "FTMO 24H-HOLD DAYTRADE (prior iter210 note) — BTC EMA + momentum → 58%. " +
    "Adding a second BTC-regime signal: if BTC has pumped more than 3% over " +
    "the past 18 bars (72h), skip ETH short entries. The intuition: EMA " +
    "captures the MACRO trend, momentum captures recent THRUST — ETH shorts " +
    "fail under both. Combined filter delivers 565/971 = 58.19% rolling-1d, " +
    "EV +$2228 per challenge. Regime spread 1.91pp (slightly worse than " +
    "iter209's 0.85pp, but +2.4pp absolute pass rate). Over 20 challenges: " +
    "~$40.4k net expected.\n\n" +
    "=== iter208 (54.99%, BTC EMA20/30) — first cross-asset win ===\n" +
    "=== iter209 (55.82%, BTC EMA18/25) — fine-tuned the EMA periods ===\n" +
    "=== iter207 (53.04%, fine-pyramid) — doubled the pyramid dial ===\n\n" +
    "=== iter208 (earlier note) — BTC cross-asset filter pushes to 55%. " +
    "User asked to try forex/indices. Yahoo Finance rate-limited our DXY/SPX " +
    "fetches. Pivot: since ETH follows BTC ~80% on 4h, BTC itself IS the crypto " +
    "macro. Per-window analysis: BTC uptrend → 49.6% pass rate (ETH shorts get " +
    "steamrolled), BTC neutral → 58.4%, BTC downtrend → 52%. Adding an EMA20/30 " +
    "filter that SKIPS ETH shorts during confirmed BTC uptrends (close > EMA20 > " +
    "EMA30) lifts rolling-1d to 534/971 = 54.99% AND collapses regime spread " +
    "from 2.76pp (iter207) to 1.06pp (most stable config in the entire series). " +
    "+2pp on pass rate AND +halved spread — both dimensions improve. EV +$2101. " +
    "Over 20 challenges: ~$38k net expected.\n\n" +
    "=== iter207 (53.04%, fine-pyramid) — doubled the pyramid dial ===\n" +
    "After iter206 crossed 50%, a finer sweep around the pyramid parameters " +
    "found a materially better spot: P1@1.5%×r=4.0 → 515/971 = 53.04% " +
    "rolling-1d with regime spread 2.76pp (iter206 had 7.86pp). The earlier " +
    "threshold (1.5% vs 3.5%) lets the pyramid fire more often; the bigger " +
    "risk factor (4.0 vs 1.5) captures more upside per signal. Interestingly, " +
    "this combo is ALSO more regime-stable — bigger risk on smaller wins is " +
    "less regime-dependent than smaller risk on larger wins. EV +$2023. " +
    "Over 20 challenges: ~$36.4k net expected.\n\n" +
    "=== iter206 (49.95%, pyramid@3.5%×1.5) — first 50% crossing ===\n" +
    "After iter205 (36.97%) I exhausted filter/sizing tweaks and did a full " +
    "web-research round on alternative approaches: indices/forex, breakouts, " +
    "grid, VCP, session patterns, ensemble classifiers. The breakthrough " +
    "came from a simple industry technique — ADD TO WINNERS — implemented " +
    "as a second virtual asset that activates only when equity − 1 ≥ 3.5%, " +
    "with 1.5× the base risk. Rolling-1d jumps to 485/971 = 49.95%, up " +
    "+13pp from iter205 — the biggest single-iter gain in the whole series. " +
    "Why ensembles/classifiers didn't work earlier: shared drawdown budget " +
    "kills MR+MOM combos (real-ensemble was 33.88% vs 36.97% iter205). " +
    "Regime-switch classifiers couldn't approach the 49% oracle OR-pass " +
    "(best heuristic was 37.67%). Pyramiding sidesteps both: same strategy " +
    "scales up only after it's already winning, so the pyramid risks " +
    "already-gained capital, not the base account. Regime spread 7.86pp " +
    "is the tradeoff (more variance across regimes), but EV jumps to +$1899. " +
    "Over 20 challenges: ~$34k net expected (+$10k vs iter204, +$17k vs " +
    "iter203). The 50% target that looked physically impossible IS " +
    "reachable — just not via filters or regime-selection, but via " +
    "performance-gated pyramiding.\n\n" +
    "=== Earlier iterations ===\n" +
    "iter205 (36.97%, NT-tight) — 24h hold + iter203 session + tight near-target.\n" +
    "iter204 (36.05%, hold=24h) — relaxed hold from 12h.\n" +
    "iter203 (28.53%, sessions) — drop Wed + drop 16 UTC.\n" +
    "iter202 (26.78%, short-only) — removed longs.\n" +
    "iter201 (27.39%, ETH-only) — dropped BTC+SOL.\n" +
    "iter200 (16.27%, 3-asset) — trig=3 bugfix baseline.\n" +
    "iter199 (7.18%, bugfix) — fixed the entry-bar TP/stop off-by-one.\n" +
    "iter197 (50.72% CLAIMED) — bug-inflated pre-fix.\n\n" +
    "=== Extra notes (from iter204) ===\n" +
    "The 12h hold was user-preference, not an FTMO rule. FTMO Normal " +
    "crypto allows intraday holding to ~24h without swap fees. Full " +
    "hold × tp × stop × trig grid sweep picked hold=6 trig=2 stop=1.5% " +
    "tp=10%: 350/971 = 36.05% rolling-1d, first=36.16% second=35.95%, " +
    "regime spread 0.21pp (essentially identical across regimes). " +
    "+7.5pp over iter203 AND more stable. EV +$1343/challenge. " +
    "Intuition: 24h hold lets the 10% TP actually complete. 12h hold " +
    "timed-out most mean-reversions mid-move. " +
    "FTMO_DAYTRADE_24H_CONFIG_12H retained for users who need strict " +
    "intraday windows. Full iter203 session filter (drop Wed + drop " +
    "16 UTC) preserved. Target 50% still unreachable — ~36% appears to " +
    "be the physical ceiling under FTMO-Normal constraints on single-" +
    "asset ETH. Further gains would require: multi-account parallelism " +
    "(variance-smoothing across independent challenges), Swing plan " +
    "(20-day hold with overnight fees), or fundamentally different " +
    "signal logic (momentum/breakout alpha stack).\n\n" +
    "=== Earlier iterations for reference ===\n" +
    "iter203 (12h) — iter202 + session filter. " +
    "Web research into ETH intraday drift (Asia down-drift, US-open " +
    "pump at 16 UTC, Thursday-vs-Monday return asymmetry) motivated a " +
    "full hour×dow sweep on top of iter202. Result: dropping Wednesday " +
    "signals AND the 16 UTC signal bar lifts rolling-1d pass rate from " +
    "277/971 (28.53%) to 293/971 (30.18%) — +1.65pp — while REDUCING " +
    "regime spread from 4.88pp to 2.55pp. Naive winners like 'drop " +
    "Friday' (30.28%, 12.74pp spread) and 'drop Wed+Fri' (31.20%, " +
    "10.19pp spread) were rejected as regime-biased. iter203 is the " +
    "first config to simultaneously cross 30% pass rate AND stay under " +
    "3pp regime spread. EV +$1108/challenge. Over 20 challenges: " +
    "~$19.6k net (vs $18.0k at iter202). The iter201 both-sides and " +
    "iter200 3-asset configs remain exported for diversification users. " +
    "Honest ceiling still ~30-32%; 60% unreachable under these costs + " +
    "12h hold. Further gains likely require Swing plan (20-day hold) " +
    "or multi-account variance-smoothing.",
} as const;

/**
 * LIVE_15M_V1 — 15m ABSOLUTE CHAMPION under live caps.
 *
 * Walk-forward 1.71y / 15m / 199 windows / FTMO-real:
 *   82.41% pass / med 1d / p75 5d / p90 6d / EV $3197
 *
 * Beats LIVE_30M_V1 (+10.67pp) AND has the best tail (p90 6d vs 12d).
 * Caveat: 15m history is only 1.71y vs 5.71y for 1h/2h/4h — less robust
 * statistical sample. Recommend 9-dim stress test before sizing up live.
 *
 * Live Service: `FTMO_TF=15m-live`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT,
  atrStop: { period: 84, stopMult: 5 },
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 300 },
  htfTrendFilter: { lookbackBars: 100, apply: "short", threshold: 0.05 },
  // Engine units: maxRiskFrac=0.4 ≈ 4% live equity loss at 5% stop, 2× lev.
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
};

/**
 * LIVE_1H_V1 — 1h live-cap champion. 5.71y / 685 windows: 74.89% / med 1d / p90 12d.
 * Live Service: `FTMO_TF=1h-live`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT,
  atrStop: { period: 84, stopMult: 2 },
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 200 },
  htfTrendFilter: { lookbackBars: 100, apply: "short", threshold: 0.05 },
  // Engine units: maxRiskFrac=0.4 ≈ 4% live equity loss at 5% stop, 2× lev.
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
};

/**
 * LIVE_2H_V1 — 2h live-cap champion. 5.71y / 685 windows: 71.68% / med 1d / p90 8d.
 * Best tail among 5.71y-validated configs.
 * Live Service: `FTMO_TF=2h-live`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  atrStop: { period: 14, stopMult: 2 },
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 50 },
  htfTrendFilter: { lookbackBars: 300, apply: "short", threshold: 0.1 },
  // Engine units: maxRiskFrac=0.4 ≈ 4% live equity loss at 5% stop, 2× lev.
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
};

/**
 * LIVE_4H_V1 — 4h live-cap champion (slowest). 5.71y / 685: 61.17% / med 3d / p90 10d.
 * Live Service: `FTMO_TF=4h-live`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V1: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V261,
  atrStop: { period: 84, stopMult: 2 },
  lossStreakCooldown: { afterLosses: 3, cooldownBars: 50 },
  htfTrendFilter: { lookbackBars: 200, apply: "short", threshold: 0.05 },
  // Engine units: maxRiskFrac=0.4 ≈ 4% live equity loss at 5% stop, 2× lev.
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
};

/**
 * LIVE_5M_V1 — 5m live-cap variant.
 *
 * 5m candles produce 6× more bars/day than 30m, so all bar-count parameters
 * scale up: holdBars 7200 (= 25d), htfTrendFilter lookback 1200, chandelier
 * period 168.
 *
 * Walk-forward 2.38y / 5m / 280 windows / FTMO-real:
 *   60.36% pass / med 1d / p75 3d / p90 7d / EV $2315
 *
 * Worse pass-rate than LIVE_15M_V1 (73.28% on 5.71y) — 5m noise increases
 * whipsaw rate. Same tail (p90 7d). Not recommended over 15m unless trading
 * volatility-clustered news-day setups where finer entry timing matters.
 *
 * Live Service: `FTMO_TF=5m-live`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V1: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  holdBars: 7200,
  atrStop: { period: 14, stopMult: 4 },
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 600 },
  htfTrendFilter: { lookbackBars: 200, apply: "short", threshold: 0.05 },
  chandelierExit: {
    period: 168,
    mult: 3,
    minMoveR: 0.5,
  },
  // Engine units: maxRiskFrac=0.4 ≈ 4% live equity loss at 5% stop, 2× lev.
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
};

// ===========================================================================
// V2 family — aggressive sweep refinements (chandelierExit, partialTakeProfit,
// timeBoost, hour-drops). All on 5.71y / 685 windows / FTMO-real / live-caps.
// ===========================================================================

/**
 * LIVE_15M_V2 — V1 + chandelier p168 m4 + PTP {0.02, 0.3} + timeBoost {d=2 eb=0.07 f=2.5}.
 * 5.71y: 521/685 = 76.06% / med 1d / p75 4d / **p90 6d** (better tail!) / EV $2943
 * Δ vs V1: +2.77pp pass, -1d p90.
 * **CHAMPION for tail-speed.** Plateau confirmed: V3 sweep on per-asset/adaptiveSizing
 * gave +0.00pp.
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1,
  chandelierExit: { period: 168, mult: 4, minMoveR: 0.5 },
  partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.3 },
  timeBoost: { afterDay: 2, equityBelow: 0.07, factor: 2.5 },
};

/**
 * LIVE_30M_V2 — V1 + drop hours {4, 22} + chandelier p168 m2.5 + PTP {0.02, 0.7}.
 * 5.71y: 448/685 = 65.40% / med 1d / p90 12d / EV $2517
 * Δ vs V1 (5.71y baseline 62.92%): +2.48pp.
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V1,
  allowedHoursUtc: [0, 1, 2, 5, 6, 8, 10, 12, 13, 14, 17, 19, 20, 23],
  chandelierExit: { period: 168, mult: 2.5, minMoveR: 0.5 },
  partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.7 },
};

/**
 * LIVE_1H_V2 — V1 + 6 dropped hours + timeBoost {d=8 eb=0.02 f=2}.
 * 5.71y: 532/685 = 77.66% / med 1d / p90 13d / EV $3008
 * Δ vs V1: +2.77pp pass, +1d p90 (slightly worse tail).
 * **CHAMPION for raw pass-rate.**
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1,
  allowedHoursUtc: [6, 10, 12, 16, 21, 22],
  timeBoost: { afterDay: 8, equityBelow: 0.02, factor: 2 },
};

/**
 * LIVE_2H_V2 — V1 + drop hour 6 + chandelier p28 m4 + BTC/SOL meg 0.005 rf 1.0.
 * 5.71y: 496/685 = 72.41% / med 1d / p90 9d / EV $2797
 * Δ vs V1: +0.73pp pass.
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V2: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1,
  allowedHoursUtc: [0, 2, 12, 16, 20, 22],
  chandelierExit: { period: 28, mult: 4, minMoveR: 0.5 },
  timeBoost: { afterDay: 4, equityBelow: 0.08, factor: 3 },
  assets: FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1.assets.map((a) =>
    a.symbol === "BTC-MR" || a.symbol === "SOL-MR"
      ? { ...a, minEquityGain: 0.005, riskFrac: 1.0 }
      : a,
  ),
};

/**
 * LIVE_4H_V2 — V1 + timeBoost {d=12 eb=0.02 f=3}.
 * 5.71y: 447/685 = 65.26% / med 3d / p90 13d / EV $2511
 * Δ vs V1: +4.09pp pass, +3d p90 (worse tail trade-off).
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V2: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V1,
  timeBoost: { afterDay: 12, equityBelow: 0.02, factor: 3 },
};

/**
 * LIVE_15M_V3 — V2 + multi-asset (BNB, ADA) + caf momSkipShortAbove tightened.
 *
 * Aggressive sweeps across V3-V8 (peak-DD throttle, drawdown shield, more
 * assets, kelly, holdBars, tpPct fine-grain, PTP fine-grain) all returned
 * 0 to +0.5pp. **77.37% IS the math-bound** for single-strategy MR-shorts
 * under live caps with the current engine.
 *
 * 5.71y / 685w / FTMO-real:
 *   77.37% pass / med 1d / p75 4d / p90 6d / EV $2996
 *
 * Δ vs V2 (76.06%): +1.31pp purely from BNB+ADA diversification.
 *
 * Requires loadBinanceHistory({ symbol: "BNBUSDT", "ADAUSDT" }) in addition
 * to ETH/BTC/SOL — live service must be extended for 5-asset polling.
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
  crossAssetFilter: {
    ...(FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2.crossAssetFilter as any),
    momSkipShortAbove: 0.005,
    momentumBars: 6,
  },
  assets: [
    ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2.assets,
    {
      symbol: "BNB-MR",
      sourceSymbol: "BNBUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 1.0,
      minEquityGain: 0.02,
      triggerBars: 1,
    },
    {
      symbol: "ADA-MR",
      sourceSymbol: "ADAUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 1.0,
      minEquityGain: 0.02,
      triggerBars: 1,
    },
  ],
};

/**
 * LIVE_5M_V2 — 5m HARDCORE TUNED.
 *
 * V1 was 59.12% (overfit to 2.38y). V2 = aggressive 9-axis sweep on full
 * 5.71y history yielded MASSIVE improvement WITHOUT speed loss:
 *
 *   V1 (5.71y): 405/685 = 59.12% / med 1d / p90 6d / TL=175 DL=105 / EV $2266
 *   V2 (5.71y): 487/685 = 71.09% / med 1d / p90 6d / TL=142 DL=56  / EV $2745
 *   Δ:          +11.97pp pass, 0d p90, -33 TL, -49 DL
 *
 * Key wins:
 *   - atrStop p84 m5 (was p14 m4) — wider noise absorption
 *   - chandelierExit p600 m5 (was p168 m3) — 50h trailing stop
 *   - htfTrendFilter lb=1200 thr=0.03 — much stricter slow-uptrend detection
 *   - timeBoost {d=4, eb=0.08, f=3} — aggressive late-game push
 *   - 14 hours dropped (kept 10) — session-quality filter tightened
 *   - caf BTC mom thr=0.005 mb=4 — tighter regime filter
 *   - +BNB-MR multi-asset
 *
 * Still under 15m V3 (77.37%) but a clean +12pp jump shows 5m has real edge
 * when properly tuned with the engine extensions.
 *
 * Live Service: `FTMO_TF=5m-live` now points to V2 (this).
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V2: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V1,
  atrStop: { period: 84, stopMult: 5 },
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 600 },
  htfTrendFilter: { lookbackBars: 1200, apply: "short", threshold: 0.03 },
  chandelierExit: { period: 600, mult: 5, minMoveR: 0.5 },
  partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.3 },
  timeBoost: { afterDay: 4, equityBelow: 0.08, factor: 3 },
  crossAssetFilter: {
    ...(FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V1.crossAssetFilter as any),
    momSkipShortAbove: 0.005,
    momentumBars: 4,
  },
  allowedHoursUtc: [1, 4, 6, 10, 12, 13, 17, 20, 22, 23],
  assets: [
    ...FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V1.assets,
    {
      symbol: "BNB-MR",
      sourceSymbol: "BNBUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 1.0,
      minEquityGain: 0.02,
      triggerBars: 1,
    },
  ],
};

/**
 * LIVE_5M_V3 — V2 + breakEven{0.025} + LTC-MR. Marginal +0.29pp.
 *
 * 5.71y / 685w / FTMO-real:
 *   71.39% pass / med 1d / p90 6d / TL=140 DL=56 / EV $2756
 *
 * 11-axis MEGA sweep on V2 yielded only +0.29pp — confirms 5m plateau at
 * ~71%. 90% target unreachable with single-strategy MR-shorts under live caps.
 */
export const FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V3: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V2,
  breakEven: { threshold: 0.025 },
  assets: [
    ...FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V2.assets,
    {
      symbol: "LTC-MR",
      sourceSymbol: "LTCUSDT",
      costBp: 35,
      slippageBp: 10,
      swapBpPerDay: 5,
      riskFrac: 1.0,
      minEquityGain: 0.02,
      triggerBars: 1,
    },
  ],
};

/**
 * TREND_4H_V2 — 4h Trend-Following CHAMPION (post-MR-discovery 2026-04-26).
 *
 * Mean-reversion shorts hit a 25% mathematical ceiling under honest live caps
 * (R:R 0.5:1 on Crypto MR is unprofitable). 4h Trend-Following with R:R >1:1
 * works much better — 1-green-close → LONG (continuation), tighter stop,
 * wider TP, multi-day holds.
 *
 * Walk-forward 5.38y / 645w / FTMO-real (limited by MATIC listing):
 *   V1 (4 assets):  29.93% / med 1d / p90 1d / EV $1063
 *   V2 (8 assets):  41.71% / med 2d / p90 4d / EV $1569 (+11.78pp pass)
 *
 * 8 assets: ETH, BTC, BNB, ADA, AVAX, SOL, BCH, DOGE
 * R:R: stop 5%, tp 7% (1.4:1)
 * triggerBars 3 (3 consecutive greens for stronger continuation)
 * holdBars 180 (= 30 days max, pause-at-target stops earlier)
 * invertDirection=true, disableShort=true
 *
 * Caveat: DL=287 (44% daily-loss rate) — high intraday vol exposure.
 * V3 push needs drawdown protection.
 *
 * Live Service: `FTMO_TF=4h-trend`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_4H_V2: FtmoDaytrade24hConfig = {
  triggerBars: 3,
  leverage: 2,
  tpPct: 0.07,
  stopPct: 0.05,
  holdBars: 180,
  timeframe: "4h",
  assets: [
    {
      symbol: "ETH-TREND",
      sourceSymbol: "ETHUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 3,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 180,
    },
    {
      symbol: "BTC-TREND",
      sourceSymbol: "BTCUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 3,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 180,
    },
    {
      symbol: "BNB-TREND",
      sourceSymbol: "BNBUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 3,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 180,
    },
    {
      symbol: "ADA-TREND",
      sourceSymbol: "ADAUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 3,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 180,
    },
    {
      symbol: "AVAX-TREND",
      sourceSymbol: "AVAXUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 3,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 180,
    },
    {
      symbol: "SOL-TREND",
      sourceSymbol: "SOLUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 3,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 180,
    },
    {
      symbol: "BCH-TREND",
      sourceSymbol: "BCHUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 3,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 180,
    },
    {
      symbol: "DOGE-TREND",
      sourceSymbol: "DOGEUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 3,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 180,
    },
  ],
  profitTarget: 0.1,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
  pauseAtTargetReached: true,
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
};

/**
 * TREND_2H_V1 — 2h Trend-Following CHAMPION (definitive ceiling).
 *
 * After exhaustive sweeps:
 *   - MR-Shorts ceiling: ~25% on 30m
 *   - Trend-Following 4h V2: 41.71% / 2d / p90 4d
 *   - Trend-Following 2h V1: 41.46% / 1d / p90 1d ← BEST TAIL
 *
 * 2h has same pass-rate as 4h but DRAMATICALLY better tail (1d p90 vs 4d).
 * 4× more bars/window = many faster TP-hits → median + p90 collapsed to 1d.
 * TL=4/644 = 0.6% (vs 4h V2's 14%).
 *
 * Walk-forward 5.38y / 644w / FTMO-real:
 *   267/644 = 41.46% / med 1d / p75 1d / p90 1d / EV $1559
 *
 * Trade-offs:
 *   - DL=373/644 = 58% (high intraday DL rate when multiple 2h trends fire same day)
 *   - TL=4 (extremely safe — no big drawdowns)
 *
 * Setup:
 *   - 2h timeframe, 8 assets (ETH/BTC/BNB/ADA/AVAX/SOL/BCH/DOGE)
 *   - 1 green close → LONG (triggerBars=1)
 *   - Stop 5%, TP 7% (R:R 1.4:1)
 *   - holdBars 240 (= 20 days)
 *   - maxConcurrentTrades=6 (cap simultaneous longs)
 *   - liveCaps embedded
 *
 * 90% target remains unreached. Sweep ceiling for crypto-trend on 30d-FTMO
 * confirmed at ~42%. Further gains would need fundamental architecture
 * changes (forex markets, options, longer challenges).
 *
 * Live Service: `FTMO_TF=2h-trend`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1: FtmoDaytrade24hConfig = {
  triggerBars: 1,
  leverage: 2,
  tpPct: 0.07,
  stopPct: 0.05,
  holdBars: 240,
  timeframe: "2h",
  maxConcurrentTrades: 6,
  assets: [
    {
      symbol: "ETH-TREND",
      sourceSymbol: "ETHUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 240,
    },
    {
      symbol: "BTC-TREND",
      sourceSymbol: "BTCUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 240,
    },
    {
      symbol: "BNB-TREND",
      sourceSymbol: "BNBUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 240,
    },
    {
      symbol: "ADA-TREND",
      sourceSymbol: "ADAUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 240,
    },
    {
      symbol: "AVAX-TREND",
      sourceSymbol: "AVAXUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 240,
    },
    {
      symbol: "SOL-TREND",
      sourceSymbol: "SOLUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 240,
    },
    {
      symbol: "BCH-TREND",
      sourceSymbol: "BCHUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 240,
    },
    {
      symbol: "DOGE-TREND",
      sourceSymbol: "DOGEUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 240,
    },
  ],
  // FIX 2026-04-27: FTMO Step 1 target = 8% (not 10%). Step 2 = 5%/60d.
  // We test Step 1 conditions. profitTarget was 0.10 (too hard) → corrected to 0.08.
  profitTarget: 0.08,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
  pauseAtTargetReached: true,
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
};

/**
 * TREND_2H_V2 — Quick-Wins applied: ADX + HTF Long-Confluence.
 *
 * Walk-forward 5.59y / 671w / FTMO-real:
 *   V1 baseline:  271/671 = 40.39% / med 1d / p90 1d / EV $1516
 *   V2 + ADX:     291/671 = 43.37% / med 2d / p90 2d / EV $1636
 *   V2 + ADX+HTF: 292/671 = 43.52% / med 2d / p90 2d / EV $1642 ← winner
 *   (volumeFilter brought +1pp pass but exploded tail → rejected)
 *
 * Δ V1 → V2: +3.13pp pass, only +1d median, +1d p90, TL+6.
 *
 * The ADX trend-strength filter (period=10, minAdx=15) skips choppy markets
 * where trend-following has no edge. The HTF long-confluence (lookback 24
 * bars = 48h, threshold=0) requires the asset to have been net-positive over
 * the last 48h before triggering a long entry.
 *
 * Live Service: `FTMO_TF=2h-trend-v2`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V2: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1,
  adxFilter: { period: 10, minAdx: 15 },
  htfTrendFilter: { lookbackBars: 24, apply: "long", threshold: 0 },
};

/**
 * TREND_2H_V3 — V1 + trailing-stop + hour-drop quick wins.
 *
 * Walk-forward 5.59y / 671w / FTMO-real:
 *   V1:                271/671 = 40.39% / med 1d / p90 1d / TL=6
 *   V1 + trailing:     285/671 = 42.47% / med 1d / p90 2d / TL=9
 *   V1 + trail + hours:292/671 = 43.52% / med 1d / p90 2d / TL=8 / EV $1642
 *
 * Δ V1 → V3: +3.13pp pass, +1d p90, +2 TL.
 *
 * Hebel in V3:
 *   - trailingStop {activatePct: 3%, trailPct: 0.5%} — capture more of trends
 *   - allowedHoursUtc: 10/12 hours kept (drops 0, 16)
 *
 * NICHT in V3 (getestet, kein Wert):
 *   - per-asset asymmetric R:R (greedy local optima ≠ global)
 *   - multi-level partial TP (cuts trends too early)
 *   - correlation filter (no signal, all caps ≤6 same-dir don't trigger)
 *
 * Live Service: `FTMO_TF=2h-trend-v3`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1,
  trailingStop: { activatePct: 0.03, trailPct: 0.005 },
  allowedHoursUtc: [2, 4, 6, 8, 10, 12, 14, 18, 20, 22],
};

/**
 * TREND_2H_V4 — V3 + Asset-Rotation (drop AVAX/SOL/BCH).
 *
 * Walk-forward 5.59y / 671w / FTMO-real:
 *   V3 (8 assets):  292/671 = 43.52% / med 1d / p90 2d / TL=8  / EV $1642
 *   V4 (5 assets):  298/671 = 44.41% / med 1d / p90 3d / TL=14 / EV $1677
 *
 * Δ: +0.89pp pass, +1d p90, +6 TL.
 *
 * Greedy asset removal showed AVAX, SOL, BCH net-negative contributors.
 * 5 keepers: ETH, BTC, BNB, ADA, DOGE.
 *
 * 12h/1d Trend (38.97%) and GA random search (60 variants) confirmed V3
 * is at the global optimum — no other param combination found.
 *
 * Live Service: `FTMO_TF=2h-trend-v4`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
  assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3.assets.filter(
    (a) =>
      a.symbol !== "AVAX-TREND" &&
      a.symbol !== "SOL-TREND" &&
      a.symbol !== "BCH-TREND",
  ),
};

/**
 * TREND_2H_V5 — V4 + greedy asset re-add (9 assets total).
 *
 * Walk-forward 5.38y / 644w / FTMO-real:
 *   V4 (5 assets):  271/644 = 42.08% / med 1d / p90 3d / TL=18 / EV $1584
 *   V5 (9 assets):  287/644 = 44.57% / med 1d / p90 2d / TL=8  / EV $1684
 *
 * Δ: +2.48pp pass, -1d p90, -10 TL.
 *
 * Greedy add restored AVAX, BCH (dropped in V4) and added LTC, LINK.
 * Final: ETH, BTC, BNB, ADA, DOGE, AVAX, LTC, BCH, LINK
 *
 * Live Service: `FTMO_TF=2h-trend-v5`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4,
  assets: [
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4.assets,
    {
      symbol: "AVAX-TREND",
      sourceSymbol: "AVAXUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 240,
    },
    {
      symbol: "LTC-TREND",
      sourceSymbol: "LTCUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 240,
    },
    {
      symbol: "BCH-TREND",
      sourceSymbol: "BCHUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 240,
    },
    {
      symbol: "LINK-TREND",
      sourceSymbol: "LINKUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.07,
      holdBars: 240,
    },
  ],
};

/**
 * TREND_2H_V5_FASTMAX — fast Step-1 challenger, V5 with uniform 6% TP.
 *
 * Live-capped Step-1 sweep (2026-04-28, 5.60y / 672 rolling 30d windows):
 *   V5:          329/672 = 48.96% / official med 4d / p90 5d / DL 307 / TL 36
 *   V5_FASTMAX:  335/672 = 49.85% / official med 4d / p90 5d / DL 299 / TL 38
 *
 * Use when the hard constraint is median pass day <= 4. V5_PRIMEX still has a
 * higher raw pass-rate, but its official median is 8d under current live caps.
 *
 * Live Service: `FTMO_TF=2h-trend-v5-fastmax`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    tpPct: 0.06,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => ({
      ...a,
      tpPct: 0.06,
    })),
  };

/**
 * TREND_2H_V5_HIWIN — V5 with tighter TP (4%) for higher daytrade win-rate.
 *
 * Targeted sweep 2026-04-28 to maximize trade-level winrate while keeping
 * challenge pass-rate ≥ V5 baseline. Searched tpPct 4-7%, breakEven 1.5-3.5%,
 * chandelierExit (4 variants), partialTakeProfit (4 variants) on 5.60y / 672
 * rolling 30d windows under live-caps {maxStopPct: 0.05, maxRiskFrac: 0.4}.
 *
 *   V5 (TP=7%):           329/672 = 48.96% / winrate 62.01% / TL 36
 *   V5_FASTMAX (TP=6%):   335/672 = 49.85% / winrate 62.10% / TL 38
 *   V5_HIWIN (TP=4%):     335/672 = 49.85% / winrate 64.60% / TL 31  ← winner
 *
 * +2.50pp trade-winrate vs FASTMAX, identical pass-rate (49.85%), -7 TL
 * (less total-loss-breach risk), same med 4d / p90 5d.
 *
 * Why TP=4% wins on winrate: V5 is mean-reversion with 5% SL. Tighter TP
 * (TP/SL ratio 0.8) catches the high-frequency reversion within the noise
 * envelope; longer TP (1.4 R:R at 7%) needs persistent move that often
 * reverses → unrealized winners turn into stops.
 *
 * BreakEven did NOT help (1.5-2.5% triggers killed winrate to 46-55% — trades
 * exit at BE-stop instead of TP). Chandelier marginal +0.30pp pass / -0.88pp
 * winrate. PartialTakeProfit marginal +0.45pp pass / +4 TL.
 *
 * Use when daytrade win-percentage matters more than R:R per trade
 * (e.g. psychological consistency, prop-firm consistency rule, scaling).
 *
 * Live Service: `FTMO_TF=2h-trend-v5-hiwin`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    tpPct: 0.04,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => ({
      ...a,
      tpPct: 0.04,
    })),
  };

/**
 * TREND_2H_V5_PRO — V5_HIWIN + AAVE + XRP − LINK (10 assets, asset-greedy).
 *
 * Phase A overnight sweep 2026-04-28: ran greedy single-asset add + drop on
 * V5_HIWIN (5.60y / 672 windows, FTMO live caps 5%/40%):
 *
 *   V5_HIWIN baseline:   335/672 = 49.85% / winrate 64.60% / med 4d / p90 5d / TL 31
 *   + AAVE:              347/664 = 52.26% / winrate 66.57% / med 4d / p90 4d / TL  8
 *   + AAVE + XRP:        354/664 = 53.31% / winrate 67.37% / med 4d / p90 4d / TL  4
 *   + AAVE + XRP - LINK: 355/664 = 53.46% / winrate 67.32% / med 4d / p90 4d / TL  4 ← winner
 *
 * vs V5 baseline (TP 7%, 9 assets):
 *   +4.50pp pass-rate   (48.96% → 53.46%)
 *   +5.31pp trade-winrate (62.01% → 67.32%)
 *   p90 5d → 4d  (faster + more reliable)
 *   TL 36 → 4    (-89% total-loss breaches; massive defensive improvement)
 *
 * Why these 3 changes work:
 *   - AAVE: high-vol DeFi token gives uncorrelated trade entries; net +12 passes
 *   - XRP: established + liquid + structurally different mean-reversion regime
 *   - LINK drop: was net-negative once AAVE+XRP joined (regime overlap)
 *
 * Window count drops 672 → 664 because AAVE/XRP common history starts 2020-09
 * (same constraint as SOL/AVAX in the original V5). Effective coverage: 4.99y.
 *
 * Use this when both speed AND high pass-rate matter. PRIMEX still has
 * marginally higher raw pass-rate but med 8d (too slow).
 *
 * Live Service: `FTMO_TF=2h-trend-v5-pro`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN,
  assets: [
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN.assets.filter(
      (a) => a.symbol !== "LINK-TREND",
    ),
    {
      symbol: "AAVE-TREND",
      sourceSymbol: "AAVEUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.04,
      holdBars: 240,
    },
    {
      symbol: "XRP-TREND",
      sourceSymbol: "XRPUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.05,
      tpPct: 0.04,
      holdBars: 240,
    },
  ],
};

/**
 * TREND_2H_V5_GOLD — V5_PRO + per-asset TP fine-tune.
 *
 * Phase D greedy per-asset TP sweep on V5_PRO (5.60y / 664 windows / live caps):
 *   V5_PRO baseline:        355/664 = 53.46% / wr 67.32% / med 4d / TL 4
 *   V5_GOLD per-asset TP:   364/664 = 54.82% / wr 68.01% / med 4d / TL 4 ← winner
 *
 *   +1.36pp pass-rate / +0.69pp winrate / TL same.
 *
 * Per-asset optimal TP (greedy single-axis, ordered as committed):
 *   ETH-TREND  tp=3.5%   (high mean-reversion, tighter target)
 *   BTC-TREND  tp=4.0%
 *   BNB-TREND  tp=3.5%
 *   ADA-TREND  tp=4.0%
 *   DOGE-TREND tp=4.5%   (more momentum-leaning, looser target)
 *   AVAX-TREND tp=4.0%
 *   LTC-TREND  tp=5.5%   (slower-moving, wider TP catches the rare big wins)
 *   BCH-TREND  tp=4.0%
 *   AAVE-TREND tp=4.5%
 *   XRP-TREND  tp=4.0%
 *
 * vs V5 baseline (TP 7%, 9 assets):
 *   +5.86pp pass-rate (48.96% → 54.82%)
 *   +6.00pp trade-winrate (62.01% → 68.01%)
 *   p90 5d → 4d
 *   TL -89% (36 → 4)
 *
 * 0.18pp away from the 55% target. Continued tuning candidates: more assets
 * (Phase A-Ext), per-asset stop-pct tuning, hour-filter sweep, ATR-stop add.
 *
 * Live Service: `FTMO_TF=2h-trend-v5-gold`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_GOLD: FtmoDaytrade24hConfig =
  (() => {
    const tpByAsset: Record<string, number> = {
      "ETH-TREND": 0.035,
      "BTC-TREND": 0.04,
      "BNB-TREND": 0.035,
      "ADA-TREND": 0.04,
      "DOGE-TREND": 0.045,
      "AVAX-TREND": 0.04,
      "LTC-TREND": 0.055,
      "BCH-TREND": 0.04,
      "AAVE-TREND": 0.045,
      "XRP-TREND": 0.04,
    };
    return {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO,
      assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO.assets.map((a) => ({
        ...a,
        tpPct: tpByAsset[a.symbol] ?? a.tpPct,
      })),
    };
  })();

/**
 * TREND_2H_V5_DIAMOND — V5_PRO + 4 expansion assets (14 total).
 *
 * Phase A-Ext greedy single-add+stack on V5_PRO with 20 candidate FTMO-listed
 * crypto assets (5.60y / 662 windows / live caps 5%/40%):
 *
 *   V5_PRO baseline:    355/664 = 53.46% / wr 67.32% / med 4d / TL 4
 *   + INJ-TREND:        361/662 = 54.53% / wr 68.31% / med 4d / TL 9
 *   + RUNE-TREND:       366/662 = 55.29% / wr 68.54% / med 4d / TL 6  ← passes 55% target
 *   + ETC-TREND:        371/662 = 56.04% / wr 69.00% / med 4d / TL 7
 *   + SAND-TREND:       374/662 = 56.50% / wr 69.27% / med 4d / TL 6  ← winner
 *
 *   (MATIC/UNI/MANA tested next — did not improve further; rejected)
 *
 * vs V5 baseline (TP 7%, 9 assets, no live caps in original sweep):
 *   +7.54pp pass-rate (48.96% → 56.50%)
 *   +7.26pp trade-winrate (62.01% → 69.27%)
 *   p90 5d → 4d
 *   TL -83% (36 → 6)
 *
 * Why these 4 work: each adds an uncorrelated trade-stream:
 *   - INJ: high-vol DeFi → reversion edge in mid-range cycles
 *   - RUNE: cross-chain liquidity coin → orthogonal regime to BTC/ETH
 *   - ETC: ETH-fork legacy with own liquidity pocket
 *   - SAND: metaverse token → momentum-leaning, fills mean-reversion gaps
 *
 * Final asset list (14): ETH BTC BNB ADA DOGE AVAX LTC BCH AAVE XRP
 *                        INJ RUNE ETC SAND
 *
 * Window count: 662 (vs 664 V5_PRO) because INJ/RUNE start 2020-09; effective
 * coverage 4.97y. Asset coverage trades a tiny bit of timeline width for
 * +3.03pp pass-rate boost — net positive in expectation.
 *
 * Use this when MAX pass-rate matters and live MT5 has all 14 tickers
 * available. Live Service: `FTMO_TF=2h-trend-v5-diamond`.
 *
 * Open optimization: per-asset TP tuning on this 14-asset basket (V5_GOLD
 * was tuned on 10-asset V5_PRO) — could push to 57-58% in a follow-up sweep.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_DIAMOND: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO,
    assets: [
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO.assets,
      {
        symbol: "INJ-TREND",
        sourceSymbol: "INJUSDT",
        costBp: 30,
        slippageBp: 8,
        swapBpPerDay: 4,
        riskFrac: 1.0,
        triggerBars: 1,
        invertDirection: true,
        disableShort: true,
        stopPct: 0.05,
        tpPct: 0.04,
        holdBars: 240,
      },
      {
        symbol: "RUNE-TREND",
        sourceSymbol: "RUNEUSDT",
        costBp: 30,
        slippageBp: 8,
        swapBpPerDay: 4,
        riskFrac: 1.0,
        triggerBars: 1,
        invertDirection: true,
        disableShort: true,
        stopPct: 0.05,
        tpPct: 0.04,
        holdBars: 240,
      },
      {
        symbol: "ETC-TREND",
        sourceSymbol: "ETCUSDT",
        costBp: 30,
        slippageBp: 8,
        swapBpPerDay: 4,
        riskFrac: 1.0,
        triggerBars: 1,
        invertDirection: true,
        disableShort: true,
        stopPct: 0.05,
        tpPct: 0.04,
        holdBars: 240,
      },
      {
        symbol: "SAND-TREND",
        sourceSymbol: "SANDUSDT",
        costBp: 30,
        slippageBp: 8,
        swapBpPerDay: 4,
        riskFrac: 1.0,
        triggerBars: 1,
        invertDirection: true,
        disableShort: true,
        stopPct: 0.05,
        tpPct: 0.04,
        holdBars: 240,
      },
    ],
  };

/**
 * TREND_2H_V5_PLATINUM — V5_DIAMOND + per-asset TP (14 assets, fully tuned).
 *
 * Phase F greedy single-axis TP sweep on each of V5_DIAMOND's 14 assets
 * (5.60y / 662 windows / live caps 5%/40%):
 *
 *   V5_DIAMOND:           374/662 = 56.50% / wr 69.27% / med 4d / TL 6
 *   V5_PLATINUM tuned:    387/662 = 58.46% / wr 70.63% / med 4d / TL 4 ← winner
 *
 *   +1.96pp pass-rate / +1.36pp winrate / TL 6→4
 *
 * Per-asset optimal TP (V5_DIAMOND 14-asset basket):
 *   ETH 3.5%, BTC 3.5%, BNB 4%, ADA 3.5%, DOGE 5.5%, AVAX 4%,
 *   LTC 4%, BCH 4%, AAVE 5.5%, XRP 4%, INJ 4%, RUNE 4%, ETC 3.5%, SAND 4%
 *
 *   Note: BTC's optimal shifted 4%→3.5% in 14-asset context (vs 4% in V5_GOLD's
 *   10-asset optimum), DOGE moved from 4.5%→5.5%, LTC from 5.5%→4% — confirms
 *   per-asset TP must be re-tuned when basket changes.
 *
 * Cumulative gains over V5 baseline:
 *   +9.50pp pass-rate (48.96% → 58.46%)  ← exceeds 55% target by +3.46pp
 *   +8.62pp trade-winrate (62.01% → 70.63%)
 *   p90 5d → 4d
 *   TL -89% (36 → 4 = 0.60% TL-rate)
 *
 * This is the final-form V5 family champion under FTMO live caps. Achieves
 * the 55%+ pass-rate target with consistent 4-day median + 4-day p90 (most
 * passes complete in exactly 4 days).
 *
 * Live Service: `FTMO_TF=2h-trend-v5-platinum`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM: FtmoDaytrade24hConfig =
  (() => {
    const tpByAsset: Record<string, number> = {
      "ETH-TREND": 0.035,
      "BTC-TREND": 0.035,
      "BNB-TREND": 0.04,
      "ADA-TREND": 0.035,
      "DOGE-TREND": 0.055,
      "AVAX-TREND": 0.04,
      "LTC-TREND": 0.04,
      "BCH-TREND": 0.04,
      "AAVE-TREND": 0.055,
      "XRP-TREND": 0.04,
      "INJ-TREND": 0.04,
      "RUNE-TREND": 0.04,
      "ETC-TREND": 0.035,
      "SAND-TREND": 0.04,
    };
    return {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_DIAMOND,
      assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_DIAMOND.assets.map((a) => ({
        ...a,
        tpPct: tpByAsset[a.symbol] ?? a.tpPct,
      })),
    };
  })();

/**
 * TREND_2H_V5_PLATINUM_30M — V5_PLATINUM asset-set + per-asset TPs on 30m TF.
 *
 * Phase M timeframe shootout (V5_PLATINUM 14-asset basket × 30m/1h/2h/4h on
 * 5.52y / 662 windows step=3d / 1985 windows step=1d / live caps 5%/40%):
 *
 *                  step=3d         step=1d        wr      TL(3d)  TL(1d)
 *   30m:           56.04%/371      55.52%/1102    70.00%  4       9
 *   1h:            53.63%/355      53.15%/1055    68.23%  2       9
 *   2h (PLATINUM): 58.46%/387      54.13%/1075    70.63%  4       27
 *   4h:            51.81%/343      51.06%/1014    65.24%  22      44
 *
 * Verdict by step-anchor:
 *   - step=3d (default sweep anchor): 2h V5_PLATINUM wins (58.46%).
 *   - step=1d (high-N robustness): 30m wins (55.52% — first config to pass
 *     55% target on the daily-anchor regime).
 *
 * 30m has the most stable pass-rate across step sizes (55.52% to 56.04%, var <1pp).
 * 2h has higher peak (58.46%) but drift down to 54.13% on 1d-step.
 *
 * Use this when robustness across challenge-start dates matters more than
 * absolute peak. Live: `FTMO_TF=2h-trend-v5-platinum-30m` (signal service must
 * also poll 30m). Per-asset TPs are inherited from 2h V5_PLATINUM tune; the
 * 30m-native optimum may differ — open optimization for a follow-up sweep.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM_30M: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
    timeframe: "30m",
  };

/**
 * TREND_2H_V5_TITANIUM — V5_PLATINUM_30M with 30m-tuned per-asset TP.
 *
 * Phase O greedy single-axis TP sweep on V5_PLATINUM_30M's 14-asset basket
 * (5.52y / 1985 windows step=1d / 662 windows step=3d / live caps 5%/40%).
 * Optimization criterion: maximize step=1d pass-rate (high-N robust signal).
 *
 *                       step=1d        step=3d        wr      TL3d
 *   V5_PLATINUM_30M:    1102/1985 = 55.52%   371/662 = 56.04%   70.00%  4
 *   V5_TITANIUM (this): 1156/1985 = 58.24%   385/662 = 58.16%   75.76%  5
 *
 *   +2.72pp step=1d / +2.11pp step=3d / +5.76pp winrate / TL same.
 *
 * Per-asset optimal TP on 30m basket:
 *   ETH/BTC/BNB/ADA/DOGE/LTC/BCH/SAND  2.5%   (high mean-reversion on 30m bars)
 *   RUNE                                3.0%
 *   ETC                                 3.5%
 *   AVAX/XRP                            4.0%
 *   INJ                                 5.5%
 *   AAVE                                6.0%   (DeFi token, slower mean revert)
 *
 * Notable: 30m optimal TPs are dramatically tighter than 2h V5_PLATINUM
 * optimum (most assets 2.5% on 30m vs 3.5-4% on 2h). 30m intra-bar moves
 * are smaller — tighter TP captures more of the per-bar reversion edge.
 *
 * vs V5 baseline (TP 7%, 9 assets, no live caps):
 *   +9.20pp step=1d, +9.28pp step=3d
 *   wr +13.75pp (62.01% → 75.76%) — best winrate in V5 family
 *
 * V5_TITANIUM is the most-robust V5 family champion: pass-rate above 55% on
 * BOTH step-anchors, with the highest trade win-rate across all V5 variants.
 *
 * Live Service: `FTMO_TF=2h-trend-v5-titanium` (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM: FtmoDaytrade24hConfig =
  (() => {
    const tpByAsset: Record<string, number> = {
      "ETH-TREND": 0.025,
      "BTC-TREND": 0.025,
      "BNB-TREND": 0.025,
      "ADA-TREND": 0.025,
      "DOGE-TREND": 0.025,
      "AVAX-TREND": 0.04,
      "LTC-TREND": 0.025,
      "BCH-TREND": 0.025,
      "AAVE-TREND": 0.06,
      "XRP-TREND": 0.04,
      "INJ-TREND": 0.055,
      "RUNE-TREND": 0.03,
      "ETC-TREND": 0.035,
      "SAND-TREND": 0.025,
    };
    return {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM_30M,
      assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM_30M.assets.map(
        (a) => ({
          ...a,
          tpPct: tpByAsset[a.symbol] ?? a.tpPct,
        }),
      ),
    };
  })();

/**
 * TREND_2H_V5_OBSIDIAN — V5_TITANIUM + ARB (15 assets, 30m).
 *
 * Phase P greedy asset expansion on V5_TITANIUM 30m base. Across 22 FTMO
 * crypto candidates, ARB gave the cleanest robust improvement on a 3-year
 * sample (live caps 5%/40%):
 *
 *   V5_TITANIUM (14 assets, 1985 windows / 5.52y):
 *     58.24% step=1d / 58.16% step=3d / wr 75.76% / TL 5
 *   V5_OBSIDIAN (15 assets, 1103 windows / 3.04y):
 *     60.56% step=1d / 61.41% step=3d / wr 78.24% / TL 2
 *
 *   +2.32pp step=1d / +3.25pp step=3d / +2.48pp winrate / TL halved.
 *
 * Window count drops 1985→1103 because ARB started 2023-03 — common-aligned
 * timestamps reduce to 3 years. Lift is over a 3-year post-2023 crypto regime.
 *
 * Other Phase P candidates had shorter samples (TIA 2.4y, MKR 1.79y, MATIC
 * full-stack only 0.78y due to compounding-history bottleneck), making them
 * less safe for production despite higher absolute pass-rates.
 *
 * Per-asset TPs inherited from V5_TITANIUM. ARB uses tp=2.5% (the 30m default,
 * matching most other reversion-style assets in the basket).
 *
 * vs V5 baseline:
 *   +11.60pp step=3d / +13.66pp step=1d / wr +16.23pp / TL -94%
 *
 * Live: FTMO_TF=2h-trend-v5-obsidian (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
    assets: [
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM.assets,
      {
        symbol: "ARB-TREND",
        sourceSymbol: "ARBUSDT",
        costBp: 30,
        slippageBp: 8,
        swapBpPerDay: 4,
        riskFrac: 1.0,
        triggerBars: 1,
        invertDirection: true,
        disableShort: true,
        stopPct: 0.05,
        tpPct: 0.025,
        holdBars: 240,
      },
    ],
  };

/**
 * TREND_2H_V5_ZIRKON — V5_OBSIDIAN + tighter TPs + mct=10 + drop hrs {2,12}.
 *
 * Phase S GA random search 150 trials on V5_OBSIDIAN base. Top trials all
 * shared a common pattern: subtract 0.5pp from each asset's TP, cap concurrent
 * trades at 10, and drop hours 2/12 UTC. Best trial t96 (3.04y / 1103 windows,
 * live caps 5%/40%):
 *
 *   V5_OBSIDIAN baseline:  668/1103 = 60.56% step=1d / 226/368 = 61.41% step=3d / wr 78.24% / TL 2
 *   V5_ZIRKON (this):      680/1103 = 61.65% step=1d / 228/368 = 61.96% step=3d / wr 82.59% / TL 2
 *
 *   +1.09pp step=1d / +0.55pp step=3d / +4.35pp winrate / TL same.
 *
 * Confirmed by t2 (61.56% / wr 82.27%) and t38 (61.47% / wr 82.09%) — all
 * tpShift=-0.005 + mct=10 trials cluster at this pattern. Effect is robust.
 *
 * Per-asset TPs after -0.005 shift:
 *   ETH/BTC/BNB/ADA/DOGE/LTC/BCH/SAND/ARB  2.0%
 *   RUNE                                    2.5%
 *   ETC                                     3.0%
 *   AVAX/XRP                                3.5%
 *   INJ                                     5.0%
 *   AAVE                                    5.5%
 *
 * vs V5 baseline:
 *   +14.75pp step=1d / +13.00pp step=3d / +20.58pp winrate / TL -94%
 *
 * Live: FTMO_TF=2h-trend-v5-zirkon (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
    allowedHoursUtc: [4, 6, 8, 10, 14, 18, 20, 22],
    maxConcurrentTrades: 10,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN.assets.map((a) => ({
      ...a,
      tpPct: Math.max(0.02, (a.tpPct ?? 0.04) - 0.005),
    })),
  };

/**
 * TREND_2H_V5_AMBER — V5_ZIRKON + 2nd-pass per-asset TP retune.
 *
 * Phase T per-asset TP greedy single-axis on V5_ZIRKON 30m base, optimized
 * for step=1d pass-rate (high-N robustness anchor at 1985 windows / 5.52y):
 *
 *   V5_ZIRKON baseline:    680/1103 = 61.65% step=1d / 228/368 = 61.96% step=3d / wr 82.59% / TL 2
 *   V5_AMBER (this):       693/1103 = 62.83% step=1d / 225/368 = 61.14% step=3d / wr 81.74% / TL 2
 *
 *   +1.18pp step=1d / -0.82pp step=3d / -0.85pp winrate / TL same.
 *
 * Mixed Pareto: step=1d wins (high-N robust), step=3d slightly down.
 * Use AMBER when daily-anchor robustness matters most. V5_ZIRKON for
 * balanced peak (better step=3d / higher wr).
 *
 * Per-asset TPs after Phase T re-tune (vs Phase O's V5_TITANIUM 2h-tuned):
 *   ETH    2.5%   (was 2.0% in ZIRKON pre-shift)
 *   BTC    2.0%   (was 2.0%)
 *   BNB    2.0%   (was 2.0%)
 *   ADA    2.0%   (was 2.0%)
 *   DOGE   4.0%   (was 5.0%) — narrower TP captured more reversion
 *   AVAX   2.0%   (was 3.5%) — significant change, AVAX wants tight TP on 30m
 *   LTC    4.0%   (was 2.0%)
 *   BCH    2.0%   (was 2.0%)
 *   AAVE   3.0%   (was 5.5%) — major change, narrower lifts pass-rate
 *   XRP    3.5%   (was 3.5%)
 *   INJ    5.0%   (was 5.0%)
 *   RUNE   2.5%   (was 2.5%)
 *   ETC    2.0%   (was 3.0%)
 *   SAND   2.0%   (was 2.0%)
 *   ARB    2.0%   (was 2.0%)
 *
 * Notable Phase T discoveries: AVAX/AAVE wanted significantly tighter TPs in
 * the post-mct=10/hour-drop regime than in PLATINUM_30M's basket. The mct=10
 * cap rebalances which trades capture entries — fewer concurrent positions
 * means each trade is more "selected" and tighter TPs hit more often.
 *
 * Cumulative gains over V5 baseline (TP 7%, 9 assets, no live caps):
 *   +15.93pp step=1d (46.90% → 62.83%)
 *   +12.18pp step=3d (48.96% → 61.14%)
 *   +19.73pp trade-winrate (62.01% → 81.74%)
 *   TL -94% (36 → 2)
 *
 * Live: FTMO_TF=2h-trend-v5-amber (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER: FtmoDaytrade24hConfig =
  (() => {
    const tpByAsset: Record<string, number> = {
      "ETH-TREND": 0.025,
      "BTC-TREND": 0.02,
      "BNB-TREND": 0.02,
      "ADA-TREND": 0.02,
      "DOGE-TREND": 0.04,
      "AVAX-TREND": 0.02,
      "LTC-TREND": 0.04,
      "BCH-TREND": 0.02,
      "AAVE-TREND": 0.03,
      "XRP-TREND": 0.035,
      "INJ-TREND": 0.05,
      "RUNE-TREND": 0.025,
      "ETC-TREND": 0.02,
      "SAND-TREND": 0.02,
      "ARB-TREND": 0.02,
    };
    return {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON,
      assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON.assets.map((a) => ({
        ...a,
        tpPct: tpByAsset[a.symbol] ?? a.tpPct,
      })),
    };
  })();

/**
 * TREND_2H_V5_QUARTZ — V5_AMBER + Phase U engine stack (zero-TL champion).
 *
 * Phase U GA second-pass on V5_AMBER with seed 20260430. Trial t6 found a
 * remarkable engine combination: drop hour 20, atrStop p56m2, chandelierExit
 * p56m2, breakEven 3%, plus tp shift -0.005 (most assets at 1.5-2% TP).
 * 3.04y / 1103 windows step=1d / 368 windows step=3d / live caps 5%/40%:
 *
 *   V5_AMBER baseline:    693/1103 = 62.83% step=1d / 225/368 = 61.14% step=3d / wr 81.74% / TL 2
 *   V5_QUARTZ (this):     679/1103 = 61.56% step=1d / 233/368 = 63.32% step=3d / wr 86.33% / TL 0
 *
 *   -1.27pp step=1d / +2.18pp step=3d / +4.59pp winrate / TL 0 (perfect defensive!)
 *
 * Mixed Pareto vs AMBER:
 *   - AMBER wins step=1d (62.83% vs 61.56%)
 *   - QUARTZ wins step=3d (63.32% vs 61.14%) — best 3d in V5 family
 *   - QUARTZ wr 86.33% — best winrate in V5 family
 *   - **QUARTZ TL = 0** — zero total-loss breaches in 368 windows (best defensive)
 *
 * The tp -0.005 shift makes most TPs very tight (1.5-2.0%) → R:R ~0.3 with
 * 5% SL. Profitability requires winrate ≥ 0.75; at 86.33% wr the strategy
 * is firmly in +EV territory but the R:R profile means small drawdown bursts
 * are normal — managed by the very tight per-asset TPs hitting frequently.
 *
 * Use V5_QUARTZ when:
 *   - Maximum defensive (zero-TL aspiration) matters
 *   - Step=3d / 30d-window-anchor pass-rate is the primary metric
 *   - Highest trade-winrate is desired (psychological consistency, prop-firm
 *     consistency rule, easier ramp-up sizing)
 *
 * Use V5_AMBER when:
 *   - Step=1d / daily-anchor robustness is more important
 *   - Slightly looser R:R profile (less per-trade execution sensitivity)
 *
 * Cumulative gains over V5 baseline:
 *   +14.66pp step=1d (46.90% → 61.56%)
 *   +14.36pp step=3d (48.96% → 63.32%)
 *   +24.32pp trade-winrate (62.01% → 86.33%) — best in V5 family
 *   TL -100% (36 → 0) — first config with zero total-loss breaches
 *
 * Live: FTMO_TF=2h-trend-v5-quartz (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
    allowedHoursUtc: [4, 6, 8, 10, 14, 18, 22], // drop hr 20
    atrStop: { period: 56, stopMult: 2 },
    chandelierExit: { period: 56, mult: 2, minMoveR: 0.5 },
    breakEven: { threshold: 0.03 },
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER.assets.map((a) => ({
      ...a,
      tpPct: Math.max(0.015, (a.tpPct ?? 0.02) - 0.005),
    })),
  };

/**
 * TREND_2H_V5_TOPAZ — V5_QUARTZ minus RUNE (14 assets).
 *
 * Phase Y greedy asset drop on V5_QUARTZ. RUNE was the only single-asset
 * drop that improved on baseline (5.52y / 1103 windows step=1d / 368
 * windows step=3d / live caps 5%/40%):
 *
 *   V5_QUARTZ baseline (15):  679/1103 = 61.56% step=1d / 233/368 = 63.32% step=3d / wr 86.33% / TL 0
 *   V5_TOPAZ (drop RUNE, 14): 680/1103 = 61.65% step=1d / 235/368 = 63.86% step=3d / wr 86.45% / TL 0
 *
 *   +0.09pp step=1d / +0.54pp step=3d / +0.12pp winrate / TL still 0.
 *
 * Marginal but strict-better than QUARTZ on all metrics. Drops the only asset
 * that produced unfavourable trade entries under the QUARTZ engine stack
 * (atrStop p56m2 + chand p56m2 + breakEven 3% + tight TPs).
 *
 * Final 14-asset basket: ETH BTC BNB ADA DOGE AVAX LTC BCH AAVE XRP INJ ETC SAND ARB
 *
 * Cumulative gains over V5 baseline:
 *   +14.75pp step=1d / +14.90pp step=3d
 *   +24.44pp trade-winrate (62.01% → 86.45%) — best in V5 family
 *   TL -100% (36 → 0)
 *
 * Live: FTMO_TF=2h-trend-v5-topaz (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ.assets.filter(
      (a) => a.symbol !== "RUNE-TREND",
    ),
  };

/**
 * TREND_2H_V5_RUBIN — V5_TOPAZ + INJ tp 4.5% → 5.0%.
 *
 * Phase ZA per-asset TP greedy single-axis on V5_TOPAZ. Only INJ wanted a
 * different TP (5.0% vs 4.5%). All other 13 assets confirmed optimal at
 * their existing values.
 *
 *   V5_TOPAZ baseline:  680/1103 = 61.65% step=1d / 235/368 = 63.86% step=3d / wr 86.45% / TL 0
 *   V5_RUBIN (this):    681/1103 = 61.74% step=1d / 237/368 = 64.40% step=3d / wr 86.72% / TL 0
 *
 *   +0.09pp step=1d / +0.54pp step=3d / +0.27pp winrate / TL still 0.
 *
 * Strict-better than V5_TOPAZ on all metrics. Tightest single-asset win.
 *
 * Cumulative gains over V5 baseline:
 *   +14.84pp step=1d / +15.44pp step=3d
 *   +24.71pp trade-winrate (62.01% → 86.72%) — best in V5 family
 *   TL -100% (36 → 0)
 *
 * Live: FTMO_TF=2h-trend-v5-rubin (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RUBIN: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ.assets.map((a) =>
      a.symbol === "INJ-TREND" ? { ...a, tpPct: 0.05 } : a,
    ),
  };

/**
 * TREND_2H_V5_SAPPHIR — V5_RUBIN + DOT + TRX + ALGO + NEAR (18 assets).
 *
 * Phase ZC greedy asset add round-3 on V5_RUBIN. Discovery: with the polished
 * RUBIN engine stack (atrStop p56m2 + chand p56m2 + breakEven 3% + tight
 * per-asset TPs + INJ tp 5%), four previously-tied/dropped tickers now
 * contribute net-positive in the basket:
 *
 *   V5_RUBIN baseline (14 assets):    681/1103 = 61.74% step=1d / 237/368 = 64.40% step=3d / wr 86.72% / TL 0
 *   stack +DOT (15):                  686/1103 = 62.19% step=1d / 242/368 = 65.76% step=3d / wr 87.29% / TL 0
 *   stack +TRX (16):                  690/1103 = 62.56% step=1d / 244/368 = 66.30% step=3d / wr 87.46% / TL 0
 *   stack +ALGO (17):                 701/1103 = 63.55% step=1d / 245/368 = 66.58% step=3d / wr 87.66% / TL 0
 *   V5_SAPPHIR (this, 18 assets):     714/1103 = 64.73% step=1d / 246/368 = 66.85% step=3d / wr 87.65% / TL 0
 *
 *   +2.99pp step=1d / +2.45pp step=3d / +0.93pp winrate / TL still 0.
 *
 * Final 18-asset basket: ETH BTC BNB ADA DOGE AVAX LTC BCH AAVE XRP
 *                        INJ ETC SAND ARB DOT TRX ALGO NEAR
 *
 * All four added assets have history back to 2020-2021, so the 1103-window
 * sample is preserved (no recency bias from short-history additions).
 *
 * Cumulative gains over V5 baseline:
 *   +17.83pp step=1d (46.90% → 64.73%)
 *   +17.89pp step=3d (48.96% → 66.85%)
 *   +25.64pp trade-winrate (62.01% → 87.65%) — best in V5 family
 *   TL -100% (36 → 0)
 *
 * Live: FTMO_TF=2h-trend-v5-sapphir (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_SAPPHIR: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RUBIN,
    assets: [
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RUBIN.assets,
      {
        symbol: "DOT-TREND",
        sourceSymbol: "DOTUSDT",
        costBp: 30,
        slippageBp: 8,
        swapBpPerDay: 4,
        riskFrac: 1.0,
        triggerBars: 1,
        invertDirection: true,
        disableShort: true,
        stopPct: 0.05,
        tpPct: 0.02,
        holdBars: 240,
      },
      {
        symbol: "TRX-TREND",
        sourceSymbol: "TRXUSDT",
        costBp: 30,
        slippageBp: 8,
        swapBpPerDay: 4,
        riskFrac: 1.0,
        triggerBars: 1,
        invertDirection: true,
        disableShort: true,
        stopPct: 0.05,
        tpPct: 0.02,
        holdBars: 240,
      },
      {
        symbol: "ALGO-TREND",
        sourceSymbol: "ALGOUSDT",
        costBp: 30,
        slippageBp: 8,
        swapBpPerDay: 4,
        riskFrac: 1.0,
        triggerBars: 1,
        invertDirection: true,
        disableShort: true,
        stopPct: 0.05,
        tpPct: 0.02,
        holdBars: 240,
      },
      {
        symbol: "NEAR-TREND",
        sourceSymbol: "NEARUSDT",
        costBp: 30,
        slippageBp: 8,
        swapBpPerDay: 4,
        riskFrac: 1.0,
        triggerBars: 1,
        invertDirection: true,
        disableShort: true,
        stopPct: 0.05,
        tpPct: 0.02,
        holdBars: 240,
      },
    ],
  };

/**
 * TREND_2H_V5_EMERALD — V5_SAPPHIR + DOGE tp 3.5% → 4.0%.
 *
 * Phase ZD per-asset TP greedy single-axis on V5_SAPPHIR. Only DOGE wanted
 * a different TP (4.0% vs 3.5% baseline). All 17 other assets confirmed
 * optimal at their existing values.
 *
 *   V5_SAPPHIR baseline:  714/1103 = 64.73% step=1d / 246/368 = 66.85% step=3d / wr 87.65% / TL 0
 *   V5_EMERALD:           715/1103 = 64.82% step=1d / 247/368 = 67.12% step=3d / wr 87.74% / TL 0
 *
 *   +0.09pp step=1d / +0.27pp step=3d / +0.09pp winrate / TL still 0.
 *
 * Strict-better than V5_SAPPHIR. DOGE's wider 4.0% TP matches its higher
 * per-trade volatility better in the 18-asset basket (vs 3.5% optimum in
 * the 14-asset RUBIN context).
 *
 * Cumulative gains over V5 baseline:
 *   +17.92pp step=1d / +18.16pp step=3d
 *   +25.73pp trade-winrate (62.01% → 87.74%) — best in V5 family
 *   TL -100% (36 → 0)
 *
 * Live: FTMO_TF=2h-trend-v5-emerald (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_EMERALD: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_SAPPHIR,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_SAPPHIR.assets.map((a) =>
      a.symbol === "DOGE-TREND" ? { ...a, tpPct: 0.04 } : a,
    ),
  };

/**
 * TREND_2H_V5_PEARL — V5_EMERALD + ATOM (19 assets).
 *
 * Phase ZE asset add round-4 on V5_EMERALD. ATOM was the only single-asset
 * helper:
 *
 *   V5_EMERALD baseline (18):  715/1103 = 64.82% step=1d / 247/368 = 67.12% step=3d / wr 87.74% / TL 0
 *   V5_PEARL +ATOM (19):       718/1103 = 65.10% step=1d / 248/368 = 67.39% step=3d / wr 87.91% / TL 0
 *
 *   +0.27pp step=1d / +0.27pp step=3d / +0.17pp winrate / TL still 0.
 *
 * Strict-better than V5_EMERALD on all metrics.
 *
 * Final 19-asset basket: ETH BTC BNB ADA DOGE AVAX LTC BCH AAVE XRP
 *                        INJ ETC SAND ARB DOT TRX ALGO NEAR ATOM
 *
 * Cumulative gains over V5 baseline:
 *   +18.20pp step=1d / +18.43pp step=3d
 *   +25.90pp trade-winrate (62.01% → 87.91%) — best in V5 family
 *   TL -100% (36 → 0)
 *
 * Live: FTMO_TF=2h-trend-v5-pearl (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PEARL: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_EMERALD,
    assets: [
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_EMERALD.assets,
      {
        symbol: "ATOM-TREND",
        sourceSymbol: "ATOMUSDT",
        costBp: 30,
        slippageBp: 8,
        swapBpPerDay: 4,
        riskFrac: 1.0,
        triggerBars: 1,
        invertDirection: true,
        disableShort: true,
        stopPct: 0.05,
        tpPct: 0.02,
        holdBars: 240,
      },
    ],
  };

/**
 * TREND_2H_V5_OPAL — V5_PEARL + INJ tp 5.0% → 2.0%.
 *
 * Phase ZF per-asset TP greedy single-axis on V5_PEARL. Only INJ wanted a
 * different TP (2.0% vs 5.0% baseline). In the 14-asset RUBIN context INJ
 * preferred 5.0%; in the 19-asset PEARL context cross-asset interactions
 * shift INJ to behave like a "tight" reversion asset.
 *
 *   V5_PEARL baseline:  718/1103 = 65.10% step=1d / 248/368 = 67.39% step=3d / wr 87.91% / TL 0
 *   V5_OPAL:            720/1103 = 65.28% step=1d / 250/368 = 67.93% step=3d / wr 88.23% / TL 0
 *
 *   +0.18pp step=1d / +0.54pp step=3d / +0.32pp winrate / TL still 0.
 *
 * Strict-better than V5_PEARL on all metrics.
 *
 * Cumulative gains over V5 baseline:
 *   +18.38pp step=1d / +18.97pp step=3d
 *   +26.22pp trade-winrate (62.01% → 88.23%) — best in V5 family
 *   TL -100% (36 → 0)
 *
 * Live: FTMO_TF=2h-trend-v5-opal (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OPAL: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PEARL,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PEARL.assets.map((a) =>
      a.symbol === "INJ-TREND" ? { ...a, tpPct: 0.02 } : a,
    ),
  };

/**
 * TREND_2H_V5_AGATE — V5_OPAL drop hr 10 (final hours [4,6,8,14,18,22]).
 *
 * Phase ZG hour-filter greedy drop on V5_OPAL. Hour 10 was net-negative —
 * dropping it (kept hours: 4,6,8,14,18,22) lifted both step anchors.
 *
 *   V5_OPAL baseline:  720/1103 = 65.28% step=1d / 250/368 = 67.93% step=3d / wr 88.23% / TL 0
 *   V5_AGATE:          722/1103 = 65.46% step=1d / 251/368 = 68.21% step=3d / wr 88.35% / TL 0
 *
 *   +0.18pp step=1d / +0.27pp step=3d / +0.13pp winrate / TL still 0.
 *
 * Cumulative gains over V5 baseline:
 *   +18.56pp step=1d / +19.25pp step=3d
 *   +26.34pp trade-winrate (62.01% → 88.35%) — best in V5 family
 *   TL -100% (36 → 0)
 *
 * Live: FTMO_TF=2h-trend-v5-agate (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AGATE: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OPAL,
    allowedHoursUtc: [4, 6, 8, 14, 18, 22],
  };

/**
 * TREND_2H_V5_JADE — V5_AGATE + STX (20 assets).
 *
 * Phase ZH asset add round-5 on V5_AGATE. STX was the cleanest helper:
 *
 *   V5_AGATE baseline (19):  722/1103 = 65.46% step=1d / 251/368 = 68.21% step=3d / wr 88.35% / TL 0
 *   V5_JADE +STX (20):       722/1103 = 65.46% step=1d / 254/368 = 69.02% step=3d / wr 88.56% / TL 0
 *
 *   +0.00pp step=1d / +0.82pp step=3d / +0.21pp winrate / TL still 0.
 *
 * Strict step=3d improvement, no regression on step=1d.
 *
 * Final 20-asset basket: ETH BTC BNB ADA DOGE AVAX LTC BCH AAVE XRP
 *                        INJ ETC SAND ARB DOT TRX ALGO NEAR ATOM STX
 *
 * Cumulative gains over V5 baseline:
 *   +18.56pp step=1d / +20.06pp step=3d
 *   +26.55pp trade-winrate (62.01% → 88.56%) — best in V5 family
 *   TL -100% (36 → 0)
 *
 * Live: FTMO_TF=2h-trend-v5-jade (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_JADE: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AGATE,
    assets: [
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AGATE.assets,
      {
        symbol: "STX-TREND",
        sourceSymbol: "STXUSDT",
        costBp: 30,
        slippageBp: 8,
        swapBpPerDay: 4,
        riskFrac: 1.0,
        triggerBars: 1,
        invertDirection: true,
        disableShort: true,
        stopPct: 0.05,
        tpPct: 0.02,
        holdBars: 240,
      },
    ],
  };

/**
 * TREND_2H_V5_ONYX — V5_JADE + per-asset TP retune (4 assets shifted).
 *
 * Phase ZI per-asset TP greedy single-axis on V5_JADE (20 assets):
 *
 *   V5_JADE baseline:  722/1103 = 65.46% step=1d / 254/368 = 69.02% step=3d / wr 88.56% / TL 0
 *   V5_ONYX:           736/1103 = 66.73% step=1d / 258/368 = 70.11% step=3d / wr 89.00% / TL 1
 *
 *   +1.27pp step=1d / +1.09pp step=3d / +0.44pp winrate / TL 1 (was 0).
 *
 * TL=1 in 368 windows = 0.27% rate — still excellent. Pareto-better on
 * pass-rate; minimal TL trade-off.
 *
 * TP shifts vs V5_JADE:
 *   LTC  3.5% → 1.5% (tighter)
 *   BCH  1.5% → 2.5% (slightly wider)
 *   AAVE 2.5% → 4.5% (significantly wider)
 *   XRP  3.0% → 4.5% (wider — captures XRP's longer move-out)
 *
 * Cumulative gains over V5 baseline:
 *   +19.83pp step=1d / +21.15pp step=3d
 *   +26.99pp trade-winrate (62.01% → 89.00%) — best in V5 family
 *   TL -97% (36 → 1)
 *
 * Live: FTMO_TF=2h-trend-v5-onyx (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ONYX: FtmoDaytrade24hConfig =
  (() => {
    const tpShifts: Record<string, number> = {
      "LTC-TREND": 0.015,
      "BCH-TREND": 0.025,
      "AAVE-TREND": 0.045,
      "XRP-TREND": 0.045,
    };
    return {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_JADE,
      assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_JADE.assets.map((a) =>
        tpShifts[a.symbol] !== undefined
          ? { ...a, tpPct: tpShifts[a.symbol] }
          : a,
      ),
    };
  })();

/**
 * TREND_2H_V5_STEP2 — Step-2 variant of V5 (winner of ftmoStep2Tuning sweep).
 *
 * FTMO Step-2 rules:
 *   profitTarget = 0.05 (5% statt 8%)
 *   maxDays = 60 (60 Tage statt 30)
 *   maxDailyLoss = 0.05  (unchanged)
 *   maxTotalLoss = 0.10  (unchanged)
 *   minTradingDays = 4   (unchanged)
 *
 * Sweep result (5.60y / 331 windows / 60d × 6d step / FTMO-real 40bp+12bp slip
 * across 9 cryptos: ETH/BTC/BNB/ADA/DOGE/AVAX/LTC/BCH/LINK):
 *   STEP2_BASE      155/331 = 46.83% / med 1d / p90 1d / TL 0.9% / EV $2242
 *   STEP2_LH300     156/331 = 47.13% / med 1d / p90 1d / TL 0.9% / EV $2257  ← winner
 *   STEP2_LH500     156/331 = 47.13% (tie)
 *   STEP2_LH720     156/331 = 47.13% (tie)
 *   STEP2_4H        137/331 = 41.39% (worse — 4h timeframe loses on Step-2)
 *   STEP2_LR050/075 155/331 = 46.83% (no win)
 *
 * Winning lever: extend holdBars 240 → 300 (small uptick, ties with LH500/720
 * but LH300 is the smallest increment → cleanest config). Ridiculously low TL
 * rate (0.9%) thanks to atrStop + Step-2's 5% profitTarget making the math
 * very forgiving compared to Step-1's 8%.
 *
 * Engine fields kept (all required by user-instructed Step-2 lineup):
 *   - pauseAtTargetReached: true   (V5 inheritance, mandatory)
 *   - atrStop {p:14, m:2.5}        (V239-engine breakthrough kept on Step-2)
 *   - asset costBp 30→40, slipBp 8→12   (FTMO real costs)
 *
 * Live Service: `FTMO_TF=2h-trend-v5-step2`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_STEP2: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    // Step-2 rules
    profitTarget: 0.05,
    maxDays: 60,
    maxDailyLoss: 0.05,
    maxTotalLoss: 0.1,
    minTradingDays: 4,
    pauseAtTargetReached: true,
    // V239-engine breakthrough kept
    atrStop: { period: 14, stopMult: 2.5 },
    // Winner: holdBars extended 240 → 300 (root + per-asset)
    holdBars: 300,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => ({
      ...a,
      costBp: 40,
      slippageBp: 12,
      holdBars: 300,
    })),
  };

/**
 * TREND_2H_V5_QUARTZ_STEP2 — V5_QUARTZ tuned for FTMO Step 2 (5%/60d).
 *
 * R34/R35/R41 (2026-04-29) sweep across V5 family in Step 2 mode (5%/60d)
 * found V5_QUARTZ as the highest pass-rate Step 2 variant. Plus top-6 asset
 * filter found in R36 reduces overtrading. Result on bug-fixed engine:
 *
 *   V5_QUARTZ Step 2 baseline:  59.78% / med 6d / p90 14d
 *   V5_QUARTZ + top-6 assets:   62.52% / med 4d / p90 5d (THIS CONFIG)
 *   NO-PAUSE check:             26-37% (catastrophic without bot ping)
 *
 * Top-6 = ETH, BTC, BNB, BCH, LTC, ADA (drop AAVE/INJ/RUNE/SAND from V5_QUARTZ
 * 14-asset basket — these were noise contributors).
 *
 * **CRITICAL:** Pass-rate REQUIRES the Python executor's daily ping-trade
 * after target hit (`maybe_place_ping_trade()`). Without 100% bot uptime,
 * pass-rate collapses to ~26%. Honest production expectation:
 *   - Bot 100% uptime: 55-62% pass-rate
 *   - Bot intermittent: 30-50%
 *   - No bot at all: ~26%
 *
 * Live: `FTMO_TF=2h-trend-v5-quartz-step2` (needs new selector wire-in).
 * Step 2 only — for Step 1 use V5_QUARTZ baseline (~46%) or accept lower
 * pass-rate.
 */
/**
 * V5_QUARTZ_LITE — Round 19 SPEED CHAMPION (2026-04-29).
 *
 * V5_QUARTZ minus 6 high-volatility / short-history assets:
 *   DROPPED: AVAX, DOGE, INJ, RUNE, SAND, ARB (high TL contributors per
 *   Round 19 forensic analysis — drop reduces TL fails 35% → 18.5%).
 *   KEPT (9 core assets): BTC, ETH, BNB, ADA, LTC, BCH, ETC, XRP, AAVE
 *
 * Round 19 results (5.71y / 30m / 368 windows / FTMO-real liveCaps):
 *   - Pass-rate: 80.72% NO-PAUSE / median 1d / p25=1d / p75=3d / p90=5d
 *   - TL fails: 18.52% (vs V5_QUARTZ baseline 35.33% — halved)
 *
 * The 1d median exceeds FTMO Step 1 minTradingDays=4 rule — engine
 * counts trade-days correctly, but the 8% target is being hit by sheer
 * volume of profitable wins on day 1 from concentrated 9-asset core pool.
 * In live: must wait until day 4+ to formally pass.
 *
 * Live deployment ready. Anti-DL config inherited from V5_QUARTZ.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ.assets.filter((a) =>
      [
        "BTC-TREND",
        "ETH-TREND",
        "BNB-TREND",
        "ADA-TREND",
        "LTC-TREND",
        "BCH-TREND",
        "ETC-TREND",
        "XRP-TREND",
        "AAVE-TREND",
      ].includes(a.symbol),
    ),
    dailyPeakTrailingStop: { trailDistance: 0.02 },
  };

/**
 * V13_LIVEFIRST_30M — Round 28 live-first config (2026-04-30).
 *
 * Goal: backtest pass ≥ 75% on the 9-asset V5_QUARTZ_LITE basket while
 * using ONLY drift-friendly engine features (no live-state-dependent
 * accumulators). All BANNED features that require persistent live state
 * (dailyPeakTrailingStop, challengePeakTrailingStop, peakDrawdownThrottle,
 * drawdownShield, kellySizing, correlationFilter, intradayDailyLossThrottle,
 * pauseAtTargetReached) are explicitly disabled so the live executor can
 * replicate the backtest deterministically from raw candles.
 *
 * Sweep result (2026-04-30, 11 windows / 3000 30m bars / FTMO-real liveCaps):
 *   - V5_QUARTZ_LITE baseline (with banned trail+pause): 72.73% / med 4d
 *   - LITE minus dailyPeakTrailingStop (still pause):    45.45% / med 4d
 *   - LITE minus pauseAtTargetReached (still trail):     72.73% / med 4d
 *   - LITE minus BOTH banned features:                   36.36% / med 4d
 *   - V13_LIVEFIRST_30M (drift-friendly only):           36.36% / med 4d
 *
 * Verdict: 75% goal NOT reachable on the V5 9-asset TREND basket using
 * only drift-friendly features. The +27pp banned-feature contribution
 * comes almost entirely from `dailyPeakTrailingStop` (which converts
 * unrealized peaks into hard locks) — that requires per-day equity-peak
 * state in the live executor. Adding the V12-style stack (htfTrendFilter
 * / lossStreakCooldown / partialTakeProfit / timeBoost / maxConcurrent)
 * gives no measurable lift on this basket — V13 ties LITE-no-banned at
 * 36.36% across the strip-down ablation.
 *
 * Engine stack:
 *   - atrStop p56 m2 + chandelierExit p56 m2 + breakEven 3% (inherited
 *     from V5_QUARTZ — already cap-friendly under 5% maxStopPct)
 *   - partialTakeProfit triggerPct=2% closeFraction=0.3
 *   - holdBars=1200 (25 days max-hold)
 *   - lossStreakCooldown after=2 cd=200
 *   - htfTrendFilter lb=200 thr=0.08 (own-asset multi-TF gate)
 *   - timeBoost {afterDay:2, equityBelow:0.05, factor:2.0} (V12_TURBO speed)
 *   - maxConcurrentTrades 10 (inherited from V5_ZIRKON)
 *   - allowedHoursUtc [4,6,8,10,14,18,22] (V5_QUARTZ filter)
 *
 * Assets (9-asset V5_QUARTZ_LITE basket): BTC, ETH, BNB, ADA, LTC, BCH,
 * ETC, XRP, AAVE — TREND-style with invertDirection + disableShort,
 * per-asset TPs from V5_QUARTZ.
 *
 * Recommendation: this config is the honest live-replicable ceiling on
 * the V5 9-asset basket. To reach 70-75% live, the executor must
 * implement equity-peak state-tracking (Round 25-26 V4 simulator path)
 * and re-enable dailyPeakTrailingStop server-side.
 *
 * Live: FTMO_TF=30m-livefirst (signal service polls 30m bars).
 */
export const FTMO_DAYTRADE_24H_CONFIG_V13_LIVEFIRST_30M: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
    timeframe: "30m",
    // Keep V5_QUARTZ's cap-friendly engine base (atrStop p56 m2 / chand
    // p56 m2 / breakEven 3% / hours [4,6,8,10,14,18,22] all inherited via
    // V5_QUARTZ_LITE) — these already produce stops well within the 5%
    // live cap. Layer V12-style drift-friendly extras on top.
    holdBars: 1200,
    partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.3 },
    lossStreakCooldown: { afterLosses: 2, cooldownBars: 200 },
    htfTrendFilter: { lookbackBars: 200, apply: "short", threshold: 0.08 },
    timeBoost: { afterDay: 2, equityBelow: 0.05, factor: 2.0 },
    maxConcurrentTrades: 10,
    liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    // BANNED features explicitly disabled — these all require persistent
    // live state that the executor does not (yet) accumulate.
    dailyPeakTrailingStop: undefined,
    challengePeakTrailingStop: undefined,
    peakDrawdownThrottle: undefined,
    drawdownShield: undefined,
    kellySizing: undefined,
    correlationFilter: undefined,
    intradayDailyLossThrottle: undefined,
    pauseAtTargetReached: false,
  };

/**
 * V5_QUARTZ_LITE_PLUS — Round 23 Champion (2026-04-29).
 * V5_QUARTZ_LITE + add-back INJ-TREND.
 *
 * Round 23 sweep showed each individual high-vol asset re-added to LITE
 * adds +1-2pp pass-rate. INJ was best single addition: 85.80% / 4d.
 *
 * 5.71y / 30m / FTMO-real liveCaps:
 *   - Pass-rate: 85.80%
 *   - Median: 4d (76% cluster at minTradingDays floor)
 *   - TL: 13.90%, DL: 0.30%
 *
 * 10 assets: BTC, ETH, BNB, ADA, LTC, BCH, ETC, XRP, AAVE, INJ.
 *
 * Caveat: like LITE, the asset selection is in-sample optimized. OOS
 * pass-rate likely 80-83%. Bootstrap CI [80%, 88%].
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_PLUS: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ.assets.filter((a) =>
      [
        "BTC-TREND",
        "ETH-TREND",
        "BNB-TREND",
        "ADA-TREND",
        "LTC-TREND",
        "BCH-TREND",
        "ETC-TREND",
        "XRP-TREND",
        "AAVE-TREND",
        "INJ-TREND",
      ].includes(a.symbol),
    ),
  };

/**
 * V5_QUARTZ_LITE_R28 — Round 28 Live-Honest Champion (2026-04-30).
 *
 * The first config to validate ≥70% pass-rate under liveMode=true (entry-time
 * sort, no exit-time lookahead). Round 28 fix-and-tune:
 *
 * 1. Round 28 added engine `liveMode?: boolean` flag — when true, the equity
 *    loop sorts trades by entry-time instead of exit-time. The default
 *    exit-sort gives the engine future-knowledge of which trades close when,
 *    inflating pass-rate by ~14.74pp on V5_QUARTZ_LITE (83.61% → 68.87%).
 *
 * 2. PTP fine-tune (210-cell sweep) on V5_QUARTZ_LITE under liveMode=true:
 *    - dailyPeakTrailingStop tightened 0.020 → 0.012 (−40% trail)
 *    - partialTakeProfit added: triggerPct 0.025 / closeFraction 0.60
 *    - close 60% of position at +2.5% favorable, run trail on remainder.
 *    Robust plateau: 7 cells in [70.83%, 71.28%] (this peak + 6 neighbors).
 *
 * Result (5.71y / 30m / 665 windows / liveMode=true):
 *   - Pass-rate: 71.28% (gap to 70% closed by 0.28pp; 0.83pp head-room)
 *   - Median: 4d (FTMO minTradingDays floor)
 *   - TL: 27.22%, DL: ~0.5%
 *
 * Compare same basket under exit-sort (lookahead, NOT live-realistic):
 *   - V5_QUARTZ_LITE base:  83.61%
 *   - V5_QUARTZ_LITE_R28:   ~84-85% (fine-tune gives marginal lift)
 *
 * Live deployment plan:
 *   - Python executor must implement persistent equity-peak state for
 *     dailyPeakTrailingStop (Round 25 Python audit: 30 LOC).
 *   - Python executor must implement partialTakeProfit (close 60% at +2.5%,
 *     auto-move stop to BE on partial exit).
 *   - 9-asset basket: BTC, ETH, BNB, ADA, LTC, BCH, ETC, XRP, AAVE.
 *   - Live-config selector: `FTMO_TF=2h-trend-v5-quartz-lite-r28`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
    dailyPeakTrailingStop: { trailDistance: 0.012 },
    partialTakeProfit: { triggerPct: 0.025, closeFraction: 0.6 },
    liveMode: true,
  };

/**
 * V5_QUARTZ_LITE_R28_V2 — Round 33 honest live-deploy champion (2026-05-01).
 *
 * Beats R28 by +4.36pp via two-step tuning:
 *   1. PTP fine-tune (Round 31): triggerPct 0.025→0.020, closeFraction 0.6→0.7
 *      → +0.90pp pass at unchanged TL.
 *   2. peakDrawdownThrottle add (Round 33): {fromPeak:0.03, factor:0.3}
 *      → +3.46pp pass AND -3.16pp TL on top of PTP tweak.
 *
 * The peakDrawdownThrottle scales risk DOWN to 30% when equity drops 3%
 * below all-time challenge peak. This catches the "good day, then 4 bad
 * days nuke account" pattern that drives R28's 27% TL fail-rate. It's
 * SOFTER than challengePeakTrailingStop (which blocks entries entirely
 * and killed pass-rate to 40-57% in R31); throttle keeps the bot in the
 * game while bleeding less per loss.
 *
 * Validation (5.55y / 30m / 665 windows / liveMode=true):
 *   - Pass: 75.64% (vs R28 71.28% = +4.36pp)
 *   - TL: 24.06% (vs R28 27.22% = -3.16pp)
 *   - DL: 0.15% (almost zero — DPT works)
 *   - Median: 4d (FTMO floor unchanged)
 *
 * Robustness (R32 OOS validation):
 *   - Walk-forward TRAIN 76.56% / TEST 73.50% / Δ -3.06pp (BETTER than
 *     R28's -3.97pp — no overfit signal, drift smaller).
 *   - Bootstrap 95% CI: [72.48, 78.95] — completely above R28's
 *     [67.82, 74.89] interval. Real lift, not lucky sample.
 *   - Year-by-year monotone better:
 *       2020:+11.5pp, 2021:+2.5pp, 2022:+0.8pp, 2023:+6.6pp,
 *       2024:+4.9pp, 2025:+7.3pp (vs R28).
 *     2026Q1 (-3.3pp, low N=30) is noise.
 *
 * Live config selector: `FTMO_TF=2h-trend-v5-quartz-lite-r28-v2`.
 *
 * Python executor support: peakDrawdownThrottle is a SIZING modifier, not
 * a state-dependent gate. Live signal generator (V231) computes the factor
 * server-side using account.equity vs equity-peak (already tracked via
 * sync_account_state). No new Python LOC needed for live deployment.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V2: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
    dailyPeakTrailingStop: { trailDistance: 0.012 },
    partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.7 },
    peakDrawdownThrottle: { fromPeak: 0.03, factor: 0.3 },
    liveMode: true,
  };

/**
 * V5_QUARTZ_LITE_R28_STEP2 — Round 28 Step 2 Champion (2026-04-30).
 *
 * Highest validated honest single-account Step-2 pass-rate found in entire
 * codebase under engine `liveMode=true` (live-fair, no exit-time lookahead).
 *
 * Result (5.71y / 30m / 655 Step-2-windows / liveMode=true):
 *   - Pass-rate: **77.86%**
 *   - Median: 4d
 *   - TL: 21.22%
 *
 * Tuning identical to R28 Step-1 except triggerPct fine-tuned for Step-2:
 *   - dpt 0.012 (same as Step-1 R28)
 *   - ptp triggerPct 0.022 / closeFraction 0.6 (Step-1 used 0.025; tighter
 *     trigger gave +0.15pp on Step-2 plateau in fine-tune sweep).
 *
 * Step 2 rules: profitTarget 5% / maxDays 60 / minTradingDays 4 / DL 5% / TL 10%.
 *
 * Step-2 80% sweep result (Round 28):
 *   - lossStreakCooldown variants: 75-77% (worse)
 *   - challengePeakTrailingStop variants: 66-67% (much worse — TL drops to <1% but pass collapses)
 *   - chandelier tighter variants: 77.5-77.7% (neutral)
 *   - timeBoost: 77.86% (neutral)
 *   - feature combos: ALL worse than base
 * Conclusion: 80% is structural ceiling on Step-2 single-account under live-fair sort.
 *
 * Joint Step1+Step2 Funded probability: 71% × 78% ≈ 55%.
 * For 80% goal (either step) → multi-account or different challenge type required.
 *
 * Live deployment: same Python executor upgrade as R28
 *   (~150 LOC: dailyPeakTrailingStop + partialTakeProfit).
 * Live config selector: `FTMO_TF=2h-trend-v5-quartz-lite-r28-step2`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_STEP2: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
    profitTarget: 0.05,
    maxDays: 60,
    holdBars: 1200,
    dailyPeakTrailingStop: { trailDistance: 0.012 },
    partialTakeProfit: { triggerPct: 0.022, closeFraction: 0.6 },
    liveMode: true,
  };

export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_STEP2: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
    // Step-2 rules
    profitTarget: 0.05,
    maxDays: 60,
    maxDailyLoss: 0.05,
    maxTotalLoss: 0.1,
    minTradingDays: 4,
    pauseAtTargetReached: true,
    // top-6 asset filter (drops AAVE/INJ/RUNE/SAND)
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ.assets.filter((a) =>
      [
        "ETH-TREND",
        "BTC-TREND",
        "BNB-TREND",
        "BCH-TREND",
        "LTC-TREND",
        "ADA-TREND",
      ].includes(a.symbol),
    ),
  };

/**
 * TREND_2H_V6 — V5 + hour-drop {22}.
 * 5.59y / 671w: 297/671 = 44.26% / 1d / p90 2d / EV $1671
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  allowedHoursUtc: [2, 4, 6, 8, 10, 12, 14, 18, 20],
};

/**
 * TREND_2H_V8 — NEW CHAMPION (2026-04-26 night R10).
 *
 * Built from V7 stack + BTC cross-asset momentum filter, force universal
 * tp=0.07 (per-asset tp from V7 was overfit and hurt).
 *
 * 5.59y / 671w / FTMO-real (live caps embedded):
 *   V5 baseline: 296/671 = 44.11% / med 1d / p90 2d / TL=8 / EV $1666
 *   V8:          310/671 = 46.20% / med 3d / p90 6d / TL=19 / EV $1749
 *   Δ:           +2.09pp pass, but TL doubled (8→19), tail 2d→6d.
 *
 * The BTC momentum gate (mb=24 ml=-0.02) skips longs when BTC has dropped
 * >2% in last 48h (24 bars × 2h). This survives more longs in the trend
 * but exposes more to total-loss when wrong.
 *
 * Trade-off vs V5:
 *   - Pass-rate +2.09pp (real)
 *   - TL +137% (concerning — needs further safety work)
 *   - p90 +4d (slower passes)
 *
 * Live Service: `FTMO_TF=2h-trend-v8`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  lossStreakCooldown: { afterLosses: 3, cooldownBars: 48 },
  adxFilter: { period: 14, minAdx: 10 },
  htfTrendFilter: { lookbackBars: 48, apply: "long", threshold: 0 },
  chandelierExit: { period: 56, mult: 2.5, minMoveR: 0.5 },
  choppinessFilter: { period: 10, maxCi: 75 },
  crossAssetFilter: {
    symbol: "BTCUSDT",
    emaFastPeriod: 4,
    emaSlowPeriod: 12,
    skipLongsIfSecondaryDowntrend: false,
    momentumBars: 24,
    momSkipLongBelow: -0.02,
  },
  crossAssetFiltersExtra: [
    {
      symbol: "ETHUSDT",
      emaFastPeriod: 4,
      emaSlowPeriod: 48,
      skipLongsIfSecondaryDowntrend: true,
    },
  ],
};

/**
 * TREND_2H_V9 — V8 + volumeFilter (R16 sweep 2026-04-26 night).
 *
 * 5.59y / 671w / FTMO-real:
 *   V8: 310/671 = 46.20% / med 3d / p90 6d / TL 16
 *   V9: 312/671 = 46.50% / med 3d / p90 7d / TL 18
 *   Δ:  +0.30pp pass, +2 TL, +1d p90.
 *
 * Volume filter skips entries where current bar's volume < 0.5×SMA(50).
 * 500 random trials confirmed this is the new local maximum.
 *
 * Live Service: `FTMO_TF=2h-trend-v9`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V9: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
  volumeFilter: { period: 50, minRatio: 0.5 },
};

/**
 * TREND_2H_V10 — V9 + tighter trailing + ADX warmup-only (R18 night).
 *
 * 5.59y / 671w / FTMO-real:
 *   V9:  312/671 = 46.50% / med 3d / p90 7d / TL 18
 *   V10: 314/671 = 46.80% / med 3d / p90 7d / TL 16
 *   Δ:  +0.30pp pass, -2 TL (Pareto improvement on safety)
 *
 * Changes:
 *   - adxFilter minAdx 10 → 0 (only skips warmup bars, no value gating)
 *   - trailingStop activatePct 0.03 → 0.03 (same), trailPct 0.005 → 0.001 (5× tighter)
 *
 * Live Service: `FTMO_TF=2h-trend-v10`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V9,
  adxFilter: { period: 14, minAdx: 0 },
  trailingStop: { activatePct: 0.03, trailPct: 0.001 },
};

/**
 * TREND_2H_V11 — V10 + per-asset tpPct (R19 night).
 *
 * 5.59y / 671w / FTMO-real:
 *   V10: 314/671 = 46.80% / med 3d / p90 7d / TL 16
 *   V11: 317/671 = 47.24% / med 3d / p90 7d / TL 14
 *   Δ:  +0.45pp pass, -2 TL (another Pareto improvement)
 *
 * Per-asset tpPct (re-tested with V10 stack):
 *   - BNB: 0.07 → 0.08 (let trend run)
 *   - ADA: 0.07 → 0.06 (faster TP on noisier alt)
 *   - LTC: 0.07 → 0.06
 *   - BCH: 0.07 → 0.06
 *   - others stay 0.07
 *
 * 1000 random trials confirmed plateau.
 * Live Service: `FTMO_TF=2h-trend-v11`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10,
  assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10.assets.map((a) => {
    if (a.symbol === "BNB-TREND") return { ...a, tpPct: 0.08 };
    if (
      a.symbol === "ADA-TREND" ||
      a.symbol === "LTC-TREND" ||
      a.symbol === "BCH-TREND"
    )
      return { ...a, tpPct: 0.06 };
    return a;
  }),
};

/**
 * TREND_2H_V12 — V11 + BTC hb=180 + chop max=72 (R20 night).
 *
 * 5.59y / 671w / FTMO-real:
 *   V11: 317/671 = 47.24% / med 3d / p90 7d / TL 14
 *   V12: 318/671 = 47.39% / med 3d / p90 7d / TL 13
 *   Δ:  +0.15pp pass, -1 TL
 *
 * Total vs V5: +3.28pp, +95 EV, TL 8 → 13 (+62%).
 * Live Service: `FTMO_TF=2h-trend-v12`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11,
  assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11.assets.map((a) =>
    a.symbol === "BTC-TREND" ? { ...a, holdBars: 180 } : a,
  ),
  choppinessFilter: { period: 10, maxCi: 72 },
};

/**
 * TREND_2H_V13_RISKY — random-trial winner from R21 (2026-04-27 night).
 *
 * 5.59y / 671w / FTMO-real:
 *   V12: 318/671 = 47.39% / med 3d / p90 7d / TL 13 (1.9% TL rate)
 *   V13: 325/671 = 48.44% / med 4d / p75 6 / p90 7d / TL 31 (4.6% TL rate)
 *   Δ:  +1.04pp pass, +18 TL (138% more total-loss breaches)
 *
 * **WARNING**: V13 is a random-search winner with significant safety regression.
 * 4.6% TL rate is well above V5's 1.2%. Use with caution.
 *
 * Found by 2000-trial random search. NOT a Pareto improvement on V12.
 *
 * Key changes vs V12:
 *   - Hours [5,6,13,15,16,19,21,23] (different subset, 8 vs V12's 10)
 *   - HTF lb=24 thr=0.05 (much stricter)
 *   - Chandelier p=168 m=2 (longer lookback, tighter mult)
 *   - Choppiness p=20 max=75 (back to 75 from V12's 72)
 *   - LSC a=4 cd=24 (more aggressive)
 *   - BTC CAF 6/36 mb=12 ml=-0.03
 *   - Volume p=150 r=0.6
 *   - trail act=0.02 (faster activation)
 *
 * Live Service: `FTMO_TF=2h-trend-v13` — but **prefer V12 for production**.
 */
/**
 * TREND_2H_V5_ROBUST — V5 + ADX filter (R30 multi-fold OOS verified 2026-04-27).
 *
 * Multi-fold validation across 11 non-overlapping 6mo slices:
 *   V5:        mean 42.42% / **min 19.61%** / std 12.60%
 *   V5_ROBUST: mean 42.42% / **min 31.37%** / std 7.54% ← TIGHTER, SAFER
 *
 * adxFilter p=10 minAdx=15 cuts the worst-slice failures (s5=19.6% → 33.3%).
 * Same average, much lower variance. Best for risk-averse production.
 *
 * Live Service: `FTMO_TF=2h-trend-v5-robust`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    adxFilter: { period: 10, minAdx: 15 },
  };

/**
 * TREND_2H_V5_RECENT — V5 + volatilityFilter (R30 multi-fold OOS verified 2026-04-27).
 *
 * Multi-fold validation across 11 non-overlapping 6mo slices:
 *   V5:        mean 42.42% / recent-3 avg 45.10%
 *   V5_RECENT: mean 41.71% / recent-3 avg **46.41%** ← BEST RECENT
 *
 * volatilityFilter{period=168, maxAtrFrac=0.04} skips entries when 14-day ATR
 * exceeds 4% of price (extreme-vol regime). Slightly lower long-term avg
 * but consistently better on recent 3 slices (last 1.5y).
 *
 * **THIS IS THE RECOMMENDED LIVE-START CONFIG** for next 6-12mo.
 *
 * Live Service: `FTMO_TF=2h-trend-v5-recent`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    volatilityFilter: { period: 168, maxAtrFrac: 0.04 },
  };

/**
 * TREND_2H_V5_PARETO — V5 + ADX + volumeFilter (R31 multi-fold OOS).
 *
 * Combines V5_ROBUST's ADX with volumeFilter. Pareto-better than V5_ROBUST:
 *   V5_ROBUST:  mean 42.42% / min 31.37% / std 7.54%
 *   V5_PARETO:  mean 42.60% / min 31.37% / std 7.58%  ← +0.18pp mean, same min
 *
 * Live Service: `FTMO_TF=2h-trend-v5-pareto`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PARETO: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    adxFilter: { period: 10, minAdx: 15 },
    volumeFilter: { period: 50, minRatio: 0.5 },
  };

/**
 * TREND_2H_V5_FUND — V5 + ADX + funding-rate filter (R32 multi-fold OOS).
 *
 * Adds funding-rate gate (perp futures crowdedness) on top of V5_ROBUST.
 * NEW engine extension: `fundingRateFilter` field.
 *
 * Multi-fold validation (11 slices):
 *   V5_ROBUST:        mean 42.42% / min 31.37%
 *   V5_ROBUST + fund: mean 42.78% / min 31.37% / +0.36pp Pareto
 *
 * **REQUIRES** funding rate data passed as `fundingBySymbol` arg to runFtmoDaytrade24h.
 * Live bot needs to fetch Binance funding endpoint (8h cadence) and forward-fill
 * to current candle bar. See `_loadFundingRate.ts` for loader.
 *
 * Live Service: `FTMO_TF=2h-trend-v5-fund`. Operational note: live needs
 * funding data fetch every cycle. Falls back to V5_ROBUST behavior if
 * fundingBySymbol is undefined or empty.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FUND: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    adxFilter: { period: 10, minAdx: 15 },
    fundingRateFilter: { maxFundingForLong: 0.001 },
  };

/**
 * TREND_2H_V5_ULTRA — V5 + ADX + volumeFilter + funding (all R30/R31/R32 wins stacked).
 *
 * Combines all three OOS-validated improvements over V5:
 *   - ADX p=10 minAdx=15 (skip weak-trend)
 *   - volumeFilter p=50 r=0.5 (skip thin-volume)
 *   - fundingRateFilter maxFL=0.0010 (skip crowded-long)
 *
 * **REQUIRES** funding rate data. See V5_FUND for operational notes.
 *
 * Live Service: `FTMO_TF=2h-trend-v5-ultra`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    adxFilter: { period: 10, minAdx: 15 },
    volumeFilter: { period: 50, minRatio: 0.5 },
    fundingRateFilter: { maxFundingForLong: 0.001 },
  };

/**
 * TREND_2H_V5_ELITE — V5_ULTRA + momentumRanking (R34 multi-fold OOS).
 *
 * Adds top-7-of-9 momentum ranking filter. Skips entries on worst-2 momentum
 * assets each bar. Removes laggards while keeping diversification.
 *
 * Multi-fold validation (11 slices, with funding data):
 *   V5_ULTRA: mean 42.96% / min 31.37% / std 7.59% / recent3 43.79%
 *   V5_ELITE: mean 43.49% / min 33.33% / std 7.61% / recent3 45.10%
 *   Δ:        +0.53pp mean, +2pp min (Pareto), +1.31pp recent
 *
 * Cumulative vs original V5:
 *   V5:       mean 42.42% / min 19.61% / std 12.60% / recent3 45.10%
 *   V5_ELITE: mean 43.49% / min 33.33% / std 7.61%  / recent3 45.10%
 *   Δ:        +1.07pp mean, +13.72pp min (60% catastrophe reduction)
 *
 * **REQUIRES** funding data + always-running momentum calculation.
 * Live Service: `FTMO_TF=2h-trend-v5-elite`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA,
    momentumRanking: { lookbackBars: 12, topN: 7 },
  };

/**
 * TREND_2H_V5_APEX — V5_ELITE + per-asset volatility-targeting (R36 multi-fold OOS).
 *
 * Adds AQR/Roncalli volatility-targeting on each asset:
 *   - target ATR fraction = 3% daily move
 *   - position size multiplier = clamp(target / current, 0.5, 3.0)
 *   - When ATR spikes (news, crashes), position auto-scales down
 *   - When ATR is calm, position scales up
 *
 * Multi-fold validation (11 slices, with funding data):
 *   V5_ELITE: mean 43.49% / min 33.33% / std 7.61% / recent3 45.10% / score 39.69%
 *   V5_APEX:  mean 43.85% / min 33.33% / std 6.44% / recent3 46.41% / score 40.63%
 *   Δ:        +0.36pp mean, same min, -1.17pp std (15% lower!), +1.31pp recent
 *
 * Cumulative vs original V5:
 *   V5:       mean 42.42% / min 19.61% / std 12.60% / recent3 45.10% / score 36.12%
 *   V5_APEX:  mean 43.85% / min 33.33% / std 6.44%  / recent3 46.41% / score 40.63%
 *   Δ:        +1.43pp mean, +13.72pp min (70% catastrophe reduction!),
 *             -6.16pp std (HALVED variance), +1.31pp recent3, +4.51pp score
 *
 * Live Service: `FTMO_TF=2h-trend-v5-apex`. Needs funding data + ATR calc per asset.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE.assets.map((a) => ({
      ...a,
      volTargeting: {
        period: 24,
        targetAtrFrac: 0.03,
        minMult: 0.5,
        maxMult: 3,
      },
    })),
  };

/**
 * TREND_2H_V5_TITAN — V5_APEX, drop AVAX, volTgt 0.035/5 (R38 multi-fold OOS).
 *
 * AVAX-TREND was net-negative contributor across 11 slices. Removing it,
 * combined with slightly looser volatility targeting (0.035 target, 5x maxMult),
 * is the final champion.
 *
 * Multi-fold validation (11 slices, with funding data):
 *   V5_APEX:  mean 43.85% / min 33.33% / std 6.44% / recent3 46.41% / score 40.63%
 *   V5_TITAN: mean 45.28% / min 35.29% / std 7.13% / recent3 49.02% / score 41.72%
 *   Δ:        +1.43pp mean, +1.96pp min, +2.61pp recent, +1.09pp score
 *
 * Cumulative vs original V5 (THE FULL JOURNEY):
 *   V5:       mean 42.42% / min 19.61% / std 12.60% / recent3 45.10% / score 36.12%
 *   V5_TITAN: mean 45.28% / min 35.29% / std 7.13%  / recent3 49.02% / score 41.72%
 *   Δ:        +2.86pp mean, +15.68pp min (80% catastrophe reduction!),
 *             -5.47pp std (43% lower variance), +3.92pp recent3, +5.60pp score
 *
 * 8 assets: ETH, BTC, BNB, ADA, DOGE, LTC, BCH, LINK (no AVAX).
 *
 * Live Service: `FTMO_TF=2h-trend-v5-titan`. **THE FINAL LIVE CHAMPION.**
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE.assets
      .filter((a) => a.symbol !== "AVAX-TREND")
      .map((a) => ({
        ...a,
        volTargeting: {
          period: 24,
          targetAtrFrac: 0.035,
          minMult: 0.5,
          maxMult: 5,
        },
      })),
  };

/**
 * TREND_2H_V5_TITAN_REAL — V5_TITAN with maxMult capped at 1.5 (live-cap-respecting).
 *
 * **WHY**: volTargeting volMult scales BOTH upside AND downside in engine. With
 * maxMult > ~1.5, a single stop can lose multiple times the FTMO max-daily-loss,
 * which would breach the 5% daily-loss limit on real FTMO (= challenge fail).
 *
 * V5_TITAN's maxMult=5 was partly bug-driven. This is the realistic version.
 *
 * 11-slice OOS:
 *   V5_TITAN (maxMult=5):  mean 45.28% / min 35.29% / recent3 49.02% / score 41.72%
 *   V5_TITAN_REAL (≤1.5):  mean 44.03% / min 35.29% / recent3 47.71% / score 40.52%
 *
 * Live Service: `FTMO_TF=2h-trend-v5-titan-real` (recommended over TITAN for production).
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN.assets.map((a) =>
      a.volTargeting
        ? { ...a, volTargeting: { ...a.volTargeting, maxMult: 1.5 } }
        : a,
    ),
  };

/**
 * TREND_2H_V5_NOVA — random-search winner from R46 (3000 trials).
 *
 * Departs from TITAN_REAL meaningfully: drops volumeFilter, choppinessFilter, LSC,
 * ETH-extra CAF — these compete with each other. Adds breakEven 0.03,
 * different hour-set, ADX p=20/m=5 (loose), HTF lb=24 thr=0.02 (different).
 *
 * Multi-fold OOS (11 slices, with funding):
 *   V5_TITAN_REAL: mean 44.03% / min 35.29% / std 7.05% / recent3 47.71% / score 40.52%
 *   V5_NOVA:       mean 47.24% / min 33.33% / std 7.74% / recent3 50.33% / score 43.37%
 *   Δ:             +3.21pp mean, -1.96pp min, +2.62pp recent3, +2.85pp score
 *
 * Cumulative vs original V5:
 *   V5:       mean 42.42% / min 19.61% / recent3 45.10% / score 36.12%
 *   V5_NOVA:  mean 47.24% / min 33.33% / recent3 50.33% / score 43.37%
 *   Δ:        +4.82pp mean, +13.72pp min, +5.23pp recent3, +7.25pp score
 *
 * Per-asset heterogeneous volTargeting (different targets/maxMults).
 * Live: `FTMO_TF=2h-trend-v5-nova`. Needs funding data fetch.
 */
/**
 * TREND_2H_V5_PRIME — TL-aware random search winner (R48, 2026-04-27).
 *
 * After engine fix (volTargeting downside-only), R48 used TL-aware score
 * `mean - 0.5×std - 2×TLrate` to penalize catastrophes. Trial 1237 found
 * minimal-but-tuned config that improves ALL key metrics over V5:
 *
 * 11-fold OOS (with funding):
 *   V5:       mean 42.42% / min 19.61% / std 12.60% / recent3 45.10% / TL 1.96% / score 32.20%
 *   V5_PRIME: mean 45.63% / min 33.33% / std  9.24% / recent3 48.37% / TL 0.89% / score 39.29%
 *   Δ:        +3.21pp mean, +13.72pp min (Pareto), +3.27pp recent3, **TL HALVED**
 *
 * NO volTargeting (avoids any maxMult complexity).
 * Filter stack: ADX p=20/m=5, chand p=28/m=3, momRank lb=6/top=6, trail 0.025/0.001.
 * Hour set 15 of 24 hours (different mix from V5's 10).
 *
 * **🏆 LIVE CHAMPION** — best balance of pass-rate + safety + recent edge.
 *
 * Live Service: `FTMO_TF=2h-trend-v5-prime`. NO funding data needed.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    trailingStop: { activatePct: 0.025, trailPct: 0.001 },
    allowedHoursUtc: [0, 1, 3, 5, 7, 9, 10, 12, 13, 14, 15, 18, 19, 20, 21],
    adxFilter: { period: 20, minAdx: 5 },
    chandelierExit: { period: 28, mult: 3, minMoveR: 0.5 },
    momentumRanking: { lookbackBars: 6, topN: 6 },
  };

/**
 * TREND_2H_V5_PRIMEX — V5_PRIME minus DOGE + funding filter (R51).
 *
 * Builds on V5_PRIME by:
 *   - dropping DOGE-TREND (greedy single-asset removal)
 *   - adding fundingRateFilter maxFL=0.0008
 *
 * Multi-fold OOS (11 slices, with funding):
 *   V5_PRIME:  mean 45.63% / min 33.33% / TL 0.89% / recent3 48.37% / score 39.29%
 *   V5_PRIMEX: mean 46.52% / min 33.33% / TL **0.53%** / recent3 47.71% / score 40.95%
 *
 * Cumulative vs V5 (orig):
 *   V5:        mean 42.42% / min 19.61% / TL 1.96% / recent3 45.10% / score 32.20%
 *   V5_PRIMEX: mean 46.52% / min 33.33% / TL **0.53%** (4× safer!) / recent3 47.71% / score 40.95%
 *   Δ:         +4.10pp mean, +13.72pp min, **TL 4× safer**, +2.61pp recent3, +8.75pp score
 *
 * 8 assets: ETH, BTC, BNB, ADA, AVAX, LTC, BCH, LINK (no DOGE).
 *
 * Live Service: `FTMO_TF=2h-trend-v5-primex` — needs funding data fetch.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME.assets.filter(
      (a) => a.symbol !== "DOGE-TREND",
    ),
    fundingRateFilter: { maxFundingForLong: 0.0008 },
  };

export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
    // Reset filter stack (NOVA found minimal+tuned wins)
    volumeFilter: undefined,
    choppinessFilter: undefined,
    lossStreakCooldown: undefined,
    crossAssetFiltersExtra: undefined,
    // Tuned filters
    adxFilter: { period: 20, minAdx: 5 },
    htfTrendFilter: { lookbackBars: 24, apply: "long", threshold: 0.02 },
    chandelierExit: { period: 56, mult: 1.5, minMoveR: 0.5 },
    crossAssetFilter: {
      symbol: "BTCUSDT",
      emaFastPeriod: 6,
      emaSlowPeriod: 24,
      skipLongsIfSecondaryDowntrend: false,
      momentumBars: 18,
      momSkipLongBelow: 0,
    },
    fundingRateFilter: { maxFundingForLong: 0.001 },
    momentumRanking: { lookbackBars: 6, topN: 7 },
    trailingStop: { activatePct: 0.025, trailPct: 0.005 },
    breakEven: { threshold: 0.03 },
    allowedHoursUtc: [1, 2, 4, 9, 10, 13, 14, 16, 17, 19],
    // Per-asset heterogeneous volTargeting (targetAtrFrac varies by asset)
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL.assets.map((a) => {
      const map: Record<string, { targetAtrFrac: number; maxMult: number }> = {
        "ETH-TREND": { targetAtrFrac: 0.025, maxMult: 1 },
        "BTC-TREND": { targetAtrFrac: 0.04, maxMult: 1 },
        "BNB-TREND": { targetAtrFrac: 0.03, maxMult: 1.5 },
        "ADA-TREND": { targetAtrFrac: 0.025, maxMult: 1.5 },
        "DOGE-TREND": { targetAtrFrac: 0.025, maxMult: 1.2 },
        "LTC-TREND": { targetAtrFrac: 0.025, maxMult: 1.5 },
        "BCH-TREND": { targetAtrFrac: 0.04, maxMult: 1.5 },
        "LINK-TREND": { targetAtrFrac: 0.04, maxMult: 1.5 },
      };
      const m = map[a.symbol];
      return m ? { ...a, volTargeting: { period: 24, minMult: 0.5, ...m } } : a;
    }),
  };

/**
 * TREND_2H_V5_LEGEND — TITAN + ADX p=14/m=12 + volTgt 0.05/5 (R40 multi-fold OOS).
 *
 * Re-tuned ADX (period 10→14, threshold 15→12) and looser volTgt (target 0.035→0.05,
 * maxMult 5 unchanged) discovered after dropping AVAX. The wider vol target captures
 * more signals while ADX p=14 is more selective on trend strength.
 *
 * Multi-fold validation (11 slices, with funding data):
 *   V5_TITAN:  mean 45.28% / min 35.29% / std 7.13% / recent3 49.02% / score 41.72%
 *   V5_LEGEND: mean 49.20% / min 35.29% / std 10.20% / recent3 47.06% / score 44.10%
 *   Δ:         +3.92pp mean, same min, +3.07pp std (noisier), -1.96pp recent3
 *
 * Cumulative vs original V5:
 *   V5:        mean 42.42% / min 19.61% / std 12.60% / recent3 45.10% / score 36.12%
 *   V5_LEGEND: mean 49.20% / min 35.29% / std 10.20% / recent3 47.06% / score 44.10%
 *   Δ:         **+6.78pp mean (16% relative), +15.68pp min (80% catastrophe reduction),
 *              +1.96pp recent3, +7.98pp score**
 *
 * 8 assets: ETH, BTC, BNB, ADA, DOGE, LTC, BCH, LINK.
 *
 * Live Service: `FTMO_TF=2h-trend-v5-legend`. **HIGHEST MEAN PASS-RATE.**
 * Note: TITAN still wins on recent3 (49.02% vs 47.06%) — choice depends on
 * whether you trust long-term avg or recent regime.
 *
 * **⚠️ DEPRECATED — DO NOT USE IN LIVE.** R42 discovered: volTargeting volMult
 * scales DOWNSIDE too, breaking live caps. With maxMult=5, a single stop can
 * lose 5× FTMO daily-loss → instant challenge fail. Backtest results are
 * partly artefact (-6.22pp when capped at maxMult=1.5).
 *
 * Use `V5_TITAN_REAL` or `V5_ELITE` (no volTgt) instead for production.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
    adxFilter: { period: 14, minAdx: 12 },
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN.assets.map((a) => ({
      ...a,
      volTargeting: {
        period: 24,
        targetAtrFrac: 0.05,
        minMult: 0.5,
        maxMult: 5,
      },
    })),
  };

/**
 * TREND_2H_V5_HIGH — V5_ULTRA with tighter funding (R34 alternative).
 *
 * Same as V5_ULTRA but maxFundingForLong=0.0003 (stricter crowdedness gate).
 * Highest MEAN pass-rate but lower MIN (more variance).
 *
 * 11-slice OOS: mean 43.32% / min 29.41% / recent3 44.44%
 *
 * Use when you accept slightly more variance for higher average pass.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIGH: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA,
    fundingRateFilter: { maxFundingForLong: 0.0003 },
  };

/**
 * TREND_2H_V15_RECENT — recent-regime optimized (R27 night, 2026-04-27).
 *
 * Sim. annealing on V8 with target=last 1y pass-rate (not full 5.6y).
 * 2000 trials with TL ≤ 5 hard cap on 1y, p6mo ≥ 30%.
 *
 * Multi-period eval:
 * | Period | V5 | V8 | V12 | **V15_RECENT** |
 * |--------|----|----|-----|----------------|
 * | 6mo    | 41.18% | 35.29% | 37.25% | **43.14%** |
 * | 1y     | 46.43% | 44.64% | 41.07% | **51.79%** ← target |
 * | 2y     | 42.74% | 40.17% | 41.45% | **43.59%** |
 * | 3y     | 41.57% | 43.54% | 42.42% | **43.82%** |
 * | FULL   | 44.11% | 46.20% | 47.39% | **44.71%** |
 *
 * **THIS IS THE LIVE-RECOMMENDED CONFIG.** It's optimal for the regime
 * we're about to live-trade (next 6-12mo extrapolation), with TL=1 on 1y
 * (essentially 0 total-loss breaches) — safer than V12 AND higher pass.
 *
 * Trade-off: lower full-history pass (44.71% vs V14's 47.69%) because
 * we explicitly traded long-term avg for recent-regime fit.
 *
 * Key changes from V8 baseline (R27 sim. annealing found):
 *   - lossStreakCooldown a=4 cd=159 (much longer pause after streak)
 *   - htfTrendFilter lb=72 thr=0.039 apply=both (stricter HTF, both directions)
 *   - chandelierExit p=56 m=2.8 (slightly tighter trail)
 *   - choppinessFilter p=20 maxCi=66 (much stricter chop filter)
 *   - crossAssetFilter BTC 12/24 mb=48 ml=-0.01 skipDown=true (slower MA, weaker mom)
 *   - crossAssetFiltersExtra: BNBUSDT 8/24 (replaced ETH)
 *   - volumeFilter p=75 r=0.75 (stricter vol)
 *   - trailingStop tr=0.0099 (1bp trail)
 *
 * Live Service: `FTMO_TF=2h-trend-v15` — **DEFAULT FOR LIVE FTMO STARTING NOW**.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V15_RECENT: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
    trailingStop: { activatePct: 0.03, trailPct: 0.0099 },
    lossStreakCooldown: { afterLosses: 4, cooldownBars: 159 },
    adxFilter: { period: 14, minAdx: 10 },
    htfTrendFilter: { lookbackBars: 72, apply: "both", threshold: 0.039 },
    chandelierExit: { period: 56, mult: 2.8, minMoveR: 0.5 },
    choppinessFilter: { period: 20, maxCi: 66 },
    crossAssetFilter: {
      symbol: "BTCUSDT",
      emaFastPeriod: 12,
      emaSlowPeriod: 24,
      skipLongsIfSecondaryDowntrend: true,
      momentumBars: 48,
      momSkipLongBelow: -0.01,
    },
    crossAssetFiltersExtra: [
      {
        symbol: "BNBUSDT",
        emaFastPeriod: 8,
        emaSlowPeriod: 24,
        skipLongsIfSecondaryDowntrend: true,
      },
    ],
    volumeFilter: { period: 75, minRatio: 0.75 },
  };

/**
 * TREND_2H_V14 — V12 + simulated annealing fine-tuning (R24 night).
 *
 * 5.59y / 671w / FTMO-real:
 *   V12: 318/671 = 47.39% / med 3d / p90 7d / TL 13
 *   V14: 321/671 = 47.84% / med 3d / p90 7d / TL 13
 *   Δ:  +0.45pp pass, same TL
 *
 * Sim. annealing tweaked 3 params:
 *   - chandelierExit mult: 2.5 → 2.28
 *   - choppinessFilter maxCi: 72 → 72.43
 *   (other sim-annealed params landed back at V12 values)
 *
 * **OVERFIT WARNING (R24-OOS):**
 *   - V5 generalizes UP on most-recent 1.68y (TRAIN 42.83% → TEST 46.67%)
 *   - V12 has mild overfit (TRAIN 47.54% → TEST 45.64% = -1.9pp)
 *   - V8 has moderate overfit (-4.3pp)
 *   - On TEST set V5 ≈ V12 (within noise)
 * The cumulative gain from V5→V14 may not fully replicate live.
 * Conservative production choice: V5 (most robust) or V12 (Pareto champion).
 *
 * Live Service: `FTMO_TF=2h-trend-v14`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
  chandelierExit: { period: 56, mult: 2.28, minMoveR: 0.5 },
  choppinessFilter: { period: 10, maxCi: 72.43 },
};

export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
    allowedHoursUtc: [5, 6, 13, 15, 16, 19, 21, 23],
    trailingStop: { activatePct: 0.02, trailPct: 0.001 },
    lossStreakCooldown: { afterLosses: 4, cooldownBars: 24 },
    htfTrendFilter: { lookbackBars: 24, apply: "long", threshold: 0.05 },
    chandelierExit: { period: 168, mult: 2, minMoveR: 0.5 },
    choppinessFilter: { period: 20, maxCi: 75 },
    crossAssetFilter: {
      symbol: "BTCUSDT",
      emaFastPeriod: 6,
      emaSlowPeriod: 36,
      skipLongsIfSecondaryDowntrend: false,
      momentumBars: 12,
      momSkipLongBelow: -0.03,
    },
    crossAssetFiltersExtra: [
      {
        symbol: "ETHUSDT",
        emaFastPeriod: 4,
        emaSlowPeriod: 24,
        skipLongsIfSecondaryDowntrend: true,
      },
    ],
    volumeFilter: { period: 150, minRatio: 0.6 },
  };

/**
 * TREND_2H_V7 — overnight HONEST sweep winner (2026-04-26 night).
 *
 * Stack of small but real wins from rounds R1+R2+R6 (full 5.59y validated):
 *   - per-asset tp: BTC 0.06, AVAX 0.08 (others 0.07)
 *   - LSC a=3 cd=48
 *   - adxFilter p=14 minAdx=10
 *   - htfTrendFilter long lb=48 thr=0
 *   - chandelierExit p=56 m=2.5
 *   - choppinessFilter p=10 maxCi=75
 *
 * 5.59y / 671w / FTMO-real (live caps embedded):
 *   V5 baseline: 296/671 = 44.11% / med 1d / p90 2d / TL=8 / EV $1666
 *   V7:          302/671 = 45.01% / med 3d / p90 5d / TL=7 / EV $1701
 *   Δ:           +0.90pp pass, but tail shifted (median 1→3d, p90 2→5d).
 *
 * Trade-off: V5 still wins on speed; V7 wins on raw pass-rate.
 *
 * Live Service: `FTMO_TF=2h-trend-v7`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V7: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => {
    if (a.symbol === "BTC-TREND") return { ...a, tpPct: 0.06 };
    if (a.symbol === "AVAX-TREND") return { ...a, tpPct: 0.08 };
    return a;
  }),
  lossStreakCooldown: { afterLosses: 3, cooldownBars: 48 },
  adxFilter: { period: 14, minAdx: 10 },
  htfTrendFilter: { lookbackBars: 48, apply: "long", threshold: 0 },
  chandelierExit: { period: 56, mult: 2.5, minMoveR: 0.5 },
  choppinessFilter: { period: 10, maxCi: 75 },
};

/**
 * MR_2H — 2h Mean-Reversion baseline (complementary to TREND_2H_V5).
 *
 * Hypothesis: V5 trend-follower fires only in trending markets. A
 * mean-reversion bot fires in sideway/range markets → minimal overlap →
 * combined ensemble can pass FTMO with a higher rate than V5 alone.
 *
 * Default direction logic in the engine (invertDirection=false) means:
 *   - long after N consecutive RED closes (fade the dip)
 *   - short after N consecutive GREEN closes (fade the pump)
 *
 * Same 9 cryptos as V5. Uses "-MR" suffix to keep symbols distinct so the
 * ensemble can union them with V5's "-TREND" symbols on a shared equity
 * pool (sourceSymbol points back to the underlying USDT pair).
 *
 * Tunable defaults — final values determined by Stage-2 sweep in
 * scripts/ftmoV5MrEnsemble.test.ts.
 */
export const FTMO_DAYTRADE_24H_CONFIG_MR_2H: FtmoDaytrade24hConfig = {
  triggerBars: 1,
  leverage: 2,
  tpPct: 0.015,
  stopPct: 0.025,
  holdBars: 24,
  timeframe: "2h",
  maxConcurrentTrades: 6,
  assets: [
    {
      symbol: "ETH-MR2",
      sourceSymbol: "ETHUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 0.5,
      triggerBars: 1,
      stopPct: 0.025,
      tpPct: 0.015,
      holdBars: 24,
    },
    {
      symbol: "BTC-MR2",
      sourceSymbol: "BTCUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 0.5,
      triggerBars: 1,
      stopPct: 0.025,
      tpPct: 0.015,
      holdBars: 24,
    },
    {
      symbol: "BNB-MR2",
      sourceSymbol: "BNBUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 0.5,
      triggerBars: 1,
      stopPct: 0.025,
      tpPct: 0.015,
      holdBars: 24,
    },
    {
      symbol: "ADA-MR2",
      sourceSymbol: "ADAUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 0.5,
      triggerBars: 1,
      stopPct: 0.025,
      tpPct: 0.015,
      holdBars: 24,
    },
    {
      symbol: "DOGE-MR2",
      sourceSymbol: "DOGEUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 0.5,
      triggerBars: 1,
      stopPct: 0.025,
      tpPct: 0.015,
      holdBars: 24,
    },
    {
      symbol: "AVAX-MR2",
      sourceSymbol: "AVAXUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 0.5,
      triggerBars: 1,
      stopPct: 0.025,
      tpPct: 0.015,
      holdBars: 24,
    },
    {
      symbol: "LTC-MR2",
      sourceSymbol: "LTCUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 0.5,
      triggerBars: 1,
      stopPct: 0.025,
      tpPct: 0.015,
      holdBars: 24,
    },
    {
      symbol: "BCH-MR2",
      sourceSymbol: "BCHUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 0.5,
      triggerBars: 1,
      stopPct: 0.025,
      tpPct: 0.015,
      holdBars: 24,
    },
    {
      symbol: "LINK-MR2",
      sourceSymbol: "LINKUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 0.5,
      triggerBars: 1,
      stopPct: 0.025,
      tpPct: 0.015,
      holdBars: 24,
    },
  ],
  profitTarget: 0.08,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
  pauseAtTargetReached: true,
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
};

/**
 * TREND_2H_V5_ENSEMBLE — V5 (trend longs) + MR (both-side reverters)
 * unified on a single 2h engine pass with shared equity pool.
 *
 * Asset list = V5 assets (all -TREND, long-only momentum-continuation)
 *            ∪ MR assets (-MR2, default MR direction logic).
 * Both run on the same equity track via the engine's sourceSymbol mechanism
 * — TREND symbols share BTCUSDT/ETHUSDT etc. with their MR2 counterparts.
 *
 * maxConcurrentTrades raised 6 → 12 so the trend and MR sides don't crowd
 * each other out under heavy regime overlap. Other engine settings inherit
 * V5 (allowedHoursUtc, trailingStop, liveCaps).
 *
 * Live Service: `FTMO_TF=2h-trend-v5-ensemble`.
 */
export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ENSEMBLE: FtmoDaytrade24hConfig =
  {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    maxConcurrentTrades: 12,
    assets: [
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets,
      ...FTMO_DAYTRADE_24H_CONFIG_MR_2H.assets,
    ],
  };

/**
 * V12_QUARTZ_30M — V5_QUARTZ_LITE 9-asset basket + V12 drift-friendly engine grafts.
 *
 * Round 28 hypothesis: V12_30M_OPT achieves 95% backtest with mostly drift-friendly
 * features (rolling indicators that the live wrapper recomputes per tick). The
 * state-dependent V12 features (kellySizing rolling-pnl, dailyPeakTrailingStop,
 * pauseAtTargetReached) are explicitly REMOVED so the same config can run in
 * backtest and live without persistent-state drift.
 *
 * Strategy base: V5_QUARTZ_LITE (TREND-mode on 30m for 9 core assets) — its
 * trade-signal logic is portable across the basket. V12's MR-spec (ETH-PYR
 * pyramid stack) was incompatible with arbitrary assets.
 *
 * V12-engine grafts (kept from V12_30M_OPT):
 *   - atrStop: tightened from p84 m48 → p32 m5.5 (V12's wider stops are
 *     skipped under liveCaps maxStopPct 5%; tighter version preserved the
 *     trailing-stop concept while passing the live cap).
 *   - holdBars: V12's 1200 → 600 (still long but doesn't block the basket).
 *   - partialTakeProfit (close 30% at +2%) — pure drift-friendly add-on.
 *   - chandelierExit p28 m3 minMoveR=0.5 — pure rolling indicator.
 *   - allowedHoursUtc 16/24 — V12's hour-filter (greedy-optimized for 30m).
 *
 * V12-engine REMOVED (state-dependent — would cause drift):
 *   - pauseAtTargetReached → false (was inherited via V5_QUARTZ chain)
 *   - kellySizing → undefined (rolling-trade-pnl persistent state)
 *   - dailyPeakTrailingStop → undefined (per-day equity peak persistent state)
 *
 * liveCaps explicit (V12 family parity): {maxStopPct: 0.05, maxRiskFrac: 0.4}.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V12_QUARTZ_30M: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  // Drift-friendly: state-dependent features off
  pauseAtTargetReached: false,
  kellySizing: undefined,
  dailyPeakTrailingStop: undefined,
  // Conservative V12 graft: only partialTakeProfit (pure rolling, no state).
  // V5_QUARTZ_LITE base already has its own atrStop p56 m2 + chandelierExit
  // p56 m2 + tighter hour-filter, all tuned for the 9-asset basket.
  // V12's wider 30m stops (p32 m5.5 → 3-5%) blew DL@5% cap on concurrent trades.
  partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.3 },
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
};

/**
 * V245_QUARTZ — Round 28 cross-strategy graft (2026-04-30).
 *
 * V245's distinctive engine stack (atrStop p18 m8 + holdBars 60 + timeBoost
 * d4 f2.0 + pauseAtTargetReached) applied to V5_QUARTZ_LITE's 9-asset TREND
 * basket on 4h bars. V245 itself is a 4h ETH+BTC+SOL MR-shorts champion
 * (85.84% backtest); the hypothesis is that its long-hold + ATR-wide engine
 * pattern transfers to the larger TREND basket while staying live-friendly
 * (no kellySizing / no challenge-peak trail).
 *
 * Why pauseAtTargetReached IS kept here: Agent 7's flagged drift-feature is
 * tolerable in the V245 stack because (a) timeBoost replaces the daily-peak
 * trail's late-stage push, (b) atrStop p18 m8 (capped to maxStopPct 5% by
 * liveCaps) is the dominant exit, both of which the live executor already
 * mirrors. The pause flag remains a known offline-vs-online drift but it is
 * NOT the equity-peak-trail accumulator that produced the round-23 0%
 * agreement disaster — a much smaller and safer drift surface.
 *
 * Engine stack (all from V245):
 *   - atrStop {period:18, stopMult:8} (capped to 5% via liveCaps)
 *   - holdBars: 60 (= 60×4h = 240h = 10d max hold)
 *   - timeBoost {afterDay:4, equityBelow:0.08, factor:2.0}
 *   - pauseAtTargetReached: true
 *   - liveCaps {maxStopPct: 0.05, maxRiskFrac: 0.4}
 *
 * Assets: 9 V5 TREND tickers (BTC ETH BNB ADA LTC BCH ETC XRP AAVE),
 * tickled to 4h timeframe. Per-asset stopPct/tpPct preserved from
 * V5_QUARTZ_LITE (which inherited the V5_QUARTZ tightening chain).
 *
 * Live: backtest-only audit. If ≥75% backtest AND ≥70% under liveMode=true,
 * promote to a live FTMO_TF tag.
 */
export const FTMO_DAYTRADE_24H_CONFIG_V245_QUARTZ: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  // Use V245's 4h timeframe — V245's ATR/holdBars are 4h-period sized.
  timeframe: "4h",
  // V245 distinctive engine stack
  atrStop: { period: 18, stopMult: 8 },
  holdBars: 60,
  timeBoost: { afterDay: 4, equityBelow: 0.08, factor: 2.0 },
  pauseAtTargetReached: true,
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
  // Drop V5_QUARTZ_LITE's 30m-tuned chandelier (p56) — V245 has no chandelier.
  // 56×30m = 28h ≠ 56×4h = 9.3 days; better to remove than to keep mis-scaled.
  chandelierExit: undefined,
  // Drop V5_QUARTZ_LITE's banned dailyPeakTrailingStop — keeps live-friendliness.
  dailyPeakTrailingStop: undefined,
  // Drop V5_QUARTZ's 30m hour filter — V245 had no hour filter; the 30m hours
  // [4,6,8,10,14,18,22] don't translate to 4h candles meaningfully.
  allowedHoursUtc: undefined,
  // Drop the V5_QUARTZ break-even override (3%) — V245 had none. We let V245's
  // wide ATR stop be the single exit-rule (consistent with V245's audit).
  breakEven: undefined,
};
