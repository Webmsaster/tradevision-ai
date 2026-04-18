import { Candle, ema, rsi, macd, atr, adx, sma } from "@/utils/indicators";

export type SignalAction = "long" | "short" | "flat";
export type MarketRegime = "trending" | "ranging" | "unknown";

export interface SignalLevels {
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
}

export interface SignalSnapshot {
  time: number;
  price: number;
  action: SignalAction;
  strength: number;
  reasons: string[];
  regime: MarketRegime;
  adx: number | null;
  htfAligned: boolean | null;
  levels: SignalLevels | null;
  indicators: {
    emaFast: number | null;
    emaSlow: number | null;
    rsi: number | null;
    macd: number | null;
    macdSignal: number | null;
    macdHist: number | null;
    atr: number | null;
  };
}

export interface SignalConfig {
  emaFastPeriod: number;
  emaSlowPeriod: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  macdFast: number;
  macdSlow: number;
  macdSignalPeriod: number;
  atrPeriod: number;
  adxPeriod: number;
  adxTrendThreshold: number;
  stopLossAtrMultiple: number;
  takeProfitAtrMultiple: number;
  volumeSmaPeriod: number;
}

export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  emaFastPeriod: 9,
  emaSlowPeriod: 21,
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  macdFast: 12,
  macdSlow: 26,
  macdSignalPeriod: 9,
  atrPeriod: 14,
  adxPeriod: 14,
  adxTrendThreshold: 20,
  stopLossAtrMultiple: 2,
  takeProfitAtrMultiple: 3,
  volumeSmaPeriod: 20,
};

export interface AnalyzeOptions {
  /** Trend direction from higher timeframe: 'long' | 'short' | 'flat' | null (unknown) */
  htfTrend?: SignalAction | null;
  config?: SignalConfig;
}

