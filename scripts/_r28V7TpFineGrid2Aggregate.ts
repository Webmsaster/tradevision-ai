/**
 * Aggregator for R28_V7 TP Fine-Grid v2 sharded results.
 *
 * Reads /tmp/r28v7_tpfg2_tp{multX100}_shard_*.jsonl for each tpMult variant
 * and emits per-variant pass-rate, median-pass-day, total-loss%, give-back%,
 * trade-counts and 4-bucket failure reason breakdown.
 *
 * Args (optional):
 *   process.argv[2..] = list of tpMults to aggregate (e.g. "0.35 0.45 0.50 0.55")
 *                       — defaults to all 11 from the full grid.
 */
import {
  readFileSync,
  existsSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";

const MULTS_DEFAULT = [
  0.35, 0.4, 0.45, 0.48, 0.5, 0.52, 0.55, 0.58, 0.6, 0.65, 0.7,
];
const args = process.argv.slice(2);
const MULTS = args.length > 0 ? args.map((s) => parseFloat(s)) : MULTS_DEFAULT;
const SHARD_COUNT = 8;
const OUT_MD = "scripts/_r28V7TpFineGrid2Results.md";

interface Row {
  winIdx: number;
  tpMult: number;
  passed: boolean;
  reason: string;
  passDay: number | null;
  finalEquityPct: number;
  tradeCount: number;
}
interface Stat {
  tpMult: number;
  windows: number;
  passes: number;
  rate: number;
  med: number;
  p90: number;
  totalTrades: number;
  avgTrades: number;
  finalEqP10: number;
  finalEqMed: number;
  reasonCounts: Record<string, number>;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * sorted.length)),
  );
  return sorted[idx]!;
}

function aggregateMult(mult: number): Stat | null {
  const tag = `tp${Math.round(mult * 100)
    .toString()
    .padStart(2, "0")}`;
  const rows: Row[] = [];
  for (let i = 0; i < SHARD_COUNT; i++) {
    const f = `/tmp/r28v7_tpfg2_${tag}_shard_${i}.jsonl`;
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as Row);
      } catch {
        // ignore partial line
      }
    }
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.winIdx - b.winIdx);

  const windows = rows.length;
  const passes = rows.filter((r) => r.passed).length;
  const passDays = rows
    .filter((r) => r.passed && r.passDay != null)
    .map((r) => r.passDay!)
    .sort((a, b) => a - b);
  const finalEquities = rows.map((r) => r.finalEquityPct).sort((a, b) => a - b);
  const totalTrades = rows.reduce((s, r) => s + r.tradeCount, 0);
  const reasonCounts: Record<string, number> = {};
  for (const r of rows)
    reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
  return {
    tpMult: mult,
    windows,
    passes,
    rate: (passes / windows) * 100,
    med: passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0,
    p90: quantile(passDays, 0.9),
    totalTrades,
    avgTrades: totalTrades / windows,
    finalEqP10: quantile(finalEquities, 0.1) * 100,
    finalEqMed: quantile(finalEquities, 0.5) * 100,
    reasonCounts,
  };
}

const stats: Stat[] = [];
for (const m of MULTS) {
  const s = aggregateMult(m);
  if (s) stats.push(s);
}

console.log("\n=== R28_V7 TP FINE-GRID v2 (Round 60, post-R56-58) ===");
console.log(
  "tpMult | pass-rate         | med | p90 | trades(avg) | finalEq p10 | finalEq med | profit | daily_loss | total_loss | give_back | time",
);
console.log(
  "-------|-------------------|-----|-----|-------------|-------------|-------------|--------|------------|------------|-----------|------",
);
for (const s of stats) {
  const reasonRate = (k: string) =>
    (((s.reasonCounts[k] ?? 0) / s.windows) * 100).toFixed(2) + "%";
  console.log(
    `${s.tpMult.toFixed(2)}   | ${s.rate.toFixed(2).padStart(5)}% (${s.passes
      .toString()
      .padStart(3)}/${s.windows.toString().padStart(3)}) | ${s.med
      .toString()
      .padStart(2)}d | ${s.p90.toString().padStart(2)}d | ${s.totalTrades
      .toString()
      .padStart(5)} (${s.avgTrades.toFixed(1).padStart(4)}) | ${s.finalEqP10
      .toFixed(2)
      .padStart(7)}% | ${s.finalEqMed.toFixed(2).padStart(6)}% | ${reasonRate(
      "profit_target",
    ).padStart(6)} | ${reasonRate("daily_loss").padStart(8)} | ${reasonRate(
      "total_loss",
    ).padStart(8)} | ${reasonRate("give_back").padStart(7)} | ${reasonRate(
      "time",
    ).padStart(5)}`,
  );
}

