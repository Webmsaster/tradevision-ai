export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  isFinal: boolean;
  /**
   * Aggressive buy volume (taker-buy base asset volume in the Binance
   * kline schema). Needed for CVD / Taker-Buy-Imbalance strategies.
   * Populated only by loaders that capture it; fall back to volume/2 if
   * unknown.
   */
  takerBuyVolume?: number;
}

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += values[i]! - values[i - period]!;
    out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  // Round 56 (R56-IND-1): a NaN in the seed window poisons every subsequent
  // EMA value forever (NaN * anything = NaN). Surface the seed only when it
  // is finite; otherwise hold null until the first finite recursive value.
  out[period - 1] = Number.isFinite(prev) ? prev : null;

  for (let i = period; i < values.length; i++) {
    // Round 56 (R56-IND-1): NaN-guard. Hold previous value to self-heal
    // instead of poisoning all downstream samples.
    const v = values[i]!;
    if (!Number.isFinite(v)) {
      out[i] = Number.isFinite(prev) ? prev : null;
      continue;
    }
    if (!Number.isFinite(prev)) {
      // Re-seed from the first finite sample after a poisoned seed window.
      prev = v;
    } else {
      prev = v * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

function rsiFromAvgs(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  let seedValid = true;
  for (let i = 1; i <= period; i++) {
    const a = values[i]!;
    const b = values[i - 1]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      // Round 56 (R56-IND-1): a single NaN in the seed window contaminates
      // avgGain/avgLoss and freezes RSI at NaN forever. Mark the seed
      // invalid and let the recursive loop self-heal once finite samples
      // resume.
      seedValid = false;
      continue;
    }
    const change = a - b;
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = seedValid ? rsiFromAvgs(avgGain, avgLoss) : null;

  for (let i = period + 1; i < values.length; i++) {
    // Round 56 (R56-IND-1): if either sample is NaN, hold the previous
    // RSI reading and skip Wilder smoothing for this bar.
    const a = values[i]!;
    const b = values[i - 1]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      out[i] = out[i - 1] ?? null;
      continue;
    }
    const change = a - b;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (!seedValid) {
      // Re-seed Wilder averages from the first finite recursive bar.
      avgGain = gain;
      avgLoss = loss;
      seedValid = true;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    out[i] = rsiFromAvgs(avgGain, avgLoss);
  }

  return out;
}

export interface MacdOutput {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

/**
 * Moving Average Convergence Divergence.
 *
 * NB: the signal line is seeded with an SMA(9) of the first 9 valid MACD
 * values (because we delegate to `ema()` which always seeds with SMA over
 * `period` samples). TradingView seeds its signal line with the first
 * MACD value as a single-sample EMA carry. The two conventions disagree
 * by ~0.1pp in the first ~10 bars after the slow-period (26) warmup;
 * they converge afterwards. This is intentional — keep this convention
 * stable across the codebase (signal-detector, AI insights, charts).
 */
export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdOutput {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const macdLine: (number | null)[] = values.map((_, i) =>
    fastEma[i] !== null && slowEma[i] !== null
      ? (fastEma[i] as number) - (slowEma[i] as number)
      : null,
  );

  const firstValidIdx = macdLine.findIndex((v) => v !== null);
  const signalLine: (number | null)[] = new Array(values.length).fill(null);
  if (firstValidIdx >= 0) {
    const slice = macdLine
      .slice(firstValidIdx)
      .map((v) => (v === null ? 0 : v));
    const sig = ema(slice, signalPeriod);
    for (let i = 0; i < sig.length; i++) {
      signalLine[firstValidIdx + i] = sig[i] ?? null;
    }
  }

  const histogram: (number | null)[] = values.map((_, i) =>
    macdLine[i] !== null && signalLine[i] !== null
      ? (macdLine[i] as number) - (signalLine[i] as number)
      : null,
  );

  return { macd: macdLine, signal: signalLine, histogram };
}

export interface AdxOutput {
  adx: (number | null)[];
  plusDi: (number | null)[];
  minusDi: (number | null)[];
}

/**
 * Average Directional Index + directional indicators. Classic Wilder smoothing.
 * ADX < 20 = weak/no trend (ranging), 20-40 = trending, > 40 = very strong trend.
 */
export function adx(candles: Candle[], period = 14): AdxOutput {
  const n = candles.length;
  const empty: AdxOutput = {
    adx: new Array(n).fill(null),
    plusDi: new Array(n).fill(null),
    minusDi: new Array(n).fill(null),
  };
  if (n < period * 2 + 1) return empty;

  const tr: number[] = new Array(n).fill(0);
  const plusDm: number[] = new Array(n).fill(0);
  const minusDm: number[] = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const upMove = c!.high - p!.high;
    const downMove = p!.low - c!.low;
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      c!.high - c!.low,
      Math.abs(c!.high - p!.close),
      Math.abs(c!.low - p!.close),
    );
  }

  // Wilder smoothing
  let trSum = 0;
  let plusDmSum = 0;
  let minusDmSum = 0;
  for (let i = 1; i <= period; i++) {
    trSum += tr[i]!;
    plusDmSum += plusDm[i]!;
    minusDmSum += minusDm[i]!;
  }

  const plusDiArr: (number | null)[] = new Array(n).fill(null);
  const minusDiArr: (number | null)[] = new Array(n).fill(null);
  const dxArr: number[] = [];

  plusDiArr[period] = trSum === 0 ? 0 : (plusDmSum / trSum) * 100;
  minusDiArr[period] = trSum === 0 ? 0 : (minusDmSum / trSum) * 100;
  const firstDx =
    plusDiArr[period]! + minusDiArr[period]! === 0
      ? 0
      : (Math.abs(plusDiArr[period]! - minusDiArr[period]!) /
          (plusDiArr[period]! + minusDiArr[period]!)) *
        100;
  dxArr.push(firstDx);

  for (let i = period + 1; i < n; i++) {
    trSum = trSum - trSum / period + tr[i]!;
    plusDmSum = plusDmSum - plusDmSum / period + plusDm[i]!;
    minusDmSum = minusDmSum - minusDmSum / period + minusDm[i]!;
    const plusDi = trSum === 0 ? 0 : (plusDmSum / trSum) * 100;
    const minusDi = trSum === 0 ? 0 : (minusDmSum / trSum) * 100;
    plusDiArr[i] = plusDi;
    minusDiArr[i] = minusDi;
    const dx =
      plusDi + minusDi === 0
        ? 0
        : (Math.abs(plusDi - minusDi) / (plusDi + minusDi)) * 100;
    dxArr.push(dx);
  }

  // dxArr[k] corresponds to candles[period + k]. First ADX seed = SMA of first `period`
  // dx values, placed at candles[2*period - 1]. Subsequent values use Wilder smoothing.
  const adxArr: (number | null)[] = new Array(n).fill(null);
  if (dxArr.length >= period) {
    let adxVal = dxArr.slice(0, period).reduce((s, v) => s + v, 0) / period;
    adxArr[2 * period - 1] = adxVal;
    for (let i = period; i < dxArr.length; i++) {
      adxVal = (adxVal * (period - 1) + dxArr[i]!) / period;
      adxArr[period + i] = adxVal;
    }
  }

  return { adx: adxArr, plusDi: plusDiArr, minusDi: minusDiArr };
}

/**
 * Choppiness Index — measures market trend vs sideways state.
 * CI = 100 × log10(SUM(TrueRange, period) / (MaxHigh(period) - MinLow(period))) / log10(period)
 * Values: 0-100. >61.8 = choppy/sideways, <38.2 = trending.
 */
export function choppiness(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  // R67 audit (Round 3): period=1 gives log10(1)=0 → division-by-zero →
  // NaN output that downstream `null`-only checks miss. Mirror the Rust
  // guard (detector_filters.rs:133): require period ≥ 2.
  if (period < 2 || candles.length <= period) return out;
  const tr: number[] = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1]!.close;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
  });
  const log10p = Math.log10(period);
  for (let i = period; i < candles.length; i++) {
    let sumTr = 0,
      maxH = -Infinity,
      minL = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      sumTr += tr[j]!;
      if (candles[j]!.high > maxH) maxH = candles[j]!.high;
      if (candles[j]!.low < minL) minL = candles[j]!.low;
    }
    const range = maxH - minL;
    if (range > 0) {
      // BUGFIX 2026-04-28 (Round 9): clamp to documented 0-100 scale.
      // log10(sumTr/range) can be negative when sumTr < range (compact range).
      const ci = (100 * Math.log10(sumTr / range)) / log10p;
      out[i] = Math.max(0, Math.min(100, ci));
    }
  }
  return out;
}

