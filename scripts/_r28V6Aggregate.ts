/**
 * Aggregator for sharded R28_V6 V4-Sim revalidation results.
 * Reads scripts/cache_bakeoff/r28v6_shard_*.jsonl and produces the same
 * pass-rate / med / p90 / failure-reason breakdown as the original test.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = `${CACHE_DIR}/r28v6_revalidation.log`;
function plog(s: string) {
  console.log(s);
}

interface Row {
  winIdx: number;
  passed: boolean;
  reason: string;
  passDay: number | null;
  finalEquityPct: number;
}

const rows: Row[] = [];
for (let i = 0; i < 32; i++) {
  const f = `${CACHE_DIR}/r28v6_shard_${i}.jsonl`;
  if (!existsSync(f)) continue;
  const text = readFileSync(f, "utf-8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line) as Row);
  }
}
rows.sort((a, b) => a.winIdx - b.winIdx);

const windows = rows.length;
const passes = rows.filter((r) => r.passed).length;
const rate = (passes / windows) * 100;
const passDays = rows
  .filter((r) => r.passed && r.passDay != null)
  .map((r) => r.passDay!)
  .sort((a, b) => a - b);
const finalEquities = rows.map((r) => r.finalEquityPct).sort((a, b) => a - b);
const medPassDay =
  passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * sorted.length)),
  );
  return sorted[idx]!;
}
const p90PassDay = quantile(passDays, 0.9);

const reasonCounts: Record<string, number> = {};
for (const r of rows)
  reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;

plog("\n=== R28_V6 V4-ENGINE RE-VALIDATION (post-R56/R57/R58) ===");
plog(`pass-rate:           ${rate.toFixed(2)}% (${passes}/${windows})`);
plog(`median pass-day:     ${medPassDay}d`);
plog(`p90 pass-day:        ${p90PassDay}d`);
plog(
  `final equity p10:    ${(quantile(finalEquities, 0.1) * 100).toFixed(2)}%`,
);
plog(
  `final equity med:    ${(quantile(finalEquities, 0.5) * 100).toFixed(2)}%`,
);
plog("");
plog("Failure reasons:");
const totalReasons = Object.values(reasonCounts).reduce((a, b) => a + b, 0);
for (const [reason, count] of Object.entries(reasonCounts).sort(
  (a, b) => b[1] - a[1],
)) {
  plog(
    `  ${reason.padEnd(15)} ${String(count).padStart(4)}  (${((count / totalReasons) * 100).toFixed(2)}%)`,
  );
}

plog("\n=== DRIFT vs PRE-R56 BASELINE ===");
const baseline = 60.29;
const drift = rate - baseline;
plog(`pre-R56 baseline:    ${baseline.toFixed(2)}%`);
plog(`post-R56/R57/R58 rate:   ${rate.toFixed(2)}%`);
plog(`drift:               ${drift >= 0 ? "+" : ""}${drift.toFixed(2)}pp`);

writeFileSync(LOG_FILE, `[${new Date().toISOString()}] aggregated\n`);
const final = `pass=${rate.toFixed(2)}% (${passes}/${windows}) med=${medPassDay}d p90=${p90PassDay}d drift=${drift >= 0 ? "+" : ""}${drift.toFixed(2)}pp\n`;
console.log(final);
