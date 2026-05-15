/**
 * 2026-05-15 TS port of `compute_poc_z_vote` (inline in
 * `engine-rust/ftmo-engine-core/src/signals_regime_confluence.rs` — Detector #12,
 * feature/r28-deploy branch).
 *
 * Multi-bar Volume-Profile POC-Z distance voter. Builds a discrete volume
 * profile over `pocWindowBars` (TF-scaled by 30/barMinutes so a 30m-tuned
 * window stays time-equivalent on 5m/2h feeds). The bar with max bucketed
 * volume = POC. Distance from signal-bar close to POC-mid z-scored against
 * the window's close-distribution std (sample-std, ddof=1).
 *
 * Voting contract:
 *   z ≥ +pocZMin  → short  (price far above value → mean-revert down)
 *   z ≤ -pocZMin  → long   (price far below value → mean-revert up)
 *   |z| < pocZMin → null   (within typical band; abstain)
 *
 * Lookahead-safe: window strictly ends at `signal_idx = candles.len() - 2`.
 */
import type { Candle } from "@/utils/indicators";
import type { VoterSide } from "@/utils/regimeVoters/types";

export interface PocZParams {
  /** Window length in BARS (TF-scaled — see `barMinutes`). Default 20. */
  pocWindowBars: number;
  /** Bucket size as fraction of window's first-close. Default 0.005 = 0.5%. */
  pocBucketPct: number;
  /** Minimum |z| to vote. Default 1.5. */
  pocZMin: number;
  /** Underlying bar duration in minutes (for TF-scaling). Default 30. */
  barMinutes: number;
}

export function defaultPocZParams(): PocZParams {
  return {
    pocWindowBars: 20,
    pocBucketPct: 0.005,
    pocZMin: 1.5,
    barMinutes: 30,
  };
}

export function computePocZVote(
  candles: Candle[],
  params: PocZParams = defaultPocZParams(),
): VoterSide {
  // TF-scale: 30 / barMinutes — keep a 30m-tuned window time-equivalent.
  const scale = Math.max(1, Math.round(30.0 / Math.max(1, params.barMinutes)));
  const n = (params.pocWindowBars | 0) * scale;
  if (n < 4 || candles.length < n + 2) return null;
  if (!Number.isFinite(params.pocZMin) || params.pocZMin <= 0) return null;
  if (!Number.isFinite(params.pocBucketPct) || params.pocBucketPct <= 0)
    return null;

  const signalIdx = candles.length - 2;
  const windowStart = signalIdx + 1 - n;
  const window = candles.slice(windowStart, signalIdx + 1);
  const firstClose = window[0]!.close;
  if (!Number.isFinite(firstClose) || firstClose <= 0) return null;
  const bucketSize = params.pocBucketPct * firstClose;
  if (bucketSize <= 0 || !Number.isFinite(bucketSize)) return null;

  const buckets = new Map<number, number>();
  const closes: number[] = [];
  let totalVol = 0;
  for (const c of window) {
    if (!Number.isFinite(c.close) || !Number.isFinite(c.volume) || c.volume < 0)
      return null;
    const key = Math.floor(c.close / bucketSize);
    buckets.set(key, (buckets.get(key) ?? 0) + c.volume);
    closes.push(c.close);
    totalVol += c.volume;
  }
  if (totalVol <= 0) return null;

  // Find max-volume bucket.
  let pocKey = 0;
  let pocVol = Number.NEGATIVE_INFINITY;
  for (const [k, v] of buckets.entries()) {
    if (v > pocVol) {
      pocVol = v;
      pocKey = k;
    }
  }
  const pocPrice = (pocKey + 0.5) * bucketSize;

  // Sample-std (ddof=1) of closes.
  let sum = 0;
  for (const c of closes) sum += c;
  const mean = sum / n;
  let varAcc = 0;
  for (const c of closes) varAcc += (c - mean) ** 2;
  const variance = varAcc / (n - 1);
  const std = Math.sqrt(variance);
  if (std <= 0 || !Number.isFinite(std)) return null;

  const signalClose = candles[signalIdx]!.close;
  const distZ = (signalClose - pocPrice) / std;
  if (!Number.isFinite(distZ)) return null;

  if (distZ >= params.pocZMin) return "short";
  if (distZ <= -params.pocZMin) return "long";
  return null;
}
