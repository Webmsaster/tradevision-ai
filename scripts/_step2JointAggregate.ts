/**
 * Step-2 Joint-Opt Aggregator — combines 8 shard JSONLs into a per-config
 * summary. Run after all shards complete.
 *
 * Usage: npx tsx scripts/_step2JointAggregate.ts
 */
import { readFileSync, readdirSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const SHARD_PATTERN = /^step2_joint_shard_\d+\.jsonl$/;

interface PerWindowRow {
  win_idx: number;
  tp_mult: number;
  step1_passed: boolean;
  step1_eq: number;
  step2_passed: boolean;
  step2_eq: number;
  step2_reason: string;
  joint_pass: boolean;
}

const allRows: PerWindowRow[] = [];
for (const f of readdirSync(CACHE_DIR)) {
  if (!SHARD_PATTERN.test(f)) continue;
  const raw = readFileSync(`${CACHE_DIR}/${f}`, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.marker) continue; // skip per-shard summary lines
    if (typeof obj.tp_mult === "number") allRows.push(obj as PerWindowRow);
  }
}
console.log(`[aggregate] loaded ${allRows.length} per-window rows`);

interface PerMult {
  step1_total: number;
  step1_pass: number;
  step2_total: number;
  step2_pass: number;
  joint_pass: number;
  step2_reasons: Record<string, number>;
}
const perMult = new Map<number, PerMult>();
for (const r of allRows) {
  if (!perMult.has(r.tp_mult)) {
    perMult.set(r.tp_mult, {
      step1_total: 0,
      step1_pass: 0,
      step2_total: 0,
      step2_pass: 0,
      joint_pass: 0,
      step2_reasons: {},
    });
  }
  const m = perMult.get(r.tp_mult)!;
  m.step1_total++;
  if (r.step1_passed) m.step1_pass++;
  // step2 only ran if step1 passed
  if (r.step1_passed) {
    m.step2_total++;
    if (r.step2_passed) m.step2_pass++;
    if (r.joint_pass) m.joint_pass++;
    m.step2_reasons[r.step2_reason] =
      (m.step2_reasons[r.step2_reason] ?? 0) + 1;
  }
}

const sortedMults = [...perMult.keys()].sort((a, b) => a - b);
console.log("\n=== Round 65 Step-2 Joint-Opt Aggregate ===\n");
console.log(
  `${"tp_mult".padEnd(10)} ${"S1 pass".padEnd(15)} ${"S2|S1 pass".padEnd(20)} ${"JOINT".padEnd(20)} ${"top S2 fail reason"}`,
);
console.log("-".repeat(95));
for (const m of sortedMults) {
  const s = perMult.get(m)!;
  const s1Rate = s.step1_total ? s.step1_pass / s.step1_total : 0;
  const s2Cond = s.step2_total ? s.step2_pass / s.step2_total : 0;
  const jointRate = s.step1_total ? s.joint_pass / s.step1_total : 0;
  const topFail = Object.entries(s.step2_reasons)
    .filter(([k]) => k !== "profit_target")
    .sort((a, b) => b[1] - a[1])[0];
  const failStr = topFail ? `${topFail[0]} (${topFail[1]})` : "—";
  console.log(
    `${m.toFixed(2).padEnd(10)} ${`${s.step1_pass}/${s.step1_total}=${(s1Rate * 100).toFixed(2)}%`.padEnd(15)} ${`${s.step2_pass}/${s.step2_total}=${(s2Cond * 100).toFixed(2)}%`.padEnd(20)} ${`${s.joint_pass}/${s.step1_total}=${(jointRate * 100).toFixed(2)}%`.padEnd(20)} ${failStr}`,
  );
}

// Champion = highest joint pass-rate.
let champ: number | null = null;
let champRate = -1;
for (const m of sortedMults) {
  const s = perMult.get(m)!;
  const rate = s.step1_total ? s.joint_pass / s.step1_total : 0;
  if (rate > champRate) {
    champRate = rate;
    champ = m;
  }
}
console.log(
  `\n🏆 Round 65 Champion: tp_mult=${champ} → joint pass-rate ${(champRate * 100).toFixed(2)}%`,
);

// Documented R28_V6_STEP2 baseline = 77.86% (from memory)
const baseline = 0.7786;
const champStep2 =
  champ !== null
    ? perMult.get(champ)!.step2_pass /
      Math.max(1, perMult.get(champ)!.step2_total)
    : 0;
console.log(
  `   vs documented R28_V6_STEP2 baseline (77.86% conditional): ${(champStep2 * 100).toFixed(2)}% (${champStep2 >= baseline ? "✅ improvement" : "❌ no improvement"})`,
);
console.log(
  `   Multi-account math: 3-Strategy joint with ${(champRate * 100).toFixed(2)}% per strategy → 1-(1-p)^3 = ${((1 - Math.pow(1 - champRate, 3)) * 100).toFixed(2)}%`,
);
