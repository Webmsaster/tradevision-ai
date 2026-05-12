/**
 * PASSLOCK Monte-Carlo Bootstrap Robustness Test
 * ================================================
 *
 * Question: Is R28_V6_PASSLOCK's documented 63.24% pass-rate (86/136) a
 * robust sweet-spot or a sample-specific lucky-strike?
 *
 * Method:
 *   1. Load N=136 window outcomes from cached jsonl shards
 *      (scripts/cache_bakeoff/r28v6_v60_passlock_shard_*.jsonl).
 *   2. Bootstrap: sample-with-replacement N windows × 10000 iterations.
 *      For each iteration compute pass-rate (% passed). Report:
 *        - point estimate
 *        - 95% CI (2.5th + 97.5th percentile)
 *        - StdDev
 *        - P(rate < 55%) — live-deploy floor
 *        - P(rate > 70%) — overfit-suspicion ceiling
 *        - histogram in 1pp buckets
 *   3. Same bootstrap on median final-equity-pct + p10 + p90.
 *   4. Output JSON + Markdown summary alongside this file.
 *
 * Important note on data-source:
 *   The CURRENT cache files reflect the POST-R9 engine state (after the
 *   gap-fill bugfix in commit 46d9bb3 changed src/utils/ftmoLiveEngineV4.ts
 *   gap-down stop-fills to use bar.open). Aggregator on current cache shows
 *   76/136 = 55.88%. The DOCUMENTED 86/136 = 63.24% claim was from the
 *   PRE-R9 run on May 5, recorded in scripts/cache_bakeoff/r60_runall_resume.log.
 *   This test bootstraps the FACTUAL current outcomes — see the report for
 *   discussion of pre-R9 vs post-R9 drift.
 *
 * Run:
 *   node ./node_modules/vitest/vitest.mjs run \
 *     --config vitest.scripts.config.ts \
 *     scripts/passlockMonteCarlo.test.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CACHE_DIR = "scripts/cache_bakeoff";
const SHARD_COUNT = 8;
const SHARD_PREFIX = "r28v6_v60_passlock_shard_";
const N_BOOTSTRAP = 10_000;
const SEED = 42; // deterministic — change to re-randomise.
const REPORT_JSON = resolve("scripts/passlock-monte-carlo-report.json");
const REPORT_MD = resolve("scripts/passlock-monte-carlo-report.md");

type Outcome = {
  winIdx: number;
  passed: boolean;
  reason: string;
  passDay: number | null;
  finalEquityPct: number;
};

// ─────────────────────────────────────────────────────────────────────────
// Mulberry32 — fast, seeded, deterministic uint32 PRNG
// ─────────────────────────────────────────────────────────────────────────
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
  const all: Outcome[] = [];
  for (let s = 0; s < SHARD_COUNT; s++) {
    const f = `${CACHE_DIR}/${SHARD_PREFIX}${s}.jsonl`;
    if (!existsSync(f)) {
      throw new Error(
        `Missing PASSLOCK shard: ${f}. Run scripts/_r28V6Round60Shard.ts to regenerate.`,
      );
    }
    const lines = readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const o = JSON.parse(line) as Outcome;
      all.push(o);
    }
  }
  // Sort by winIdx for stable ordering (bootstrap doesn't care, but reports do).
  all.sort((a, b) => a.winIdx - b.winIdx);
  return all;
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = (sortedAsc.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = idx - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return NaN;
  const m = mean(arr);
  let s = 0;
  for (const x of arr) {
    const d = x - m;
    s += d * d;
  }
  return Math.sqrt(s / (arr.length - 1));
}

interface BootstrapStats {
  point: number;
  mean: number;
  stdDev: number;
  ci95Low: number;
  ci95High: number;
  ci99Low: number;
  ci99High: number;
  pBelow55: number;
  pAbove70: number;
  pBelow50: number;
  pAbove65: number;
  histogram1pp: { bucket: number; count: number; pct: number }[];
}

function bootstrapPassRate(
  outcomes: Outcome[],
  rng: () => number,
  iterations: number,
): BootstrapStats {
  const n = outcomes.length;
  const passedFlags = outcomes.map((o) => (o.passed ? 1 : 0));
  const point = (passedFlags.reduce((a, b) => a + b, 0) / n) * 100;

  const rates: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let count = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rng() * n);
      count += passedFlags[idx]!;
    }
    rates[i] = (count / n) * 100;
  }
  const sorted = [...rates].sort((a, b) => a - b);

  // Histogram in 1pp buckets from 0 to 100 (only populated buckets reported).
  const buckets = new Map<number, number>();
  for (const r of rates) {
    const b = Math.floor(r);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const histogram1pp = [...buckets.entries()]
    .map(([bucket, count]) => ({
      bucket,
      count,
      pct: (count / iterations) * 100,
    }))
    .sort((a, b) => a.bucket - b.bucket);

  return {
    point,
    mean: mean(rates),
    stdDev: stdDev(rates),
    ci95Low: quantile(sorted, 0.025),
    ci95High: quantile(sorted, 0.975),
    ci99Low: quantile(sorted, 0.005),
    ci99High: quantile(sorted, 0.995),
    pBelow55: rates.filter((r) => r < 55).length / iterations,
    pAbove70: rates.filter((r) => r > 70).length / iterations,
    pBelow50: rates.filter((r) => r < 50).length / iterations,
    pAbove65: rates.filter((r) => r > 65).length / iterations,
    histogram1pp,
  };
}

interface EquityStats {
  point: { median: number; p10: number; p90: number };
  bootstrap: {
    median: { mean: number; ci95Low: number; ci95High: number; stdDev: number };
    p10: { mean: number; ci95Low: number; ci95High: number; stdDev: number };
    p90: { mean: number; ci95Low: number; ci95High: number; stdDev: number };
  };
}

function bootstrapEquity(
  outcomes: Outcome[],
  rng: () => number,
  iterations: number,
): EquityStats {
  const n = outcomes.length;
  const eq = outcomes.map((o) => o.finalEquityPct * 100);
  const eqSorted = [...eq].sort((a, b) => a - b);
  const pointMedian = quantile(eqSorted, 0.5);
  const pointP10 = quantile(eqSorted, 0.1);
  const pointP90 = quantile(eqSorted, 0.9);

  const medians: number[] = [];
  const p10s: number[] = [];
  const p90s: number[] = [];
  const sample = new Array<number>(n);
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < n; j++) {
      sample[j] = eq[Math.floor(rng() * n)]!;
    }
    sample.sort((a, b) => a - b);
    medians.push(quantile(sample, 0.5));
    p10s.push(quantile(sample, 0.1));
    p90s.push(quantile(sample, 0.9));
  }

  function summarise(arr: number[]) {
    const s = [...arr].sort((a, b) => a - b);
    return {
      mean: mean(arr),
      ci95Low: quantile(s, 0.025),
      ci95High: quantile(s, 0.975),
      stdDev: stdDev(arr),
    };
  }

  return {
    point: { median: pointMedian, p10: pointP10, p90: pointP90 },
    bootstrap: {
      median: summarise(medians),
      p10: summarise(p10s),
      p90: summarise(p90s),
    },
  };
}

function failReasonBreakdown(outcomes: Outcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of outcomes) counts[o.reason] = (counts[o.reason] ?? 0) + 1;
  return counts;
}

function buildMarkdown(
  passStats: BootstrapStats,
  equityStats: EquityStats,
  outcomes: Outcome[],
  reasonCounts: Record<string, number>,
): string {
  const n = outcomes.length;
  const passes = outcomes.filter((o) => o.passed).length;
  const lines: string[] = [];
  lines.push("# PASSLOCK Monte-Carlo Bootstrap Robustness Report");
  lines.push("");
  lines.push(
    `Generated: ${new Date().toISOString()} | Bootstrap iterations: ${N_BOOTSTRAP} | RNG seed: ${SEED}`,
  );
  lines.push("");
  lines.push("## Source Data");
  lines.push("");
  lines.push(
    `- Source: \`scripts/cache_bakeoff/${SHARD_PREFIX}{0..${SHARD_COUNT - 1}}.jsonl\``,
  );
  lines.push(`- Total windows: **${n}**`);
  lines.push(
    `- Raw passes: **${passes} / ${n} = ${((passes / n) * 100).toFixed(2)}%**`,
  );
  lines.push("");
  lines.push("### IMPORTANT: Pre-R9 vs Post-R9 drift");
  lines.push("");
  lines.push(
    "The cached jsonl files reflect the **POST-R9 engine state** (gap-fill bugfix in commit 46d9bb3).",
  );
  lines.push(
    "The documented PASSLOCK champion claim was **86/136 = 63.24% PRE-R9** (recorded in `scripts/cache_bakeoff/r60_runall_resume.log`).",
  );
  lines.push(
    "Current cache: **76/136 = 55.88% POST-R9**. Drift due to engine bugfix: **-7.36pp**.",
  );
  lines.push(
    "This means the 63.24% claim is itself sensitive to engine semantics. Bootstrap confidence intervals below apply to the POST-R9 sample.",
  );
  lines.push("");
  lines.push("## Pass-Rate Bootstrap");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Point estimate (raw) | **${passStats.point.toFixed(2)}%** |`);
  lines.push(`| Bootstrap mean | ${passStats.mean.toFixed(2)}% |`);
  lines.push(`| Bootstrap stdDev | ${passStats.stdDev.toFixed(2)}pp |`);
  lines.push(
    `| 95% CI | [${passStats.ci95Low.toFixed(2)}%, ${passStats.ci95High.toFixed(2)}%] (width ${(passStats.ci95High - passStats.ci95Low).toFixed(2)}pp) |`,
  );
  lines.push(
    `| 99% CI | [${passStats.ci99Low.toFixed(2)}%, ${passStats.ci99High.toFixed(2)}%] |`,
  );
  lines.push(`| P(rate < 50%) | ${(passStats.pBelow50 * 100).toFixed(2)}% |`);
  lines.push(
    `| P(rate < 55%) — live floor | ${(passStats.pBelow55 * 100).toFixed(2)}% |`,
  );
  lines.push(`| P(rate > 65%) | ${(passStats.pAbove65 * 100).toFixed(2)}% |`);
  lines.push(
    `| P(rate > 70%) — overfit ceiling | ${(passStats.pAbove70 * 100).toFixed(2)}% |`,
  );
  lines.push("");
  lines.push("### Pass-Rate Histogram (1pp buckets)");
  lines.push("");
  lines.push("| % bucket | count | iterations |");
  lines.push("|---|---:|---:|");
  for (const h of passStats.histogram1pp) {
    const bar = "█".repeat(Math.max(1, Math.round(h.pct)));
    lines.push(`| ${h.bucket}-${h.bucket + 1}% | ${h.count} | ${bar} |`);
  }
  lines.push("");
  lines.push("## Final-Equity-Pct Bootstrap");
  lines.push("");
  lines.push("Each bootstrap iteration samples 136 windows with replacement");
  lines.push(
    "from the observed equity distribution and computes the percentile.",
  );
  lines.push("");
  lines.push("| Percentile | Point | Bootstrap mean | 95% CI | StdDev |");
  lines.push("|---|---|---|---|---|");
  lines.push(
    `| Median | ${equityStats.point.median.toFixed(2)}% | ${equityStats.bootstrap.median.mean.toFixed(2)}% | [${equityStats.bootstrap.median.ci95Low.toFixed(2)}%, ${equityStats.bootstrap.median.ci95High.toFixed(2)}%] | ${equityStats.bootstrap.median.stdDev.toFixed(2)}pp |`,
  );
  lines.push(
    `| P10 | ${equityStats.point.p10.toFixed(2)}% | ${equityStats.bootstrap.p10.mean.toFixed(2)}% | [${equityStats.bootstrap.p10.ci95Low.toFixed(2)}%, ${equityStats.bootstrap.p10.ci95High.toFixed(2)}%] | ${equityStats.bootstrap.p10.stdDev.toFixed(2)}pp |`,
  );
  lines.push(
    `| P90 | ${equityStats.point.p90.toFixed(2)}% | ${equityStats.bootstrap.p90.mean.toFixed(2)}% | [${equityStats.bootstrap.p90.ci95Low.toFixed(2)}%, ${equityStats.bootstrap.p90.ci95High.toFixed(2)}%] | ${equityStats.bootstrap.p90.stdDev.toFixed(2)}pp |`,
  );
  lines.push("");
  lines.push("## Fail-Reason Breakdown (raw)");
  lines.push("");
  lines.push("| Reason | Count | % |");
  lines.push("|---|---:|---:|");
  for (const [reason, count] of Object.entries(reasonCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`| ${reason} | ${count} | ${((count / n) * 100).toFixed(1)}% |`);
  }
  lines.push("");
  lines.push("## Interpretation");
  lines.push("");
  const ciWidth = passStats.ci95High - passStats.ci95Low;
  const robust = ciWidth < 20 && passStats.pBelow55 < 0.5;
  const luckyStrike = passStats.pAbove70 > 0.05;
  lines.push(
    `- **CI width**: ${ciWidth.toFixed(2)}pp — ${ciWidth < 15 ? "tight" : ciWidth < 20 ? "moderate" : "wide"} (a tight CI suggests the point estimate is well-supported by the sample)`,
  );
  lines.push(
    `- **P(rate < 55% live-floor)**: ${(passStats.pBelow55 * 100).toFixed(2)}% — ${passStats.pBelow55 < 0.25 ? "low downside risk" : passStats.pBelow55 < 0.5 ? "moderate downside risk" : "high downside risk"}`,
  );
  lines.push(
    `- **P(rate > 70% overfit-ceiling)**: ${(passStats.pAbove70 * 100).toFixed(2)}% — ${passStats.pAbove70 < 0.05 ? "no overfit signal" : "potential overfit signal"}`,
  );
  lines.push("");
  lines.push(
    `**Verdict**: ${robust ? "Sweet-spot evidence is moderately robust within this 136-window sample." : "Sample-specific lucky-strike risk is non-trivial."} ${luckyStrike ? "The bootstrap distribution does NOT extend much above the claim, which weakens the overfit hypothesis." : "The bootstrap distribution clusters below the original 63.24% claim, indicating the claim is sensitive to engine semantics (R9 fix)."}`,
  );
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push(
    "node ./node_modules/vitest/vitest.mjs run --config vitest.scripts.config.ts scripts/passlockMonteCarlo.test.ts",
  );
  lines.push("```");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// vitest entry — runs once and writes both reports.
// ─────────────────────────────────────────────────────────────────────────
describe("PASSLOCK Monte-Carlo Bootstrap", () => {
  it("samples 10000 bootstrap iterations and writes JSON + Markdown reports", () => {
    const outcomes = loadOutcomes();
    expect(outcomes.length).toBe(136);

    const rng = mulberry32(SEED);
    const passStats = bootstrapPassRate(outcomes, rng, N_BOOTSTRAP);
    const equityStats = bootstrapEquity(outcomes, rng, N_BOOTSTRAP);
    const reasonCounts = failReasonBreakdown(outcomes);

    // ── Statistical sanity (CI brackets point estimate) ──
    expect(passStats.point).toBeGreaterThan(0);
    expect(passStats.point).toBeLessThan(100);
    expect(passStats.ci95Low).toBeLessThanOrEqual(passStats.point);
    expect(passStats.ci95High).toBeGreaterThanOrEqual(passStats.point);
    expect(passStats.ci99Low).toBeLessThanOrEqual(passStats.ci95Low);
    expect(passStats.ci99High).toBeGreaterThanOrEqual(passStats.ci95High);
    expect(passStats.stdDev).toBeGreaterThan(0);
    expect(passStats.stdDev).toBeLessThan(15); // sanity: a binomial proportion
    // bootstrap stdDev should be in the single-digit-pp range for n=136
    expect(passStats.mean).toBeCloseTo(passStats.point, 0); // within 1pp
    // probabilities sum-of-buckets = total iterations
    const totalHist = passStats.histogram1pp.reduce((a, b) => a + b.count, 0);
    expect(totalHist).toBe(N_BOOTSTRAP);

    // Equity bootstrap sanity
    expect(equityStats.bootstrap.median.ci95Low).toBeLessThanOrEqual(
      equityStats.point.median,
    );
    expect(equityStats.bootstrap.median.ci95High).toBeGreaterThanOrEqual(
      equityStats.point.median,
    );
    expect(equityStats.bootstrap.p10.ci95Low).toBeLessThan(
      equityStats.bootstrap.p90.ci95High,
    );

    // ── Persist reports ──
    const json = {
      meta: {
        generatedAt: new Date().toISOString(),
        bootstrapIterations: N_BOOTSTRAP,
        seed: SEED,
        sampleSize: outcomes.length,
        cacheDir: CACHE_DIR,
        shardPrefix: SHARD_PREFIX,
        notes:
          "Cache reflects POST-R9 engine. Documented 86/136=63.24% claim was PRE-R9.",
      },
      raw: {
        windows: outcomes.length,
        passes: outcomes.filter((o) => o.passed).length,
        passRatePct: passStats.point,
        documentedClaimPct: 63.24,
        deltaVsClaimPp: passStats.point - 63.24,
        reasonCounts,
      },
      passRate: passStats,
      equity: equityStats,
    };
    writeFileSync(REPORT_JSON, JSON.stringify(json, null, 2));
    writeFileSync(
      REPORT_MD,
      buildMarkdown(passStats, equityStats, outcomes, reasonCounts),
    );

    // ── Console summary for vitest stdout ──
    console.log("\n=== PASSLOCK Monte-Carlo Bootstrap ===");
    console.log(`Sample: ${outcomes.length} windows`);
    console.log(
      `Raw pass-rate: ${passStats.point.toFixed(2)}% (${outcomes.filter((o) => o.passed).length}/${outcomes.length})`,
    );
    console.log(
      `Documented claim: 63.24% — drift: ${(passStats.point - 63.24).toFixed(2)}pp`,
    );
    console.log(
      `Bootstrap 95% CI: [${passStats.ci95Low.toFixed(2)}%, ${passStats.ci95High.toFixed(2)}%]`,
    );
    console.log(
      `StdDev: ${passStats.stdDev.toFixed(2)}pp | P(<55%) = ${(passStats.pBelow55 * 100).toFixed(2)}% | P(>70%) = ${(passStats.pAbove70 * 100).toFixed(2)}%`,
    );
    console.log(`Reports written:`);
    console.log(`  ${REPORT_JSON}`);
    console.log(`  ${REPORT_MD}`);
  });
});
