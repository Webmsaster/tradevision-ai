/**
 * Aggregator for sharded R28_V6 V4-Sim revalidation results.
 * Reads scripts/cache_bakeoff/r28v6_shard_*.jsonl and produces the same
 * pass-rate / med / p90 / failure-reason breakdown as the original test.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

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

// Bug-Audit Round 3 (R3 fix 1): dynamic-glob over shard files instead of
// magic SHARDS=32 (sister scripts use 8). Reading `r28v6_shard_<n>.jsonl`
// from the directory keeps aggregate consistent regardless of how many
// shards a sweep actually produced.
// Bug-Audit Round 1 (kept): dedup by winIdx (last write wins) so a resumed
// shard or a same-window appearing in two shard files cannot double-count.
const SHARD_FILE_RE = /^r28v6_shard_\d+\.jsonl$/;
const byWin = new Map<number, Row>();
const shardFiles = readdirSync(CACHE_DIR)
  .filter((n) => SHARD_FILE_RE.test(n))
  .sort();
for (const name of shardFiles) {
  const f = `${CACHE_DIR}/${name}`;
  const text = readFileSync(f, "utf-8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Row;
    byWin.set(r.winIdx, r);
  }
}
const rows: Row[] = [...byWin.values()].sort((a, b) => a.winIdx - b.winIdx);

// Bug-Audit Round 4: window-coverage gap detection. If a shard crashes
// mid-run (OOM, SIGKILL, vitest-zombie pkill), the union of jsonl files
// can have holes (e.g. shard 3 of 8 dies → windows 3, 11, 19, ... missing).
// Without detection, the aggregator silently reports a smaller-than-real
// denominator and an inflated rate. Walk the contiguous winIdx range and
// list missing indices so the user can re-run only the dead shards.
// 2026-05-13 Codex Round 6 HIGH FIX (#SH1+#SH2): fail-closed on coverage
// gaps OR duplicate winIdx. Previously gaps were warned-but-aggregated
// (silent denominator shrink → inflated rate). Now: gaps + duplicates
// throw. Set FTMO_AGG_ALLOW_GAPS=1 to suppress for ad-hoc partial runs.
const allowGaps =
  process.env.FTMO_AGG_ALLOW_GAPS === "1" ||
  process.env.FTMO_AGG_ALLOW_GAPS === "true";
const seenIds = new Set<number>();
const duplicateIds: number[] = [];
for (const name of shardFiles) {
  const f = `${CACHE_DIR}/${name}`;
  for (const line of readFileSync(f, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Row;
      if (seenIds.has(r.winIdx)) duplicateIds.push(r.winIdx);
      seenIds.add(r.winIdx);
    } catch {
      // ignore — already counted via byWin.set, will be caught by gap-check
    }
  }
}
if (rows.length > 0) {
  const maxIdx = rows[rows.length - 1]!.winIdx;
  const present = new Set(rows.map((r) => r.winIdx));
  const missing: number[] = [];
  for (let i = 0; i <= maxIdx; i++) if (!present.has(i)) missing.push(i);
  if (missing.length > 0) {
    plog(
      `⚠ WINDOW-COVERAGE GAPS: ${missing.length} missing winIdx (max seen=${maxIdx})`,
    );
    plog(
      `  first 20 missing: ${missing.slice(0, 20).join(",")}${missing.length > 20 ? ", ..." : ""}`,
    );
    plog(
      `  Hint: re-run the shard whose (winIdx % SHARD_COUNT) matches those indices.`,
    );
    if (!allowGaps) {
      throw new Error(
        `Aggregate FAILED: ${missing.length} missing winIdx between 0 and ${maxIdx}. ` +
          `Re-run the dead shard(s) or set FTMO_AGG_ALLOW_GAPS=1 to compute on partial data.`,
      );
    }
  }
  if (duplicateIds.length > 0) {
    plog(
      `⚠ DUPLICATE WINDOWS: ${duplicateIds.length} winIdx repeated across shards`,
    );
    plog(
      `  first 10: ${duplicateIds.slice(0, 10).join(",")}${duplicateIds.length > 10 ? ", ..." : ""}`,
    );
    if (!allowGaps) {
      throw new Error(
        `Aggregate FAILED: ${duplicateIds.length} duplicate winIdx. ` +
          `Likely stale shard output from a prior run was not cleaned up. ` +
          `Delete old jsonl files or set FTMO_AGG_ALLOW_GAPS=1.`,
      );
    }
  }
}

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
// Bug-Audit Round 3 (R3 fix 5): linear-interpolated quantile (mirrors
// `passlockMonteCarlo.test.ts`). Old `Math.floor(q*N)` had an off-by-one
// (e.g. q=0.9, N=10 → idx=9 = max, not the 90th-percentile).
function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0]!;
  const qc = Math.min(1, Math.max(0, q));
  const pos = (n - 1) * qc;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
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
