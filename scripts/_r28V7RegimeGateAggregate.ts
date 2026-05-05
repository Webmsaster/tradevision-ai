/**
 * Aggregator for R28_V7 regime-gate shard outputs (Round 60).
 *
 * Reads scripts/cache_bakeoff/r28v7_regime_v<v>_shard_*.jsonl for v in {0..4}
 * and emits a per-variant pass-rate / median pass-day / TL% / give_back%
 * summary plus a delta vs V0 (baseline).
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";

interface Row {
  winIdx: number;
  variant: number;
  passed: boolean;
  reason: string;
  passDay: number | null;
  finalEquityPct: number;
  blocked: number;
  totalBars: number;
  blockPct: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * sorted.length)),
  );
  return sorted[idx]!;
}

interface Stats {
  variant: number;
  windows: number;
  passes: number;
  rate: number;
  medPassDay: number;
  p90PassDay: number;
  finalP10: number;
  finalMed: number;
  reasonCounts: Record<string, number>;
  totalLossPct: number;
  giveBackPct: number;
  meanBlockPct: number;
}

function statsFor(rows: Row[], variant: number): Stats {
  const v = rows.filter((r) => r.variant === variant);
  const passes = v.filter((r) => r.passed).length;
  const passDays = v
    .filter((r) => r.passed && r.passDay != null)
    .map((r) => r.passDay!)
    .sort((a, b) => a - b);
  const finals = v.map((r) => r.finalEquityPct).sort((a, b) => a - b);
  const reasonCounts: Record<string, number> = {};
  for (const r of v) reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
  const tl = reasonCounts["total_loss"] ?? 0;
  const gb = reasonCounts["give_back"] ?? 0;
  const block =
    v.length > 0 ? v.reduce((a, b) => a + b.blockPct, 0) / v.length : 0;
  return {
    variant,
    windows: v.length,
    passes,
    rate: v.length > 0 ? (passes / v.length) * 100 : 0,
    medPassDay:
      passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0,
    p90PassDay: quantile(passDays, 0.9),
    finalP10: quantile(finals, 0.1) * 100,
    finalMed: quantile(finals, 0.5) * 100,
    reasonCounts,
    totalLossPct: v.length > 0 ? (tl / v.length) * 100 : 0,
    giveBackPct: v.length > 0 ? (gb / v.length) * 100 : 0,
    meanBlockPct: block * 100,
  };
}

const allRows: Row[] = [];
for (let v = 0; v <= 4; v++) {
  for (let i = 0; i < 32; i++) {
    const f = `${CACHE_DIR}/r28v7_regime_v${v}_shard_${i}.jsonl`;
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      allRows.push(JSON.parse(line) as Row);
    }
  }
}

const lines: string[] = [];
function emit(s: string) {
  console.log(s);
  lines.push(s);
}

emit("=== R28_V7 REGIME-GATE SHARD AGGREGATE (Round 60, 2026-05-03) ===");
emit("");

const variantNames: Record<number, string> = {
  0: "V0 baseline (no gate)",
  1: "V1 BTC close < EMA200(2h)",
  2: "V2 BTC EMA50 < EMA200(2h) [death-cross]",
  3: "V3 BTC last-7d return < -5%",
  4: "V4 require BOTH BTC & ETH close > EMA200(2h)",
};

const allStats: Stats[] = [];
for (let v = 0; v <= 4; v++) {
  const s = statsFor(allRows, v);
  if (s.windows === 0) {
    emit(`${variantNames[v]}: NO DATA`);
    continue;
  }
  allStats.push(s);
  emit(`--- ${variantNames[v]} ---`);
  emit(`  pass-rate:        ${s.rate.toFixed(2)}% (${s.passes}/${s.windows})`);
  emit(`  median pass-day:  ${s.medPassDay}d`);
  emit(`  p90 pass-day:     ${s.p90PassDay}d`);
  emit(
    `  final eq p10/med: ${s.finalP10.toFixed(2)}% / ${s.finalMed.toFixed(2)}%`,
  );
  emit(`  total-loss%:      ${s.totalLossPct.toFixed(2)}%`);
  emit(`  give-back%:       ${s.giveBackPct.toFixed(2)}%`);
  emit(`  mean block%:      ${s.meanBlockPct.toFixed(2)}%`);
  emit(
    `  reasons: ${Object.entries(s.reasonCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(" ")}`,
  );
  emit("");
}

const baseline = allStats.find((s) => s.variant === 0);
if (baseline) {
  emit("=== DELTA vs V0 BASELINE ===");
  emit(`baseline: ${baseline.rate.toFixed(2)}% (memory: 56.62%)`);
  for (const s of allStats) {
    if (s.variant === 0) continue;
    const dPass = s.rate - baseline.rate;
    const dTL = s.totalLossPct - baseline.totalLossPct;
    emit(
      `V${s.variant}: ${s.rate.toFixed(2)}% (${dPass >= 0 ? "+" : ""}${dPass.toFixed(2)}pp) TL=${s.totalLossPct.toFixed(2)}% (${dTL >= 0 ? "+" : ""}${dTL.toFixed(2)}pp) block=${s.meanBlockPct.toFixed(1)}%`,
    );
  }
}

writeFileSync(
  `${CACHE_DIR}/r28v7_regime_aggregate.log`,
  lines.join("\n") + "\n",
);
console.log(`\nWrote ${CACHE_DIR}/r28v7_regime_aggregate.log`);
