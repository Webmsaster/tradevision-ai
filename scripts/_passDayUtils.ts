/**
 * Shared helpers for FTMO walk-forward result aggregation.
 *
 * Centralises three corrections that previously lived as copy-pasted snippets
 * across helpers and one-off test files:
 *
 * 1. `pick(q, sorted)` — percentile picker. Old version used
 *    `arr[Math.floor(arr.length * q)]` which is off-by-one for the upper end
 *    (q=1 lands past the array). Returns NaN on empty input instead of 0.
 *
 * 2. `computePassDay(result)` — pass-day count. Old version used
 *    `trades[trades.length-1].day + 1`, which under-counts when
 *    `pauseAtTargetReached` ends the run early on the same bar as the last
 *    trade entry (the engine still increments `uniqueTradingDays`). We now
 *    take `max(uniqueTradingDays, lastTrade.day + 1)`.
 *
 * 3. `assertAligned(byAsset)` — verifies all per-asset arrays share the same
 *    `openTime` at every index (required for walk-forward slicing). The
 *    backtest engine's internal `alignsByTimestamp` returns `false` silently
 *    on mismatch, masking time-misaligned data.
 *
 * Plus a Fisher-Yates `shuffleInPlace()` to replace the biased
 * `arr.sort(() => Math.random() - 0.5)` idiom.
 *
 * Plus a tiny seedable LCG `mkRng(seed)` so random-search tests are
 * reproducible without adding a `seedrandom` dependency.
 */
import type { FtmoDaytrade24hResult } from "../src/utils/ftmoDaytrade24h";
import type { Candle } from "../src/utils/indicators";

/**
 * Quantile pick on a sorted ascending array. Empty input returns NaN.
 *
 * idx = clamp( ceil(n*q) - 1, 0, n-1 )
 *
 * For n=10:
 *   q=0    → idx 0       (was 0)
 *   q=0.25 → idx 2       (was 2)   identical
 *   q=0.5  → idx 4       (was 5)   ← change
 *   q=0.9  → idx 8       (was 9)   ← change
 *   q=1.0  → idx 9       (was OOB) ← change
 */
export function pick(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(n * q) - 1));
  return sortedAsc[idx];
}

/**
 * Days needed to reach the FTMO target for a passed window.
 *
 * `pauseAtTargetReached:true` ends the engine loop at the bar that pushes
 * equity over the profit target. `uniqueTradingDays` already counts that
 * day; `lastTrade.day` is 0-indexed. We take the max for safety against
 * either being lower than reality.
 */
export function computePassDay(r: FtmoDaytrade24hResult): number {
  if (!r.passed || r.trades.length === 0) return 0;
  const lastDay = r.trades[r.trades.length - 1].day + 1;
  return Math.max(r.uniqueTradingDays, lastDay);
}

/**
 * Assert that all per-asset candle arrays share the same `openTime` at
 * every index they share. Throws on mismatch with a precise location.
 */
export function assertAligned(byAsset: Record<string, Candle[]>): void {
  const symbols = Object.keys(byAsset);
  if (symbols.length < 2) return;
  const ref = byAsset[symbols[0]];
  const minLen = Math.min(...symbols.map((s) => byAsset[s].length));
  for (let i = 0; i < minLen; i++) {
    const t = ref[i].openTime;
    for (let k = 1; k < symbols.length; k++) {
      const s = symbols[k];
      if (byAsset[s][i].openTime !== t) {
        throw new Error(
          `Time misalignment at index ${i}: ${symbols[0]}=${t} vs ${s}=${byAsset[s][i].openTime}`,
        );
      }
    }
  }
}

/** Fisher-Yates shuffle in place. Pass `rng` for deterministic shuffles. */
export function shuffleInPlace<T>(
  arr: T[],
  rng: () => number = Math.random,
): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Convenience: shuffle a copy. */
export function shuffled<T>(arr: T[], rng: () => number = Math.random): T[] {
  return shuffleInPlace([...arr], rng);
}

/**
 * Mulberry32 — small, fast, well-tested seedable PRNG. Suitable for
 * reproducible random search; not cryptographically secure.
 */
export function mkRng(seed = 1): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
