/**
 * Aggregate V5-Family R58 sharded results.
 *
 * Reads `cache_bakeoff/v5fam_<cfg>_shard_<idx>.jsonl` and prints per-config
 * pass-rate, median pass-day, p90, drift vs pre-bugfix Memory baseline,
 * and recommends top candidates ≥60% as new R28_V7 candidates.
 */
import { readFileSync, existsSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = `${CACHE_DIR}/v5_family_r58_reval.log`;

function plog(s: string) {
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [agg] ${s}\n`);
  console.log(s);
}

interface WinRecord {
  winStart: number;
  passed: boolean;
  reason: string;
  passDay: number | null;
  finalEquityPct: number;
}

interface AggResult {
  name: string;
  preBugfixRate: number;
  totalWindows: number;
  passes: number;
  rate: number;
  drift: number;
  medPassDay: number;
  p90PassDay: number;
  reasonCounts: Record<string, number>;
  finalEquityP10: number;
  finalEquityMed: number;
}

const CONFIG_BASELINES: { name: string; preBugfixRate: number }[] = [
  { name: "V5_QUARTZ_LITE", preBugfixRate: 78.59 },
  { name: "V5_AGATE", preBugfixRate: 65.46 },
  { name: "V5_JADE", preBugfixRate: 65.46 },
  { name: "V5_AMBER", preBugfixRate: 62.83 },
  { name: "V5_OBSIDIAN", preBugfixRate: 60.56 },
  { name: "V5_ZIRKON", preBugfixRate: 61.65 },
  { name: "V5_TOPAZ", preBugfixRate: 61.65 },
  { name: "V5_RUBIN", preBugfixRate: 61.74 },
  { name: "V5_SAPPHIR", preBugfixRate: 64.73 },
  { name: "V5_EMERALD", preBugfixRate: 64.82 },
  { name: "V5_PEARL", preBugfixRate: 65.1 },
  { name: "V5_OPAL", preBugfixRate: 65.28 },
  { name: "V5_NOVA", preBugfixRate: 47.24 },
];

const SHARD_COUNT = parseInt(process.argv[2] ?? "8", 10);
const R28_V6_BASELINE = 56.62;
const CANDIDATE_THRESHOLD = R28_V6_BASELINE + 3.38; // = 60.0%

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * sorted.length)),
  );
  return sorted[idx]!;
}

const results: AggResult[] = [];

for (const { name, preBugfixRate } of CONFIG_BASELINES) {
  const allRecords: WinRecord[] = [];
  for (let s = 0; s < SHARD_COUNT; s++) {
    const path = `${CACHE_DIR}/v5fam_${name}_shard_${s}.jsonl`;
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        allRecords.push(JSON.parse(line) as WinRecord);
      } catch {
        // ignore malformed
      }
    }
  }

  if (allRecords.length === 0) {
    plog(`[skip ${name}] no records`);
    continue;
  }

  const totalWindows = allRecords.length;
  const passes = allRecords.filter((r) => r.passed).length;
  const passDays = allRecords
    .filter((r) => r.passed && r.passDay !== null)
    .map((r) => r.passDay!)
    .sort((a, b) => a - b);
  const finalEquities = allRecords
    .map((r) => r.finalEquityPct)
    .sort((a, b) => a - b);
  const reasonCounts: Record<string, number> = {};
  for (const r of allRecords) {
    reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
  }
  const medPassDay =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const p90PassDay = quantile(passDays, 0.9);
  const rate = (passes / totalWindows) * 100;
  const drift = rate - preBugfixRate;

  results.push({
    name,
    preBugfixRate,
    totalWindows,
    passes,
    rate,
    drift,
    medPassDay,
    p90PassDay,
    reasonCounts,
    finalEquityP10: quantile(finalEquities, 0.1),
    finalEquityMed: quantile(finalEquities, 0.5),
  });
}

// Sort by post-fix rate desc
results.sort((a, b) => b.rate - a.rate);

plog("\n========================================================");
plog("V5-FAMILY R58 RE-VALIDATION RESULTS (sorted by post-fix rate)");
plog("========================================================");
plog(`R28_V6 baseline:        ${R28_V6_BASELINE.toFixed(2)}%`);
plog(
  `Candidate threshold:    ${CANDIDATE_THRESHOLD.toFixed(2)}% (R28_V6 + 3.38pp)`,
);
plog("");
plog(
  "config              | post-fix | windows | med | p90 | pre-bugfix | drift   | vs R28_V6",
);
plog(
  "--------------------+----------+---------+-----+-----+------------+---------+----------",
);

for (const r of results) {
  const vsR28 = r.rate - R28_V6_BASELINE;
  const candidate = r.rate >= CANDIDATE_THRESHOLD ? " ⭐ CANDIDATE" : "";
  plog(
    `${r.name.padEnd(20)}| ${r.rate.toFixed(2).padStart(7)}% | ${String(r.totalWindows).padStart(7)} | ${String(r.medPassDay).padStart(3)} | ${String(r.p90PassDay).padStart(3)} | ${r.preBugfixRate.toFixed(2).padStart(9)}% | ${(r.drift >= 0 ? "+" : "") + r.drift.toFixed(2).padStart(6)}pp | ${(vsR28 >= 0 ? "+" : "") + vsR28.toFixed(2).padStart(6)}pp${candidate}`,
  );
}

const candidates = results.filter((r) => r.rate >= CANDIDATE_THRESHOLD);

plog("");
plog("========================================================");
plog(`CANDIDATES (≥${CANDIDATE_THRESHOLD.toFixed(2)}%): ${candidates.length}`);
plog("========================================================");

if (candidates.length === 0) {
  plog(
    "No candidate beat R28_V6 by ≥3.38pp. R28_V6 (56.62%) remains the champion.",
  );
} else {
  for (const c of candidates) {
    plog(
      `${c.name}: ${c.rate.toFixed(2)}% / med ${c.medPassDay}d / p90 ${c.p90PassDay}d / windows ${c.totalWindows}`,
    );
    plog(`  failure reasons:`);
    for (const [reason, count] of Object.entries(c.reasonCounts).sort(
      (a, b) => b[1] - a[1],
    )) {
      plog(
        `    ${reason.padEnd(20)} ${String(count).padStart(4)} (${((count / c.totalWindows) * 100).toFixed(2)}%)`,
      );
    }
  }
  const top = candidates[0]!;
  plog("");
  plog(
    `RECOMMENDATION: ${top.name} = R28_V7 candidate (${top.rate.toFixed(2)}%, +${(top.rate - R28_V6_BASELINE).toFixed(2)}pp vs R28_V6).`,
  );
}

plog("");
plog("Per-config failure-reason breakdown (top 4):");
for (const r of results) {
  const top4 = Object.entries(r.reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k}=${v}(${((v / r.totalWindows) * 100).toFixed(0)}%)`)
    .join("  ");
  plog(`  ${r.name.padEnd(20)} ${top4}`);
}

// Final structured output
plog("");
plog("Final structured output (JSON):");
plog(JSON.stringify(results, null, 2));
