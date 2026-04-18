import { Candle, ema, rsi, macd, atr } from "@/utils/indicators";

export type SignalAction = "long" | "short" | "flat";

export interface SignalSnapshot {
  time: number;
  price: number;
  action: SignalAction;
  strength: number;
  reasons: string[];
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
};

export function analyzeCandles(
  candles: Candle[],
  cfg: SignalConfig = DEFAULT_SIGNAL_CONFIG,
): SignalSnapshot | null {
  if (candles.length < cfg.emaSlowPeriod + 2) return null;

  const closes = candles.map((c) => c.close);
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

  const reasons: string[] = [];
  let longScore = 0;
  let shortScore = 0;

  // EMA crossover (strongest signal, weight 2)
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

  // RSI as trend confirmation (above/below 50) — extremes logged but don't add score,
  // since in a strong trend RSI can stay oversold/overbought for extended periods.
  if (rsiNow !== null) {
    if (rsiNow >= 55) {
      longScore += 2;
      reasons.push(`RSI ${rsiNow.toFixed(1)} bullish (>50)`);
    } else if (rsiNow <= 45) {
      shortScore += 2;
      reasons.push(`RSI ${rsiNow.toFixed(1)} bearish (<50)`);
    }
    if (rsiNow > cfg.rsiOverbought) {
      reasons.push(`RSI ${rsiNow.toFixed(1)} overbought — exhaustion risk`);
    } else if (rsiNow < cfg.rsiOversold) {
      reasons.push(`RSI ${rsiNow.toFixed(1)} oversold — exhaustion risk`);
    }
  }

  // MACD momentum: bullish when MACD > Signal and histogram rising
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

  let action: SignalAction = "flat";
  const diff = longScore - shortScore;
  if (diff >= 3) action = "long";
  else if (diff <= -3) action = "short";

  const strength = Math.min(10, Math.max(longScore, shortScore));

  return {
    time: candles[last].closeTime,
    price: candles[last].close,
    action,
    strength,
    reasons,
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

/**
 * Compares the newest snapshot against the previous one. Returns true if the
 * action changed — consumers use this to decide whether to emit a new signal event.
 */
export function hasActionChanged(
  prev: SignalSnapshot | null,
  next: SignalSnapshot,
): boolean {
  if (!prev) return next.action !== "flat";
  return prev.action !== next.action;
}
