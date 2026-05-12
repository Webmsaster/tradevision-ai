/**
 * Round 60 — Early-peek aggregator for partial TOD-gate results.
 *
 * Aggregates over ONLY the windows that are present in ALL variants (intersection
 * by winIdx). Lets you see the variant ranking before the full sweep finishes.
 */
import { readFileSync, existsSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const VARIANTS = ["V1", "V2", "V3", "V4", "V5"];
const BASELINE_PASS = 56.62;

interface Row {
  winIdx: number;
  passed: boolean;
  reason: string;
  passDay: number | null;
  finalEquityPct: number;
}

function loadVariant(v: string): Row[] {
  const rows: Row[] = [];
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

const allRowsByVariant: Record<string, Row[]> = {};
for (const v of VARIANTS) allRowsByVariant[v] = loadVariant(v);

// V0 baseline for the same window indices
const v0Rows: Row[] = [];
for (let i = 0; i < 32; i++) {
  const f = `${CACHE_DIR}/r28v6_shard_${i}.jsonl`;
  if (!existsSync(f)) continue;
  const text = readFileSync(f, "utf-8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    v0Rows.push(JSON.parse(line) as Row);
  }
}

// Find common winIdx across all variants
const idxSets = VARIANTS.map(
  (v) => new Set(allRowsByVariant[v]!.map((r) => r.winIdx)),
);
let common = [...idxSets[0]!];
for (let i = 1; i < idxSets.length; i++) {
  common = common.filter((x) => idxSets[i]!.has(x));
}
common.sort((a, b) => a - b);

const v0Map = new Map(v0Rows.map((r) => [r.winIdx, r]));

console.log(
  `\n=== ROUND 60 EARLY PEEK (common windows: ${common.length}) ===\n`,
);
console.log(
  `window indices: [${common.slice(0, 8).join(",")}${common.length > 8 ? ",..." : ""}]\n`,
);

console.log(
  "variant | windows | passes |   rate   | drift vs V0(common) | drift vs V0(56.62%)",
);
console.log(
  "--------+---------+--------+----------+---------------------+--------------------",
);

const v0CommonPasses = common.filter((idx) => v0Map.get(idx)?.passed).length;
const v0CommonRate = (v0CommonPasses / common.length) * 100;
console.log(
  `V0 base | ${String(common.length).padStart(7)} | ${String(v0CommonPasses).padStart(6)} | ${v0CommonRate.toFixed(2).padStart(6)}%  |       0.00pp        |  ${(v0CommonRate - BASELINE_PASS).toFixed(2)}pp`,
);

for (const v of VARIANTS) {
  const rows = allRowsByVariant[v]!.filter((r) => idxSets[0]!.has(r.winIdx));
  const inCommon = rows.filter((r) => common.includes(r.winIdx));
  const passes = inCommon.filter((r) => r.passed).length;
  const rate = inCommon.length > 0 ? (passes / inCommon.length) * 100 : 0;
  const drift = rate - v0CommonRate;
  const driftBaseline = rate - BASELINE_PASS;
  console.log(
    `${v.padEnd(7)} | ${String(inCommon.length).padStart(7)} | ${String(passes).padStart(6)} | ${rate.toFixed(2).padStart(6)}%  |  ${drift >= 0 ? "+" : ""}${drift.toFixed(2)}pp           |  ${driftBaseline >= 0 ? "+" : ""}${driftBaseline.toFixed(2)}pp`,
  );
}

console.log(
  "\nNote: V1 should equal V0 baseline (same hours filter). Drift indicates simulator non-determinism.\n",
);