export function atr(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;

  const tr: number[] = candles.map((c, i) => {
    if (i === 0) {
      const r = c.high - c.low;
      return Number.isFinite(r) ? r : NaN;
    }
    const prevClose = candles[i - 1]!.close;
    if (
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(prevClose)
    ) {
      return NaN;
    }
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
  });

  // Round 56 (R56-IND-1): a single NaN TR (e.g. broken candle) used to
  // poison every subsequent ATR sample via Wilder smoothing. Self-heal
  // by holding the previous valid value when the current TR is NaN.
  let sum = 0;
  let seedValid = true;
  for (let i = 1; i <= period; i++) {
    if (!Number.isFinite(tr[i]!)) {
      seedValid = false;
      continue;
    }
    sum += tr[i]!;
  }
  let prev = sum / period;
  out[period] = seedValid && Number.isFinite(prev) ? prev : null;

  for (let i = period + 1; i < candles.length; i++) {
    const t = tr[i]!;
    if (!Number.isFinite(t)) {
      out[i] = Number.isFinite(prev) ? prev : null;
      continue;
    }
    if (!Number.isFinite(prev)) {
      // Re-seed once a finite TR appears after a NaN-poisoned seed.
      prev = t;
    } else {
      prev = (prev * (period - 1) + t) / period;
    }
    out[i] = prev;
  }

  return out;
}
