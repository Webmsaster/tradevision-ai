/**
 * 2026-05-15 TS port of `engine-rust/ftmo-engine-core/src/signals_hmm_regime.rs`
 * (feature/r28-deploy branch).
 *
 * 3-state Gaussian HMM regime-classifier voter. Forward algorithm with
 * per-step normalization. Phase-1 hardcoded `defaultBtc30mModel()` so the
 * wiring works without JSON-load.
 *
 * Features (2-d, diagonal covariance):
 *   1. log-return = ln(close[t] / close[t-1])
 *   2. realized-vol = std of log-returns over last `volLookbackBars` bars.
 *
 * Vote rule: Long when P(bull) ≥ pThresholdBull AND P(bear) ≤ pOppositeMax.
 * Short is symmetric. Otherwise abstain.
 *
 * Lookahead-safe: features extracted from `candles[..= signal_idx]` with
 * `signal_idx = candles.len() - 2`. Entry bar `candles[len - 1]` is never read.
 */
import type { Candle } from "@/utils/indicators";
import type { VoterSide } from "@/utils/regimeVoters/types";

export interface HmmRegimeParams {
  nStates: number;
  pThresholdBull: number;
  pThresholdBear: number;
  pOppositeMax: number;
  warmupBars: number;
  volLookbackBars: number;
}

export function defaultHmmRegimeParams(): HmmRegimeParams {
  return {
    nStates: 3,
    pThresholdBull: 0.55,
    pThresholdBear: 0.55,
    pOppositeMax: 0.2,
    warmupBars: 200,
    volLookbackBars: 48,
  };
}

export interface HmmModel {
  nStates: number;
  startProb: number[];
  /** n_states × n_states row-stochastic matrix. */
  transMat: number[][];
  /** n_states × n_features. */
  means: number[][];
  /** n_states × n_features (per-feature diagonal variance). */
  covars: number[][];
  /** Same order as state-rows; e.g. ["bear","range","bull"]. */
  stateLabels: string[];
}

/**
 * Hardcoded Phase-1 BTC-30m HMM. Mirrors the Rust
 * `HmmModel::default_btc_30m()` constants byte-for-byte.
 *
 * State 0=bear, 1=range, 2=bull. Diagonal covariance = 4e-6 per feature
 * (σ ≈ 0.002). Means in (log_return, realized_vol) space.
 */
export function defaultBtc30mModel(): HmmModel {
  return {
    nStates: 3,
    startProb: [1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0],
    transMat: [
      [0.96, 0.03, 0.01],
      [0.02, 0.96, 0.02],
      [0.01, 0.03, 0.96],
    ],
    means: [
      [-0.004, 0.012],
      [0.0, 0.004],
      [0.004, 0.012],
    ],
    covars: [
      [4.0e-6, 4.0e-6],
      [4.0e-6, 4.0e-6],
      [4.0e-6, 4.0e-6],
    ],
    stateLabels: ["bear", "range", "bull"],
  };
}

function stateIndexByLabel(model: HmmModel, name: string): number | null {
  const lname = name.toLowerCase();
  for (let i = 0; i < model.stateLabels.length; i++) {
    if (model.stateLabels[i]!.toLowerCase() === lname) return i;
  }
  if (model.stateLabels.length === 0 && model.nStates === 3) {
    if (name === "bear") return 0;
    if (name === "range") return 1;
    if (name === "bull") return 2;
  }
  return null;
}

function gaussianPdfDiag(
  obs: number[],
  mean: number[],
  variance: number[],
): number {
  let p = 1;
  const twoPi = 2 * Math.PI;
  for (let d = 0; d < obs.length; d++) {
    const o = obs[d]!;
    const m = mean[d]!;
    const v = variance[d]!;
    if (
      !Number.isFinite(o) ||
      !Number.isFinite(m) ||
      !Number.isFinite(v) ||
      v <= 0
    ) {
      return 0;
    }
    const z = (o - m) / Math.sqrt(v);
    const coef = 1 / Math.sqrt(twoPi * v);
    p *= coef * Math.exp(-0.5 * z * z);
  }
  return p;
}

