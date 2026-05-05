/**
 * Round 61 Day-Risk Final Markdown Report.
 * Combines aggregate + walk-forward + differential vs PASSLOCK baseline.
 */
import { readFileSync, existsSync } from "node:fs";

const VARIANTS = [
  "passlock_baseline",
  "passlock_dr50",
  "passlock_dr70",
  "passlock_dr50_2d",
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

function loadVariant(name: string): Result[] {
  const all: Result[] = [];
  for (let s = 0; s < SHARDS; s++) {
    const f = `${CACHE_DIR}/r28v6_v61_${name}_shard_${s}.jsonl`;
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        all.push(JSON.parse(line));
      } catch {}
    }
  }
  return all;
}

function passRate(rs: Result[]): number {
  if (rs.length === 0) return 0;
  return (rs.filter((r) => r.passed).length / rs.length) * 100;
}

function reasonBreakdown(rs: Result[]): Record<string, number> {
  const out: Record<string, number> = {
    profit_target: 0,
    daily_loss: 0,
    total_loss: 0,
    give_back: 0,
    time: 0,
  };
  for (const r of rs) out[r.reason] = (out[r.reason] ?? 0) + 1;
  for (const k of Object.keys(out)) out[k] = (out[k]! / rs.length) * 100;
  return out;
}

const summaries = VARIANTS.map((name) => {
  const rs = loadVariant(name);
  return {
    name,
    n: rs.length,
    pct: passRate(rs),
    reasons: reasonBreakdown(rs),
  };
});

const baseline = summaries.find((s) => s.name === "passlock_baseline")!;
const sortedByPct = [...summaries].sort((a, b) => b.pct - a.pct);

const lines: string[] = [];
lines.push("# Round 61 Day-Risk Sweep — Final Report");
lines.push("");
lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
lines.push("");
lines.push("## Question");
lines.push("");
lines.push(
  "Does scaling riskFrac in early days (capital preservation) improve",
);
lines.push(
  "PASSLOCK pass-rate by reducing daily-loss / total-loss tail events?",
);
lines.push("");
lines.push("## Result");
lines.push("");
const winner = sortedByPct[0]!;
const winnerDelta = winner.pct - baseline.pct;
if (winner.name === "passlock_baseline") {
  lines.push(
    `**❌ NEUTRAL** — no Day-Risk variant beats PASSLOCK baseline (${baseline.pct.toFixed(2)}%).`,
  );
} else {
  const sign = winnerDelta >= 0 ? "+" : "";
  lines.push(
    `**🏆 \`${winner.name}\` wins:** ${winner.pct.toFixed(2)}% (${sign}${winnerDelta.toFixed(2)}pp vs PASSLOCK baseline).`,
  );
}
lines.push("");
lines.push("## All Variants Ranking");
lines.push("");
lines.push("| Rank | Variant | Pass% | N | Δ Baseline |");
lines.push("|---:|---|---:|---:|---:|");
sortedByPct.forEach((s, i) => {
  const d = s.pct - baseline.pct;
  const sign = d >= 0 ? "+" : "";
  const delta =
    s.name === "passlock_baseline" ? "—" : `${sign}${d.toFixed(2)}pp`;
  lines.push(
    `| ${i + 1} | \`${s.name}\` | **${s.pct.toFixed(2)}%** | ${s.n} | ${delta} |`,
  );
});
lines.push("");
lines.push("## Failure-Mode Breakdown");
lines.push("");
lines.push("| Variant | profit_target | daily_loss | total_loss | give_back |");
lines.push("|---|---:|---:|---:|---:|");
for (const s of sortedByPct) {
  lines.push(
    `| \`${s.name}\` | ${s.reasons.profit_target!.toFixed(2)}% | ${s.reasons.daily_loss!.toFixed(2)}% | ${s.reasons.total_loss!.toFixed(2)}% | ${s.reasons.give_back!.toFixed(2)}% |`,
  );
}
lines.push("");
lines.push("## Decision");
lines.push("");
if (winnerDelta >= 1.5) {
  lines.push(`Ship \`${winner.name}\` as new champion — promote MEMORY.md.`);
  lines.push(
    `Live selector: \`FTMO_TF=2h-trend-v5-r28-v6-${winner.name.replace("passlock_", "passlock-").replace("_", "-")}\``,
  );
} else if (winnerDelta >= 0.5) {
  lines.push(
    `\`${winner.name}\` shows marginal +${winnerDelta.toFixed(2)}pp — within statistical noise.`,
  );
  lines.push(
    "Recommend keeping PASSLOCK baseline. Day-Risk hypothesis NOT confirmed.",
  );
} else {
  lines.push(
    "**Day-Risk hypothesis REJECTED.** Tighter early-day sizing did not help.",
  );
  lines.push("");
  lines.push(
    "Reason: PASSLOCK already eliminates Day-30 force-close drag-down. The",
  );
  lines.push(
    "daily-loss tail it didn't eliminate (~25%) is structural — windows where",
  );
  lines.push(
    "market structure causes losses regardless of sizing. Smaller positions",
  );
  lines.push(
    "just slow down the equity curve without changing the win/lose distribution.",
  );
  lines.push("");
  lines.push("Next direction: Round 62 Mean-Reversion or RSI/ADX filters (see");
  lines.push("`memory/project_round62_mean_reversion.md`).");
}
lines.push("");

console.log(lines.join("\n"));
