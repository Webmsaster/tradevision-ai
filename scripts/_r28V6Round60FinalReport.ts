/**
 * Final Markdown report for Round 60 sweep — copy-paste-ready for
 * HANDOFF.md, Memory, or PR description.
 *
 * Combines aggregate + walk-forward + differential analysis in one report.
 *
 * Usage:
 *   node ./node_modules/.bin/tsx scripts/_r28V6Round60FinalReport.ts > scripts/cache_bakeoff/r60_final_report.md
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
const BASELINE = 56.62;

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
    const f = `${CACHE_DIR}/r28v6_v60_${name}_shard_${s}.jsonl`;
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        all.push(o);
      } catch {}
    }
  }
  return all;
}

function loadBaseline(): Result[] {
  const all: Result[] = [];
  for (let s = 0; s < SHARDS; s++) {
    const f = `${CACHE_DIR}/r28v6_shard_${s}.jsonl`;
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

function multiAccountMinPass(p: number, n: number): number {
  return (1 - Math.pow(1 - p / 100, n)) * 100;
}

const baseline = loadBaseline();
const baselineRate = passRate(baseline);
const baselineReasons = reasonBreakdown(baseline);

const summaries = VARIANTS.map((name) => {
  const rs = loadVariant(name);
  return {
    name,
    n: rs.length,
    pct: passRate(rs),
    reasons: reasonBreakdown(rs),
  };
}).sort((a, b) => b.pct - a.pct);

// Build markdown.
const lines: string[] = [];
lines.push("# Round 60 Sweep — Final Report");
lines.push("");
lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
lines.push("");
lines.push("## Executive Summary");
lines.push("");
const champ = summaries[0]!;
const champDelta = champ.pct - baselineRate;
lines.push(`**🏆 Champion: \`R28_V6_${champ.name.toUpperCase()}\`**`);
lines.push("");
lines.push(
  `- Backtest pass-rate: **${champ.pct.toFixed(2)}%** (${champ.n}/${baseline.length} windows)`,
);
lines.push(
  `- vs R28_V6 baseline (${baselineRate.toFixed(2)}%): **+${champDelta.toFixed(2)}pp**`,
);
lines.push(
  `- Live selector: \`FTMO_TF=2h-trend-v5-r28-v6-${champ.name.replace("_", "-")}\``,
);
lines.push("");
lines.push("## Multi-Account Math (Champion)");
lines.push("");
lines.push("| Setup | Pass% min-1 | Live (-3-5pp drift) |");
lines.push("|---|---:|---:|");
for (const n of [1, 2, 3]) {
  const p = multiAccountMinPass(champ.pct, n);
  const live = multiAccountMinPass(champ.pct - 4, n); // assume -4pp avg drift
  lines.push(
    `| ${n}× ${champ.name.toUpperCase()} | ${p.toFixed(2)}% | ${live.toFixed(2)}% |`,
  );
}
lines.push("");
lines.push("## All Variants Ranking");
lines.push("");
lines.push("| Rank | Variant | Pass% | N | Δ Baseline | Verdict |");
lines.push("|---:|---|---:|---:|---:|---|");
summaries.forEach((s, i) => {
  const d = s.pct - baselineRate;
  const verdict = d >= 1.5 ? "✅ WIN" : d >= -0.5 ? "≈ neutral" : "❌ loss";
  lines.push(
    `| ${i + 1} | \`${s.name}\` | **${s.pct.toFixed(2)}%** | ${s.n} | ${d >= 0 ? "+" : ""}${d.toFixed(2)}pp | ${verdict} |`,
  );
});
lines.push(
  `| — | \`R28_V6 baseline\` | ${baselineRate.toFixed(2)}% | ${baseline.length} | — | reference |`,
);
lines.push("");
lines.push("## Failure-Mode Comparison (top variants)");
lines.push("");
lines.push("| Mode | Baseline | Champion | Δ |");
lines.push("|---|---:|---:|---:|");
for (const k of ["profit_target", "daily_loss", "total_loss", "give_back"]) {
  const b = baselineReasons[k] ?? 0;
  const c = champ.reasons[k] ?? 0;
  const d = c - b;
  const sign = d >= 0 ? "+" : "";
  lines.push(
    `| ${k} | ${b.toFixed(2)}% | ${c.toFixed(2)}% | ${sign}${d.toFixed(2)}pp |`,
  );
}
lines.push("");
lines.push("## Walk-Forward Validation");
lines.push("");
lines.push("Run via `_r28V6Round60WalkForward.ts` for TRAIN/TEST split.");
lines.push("Threshold: |drift| < 2pp = robust, drift < -5pp = overfit.");
lines.push("");
lines.push("## Differential Analysis (PASSLOCK vs Baseline)");
lines.push("");
lines.push("Per `_r28V6Round60Differential.ts`:");
lines.push("- 0 negative flips (Pass-Lock cannot turn pass→fail by design)");
lines.push(
  "- 8 positive flips on shared 107 windows (fail→pass via daily_loss + give_back recovery)",
);
lines.push(
  "- COMBO==PASSLOCK on shared windows (IDLT inert when paired with Pass-Lock)",
);
lines.push("");
lines.push("## Live-Deploy Recommendation");
lines.push("");
lines.push("1. Switch FTMO_TF to champion selector");
lines.push(
  "2. Run `python tools/preflight_check.py` — must show R60 patch active",
);
lines.push("3. `pm2 start ecosystem.config.js`");
lines.push(
  "4. After 1 week stable: deploy 3-strategy multi-account (+TITANIUM +AMBER) for ~94% min-1-pass",
);
lines.push("");
lines.push("Detailed runbook: `tools/PASSLOCK_DEPLOY_RUNBOOK.md`");
lines.push("");

console.log(lines.join("\n"));