function computeFeatures(
  candles: Candle[],
  idx: number,
  volLookbackBars: number,
): [number, number] | null {
  if (idx === 0 || volLookbackBars <= 0) return null;
  if (idx + 1 < volLookbackBars) return null;
  const prev = candles[idx - 1]!.close;
  const cur = candles[idx]!.close;
  if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur <= 0)
    return null;
  const lr = Math.log(cur / prev);
  if (!Number.isFinite(lr)) return null;

  const start = idx + 1 - volLookbackBars;
  if (start === 0) return null; // would need candles[-1].
  const returns: number[] = [];
  for (let k = start; k <= idx; k++) {
    const p0 = candles[k - 1]!.close;
    const p1 = candles[k]!.close;
    if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0 || p1 <= 0)
      return null;
    const r = Math.log(p1 / p0);
    if (!Number.isFinite(r)) return null;
    returns.push(r);
  }
  if (returns.length === 0) return null;
  const n = returns.length;
  let sum = 0;
  for (const r of returns) sum += r;
  const mean = sum / n;
  let varAcc = 0;
  for (const r of returns) varAcc += (r - mean) ** 2;
  const variance = varAcc / n;
  if (!Number.isFinite(variance) || variance < 0) return null;
  return [lr, Math.sqrt(variance)];
}

/**
 * Run the forward algorithm and return per-state posterior at the LAST
 * step. Normalizes alpha at every step to avoid underflow.
 */
export function forwardPosterior(
  model: HmmModel,
  obs: [number, number][],
): number[] | null {
  if (obs.length === 0 || model.nStates === 0) return null;
  const n = model.nStates;
  let alpha = new Array(n).fill(0) as number[];

  for (let k = 0; k < n; k++) {
    const pdf = gaussianPdfDiag(obs[0]!, model.means[k]!, model.covars[k]!);
    alpha[k] = model.startProb[k]! * pdf;
  }
  let s0 = 0;
  for (const a of alpha) s0 += a;
  if (!Number.isFinite(s0) || s0 <= 0) {
    alpha = [...model.startProb];
  } else {
    for (let k = 0; k < n; k++) alpha[k] = alpha[k]! / s0;
  }

  const next = new Array(n).fill(0) as number[];
  for (let t = 1; t < obs.length; t++) {
    for (let k = 0; k < n; k++) {
      let acc = 0;
      for (let j = 0; j < n; j++) {
        acc += alpha[j]! * model.transMat[j]![k]!;
      }
      const pdf = gaussianPdfDiag(obs[t]!, model.means[k]!, model.covars[k]!);
      next[k] = acc * pdf;
    }
    let s = 0;
    for (const v of next) s += v;
    if (Number.isFinite(s) && s > 0) {
      for (let k = 0; k < n; k++) alpha[k] = next[k]! / s;
    }
    // else: carry alpha unchanged (degenerate step).
  }
  return alpha;
}

export function computeHmmRegimeVote(
  candles: Candle[],
  model: HmmModel = defaultBtc30mModel(),
  params: HmmRegimeParams = defaultHmmRegimeParams(),
): VoterSide {
  if (params.warmupBars <= 0) return null;
  // +1 to keep `candles[len-1]` (entry bar) untouched.
  if (
    candles.length <
    Math.max(params.warmupBars, params.volLookbackBars + 2) + 1
  )
    return null;
  if (
    !Number.isFinite(params.pThresholdBull) ||
    !Number.isFinite(params.pThresholdBear) ||
    !Number.isFinite(params.pOppositeMax) ||
    params.pThresholdBull <= 0 ||
    params.pThresholdBear <= 0
  ) {
    return null;
  }
  const signalIdx = candles.length - 2;
  const obsStart = signalIdx + 1 - params.warmupBars;
  const obs: [number, number][] = [];
  for (let k = obsStart; k <= signalIdx; k++) {
    const f = computeFeatures(candles, k, params.volLookbackBars);
    if (f === null) return null;
    obs.push(f);
  }
  const posterior = forwardPosterior(model, obs);
  if (posterior === null) return null;

  const bullIdx = stateIndexByLabel(model, "bull");
  const bearIdx = stateIndexByLabel(model, "bear");
  if (bullIdx === null || bearIdx === null) return null;
  if (bullIdx >= posterior.length || bearIdx >= posterior.length) return null;
  const pBull = posterior[bullIdx]!;
  const pBear = posterior[bearIdx]!;
  if (!Number.isFinite(pBull) || !Number.isFinite(pBear)) return null;

  if (pBull >= params.pThresholdBull && pBear <= params.pOppositeMax)
    return "long";
  if (pBear >= params.pThresholdBear && pBull <= params.pOppositeMax)
    return "short";
  return null;
}
