/**
 * Walk-Forward Validation für Round 60 sweep results.
 *
 * Reads existing `r28v6_v60_<variant>_shard_*.jsonl`, splits windows by index
 * (first half = TRAIN, second half = TEST), and reports pass-rate per split
 * for each variant. Drift = TEST - TRAIN.
 *
 * Robust if |drift| < 2pp. Overfit warning if drift > 5pp negative.
 *
 * Usage:
 *   node ./node_modules/.bin/tsx scripts/_r28V6Round60WalkForward.ts
 */
import { readFileSync, existsSync } from "node:fs";

const VARIANTS = [
  "passlock",
  "corrcap2",
  "corrcap3",
  "lscool48",
  "lscool96",
  "todcutoff18",
  "todcutoff20",
  "voltp_aggr",
  "voltp_mild",
  "voltp_inv",
  "voltp_low",
  "idlt_25",
  "idlt_30",
  "idlt_35",
  "combo_pl_idlt",
];
const CACHE_DIR = "scripts/cache_bakeoff";
const SHARDS = 8;

interface Result {
  winIdx: number;
  passed: boolean;
  reason: string;
}

console.log("Round 60 Walk-Forward Validation");
console.log("Splits windows by winIdx → first 50% TRAIN, last 50% TEST");
console.log("Robust threshold: |drift| < 2pp. Overfit warning: drift < -5pp.");
console.log("===");
console.log(
  `${"variant".padEnd(15)} ${"TRAIN".padStart(10)} ${"TEST".padStart(10)} ${"DRIFT".padStart(10)}  status`,
);

const summary: {
  name: string;
  trainPct: number;
  testPct: number;
  drift: number;
  verdict: string;
}[] = [];

for (const variant of VARIANTS) {
  const all: Result[] = [];
  for (let s = 0; s < SHARDS; s++) {
    const f = `${CACHE_DIR}/r28v6_v60_${variant}_shard_${s}.jsonl`;
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        all.push({
          winIdx: o.winIdx,
          passed: !!o.passed,
          reason: o.reason ?? "",
        });
      } catch {}
    }
  }
  if (all.length < 10) {
    console.log(`${variant.padEnd(15)} skipped (n=${all.length} too small)`);
    continue;
  }
  // Sort by winIdx so split is chronological.
  all.sort((a, b) => a.winIdx - b.winIdx);
  const half = Math.floor(all.length / 2);
  const train = all.slice(0, half);
  const test = all.slice(half);
  const trainPasses = train.filter((r) => r.passed).length;
  const testPasses = test.filter((r) => r.passed).length;
  const trainPct = (trainPasses / train.length) * 100;
  const testPct = (testPasses / test.length) * 100;
  const drift = testPct - trainPct;

  let verdict: string;
  if (Math.abs(drift) < 2) verdict = "✅ ROBUST";
  else if (drift < -5) verdict = "🚨 OVERFIT";
  else if (drift < -2) verdict = "⚠️  caution";
  else if (drift > 5) verdict = "📈 LIVE-LUCKY (test outperformed)";
  else verdict = "≈ neutral";

  console.log(
    `${variant.padEnd(15)} ${`${trainPct.toFixed(2)}%`.padStart(10)} ${`${testPct.toFixed(2)}%`.padStart(10)} ${`${drift >= 0 ? "+" : ""}${drift.toFixed(2)}pp`.padStart(10)}  ${verdict}`,
  );
  summary.push({ name: variant, trainPct, testPct, drift, verdict });
}

console.log("===");
console.log("Champions sorted by TEST-set pass-rate (out-of-sample):");
summary
  .sort((a, b) => b.testPct - a.testPct)
  .forEach((s) => {
    console.log(
      `  ${s.name.padEnd(15)} TEST=${s.testPct.toFixed(2)}% (drift ${s.drift >= 0 ? "+" : ""}${s.drift.toFixed(2)}pp)`,
    );
  });
