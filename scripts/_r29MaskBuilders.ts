/**
 * R29-R8 mask builders.
 *
 * Each function takes aligned per-asset candles and returns a per-asset
 * boolean series indicating "entry allowed at bar i". Multiple masks can
 * be AND-combined via {@link andMasks}.
 */
import type { Candle } from "../src/utils/indicators";

/**
 * Cross-Sectional Momentum gate.
 * For each bar i, rank assets by trailing `lookbackBars` return.
 * Assets in top-N (positive momentum) OR bottom-N (negative momentum)
 * pass the filter; middle assets are blocked.
 *
 * Rationale: PASSLOCK trades both directions; cross-mom strips out
 * "no-momentum" assets where the trend strategy is most likely to
 * chop. We don't enforce direction (long-only-top / short-only-bottom)
 * because that would conflict with PASSLOCK's directional logic; we
 * simply block mid-momentum assets where edges are weakest.
 */
export function buildCrossMomentumMask(
  alignedCandles: Record<string, Candle[]>,
  lookbackBars: number,
  topN: number,
): Record<string, (boolean | null)[]> {
  const symbols = Object.keys(alignedCandles);
  const len = alignedCandles[symbols[0]!]!.length;
  const masks: Record<string, (boolean | null)[]> = {};
  for (const s of symbols) masks[s] = new Array(len);

  for (let i = 0; i < len; i++) {
    if (i < lookbackBars) {
      for (const s of symbols) masks[s]![i] = null;
      continue;
    }
    const rets: { sym: string; ret: number }[] = [];
    for (const s of symbols) {
      const c = alignedCandles[s]!;
      const past = c[i - lookbackBars]!.close;
      const now = c[i]!.close;
      rets.push({ sym: s, ret: now / past - 1 });
    }
    rets.sort((a, b) => b.ret - a.ret);
    const topSet = new Set(rets.slice(0, topN).map((r) => r.sym));
    const bottomSet = new Set(rets.slice(rets.length - topN).map((r) => r.sym));
    for (const s of symbols) {
      masks[s]![i] = topSet.has(s) || bottomSet.has(s);
    }
  }
  return masks;
}

/**
 * HMM-light regime gate.
 * Computes rolling realized vol (stddev of log-returns over `volLookback`),
 * then ranks each bar's vol against the trailing `percentileWindow` bars.
 * Allowed = vol percentile in [minPct, maxPct]. Defaults strip out the
 * lowest-vol (chop/range) and highest-vol (panic) regimes.
 */
export function buildRegimeMask(
  alignedCandles: Record<string, Candle[]>,
  opts: {
    volLookback: number;
    percentileWindow: number;
    minPct: number;
    maxPct: number;
  },
): Record<string, (boolean | null)[]> {
  const { volLookback, percentileWindow, minPct, maxPct } = opts;
  const symbols = Object.keys(alignedCandles);
  const masks: Record<string, (boolean | null)[]> = {};
  for (const s of symbols) {
    const candles = alignedCandles[s]!;
    const len = candles.length;
    const m: (boolean | null)[] = new Array(len);

    // Pre-compute log returns.
    const lr: number[] = new Array(len);
    lr[0] = 0;
    for (let i = 1; i < len; i++) {
      const prev = candles[i - 1]!.close;
      const cur = candles[i]!.close;
      lr[i] = prev > 0 ? Math.log(cur / prev) : 0;
    }
    // Realized vol: rolling stddev over volLookback.
    const vol: (number | null)[] = new Array(len);
    for (let i = 0; i < len; i++) {
      if (i < volLookback) {
        vol[i] = null;
        continue;
      }
      let sum = 0;
      for (let j = i - volLookback + 1; j <= i; j++) sum += lr[j]!;
      const mean = sum / volLookback;
      let v = 0;
      for (let j = i - volLookback + 1; j <= i; j++) {
        const d = lr[j]! - mean;
        v += d * d;
      }
      vol[i] = Math.sqrt(v / volLookback);
    }
    // Rolling percentile rank.
    for (let i = 0; i < len; i++) {
      if (i < volLookback + percentileWindow || vol[i] === null) {
        m[i] = null;
        continue;
      }
      const cur = vol[i]!;
      let rank = 0;
      let n = 0;
      for (let j = i - percentileWindow + 1; j <= i; j++) {
        const v = vol[j];
        if (v === null) continue;
        if (v < cur) rank++;
        n++;
      }
      const pct = n > 0 ? (rank / n) * 100 : 50;
      m[i] = pct >= minPct && pct <= maxPct;
    }
    masks[s] = m;
  }
  return masks;
}

/**
 * AND-combine multiple per-asset masks. Result: true iff all input
 * masks are true (or null in which case treated as "no opinion → pass").
 */
export function andMasks(
  ...masks: Record<string, (boolean | null)[]>[]
): Record<string, (boolean | null)[]> {
  const symbols = new Set<string>();
  for (const m of masks) for (const s of Object.keys(m)) symbols.add(s);
  const out: Record<string, (boolean | null)[]> = {};
  for (const s of symbols) {
    let len = 0;
    for (const m of masks) if (m[s] && m[s]!.length > len) len = m[s]!.length;
    const series: (boolean | null)[] = new Array(len);
    for (let i = 0; i < len; i++) {
      let allow: boolean | null = null;
      let blocked = false;
      for (const m of masks) {
        const v = m[s]?.[i];
        if (v === false) {
          blocked = true;
          break;
        }
        if (v === true) allow = true;
      }
      series[i] = blocked ? false : allow;
    }
    out[s] = series;
  }
  return out;
}
