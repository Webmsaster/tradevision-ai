/**
 * Aggregator for R28_V7 per-asset TP-multiplier greedy sweep.
 *
 * Reads scripts/cache_bakeoff/r28v7_greedy_<assetIdx>.jsonl files, identifies
 * the per-asset OPTIMAL tpMult, builds the greedy combo (R28_V7_GREEDY) and
 * runs it on the full dataset to verify the combination effect.
 *
 * Outputs a ranked log of all 45 single-asset variants + the final greedy
 * combo result + ship/no-ship decision relative to baseline 60.29%.
 */
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = `${CACHE_DIR}/r28v7_perasset_greedy.log`;
writeFileSync(LOG_FILE, `[${new Date().toISOString()}] aggregate start\n`);
function plog(s: string) {
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`);
  console.log(s);
}

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

interface VariantResult {
  variant: string;
  asset: string | null;
  mult: number;
  passes: number;
  windows: number;
  rate: number;
  med: number;
  p90: number;
  durationSec: number;
}

function loadAligned(): { aligned: Record<string, Candle[]>; minBars: number } {
  const data: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    data[s] = JSON.parse(readFileSync(`${CACHE_DIR}/${s}_30m.json`, "utf-8"));
  }
  const sets = SYMBOLS.map((s) => new Set(data[s]!.map((c) => c.openTime)));
  const common = [...sets[0]!]
    .filter((t) => sets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of SYMBOLS)
    aligned[s] = data[s]!.filter((c) => cs.has(c.openTime));
  return {
    aligned,
    minBars: Math.min(...SYMBOLS.map((s) => aligned[s]!.length)),
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * sorted.length)),
  );
  return sorted[idx]!;
}

function makeComboCfg(perAsset: Record<string, number>): FtmoDaytrade24hConfig {
  const baseV4 = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4;
  const baseV6 = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
  return {
    ...baseV6,
    assets: baseV4.assets.map((a) => {
      const sym = a.sourceSymbol ?? a.symbol;
      const mult = perAsset[sym] ?? 0.55;
      return { ...a, tpPct: (a.tpPct ?? 0.05) * mult };
    }),
    liveCaps: baseV6.liveCaps ?? { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    partialTakeProfit: baseV6.partialTakeProfit ?? {
      triggerPct: 0.012,
      closeFraction: 0.7,
    },
  };
}

function runFinal(
  name: string,
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  minBars: number,
): { passes: number; windows: number; rate: number; med: number; p90: number } {
  const winBars = cfg.maxDays * 48;
  const stepBars = 14 * 48;
  const WARMUP = 5000;
  let passes = 0;
  let windows = 0;
  const passDays: number[] = [];
  for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
    windows++;
    const trimmed: Record<string, Candle[]> = {};
    for (const k of Object.keys(aligned))
      trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
    const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, name);
    if (r.passed) {
      passes++;
      if (r.passDay) passDays.push(r.passDay);
    }
  }
  passDays.sort((a, b) => a - b);
  const med =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const p90 = quantile(passDays, 0.9);
  const rate = (passes / windows) * 100;
  return { passes, windows, rate, med, p90 };
}

// === Step 1: Read all shard outputs ===
const allResults: VariantResult[] = [];
const baselineFile = `${CACHE_DIR}/r28v7_greedy_baseline.jsonl`;
let baselineRate = 60.29; // fallback if baseline shard missing
if (existsSync(baselineFile)) {
  for (const line of readFileSync(baselineFile, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as VariantResult;
    allResults.push(r);
    baselineRate = r.rate;
  }
}
for (let idx = 0; idx < SYMBOLS.length; idx++) {
  const f = `${CACHE_DIR}/r28v7_greedy_${idx}.jsonl`;
  if (!existsSync(f)) {
    plog(`[warn] missing shard ${idx} (${SYMBOLS[idx]})`);
    continue;
  }
  for (const line of readFileSync(f, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    allResults.push(JSON.parse(line) as VariantResult);
  }
}

// === Step 2: Per-variant ranking ===
plog("\n=== R28_V7 PER-ASSET GREEDY SWEEP — ALL 46 VARIANTS ===");
plog(`Baseline (uniform 0.55 = R28_V6):  ${baselineRate.toFixed(2)}%`);
plog("");
plog(
  "variant                           | pass% | med | p90 | windows | Δ vs base",
);
plog(
  "----------------------------------+-------+-----+-----+---------+----------",
);
const sorted = [...allResults].sort((a, b) => b.rate - a.rate);
for (const r of sorted) {
  const delta = r.rate - baselineRate;
  const sign = delta >= 0 ? "+" : "";
  plog(
    `${r.variant.padEnd(33)} | ${r.rate.toFixed(2).padStart(5)} | ${String(r.med).padStart(3)} | ${String(r.p90).padStart(3)} | ${String(r.windows).padStart(7)} | ${sign}${delta.toFixed(2)}pp`,
  );
}

// === Step 3: Identify per-asset optimum (best tpMult per asset) ===
//
// The 0.55 baseline (uniform) is treated as the implicit "no-change" option
// for every asset — if no probed mult beats baseline, that asset stays at
// 0.55 in the greedy combo (only assets with a strict improvement get
// switched).
plog("\n=== PER-ASSET OPTIMA ===");
const perAssetOptimum: Record<string, number> = {};
const perAssetOptRate: Record<string, number> = {};
for (const sym of SYMBOLS) {
  const variants = allResults.filter((r) => r.asset === sym);
  if (variants.length === 0) {
    plog(`[warn] no variants found for ${sym} → keeping baseline 0.55`);
    perAssetOptimum[sym] = 0.55;
    perAssetOptRate[sym] = baselineRate;
    continue;
  }
  // Compare each probed mult against the 0.55 baseline. Only switch this
  // asset if some probed mult STRICTLY beats baseline. On ties, prefer the
  // baseline (= keep 0.55) for stability.
  variants.sort((a, b) => b.rate - a.rate);
  const best = variants[0]!;
  if (best.rate > baselineRate) {
    perAssetOptimum[sym] = best.mult;
    perAssetOptRate[sym] = best.rate;
  } else {
    perAssetOptimum[sym] = 0.55;
    perAssetOptRate[sym] = baselineRate;
  }
  const delta = perAssetOptRate[sym] - baselineRate;
  const sign = delta >= 0 ? "+" : "";
  plog(
    `  ${sym.padEnd(10)}  optimum tpMult=${perAssetOptimum[sym].toFixed(2)}  →  ${perAssetOptRate[sym].toFixed(2)}% (${sign}${delta.toFixed(2)}pp)  [probed: ${variants.map((v) => `${v.mult.toFixed(2)}=${v.rate.toFixed(2)}%`).join(", ")}]`,
  );
}

// === Step 4: Build R28_V7_GREEDY combo ===
plog("\n=== R28_V7_GREEDY COMBO ===");
plog(`per-asset map: ${JSON.stringify(perAssetOptimum)}`);
const allBaseline = SYMBOLS.every((s) => perAssetOptimum[s] === 0.55);
if (allBaseline) {
  plog(
    "[note] All per-asset optima collapse to 0.55 — greedy combo == baseline. Skipping final run.",
  );
  plog("\n=== DECISION ===");
  plog(`R28_V6 baseline: ${baselineRate.toFixed(2)}%`);
  plog(`R28_V7_GREEDY:   ${baselineRate.toFixed(2)}% (no improvement)`);
  plog("DECISION: NO-SHIP — R28_V6 remains champion.");
  process.exit(0);
}

const { aligned, minBars } = loadAligned();
const comboCfg = makeComboCfg(perAssetOptimum);
plog(`[setup] ${SYMBOLS.length} syms, ${minBars} bars`);
plog("[run] R28_V7_GREEDY full sweep...");
const t0 = Date.now();
const finalResult = runFinal("R28_V7_GREEDY", comboCfg, aligned, minBars);
plog(
  `[done] R28_V7_GREEDY: ${finalResult.passes}/${finalResult.windows} = ${finalResult.rate.toFixed(2)}% / med=${finalResult.med}d / p90=${finalResult.p90}d / ${Math.round((Date.now() - t0) / 1000)}s`,
);

// === Step 5: Decision ===
plog("\n=== DECISION ===");
const greedyDelta = finalResult.rate - baselineRate;
const sign = greedyDelta >= 0 ? "+" : "";
plog(`R28_V6 baseline:  ${baselineRate.toFixed(2)}%`);
plog(
  `R28_V7_GREEDY:    ${finalResult.rate.toFixed(2)}%  (${sign}${greedyDelta.toFixed(2)}pp)`,
);
if (finalResult.rate >= baselineRate + 2.0) {
  plog("DECISION: SHIP — R28_V7_GREEDY beats baseline by ≥+2pp. New champion.");
} else if (finalResult.rate >= baselineRate) {
  plog(
    "DECISION: NO-SHIP (marginal) — improvement <+2pp. R28_V6 holds. Document but don't ship.",
  );
} else {
  plog(
    "DECISION: NO-SHIP — R28_V7_GREEDY is below baseline. R28_V6 remains champion.",
  );
}
plog(`\nper-asset tpMult map: ${JSON.stringify(perAssetOptimum)}`);
