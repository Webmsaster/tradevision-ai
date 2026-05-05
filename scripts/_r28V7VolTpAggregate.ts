/**
 * R28_V7 vol-adaptive TP — aggregator.
 *
 * Reads scripts/cache_voltp_r28v7/r28v7_<VARIANT>_shard_*.jsonl
 * and produces pass-rate / med / p90 / failure-reason breakdown
 * per variant.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_voltp_r28v7";

interface Row {
  variant: string;
  winIdx: number;
  passed: boolean;
  reason: string;
  passDay: number | null;
  finalEquityPct: number;
  tpSnap?: Record<string, number>;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * sorted.length)),
  );
  return sorted[idx]!;
}

const VARIANTS = ["V0", "V1", "V2", "V3", "V4"];
const SHARD_LIMIT = 32;
const lines: string[] = [];
function plog(s: string) {
  console.log(s);
  lines.push(s);
}

const summary: Record<
  string,
  { rate: number; passes: number; windows: number }
> = {};

for (const variant of VARIANTS) {
  const rows: Row[] = [];
  for (let i = 0; i < SHARD_LIMIT; i++) {
    const f = `${CACHE_DIR}/r28v7_${variant}_shard_${i}.jsonl`;
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as Row);
      } catch {
        // skip malformed
      }
    }
  }
  if (rows.length === 0) {
    plog(`\n=== ${variant} === NO DATA`);
    continue;
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
  const p90PassDay = quantile(passDays, 0.9);
  const reasonCounts: Record<string, number> = {};
  for (const r of rows)
    reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;

  plog(`\n=== R28_V7_${variant} VOL-ADAPTIVE TP ===`);
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
  // First-window TP snapshot for sanity-check
  const snap = rows.find((r) => r.tpSnap)?.tpSnap;
  if (snap) {
    plog("");
    plog("Sample tpPct (first sampled window):");
    for (const [k, v] of Object.entries(snap)) {
      plog(`  ${k.padEnd(15)} ${(v * 100).toFixed(3)}%`);
    }
  }
  summary[variant] = { rate, passes, windows };
}

plog("\n=== SUMMARY (R28_V6 baseline target = 56.62%) ===");
for (const v of VARIANTS) {
  const s = summary[v];
  if (!s) continue;
  const drift = s.rate - 56.62;
  plog(
    `${v}: ${s.rate.toFixed(2)}% (${s.passes}/${s.windows})  drift=${
      drift >= 0 ? "+" : ""
    }${drift.toFixed(2)}pp`,
  );
}

writeFileSync(
  `${CACHE_DIR}/aggregate.log`,
  `[${new Date().toISOString()}] aggregated\n${lines.join("\n")}\n`,
);
