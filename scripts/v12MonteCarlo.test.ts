/**
 * R29-V12 Monte-Carlo bootstrap robustness test for V12_30M_OPT champion.
 *
 *   node ./node_modules/vitest/vitest.mjs run \
 *     --config vitest.scripts.config.ts scripts/v12MonteCarlo.test.ts
 *
 * Reads window outcomes from r29_iterV12_stock_shard_{0..7}.jsonl,
 * bootstrap-resamples 10k×, reports pass-rate CI + statistical sanity.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CACHE_DIR = "scripts/cache_bakeoff";
const SHARD_COUNT = 8;
const SHARD_PREFIX = "r29_iterV12_stock_shard_";
const N_BOOTSTRAP = 10_000;
const SEED = 42;
const REPORT_JSON = resolve("scripts/v12-monte-carlo-report.json");
const REPORT_MD = resolve("scripts/v12-monte-carlo-report.md");

type Outcome = {
  winIdx: number;
  passed: boolean;
  reason: string;
  passDay: number | null;
  finalEquityPct: number;
};

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadOutcomes(): Outcome[] {
  const out: Outcome[] = [];
  for (let i = 0; i < SHARD_COUNT; i += 1) {
    const f = `${CACHE_DIR}/${SHARD_PREFIX}${i}.jsonl`;
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line));
    }
  }
  return out;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - idx) + sorted[hi]! * (idx - lo);
}

describe("V12_30M_OPT Monte-Carlo Bootstrap", () => {
  it("computes pass-rate confidence interval", () => {
    const outcomes = loadOutcomes();
    const N = outcomes.length;
    expect(N).toBeGreaterThan(50);

    const pointEstimate = outcomes.filter((o) => o.passed).length / N;
    const finalEqPctSorted = [...outcomes]
      .map((o) => o.finalEquityPct)
      .sort((a, b) => a - b);

    const rng = mulberry32(SEED);
    const passRates: number[] = [];
    const eqMedians: number[] = [];

    for (let it = 0; it < N_BOOTSTRAP; it += 1) {
      let p = 0;
      const eqs: number[] = [];
      for (let j = 0; j < N; j += 1) {
        const idx = Math.floor(rng() * N);
        const o = outcomes[idx]!;
        if (o.passed) p += 1;
        eqs.push(o.finalEquityPct);
      }
      passRates.push(p / N);
      eqs.sort((a, b) => a - b);
      eqMedians.push(quantile(eqs, 0.5));
    }
    passRates.sort((a, b) => a - b);
    eqMedians.sort((a, b) => a - b);

    const mean = passRates.reduce((s, x) => s + x, 0) / passRates.length;
    const sd = Math.sqrt(
      passRates.reduce((s, x) => s + (x - mean) ** 2, 0) / passRates.length,
    );
    const ci95Lo = quantile(passRates, 0.025);
    const ci95Hi = quantile(passRates, 0.975);
    const ci99Lo = quantile(passRates, 0.005);
    const ci99Hi = quantile(passRates, 0.995);

    const below55 = passRates.filter((r) => r < 0.55).length / passRates.length;
    const above70 = passRates.filter((r) => r > 0.7).length / passRates.length;
    const above65 = passRates.filter((r) => r > 0.65).length / passRates.length;

    const histogram: Record<string, number> = {};
    for (const r of passRates) {
      const bucket = `${(Math.floor(r * 100) / 100).toFixed(2)}`;
      histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    }

    const eqMedian50 = quantile(finalEqPctSorted, 0.5);
    const eqP10 = quantile(finalEqPctSorted, 0.1);
    const eqP90 = quantile(finalEqPctSorted, 0.9);

    const reasonCounts: Record<string, number> = {};
    for (const o of outcomes) {
      reasonCounts[o.reason] = (reasonCounts[o.reason] ?? 0) + 1;
    }

    const report = {
      n_windows: N,
      n_bootstrap: N_BOOTSTRAP,
      seed: SEED,
      point_estimate: pointEstimate,
      bootstrap_mean: mean,
      bootstrap_stddev: sd,
      ci95_lo: ci95Lo,
      ci95_hi: ci95Hi,
      ci99_lo: ci99Lo,
      ci99_hi: ci99Hi,
      p_below_55: below55,
      p_above_65: above65,
      p_above_70: above70,
      final_equity: { p10: eqP10, p50: eqMedian50, p90: eqP90 },
      reason_counts: reasonCounts,
      histogram,
    };

    writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
    const md = [
      "# V12_30M_OPT_STOCK Monte-Carlo Bootstrap",
      "",
      `- Source: \`scripts/cache_bakeoff/${SHARD_PREFIX}{0..${SHARD_COUNT - 1}}.jsonl\``,
      `- N windows: **${N}**`,
      `- Bootstraps: ${N_BOOTSTRAP}, seed=${SEED}`,
      "",
      "## Headline",
      "",
      `- **Point estimate**: ${(pointEstimate * 100).toFixed(2)}%`,
      `- Bootstrap mean: ${(mean * 100).toFixed(2)}%`,
      `- StdDev: ${(sd * 100).toFixed(2)}pp`,
      `- 95% CI: [${(ci95Lo * 100).toFixed(2)}%, ${(ci95Hi * 100).toFixed(2)}%]`,
      `- 99% CI: [${(ci99Lo * 100).toFixed(2)}%, ${(ci99Hi * 100).toFixed(2)}%]`,
      `- P(rate > 65%) live-target: **${(above65 * 100).toFixed(1)}%**`,
      `- P(rate > 70%) overshoot: ${(above70 * 100).toFixed(1)}%`,
      `- P(rate < 55%) downside: ${(below55 * 100).toFixed(1)}%`,
      "",
      "## Final equity %",
      `- P10: ${(eqP10 * 100).toFixed(2)}%`,
      `- P50 (median): ${(eqMedian50 * 100).toFixed(2)}%`,
      `- P90: ${(eqP90 * 100).toFixed(2)}%`,
      "",
      "## Failure reasons",
      Object.entries(reasonCounts)
        .map(([k, v]) => `- ${k}: ${v} (${((v / N) * 100).toFixed(1)}%)`)
        .join("\n"),
      "",
    ].join("\n");
    writeFileSync(REPORT_MD, md);

    // sanity asserts
    expect(ci95Lo).toBeLessThanOrEqual(pointEstimate);
    expect(pointEstimate).toBeLessThanOrEqual(ci95Hi);
    expect(ci99Lo).toBeLessThanOrEqual(ci95Lo);
    expect(ci95Hi).toBeLessThanOrEqual(ci99Hi);
    expect(sd).toBeGreaterThan(0);
    expect(Math.abs(mean - pointEstimate)).toBeLessThan(0.01);
  });
});
