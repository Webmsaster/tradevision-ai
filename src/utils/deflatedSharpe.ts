/**
 * Deflated Sharpe Ratio (Bailey & López de Prado 2014, SSRN 2460551).
 *
 * The Sharpe you observe in a backtest is biased upward by:
 *   1. Skew & kurtosis of returns (fat tails inflate Sharpe)
 *   2. Finite-sample size (small N gives noisy Sharpe)
 *   3. **Multi-testing** — if you tried K strategies and picked the best,
 *      the reported Sharpe is selection-biased
 *
 * DSR computes the probability that the TRUE Sharpe is > 0 given all three
 * adjustments. Values > 0.95 = statistically robust edge. < 0.60 = likely
 * spurious even if raw Sharpe looks nice.
 *
 * Formula (after Bailey/LdP 2014):
 *   SR_0 = E[max(SR_k)] for K independent trials, approx:
 *          sqrt((1 - γ) × invΦ(1 - 1/K) + γ × invΦ(1 - 1/(K·e)))
 *          where γ is Euler-Mascheroni ≈ 0.5772
 *   Z = (SR - SR_0) × sqrt(N - 1) /
 *       sqrt(1 - skew·SR + ((kurt - 1) / 4)·SR²)
 *   DSR = Φ(Z)
 */

export interface DeflatedSharpeInput {
  returnsPct: number[]; // per-period decimal returns
  trialsTried: number; // number of strategies/configs evaluated (K)
  periodsPerYear?: number; // for annualised reporting (not used in DSR)
}

export interface DeflatedSharpeResult {
  sharpe: number; // raw (annualised)
  perPeriodSharpe: number;
  expectedMaxSharpe: number; // SR_0 benchmark
  deflatedSharpe: number; // probability in [0, 1]
  skewness: number;
  kurtosis: number;
  n: number;
  isSignificant95: boolean;
}

function normalCdf(x: number): number {
  // Abramowitz-Stegun approx
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * ax);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

function normalInvCdf(p: number): number {
  // Beasley-Springer-Moro
  if (p <= 0 || p >= 1) return 0;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  q = p - 0.5;
  r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
      q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

export function computeDeflatedSharpe(
  input: DeflatedSharpeInput,
): DeflatedSharpeResult {
  const r = input.returnsPct;
  const n = r.length;
  if (n < 10) {
    return {
      sharpe: 0,
      perPeriodSharpe: 0,
      expectedMaxSharpe: 0,
      deflatedSharpe: 0,
      skewness: 0,
      kurtosis: 3,
      n,
      isSignificant95: false,
    };
  }
  const mean = r.reduce((a, b) => a + b, 0) / n;
  const varR = r.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const std = Math.sqrt(varR);

  // Skew + excess kurtosis (Fisher's)
  let m3 = 0,
    m4 = 0;
  for (const v of r) {
    const d = v - mean;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m3 /= n;
  m4 /= n;
  const skew = std > 0 ? m3 / (std * std * std) : 0;
  const kurt = std > 0 ? m4 / (std * std * std * std) : 3;

  const sharpePerPeriod = std > 0 ? mean / std : 0;
  const periodsPerYear = input.periodsPerYear ?? 8760;
  const sharpeAnn = sharpePerPeriod * Math.sqrt(periodsPerYear);

  // Expected max Sharpe (SR_0) for K trials — per Bailey/LdP 2014, this is
  // the per-period Sharpe you'd get by pure multi-testing luck. The output
  // of inverse-normal is in units of stderr; we divide by sqrt(n-1) to get
  // per-period Sharpe units.
  const K = Math.max(1, input.trialsTried);
  const gamma = 0.5772156649;
  const expMaxRaw =
    (1 - gamma) * normalInvCdf(1 - 1 / K) +
    gamma * normalInvCdf(1 - 1 / (K * Math.E));
  const expMaxPerPeriod = expMaxRaw / Math.sqrt(Math.max(1, n - 1));
  const expMaxAnnualised = expMaxPerPeriod * Math.sqrt(periodsPerYear);

  // DSR Z-stat (per-period form)
  const denom = Math.sqrt(
    Math.max(
      1e-12,
      1 - skew * sharpePerPeriod + ((kurt - 1) / 4) * sharpePerPeriod ** 2,
    ),
  );
  const z =
    ((sharpePerPeriod - expMaxPerPeriod) * Math.sqrt(Math.max(1, n - 1))) /
    denom;
  const dsr = normalCdf(z);

  return {
    sharpe: sharpeAnn,
    perPeriodSharpe: sharpePerPeriod,
    expectedMaxSharpe: expMaxAnnualised,
    deflatedSharpe: dsr,
    skewness: skew,
    kurtosis: kurt,
    n,
    isSignificant95: dsr >= 0.95,
  };
}
