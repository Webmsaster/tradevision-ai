/**
 * Aggregator for Round 60 Time-of-Day gate sweep.
 * Reads scripts/cache_bakeoff/r28v7_tod_<variant>_shard_*.jsonl per variant
 * and produces a comparison report against R28_V6 baseline (56.62%).
 */
import { readFileSync, existsSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const VARIANTS = ["V0", "V1", "V2", "V3", "V4", "V5"];
const BASELINE_PASS = 56.62;

interface Row {
  winIdx: number;
  passed: boolean;
  reason: string;
  passDay: number | null;
  finalEquityPct: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * sorted.length)),
  );
  return sorted[idx]!;
}

function loadVariant(v: string): Row[] {
  const rows: Row[] = [];
  // Try V0 from baseline shards first (reused).
  if (v === "V0") {
    for (let i = 0; i < 32; i++) {
      const f = `${CACHE_DIR}/r28v6_shard_${i}.jsonl`;
      if (!existsSync(f)) continue;
      const text = readFileSync(f, "utf-8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        rows.push(JSON.parse(line) as Row);
      }
    }
    if (rows.length > 0) return rows;
  }
  for (let i = 0; i < 32; i++) {
    const f = `${CACHE_DIR}/r28v7_tod_${v}_shard_${i}.jsonl`;
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      rows.push(JSON.parse(line) as Row);
    }
  }
  return rows;
}

interface Summary {
  variant: string;
  windows: number;
  passes: number;
  rate: number;
  drift: number;
  medPassDay: number;
  p90PassDay: number;
  reasonCounts: Record<string, number>;
  finalEqP10: number;
  finalEqMed: number;
}

function summarize(v: string, rows: Row[]): Summary {
  rows = rows.slice().sort((a, b) => a.winIdx - b.winIdx);
  const windows = rows.length;
  const passes = rows.filter((r) => r.passed).length;
  const rate = windows > 0 ? (passes / windows) * 100 : 0;
  const passDays = rows
    .filter((r) => r.passed && r.passDay != null)
    .map((r) => r.passDay!)
    .sort((a, b) => a - b);
  const finalEquities = rows.map((r) => r.finalEquityPct).sort((a, b) => a - b);
  const medPassDay =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const p90PassDay = quantile(passDays, 0.9);
  const reasonCounts: Record<string, number> = {};
  for (const r of rows)
    reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
  return {
    variant: v,
    windows,
    passes,
    rate,
    drift: rate - BASELINE_PASS,
    medPassDay,
    p90PassDay,
    reasonCounts,
    finalEqP10: quantile(finalEquities, 0.1) * 100,
    finalEqMed: quantile(finalEquities, 0.5) * 100,
  };
}

const summaries: Summary[] = VARIANTS.map((v) => summarize(v, loadVariant(v)));

console.log("\n=== ROUND 60: TIME-OF-DAY GATE SWEEP (R28_V6 base) ===\n");
console.log(
  "variant | windows | passes |   rate   |   drift  | med pass | p90 pass | finalEq p10 | finalEq med",
);
console.log(
  "--------+---------+--------+----------+----------+----------+----------+-------------+------------",
);
for (const s of summaries) {
  if (s.windows === 0) {
    console.log(
      `${s.variant.padEnd(7)} |   ---   |   ---  |   ---    |   ---    |    ---   |    ---   |     ---     |     ---`,
    );
    continue;
  }
  const driftSign = s.drift >= 0 ? "+" : "";
  console.log(
    `${s.variant.padEnd(7)} | ${String(s.windows).padStart(7)} | ${String(s.passes).padStart(6)} | ${s.rate.toFixed(2).padStart(6)}%  |  ${driftSign}${s.drift.toFixed(2).padStart(5)}pp | ${String(s.medPassDay).padStart(7)}d | ${String(s.p90PassDay).padStart(7)}d | ${s.finalEqP10.toFixed(2).padStart(9)}% | ${s.finalEqMed.toFixed(2).padStart(8)}%`,
  );
}

console.log("\n=== FAILURE-REASON BREAKDOWN ===\n");
for (const s of summaries) {
  if (s.windows === 0) continue;
  console.log(`-- ${s.variant} --`);
  const total = Object.values(s.reasonCounts).reduce((a, b) => a + b, 0);
  for (const [reason, count] of Object.entries(s.reasonCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(
      `  ${reason.padEnd(15)} ${String(count).padStart(4)}  (${((count / total) * 100).toFixed(2)}%)`,
    );
  }
  console.log("");
}

// Best variant ≥ 58%?
const best = summaries
  .slice()
  .sort((a, b) => b.rate - a.rate)
  .find((s) => s.windows > 0);

console.log("\n=== VERDICT ===");
if (best) {
  console.log(
    `best: ${best.variant} = ${best.rate.toFixed(2)}% (${best.passes}/${best.windows}, drift ${best.drift >= 0 ? "+" : ""}${best.drift.toFixed(2)}pp)`,
  );
  if (best.rate >= 58) {
    console.log(
      `WIN: variant ${best.variant} beats baseline (${best.rate.toFixed(2)}% >= 58%)`,
    );
  } else {
    console.log(
      `NO-WIN: best ${best.rate.toFixed(2)}% < 58% threshold. Time-of-day gate hypothesis rejected.`,
    );
  }
}