export function analyzeCandles(
  candles: Candle[],
  options: AnalyzeOptions = {},
): SignalSnapshot | null {
  const cfg = options.config ?? DEFAULT_SIGNAL_CONFIG;
  if (candles.length < cfg.emaSlowPeriod + 2) return null;

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const emaFastArr = ema(closes, cfg.emaFastPeriod);
  const emaSlowArr = ema(closes, cfg.emaSlowPeriod);
  const rsiArr = rsi(closes, cfg.rsiPeriod);
  const macdArr = macd(
    closes,
    cfg.macdFast,
    cfg.macdSlow,
    cfg.macdSignalPeriod,
  );
  const atrArr = atr(candles, cfg.atrPeriod);
  const adxResult = adx(candles, cfg.adxPeriod);
  const volSmaArr = sma(volumes, cfg.volumeSmaPeriod);

  const last = candles.length - 1;
  const prev = last - 1;

  const emaFastNow = emaFastArr[last];
  const emaFastPrev = emaFastArr[prev];
  const emaSlowNow = emaSlowArr[last];
  const emaSlowPrev = emaSlowArr[prev];
  const rsiNow = rsiArr[last];
  const macdNow = macdArr.macd[last];
  const macdSignalNow = macdArr.signal[last];
  const macdHistNow = macdArr.histogram[last];
  const macdHistPrev = macdArr.histogram[prev];
  const atrNow = atrArr[last];
  const adxNow = adxResult.adx[last];
  const volNow = volumes[last];
  const volAvg = volSmaArr[last];

  const reasons: string[] = [];
  let longScore = 0;
  let shortScore = 0;

  // --- Regime detection via ADX ---
  let regime: MarketRegime = "unknown";
  if (adxNow !== null) {
    regime = adxNow >= cfg.adxTrendThreshold ? "trending" : "ranging";
  }

  // --- EMA crossover/state ---
  const emaFastAbove =
    emaFastNow !== null && emaSlowNow !== null && emaFastNow > emaSlowNow;
  const emaFastBelow =
    emaFastNow !== null && emaSlowNow !== null && emaFastNow < emaSlowNow;
  const crossUp =
    emaFastPrev !== null &&
    emaSlowPrev !== null &&
    emaFastNow !== null &&
    emaSlowNow !== null &&
    emaFastPrev <= emaSlowPrev &&
    emaFastNow > emaSlowNow;
  const crossDown =
    emaFastPrev !== null &&
    emaSlowPrev !== null &&
    emaFastNow !== null &&
    emaSlowNow !== null &&
    emaFastPrev >= emaSlowPrev &&
    emaFastNow < emaSlowNow;

  if (crossUp) {
    longScore += 3;
    reasons.push(
      `EMA${cfg.emaFastPeriod} crossed above EMA${cfg.emaSlowPeriod}`,
    );
  } else if (emaFastAbove) {
    longScore += 1;
    reasons.push(`EMA${cfg.emaFastPeriod} above EMA${cfg.emaSlowPeriod}`);
  }
  if (crossDown) {
    shortScore += 3;
    reasons.push(
      `EMA${cfg.emaFastPeriod} crossed below EMA${cfg.emaSlowPeriod}`,
    );
  } else if (emaFastBelow) {
    shortScore += 1;
    reasons.push(`EMA${cfg.emaFastPeriod} below EMA${cfg.emaSlowPeriod}`);
  }

  // --- RSI trend confirmation ---
  if (rsiNow !== null) {
    if (rsiNow >= 55) {
      longScore += 2;
      reasons.push(`RSI ${rsiNow.toFixed(1)} bullish (>50)`);
    } else if (rsiNow <= 45) {
      shortScore += 2;
      reasons.push(`RSI ${rsiNow.toFixed(1)} bearish (<50)`);
    }
    if (rsiNow > cfg.rsiOverbought)
      reasons.push(`RSI ${rsiNow.toFixed(1)} overbought — exhaustion risk`);
    else if (rsiNow < cfg.rsiOversold)
      reasons.push(`RSI ${rsiNow.toFixed(1)} oversold — exhaustion risk`);
  }

  // --- MACD momentum ---
  if (
    macdNow !== null &&
    macdSignalNow !== null &&
    macdHistNow !== null &&
    macdHistPrev !== null
  ) {
    if (macdNow > macdSignalNow && macdHistNow > macdHistPrev) {
      longScore += 2;
      reasons.push(`MACD bullish, histogram rising`);
    } else if (macdNow < macdSignalNow && macdHistNow < macdHistPrev) {
      shortScore += 2;
      reasons.push(`MACD bearish, histogram falling`);
    }
  }

  // --- Volume filter (confirms conviction) ---
  if (volAvg !== null && volAvg > 0 && volNow > volAvg * 1.2) {
    if (longScore > shortScore) {
      longScore += 1;
      reasons.push(
        `Volume ${((volNow / volAvg) * 100 - 100).toFixed(0)}% above avg`,
      );
    } else if (shortScore > longScore) {
      shortScore += 1;
      reasons.push(
        `Volume ${((volNow / volAvg) * 100 - 100).toFixed(0)}% above avg`,
      );
    }
  }

  // --- Higher-timeframe alignment ---
  let htfAligned: boolean | null = null;
  if (options.htfTrend !== undefined && options.htfTrend !== null) {
    if (options.htfTrend === "long") {
      htfAligned = longScore > shortScore;
      if (htfAligned) {
        longScore += 1;
        reasons.push(`Higher timeframe uptrend aligns`);
      } else if (shortScore > longScore) {
        reasons.push(`⚠ Higher timeframe is UP — short fights the trend`);
      }
    } else if (options.htfTrend === "short") {
      htfAligned = shortScore > longScore;
      if (htfAligned) {
        shortScore += 1;
        reasons.push(`Higher timeframe downtrend aligns`);
      } else if (longScore > shortScore) {
        reasons.push(`⚠ Higher timeframe is DOWN — long fights the trend`);
      }
    } else {
      htfAligned = null;
    }
  }

  // --- Decide action ---
  let action: SignalAction = "flat";
  const diff = longScore - shortScore;
  if (diff >= 3) action = "long";
  else if (diff <= -3) action = "short";

  // --- Regime gate: block trend-following signals in ranging markets ---
  if (action !== "flat" && regime === "ranging") {
    action = "flat";
    reasons.push(
      `⚠ ADX ${adxNow!.toFixed(1)} < ${cfg.adxTrendThreshold}: market ranging, signal suppressed`,
    );
  }

  // --- HTF counter-trend gate: don't fight the higher timeframe ---
  if (
    action !== "flat" &&
    options.htfTrend &&
    options.htfTrend !== "flat" &&
    action !== options.htfTrend
  ) {
    action = "flat";
    if (!reasons.some((r) => r.startsWith("⚠ Higher timeframe"))) {
      reasons.push(`⚠ Signal suppressed: opposes higher timeframe trend`);
    }
  }

  const strength = Math.min(10, Math.max(longScore, shortScore));

  // --- ATR-based SL/TP ---
  let levels: SignalLevels | null = null;
  const entry = candles[last].close;
  if (atrNow !== null && atrNow > 0 && action !== "flat") {
    const slDistance = atrNow * cfg.stopLossAtrMultiple;
    const tpDistance = atrNow * cfg.takeProfitAtrMultiple;
    const stopLoss =
      action === "long" ? entry - slDistance : entry + slDistance;
    const takeProfit =
      action === "long" ? entry + tpDistance : entry - tpDistance;
    levels = {
      entry,
      stopLoss,
      takeProfit,
      riskReward: cfg.takeProfitAtrMultiple / cfg.stopLossAtrMultiple,
    };
  }

  return {
    time: candles[last].closeTime,
    price: entry,
    action,
    strength,
    reasons,
    regime,
    adx: adxNow,
    htfAligned,
    levels,
    indicators: {
      emaFast: emaFastNow,
      emaSlow: emaSlowNow,
      rsi: rsiNow,
      macd: macdNow,
      macdSignal: macdSignalNow,
      macdHist: macdHistNow,
      atr: atrNow,
    },
  };
}

