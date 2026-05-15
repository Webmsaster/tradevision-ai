/**
 * 2026-05-15 — Shared types + helpers for RegimeConfluence voters.
 *
 * Ported from `engine-rust/ftmo-engine-core/src/signals_*` on branch
 * `feature/r28-deploy`. The TypeScript pendants live in `src/utils/regimeVoters/`
 * so the live signal-service (`ftmoLiveEngineV4.ts`) can vote consistently
 * with the Rust backtest engine.
 *
 * **Critical convention difference between Rust and TS:**
 *
 * - **Rust:** `signal_idx = candles.len() - 2` (last fully-closed bar);
 *   entry executes at `candles[len - 1].open` (entry bar). The entry bar
 *   is NEVER read in the voting path.
 * - **TS (live):** the live engine passes the candle slice up to and
 *   including the just-closed bar. The last candle in the slice IS the
 *   signal bar (= `candles[len - 1]`). Entry executes at the NEXT bar's
 *   open which has not yet arrived.
 *
 * To preserve the Rust voter logic literally **and** stay live-safe, the
 * TS voters mirror the Rust signature exactly. Callers using the
 * Rust-convention pass the entry-bar in slot `len - 1`. Live callers that
 * only have signal bars must append a placeholder entry-bar slot (any
 * finite value works — voters never read it) before invoking. This keeps
 * the porting 1:1 with no logic divergence.
 *
 * To make this less footgun-y, each voter ALSO exposes a `*Live`
 * convenience wrapper that takes the signal-bar slice directly.
 */
import type { Candle } from "@/utils/indicators";

/** Voting direction. `null` = abstain. */
export type VoterSide = "long" | "short" | null;

/**
 * Append a synthetic placeholder entry-bar to a live-convention slice
 * (where the last element IS the signal bar) so the Rust-convention
 * voters work directly. The placeholder bar's content is irrelevant —
 * the voters all derive their signal from candles[..= len-2].
 */
export function withPlaceholderEntryBar(signalBarSlice: Candle[]): Candle[] {
  if (signalBarSlice.length === 0) return signalBarSlice;
  const last = signalBarSlice[signalBarSlice.length - 1]!;
  // Placeholder bar — content is never read but must be structurally valid.
  return [
    ...signalBarSlice,
    {
      openTime: last.openTime + 1,
      open: last.close,
      high: last.close,
      low: last.close,
      close: last.close,
      volume: 0,
      closeTime: last.closeTime + 1,
      isFinal: false,
    },
  ];
}

/** Population standard deviation (ddof=0). */
export function populationStd(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let acc = 0;
  for (const v of values) acc += (v - mean) ** 2;
  return Math.sqrt(acc / n);
}

/** Sample standard deviation (ddof=1). Matches POC-Z rust impl. */
export function sampleStd(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let acc = 0;
  for (const v of values) acc += (v - mean) ** 2;
  return Math.sqrt(acc / (n - 1));
}

/**
 * Rolling population std over a `period`-bar window.
 * Returns one entry per input index; index < period-1 → null.
 * Mirrors Rust `crate::indicators::rolling_std` (ddof=0).
 */
export function rollingStd(
  values: number[],
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let k = i - period + 1; k <= i; k++) sum += values[k]!;
    const mean = sum / period;
    let acc = 0;
    for (let k = i - period + 1; k <= i; k++) acc += (values[k]! - mean) ** 2;
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

/**
 * Wilder-smoothing ATR series. One entry per candle; ATR[i] is `null`
 * for i ≤ `period` (matches the Rust `crate::indicators::atr` convention
 * that returns `Option<f64>` and skips warmup).
 */
export function atrWilder(
  candles: Candle[],
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (period <= 0 || candles.length <= period) return out;
  // True-range series.
  const tr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const a = c.high - c.low;
    const b = Math.abs(c.high - prev.close);
    const d = Math.abs(c.low - prev.close);
    tr[i] = Math.max(a, b, d);
  }
  // Seed: simple-average TR over the first `period` bars (skipping idx 0).
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i]!;
  seed /= period;
  out[period] = seed;
  // Wilder recursion: ATR[i] = (ATR[i-1] * (period - 1) + TR[i]) / period.
  for (let i = period + 1; i < candles.length; i++) {
    const prev = out[i - 1]!;
    out[i] = (prev * (period - 1) + tr[i]!) / period;
  }
  return out;
}
