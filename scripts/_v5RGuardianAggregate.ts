/**
 * Aggregate V5R Daily-Equity-Guardian sweep results across triggers.
 * Reads scripts/cache_bakeoff/r28v6_v5r_g{25,30,35,40}_shard_{0-7}.jsonl
 */
import { readFileSync, existsSync } from "node:fs";

const TRIGGERS = ["g25", "g30", "g35", "g40"];
const CACHE_DIR = "scripts/cache_bakeoff";

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

console.log("V5R Daily Equity Guardian — sweep aggregate");
console.log("Baseline R28_V6 V4-Engine: 56.62% (77/136)");
console.log("===");

for (const trig of TRIGGERS) {
  const all: Result[] = [];
  for (let s = 0; s < 8; s++) {
    const f = `${CACHE_DIR}/r28v6_v5r_${trig}_shard_${s}.jsonl`;
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) all.push(JSON.parse(line));
  }
  if (all.length === 0) {
    console.log(`${trig}: NO DATA`);
    continue;
  }
  const passes = all.filter((r) => r.passed).length;
  const passPct = (passes / all.length) * 100;
  const passDays = all
    .filter((r) => r.passed && r.passDay)
    .map((r) => r.passDay!)
    .sort((a, b) => a - b);
  const median = passDays.length
    ? passDays[Math.floor(passDays.length / 2)]
    : null;
  const reasonCounts: Record<string, number> = {};
  for (const t of failTypes) reasonCounts[t] = 0;
  for (const r of all)
    reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
  const breakdown = failTypes
    .map((t) => `${t}=${((reasonCounts[t]! / all.length) * 100).toFixed(1)}%`)
    .join(", ");
  console.log(
    `${trig} (trigger -${trig.slice(1)}/10 = -${parseFloat(trig.slice(1)) / 10}%): ${passes}/${all.length} = ${passPct.toFixed(2)}% / med=${median}d / ${breakdown}`,
  );
}