export function hasActionChanged(
  prev: SignalSnapshot | null,
  next: SignalSnapshot,
): boolean {
  if (!prev) return next.action !== "flat";
  return prev.action !== next.action;
}

/**
 * Derives the higher-timeframe trend from a set of HTF candles by checking
 * EMA fast vs EMA slow. Returns 'long', 'short', or 'flat' when EMAs are close.
 */
export function deriveHtfTrend(
  htfCandles: Candle[],
  cfg: SignalConfig = DEFAULT_SIGNAL_CONFIG,
): SignalAction | null {
  if (htfCandles.length < cfg.emaSlowPeriod + 2) return null;
  const closes = htfCandles.map((c) => c.close);
  const fast = ema(closes, cfg.emaFastPeriod);
  const slow = ema(closes, cfg.emaSlowPeriod);
  const fastNow = fast.at(-1);
  const slowNow = slow.at(-1);
  if (fastNow == null || slowNow == null) return null;
  const pctDiff = Math.abs(fastNow - slowNow) / slowNow;
  if (pctDiff < 0.001) return "flat";
  return fastNow > slowNow ? "long" : "short";
}

// ---- Backtest ----

export interface BacktestTrade {
  openTime: number;
  closeTime: number;
  direction: "long" | "short";
  entry: number;
  exit: number;
  pnlR: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  wins: number;
  losses: number;
  winRate: number;
  totalR: number;
  avgR: number;
  profitFactor: number;
}

/**
 * Walk-forward simulation over a candle history. Opens a position when the engine
 * flips to long/short, exits when the action changes to the opposite side or flat.
 * PnL is expressed in R-multiples (1R = the SL distance at entry). No fees/slippage.
 */
export function backtest(
  candles: Candle[],
  cfg: SignalConfig = DEFAULT_SIGNAL_CONFIG,
): BacktestResult {
  const trades: BacktestTrade[] = [];
  let open: {
    direction: "long" | "short";
    entry: number;
    slDistance: number;
    openTime: number;
  } | null = null;

  // Step through, re-analyzing each prefix (sliding window would be heavy; this is simpler)
  const minBars = Math.max(cfg.emaSlowPeriod, cfg.adxPeriod * 2) + 5;
  for (let i = minBars; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const snap = analyzeCandles(window, { config: cfg });
    if (!snap) continue;
    const currentPrice = candles[i].close;

    if (open) {
      const shouldClose =
        (open.direction === "long" && snap.action !== "long") ||
        (open.direction === "short" && snap.action !== "short");
      if (shouldClose) {
        const pnlPrice =
          open.direction === "long"
            ? currentPrice - open.entry
            : open.entry - currentPrice;
        const pnlR = open.slDistance > 0 ? pnlPrice / open.slDistance : 0;
        trades.push({
          openTime: open.openTime,
          closeTime: candles[i].closeTime,
          direction: open.direction,
          entry: open.entry,
          exit: currentPrice,
          pnlR,
        });
        open = null;
      }
    }

    if (
      !open &&
      (snap.action === "long" || snap.action === "short") &&
      snap.levels
    ) {
      open = {
        direction: snap.action,
        entry: snap.levels.entry,
        slDistance: Math.abs(snap.levels.entry - snap.levels.stopLoss),
        openTime: candles[i].closeTime,
      };
    }
  }

  const wins = trades.filter((t) => t.pnlR > 0).length;
  const losses = trades.filter((t) => t.pnlR < 0).length;
  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const totalR = trades.reduce((s, t) => s + t.pnlR, 0);
  const avgR = trades.length > 0 ? totalR / trades.length : 0;
  const grossWin = trades
    .filter((t) => t.pnlR > 0)
    .reduce((s, t) => s + t.pnlR, 0);
  const grossLoss = Math.abs(
    trades.filter((t) => t.pnlR < 0).reduce((s, t) => s + t.pnlR, 0),
  );
  const profitFactor =
    grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  return { trades, wins, losses, winRate, totalR, avgR, profitFactor };
}