// Find peak.
const peak =
  stats.length > 0 ? stats.reduce((a, b) => (b.rate > a.rate ? b : a)) : null;
console.log("");
if (peak) {
  console.log(
    `>>> PEAK: tpMult=${peak.tpMult.toFixed(2)} pass=${peak.rate.toFixed(2)}% (${peak.passes}/${peak.windows})`,
  );
  if (peak.rate >= 58) {
    console.log(
      `>>> GOAL MET: tpMult=${peak.tpMult.toFixed(2)} achieves ≥58% (= ${peak.rate.toFixed(2)}%)`,
    );
  } else {
    console.log(
      `>>> GOAL NOT MET: peak ${peak.rate.toFixed(2)}% < 58% threshold`,
    );
  }
}

// Write markdown report.
let md = "# R28_V7 TP Fine-Grid v2 Results — Round 60\n\n";
md += `Generated: ${new Date().toISOString()}\n\n`;
md += "## Context\n\n";
md += "Re-validation of R28_V6 tpMult plateau under the FIXED engine ";
md += "(post-R56 funding cost, R57 Day-30 force-close, R58 atomic Lua). ";
md += "Round 53 found plateau 0.55-0.59 = 60.29% pre-R56. ";
md += "After fixes, R28_V6 ×0.55 = 56.62%. This sweep tests if a different ";
md += "tpMult is now optimal.\n\n";
md += "**Engine**: V4 Live Engine (`ftmoLiveEngineV4.simulate`). ";
md += "9-asset crypto basket (R28_V6). ";
md += "30m bars, 136 windows, step=14d, profit-target 8%, maxDays 30.\n\n";
md += "## Results Table\n\n";
md +=
  "| tpMult | pass-rate | passes | med-day | p90-day | total-trades | avg-trades/win | finalEq p10 | finalEq med | profit_target | daily_loss | total_loss | give_back | time |\n";
md +=
  "|--------|-----------|--------|---------|---------|--------------|----------------|-------------|-------------|---------------|------------|------------|-----------|------|\n";
for (const s of stats) {
  const reasonRate = (k: string) =>
    (((s.reasonCounts[k] ?? 0) / s.windows) * 100).toFixed(2) + "%";
  md += `| ${s.tpMult.toFixed(2)} | ${s.rate.toFixed(2)}% | ${s.passes}/${s.windows} | ${s.med}d | ${s.p90}d | ${s.totalTrades} | ${s.avgTrades.toFixed(1)} | ${s.finalEqP10.toFixed(2)}% | ${s.finalEqMed.toFixed(2)}% | ${reasonRate("profit_target")} | ${reasonRate("daily_loss")} | ${reasonRate("total_loss")} | ${reasonRate("give_back")} | ${reasonRate("time")} |\n`;
}
md += "\n## Analysis\n\n";
if (peak) {
  md += `- **Peak**: tpMult=${peak.tpMult.toFixed(2)} → **${peak.rate.toFixed(2)}%** pass-rate (${peak.passes}/${peak.windows} windows)\n`;
  const r28v6 = stats.find((s) => Math.abs(s.tpMult - 0.55) < 1e-6);
  if (r28v6) {
    const drift = peak.rate - r28v6.rate;
    md += `- **R28_V6 baseline (×0.55)**: ${r28v6.rate.toFixed(2)}%\n`;
    md += `- **Drift**: ${drift >= 0 ? "+" : ""}${drift.toFixed(2)}pp vs baseline\n`;
  }
  md += `- **Goal (≥58%)**: ${peak.rate >= 58 ? "ACHIEVED" : "NOT achieved (peak " + peak.rate.toFixed(2) + "%)"}\n`;
}
md += "\n## Methodology\n\n";
md +=
  "- Sharded 8-way parallel via `scripts/_r28V7TpFineGrid2Shard.ts <idx> 8 <tpMult>`.\n";
md +=
  "- Each tpMult variant ran 17 windows per shard × 8 shards = 136 windows total.\n";
md += "- Engine: `ftmoLiveEngineV4.simulate` (production V4 Live Engine).\n";
md += "- 9-asset crypto basket: AAVE/ADA/BCH/BNB/BTC/ETC/ETH/LTC/XRP.\n";
md += "- Per-asset tpPct = R28_V4 baseline × tpMult.\n";
md +=
  "- All other R28_V6 features preserved (PTP triggerPct=0.012, closeFraction=0.7, liveCaps, atrStop, etc.).\n";

writeFileSync(OUT_MD, md);
console.log(`\nWrote ${OUT_MD}`);
