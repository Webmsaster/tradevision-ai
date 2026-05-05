/**
 * Aggregate Round 60 multi-variant sweep across 7 variants × 8 shards.
 * Reads scripts/cache_bakeoff/r28v6_v60_<variant>_shard_{0-7}.jsonl
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
  passDay: number | null;
  finalEquityPct: number;
}

const failTypes = [
  "profit_target",
  "daily_loss",
  "total_loss",
  "give_back",
  "time",
] as const;

console.log("Round 60 Multi-Variant Sweep — aggregate");
console.log("Baseline R28_V6 V4-Engine: 56.62% (77/136)");
console.log("===");

const summary: {
  name: string;
  pct: number;
  n: number;
  passes: number;
  med: number | null;
  breakdown: string;
}[] = [];

for (const variant of VARIANTS) {
  const all: Result[] = [];
  for (let s = 0; s < SHARDS; s++) {
    const f = `${CACHE_DIR}/r28v6_v60_${variant}_shard_${s}.jsonl`;
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) all.push(JSON.parse(line));
  }
  if (all.length === 0) {
    console.log(`${variant}: NO DATA`);
    summary.push({
      name: variant,
      pct: 0,
      n: 0,
      passes: 0,
      med: null,
      breakdown: "no-data",
    });
    continue;
  }
  const passes = all.filter((r) => r.passed).length;
  const passPct = (passes / all.length) * 100;
  const passDays = all
    .filter((r) => r.passed && r.passDay)
    .map((r) => r.passDay!)
    .sort((a, b) => a - b);
  const median = passDays.length
    ? (passDays[Math.floor(passDays.length / 2)] ?? null)
    : null;
  const reasonCounts: Record<string, number> = {};
  for (const t of failTypes) reasonCounts[t] = 0;
  for (const r of all)
    reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
  const breakdown = failTypes
    .map((t) => `${t}=${((reasonCounts[t]! / all.length) * 100).toFixed(1)}%`)
    .join(", ");
  console.log(
    `${variant.padEnd(13)} ${passes}/${all.length} = ${passPct.toFixed(2)}% / med=${median}d / ${breakdown}`,
  );
  summary.push({
    name: variant,
    pct: passPct,
    n: all.length,
    passes,
    med: median,
    breakdown,
  });
}

console.log("===");
console.log("Δ vs baseline 56.62%:");
const baseline = 56.62;
for (const s of summary) {
  const d = s.pct - baseline;
  const sign = d >= 0 ? "+" : "";
  const verdict = d >= 1.5 ? "✅ WIN" : d >= -0.5 ? "≈ neutral" : "❌ LOSS";
  console.log(
    `  ${s.name.padEnd(13)} ${s.pct.toFixed(2)}% (${sign}${d.toFixed(2)}pp) ${verdict}`,
  );
}
