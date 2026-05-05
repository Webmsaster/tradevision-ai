/**
 * Aggregator for the R28_V7 SL-multiplier sweep.
 *
 * Reads scripts/cache_bakeoff/r28v7_sl_*.jsonl produced by the shard runner,
 * builds a sortable ranking of all variants, identifies the best per-asset
 * stopMult choices and constructs a Phase-3 greedy combo spec.
 *
 * Outputs:
 *   - scripts/cache_bakeoff/r28v7_sl_sweep.log (human-readable ranking)
 *   - prints `COMBO_SPEC=<spec>` on stdout when a combo is recommended (so
 *     the orchestrator script can pick it up)
 */
import {
  readFileSync,
  existsSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = `${CACHE_DIR}/r28v7_sl_sweep.log`;

const SYMBOLS = [
  "AAVEUSDT",
  "ADAUSDT",
  "BCHUSDT",
  "BNBUSDT",
  "BTCUSDT",
  "ETCUSDT",
  "ETHUSDT",
  "LTCUSDT",
  "XRPUSDT",
];

interface Row {
  variant: string;
  task: string;
  stopMultMap: Record<string, number>;
  passes: number;
  windows: number;
  rate: number;
  med: number;
  p90: number;
  durationSec: number;
}

writeFileSync(LOG_FILE, `[${new Date().toISOString()}] aggregate start\n`);
function plog(s: string) {
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`);
  console.log(s);
}

const rows: Row[] = [];
// Glob via fs/readdir, but simpler: scan known task names.
const taskNames: string[] = [
  "u_0_6",
  "u_0_8",
  "u_1_0",
  "u_1_2",
  "u_1_4",
  "u_1_6",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
];
// Also scan for any combo file present.
import { readdirSync } from "node:fs";
const allFiles = readdirSync(CACHE_DIR).filter(
  (f) => f.startsWith("r28v7_sl_") && f.endsWith(".jsonl"),
);
for (const f of allFiles) {
  const text = readFileSync(`${CACHE_DIR}/${f}`, "utf-8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Row);
    } catch (e) {
      plog(`[warn] bad json line in ${f}: ${line.slice(0, 80)}`);
    }
  }
}

if (rows.length === 0) {
  plog("[error] no shard output found");
  process.exit(1);
}

const BASELINE = 60.29;

plog(`\n=== R28_V7 SL-MULT SWEEP — ${rows.length} variants ===`);
plog(`baseline R28_V6: ${BASELINE.toFixed(2)}%\n`);

// Phase 1 ranking
const phase1 = rows.filter((r) => r.variant.startsWith("UNIFORM_"));
plog("--- Phase 1: uniform stopMult ---");
plog("variant                          | pass% | med | p90 | windows | dur");
plog("---------------------------------+-------+-----+-----+---------+----");
for (const r of [...phase1].sort((a, b) => b.rate - a.rate)) {
  const delta = r.rate - BASELINE;
  const sign = delta >= 0 ? "+" : "";
  plog(
    `${r.variant.padEnd(32)} | ${r.rate.toFixed(2).padStart(5)} | ${String(r.med).padStart(3)} | ${String(r.p90).padStart(3)} | ${String(r.windows).padStart(7)} | ${String(r.durationSec).padStart(3)}s   (${sign}${delta.toFixed(2)}pp)`,
  );
}

// Phase 2 ranking — per asset
const phase2 = rows.filter(
  (r) => !r.variant.startsWith("UNIFORM_") && !r.variant.startsWith("COMBO_"),
);
plog("\n--- Phase 2: per-asset stopMult (others=1.00) ---");
plog("variant                              | pass% | med | p90 | windows");
plog("-------------------------------------+-------+-----+-----+--------");
for (const r of [...phase2].sort((a, b) => b.rate - a.rate)) {
  const delta = r.rate - BASELINE;
  const sign = delta >= 0 ? "+" : "";
  plog(
    `${r.variant.padEnd(36)} | ${r.rate.toFixed(2).padStart(5)} | ${String(r.med).padStart(3)} | ${String(r.p90).padStart(3)} | ${String(r.windows).padStart(7)}   (${sign}${delta.toFixed(2)}pp)`,
  );
}

// Per-asset best multiplier
plog("\n--- Per-asset best stopMult (vs uniform=1.00) ---");
const perAssetBest: Record<string, { mult: number; rate: number }> = {};
const baseline100 = phase2.find((r) =>
  r.variant.includes("stopMult=1.00_others=1.00"),
);
const baselineRate100 = baseline100?.rate ?? BASELINE;

for (const sym of SYMBOLS) {
  const variants = phase2.filter((r) => r.variant.startsWith(`${sym}_`));
  if (variants.length === 0) continue;
  const sorted = [...variants].sort((a, b) => b.rate - a.rate);
  const best = sorted[0]!;
  const m = best.stopMultMap[sym] ?? 1.0;
  perAssetBest[sym] = { mult: m, rate: best.rate };
  const delta = best.rate - baselineRate100;
  const sign = delta >= 0 ? "+" : "";
  plog(
    `${sym.padEnd(10)} best mult=${m.toFixed(2)} -> ${best.rate.toFixed(2)}%  (${sign}${delta.toFixed(2)}pp)`,
  );
}

// Phase 3 combo ranking
const phase3 = rows.filter((r) => r.variant.startsWith("COMBO_"));
if (phase3.length > 0) {
  plog("\n--- Phase 3: combo variants ---");
  for (const r of [...phase3].sort((a, b) => b.rate - a.rate)) {
    const delta = r.rate - BASELINE;
    const sign = delta >= 0 ? "+" : "";
    plog(
      `${r.variant.padEnd(40)} | ${r.rate.toFixed(2).padStart(5)} | med=${r.med}d | p90=${r.p90}d   (${sign}${delta.toFixed(2)}pp)`,
    );
  }
}

// Overall ranking
plog("\n--- ALL VARIANTS (sorted by pass-rate) ---");
const allSorted = [...rows].sort((a, b) => b.rate - a.rate);
for (const r of allSorted.slice(0, 15)) {
  const delta = r.rate - BASELINE;
  const sign = delta >= 0 ? "+" : "";
  plog(
    `${r.variant.padEnd(42)} ${r.rate.toFixed(2).padStart(5)}%  med=${r.med}d  (${sign}${delta.toFixed(2)}pp vs R28_V6)`,
  );
}

const top = allSorted[0]!;
plog(
  `\n>>> BEST: ${top.variant} → ${top.rate.toFixed(2)}% / med=${top.med}d (${top.rate - BASELINE >= 0 ? "+" : ""}${(top.rate - BASELINE).toFixed(2)}pp vs R28_V6)`,
);

// Win-criteria classification
plog("\n=== WIN-CRITERIA ===");
if (top.rate >= 63.29) {
  plog(`SHIP: ${top.variant} >= +3.0pp (matches V7 ship threshold)`);
} else if (top.rate >= 62.29) {
  plog(`MARGINAL+: ${top.variant} >= +2.0pp (worth shipping behind flag)`);
} else if (top.rate >= 61.29) {
  plog(`MARGINAL: ${top.variant} >= +1.0pp (worth documenting, not ship)`);
} else if (top.rate >= 60.29) {
  plog(`NEUTRAL: ${top.variant} = ${top.rate.toFixed(2)}% (no improvement)`);
} else {
  plog(`REGRESSION: ${top.variant} = ${top.rate.toFixed(2)}% (R28_V6 wins)`);
}

// Build combo spec from per-asset bests for Phase 3 (only if phase3 not yet run)
if (phase3.length === 0) {
  const helpfulPicks: { sym: string; mult: number; delta: number }[] = [];
  for (const sym of SYMBOLS) {
    const b = perAssetBest[sym];
    if (!b) continue;
    if (b.mult === 1.0) continue;
    const delta = b.rate - baselineRate100;
    if (delta >= 0.5) {
      helpfulPicks.push({ sym, mult: b.mult, delta });
    }
  }
  helpfulPicks.sort((a, b) => b.delta - a.delta);
  if (helpfulPicks.length > 0) {
    const spec = helpfulPicks
      .map((p) => `${SYMBOLS.indexOf(p.sym)}:${p.mult}`)
      .join(",");
    plog(`\n>>> Phase-3 COMBO_SPEC candidate: ${spec}`);
    plog(
      `    (${helpfulPicks.length} per-asset picks each ≥+0.5pp vs uniform=1.00)`,
    );
    // Output to stdout in a parseable form for the orchestrator
    console.log(`COMBO_SPEC=${spec}`);
  } else {
    plog(`\nNo per-asset pick beats baseline by ≥0.5pp — skip Phase 3.`);
  }
}
