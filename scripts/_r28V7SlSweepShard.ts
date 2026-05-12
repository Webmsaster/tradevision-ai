/**
 * R28_V7 Stop-Loss Multiplier Sweep — shard runner.
 *
 * Tests if per-asset stopPct (stopMult) variation improves R28_V6 from
 * 60.29% baseline (post-R56/R57/R58 V4 Live Engine).
 *
 * Phase 1 (uniform): tasks "u_0.6", "u_0.8", "u_1.0", "u_1.2", "u_1.4", "u_1.6"
 *   -> uniform stopMult applied to ALL 9 assets, keeping per-asset tpMult=0.55.
 *
 * Phase 2 (per-asset): tasks "0".."8" -> each asset varied across stopMult ∈
 *   {0.7, 1.0, 1.4} keeping all OTHER assets at stopMult=1.0. The 1.0 row is
 *   the per-asset baseline replication and serves as a sanity-check duplicate
 *   of Phase 1's u_1.0.
 *
 * Phase 3 (combo): task "combo:<spec>" — spec is a comma-separated
 *   "ASSETIDX:MULT" list (e.g. "0:0.7,3:1.4"). Driven by the aggregator after
 *   Phase 1+2 reveal a winning per-asset combo.
 *
 * Args:
 *   process.argv[2] = task identifier (see above)
 *
 * Outputs JSON-line per variant to scripts/cache_bakeoff/r28v7_sl_<task>.jsonl.
 *
 * Invariants vs R28_V6:
 *   - tpMult uniform 0.55 (R28_V6 winner)
 *   - liveCaps {maxStopPct: 0.05, maxRiskFrac: 0.4} kept — engine clamps
 *     final effStop to liveCaps.maxStopPct, so stopMult>1.0 is mostly a no-op
 *     once base stopPct already saturates the cap. Worth measuring though,
 *     since some assets may have base stopPct < 0.05.
 *   - PTP triggerPct=0.012, closeFraction=0.7 (R28_V6 fix)
 */
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";

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

const PER_ASSET_MULTS = [0.7, 1.0, 1.4];
const UNIFORM_MULTS_BY_TASK: Record<string, number> = {
  "u_0.6": 0.6,
  "u_0.8": 0.8,
  "u_1.0": 1.0,
  "u_1.2": 1.2,
  "u_1.4": 1.4,
  "u_1.6": 1.6,
};

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

/**
 * Build a config with per-asset stopPct = base.stopPct × stopMultMap[symbol].
 * Default stopMult is 1.0. Engine still applies liveCaps.maxStopPct=0.05 as
 * the post-clamp ceiling, so stopMult ≥1.0 may be a no-op for assets whose
 * base stopPct already saturates 5%.
 *
 * tpMult uniform 0.55 (R28_V6 winner). PTP triggerPct=0.012 (R28_V6 fix).
 */
function makeCfg(stopMultMap: Record<string, number>): FtmoDaytrade24hConfig {
  const baseV4 = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4;
  const baseV6 = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
  return {
    ...baseV6,
    assets: baseV4.assets.map((a) => {
      const sym = a.sourceSymbol ?? a.symbol;
      const mult = stopMultMap[sym] ?? 1.0;
      const baseStop = a.stopPct ?? baseV6.stopPct ?? 0.05;
      const baseTp = a.tpPct ?? 0.05;
      return {
        ...a,
        stopPct: baseStop * mult,
        tpPct: baseTp * 0.55,
      };
    }),
    liveCaps: baseV6.liveCaps ?? { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    partialTakeProfit: baseV6.partialTakeProfit ?? {
      triggerPct: 0.012,
      closeFraction: 0.7,
    },
  };
}

interface VariantResult {
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

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * sorted.length)),
  );
  return sorted[idx]!;
}

function runVariant(
  variantName: string,
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  minBars: number,
): {
  passes: number;
  windows: number;
  rate: number;
  med: number;
  p90: number;
  durationSec: number;
} {
  const winBars = cfg.maxDays * 48;
  const stepBars = 14 * 48;
  const WARMUP = 5000;
  let passes = 0;
  let windows = 0;
  const passDays: number[] = [];
  const t0 = Date.now();
  for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
    windows++;
    const trimmed: Record<string, Candle[]> = {};
    for (const k of Object.keys(aligned))
      trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
    const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, variantName);
    if (r.passed) {
      passes++;
      if (r.passDay) passDays.push(r.passDay);
    }
    if (windows % 20 === 0) {
      console.log(
        `[shard ${process.argv[2]}] [progress ${variantName}] win=${windows} passes=${passes} t+${Math.round((Date.now() - t0) / 1000)}s`,
      );
    }
  }
  passDays.sort((a, b) => a - b);
  const med =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const p90 = quantile(passDays, 0.9);
  const rate = (passes / windows) * 100;
  return {
    passes,
    windows,
    rate,
    med,
    p90,
    durationSec: Math.round((Date.now() - t0) / 1000),
  };
}

const arg = process.argv[2] ?? "";
if (!arg) {
  console.error("Usage: shard <task>  (u_0.6|...|u_1.6 | 0..8 | combo:spec)");
  process.exit(1);
}

const outFile = `${CACHE_DIR}/r28v7_sl_${arg.replace(/[:,.]/g, "_")}.jsonl`;
writeFileSync(outFile, "");

const { aligned, minBars } = loadAligned();
console.log(`[shard ${arg}] setup: ${SYMBOLS.length} syms, ${minBars} bars`);

interface Task {
  variant: string;
  stopMultMap: Record<string, number>;
}

const tasks: Task[] = [];

if (arg.startsWith("u_")) {
  // Phase 1 — uniform
  const m = UNIFORM_MULTS_BY_TASK[arg];
  if (m === undefined) {
    console.error(`Unknown uniform task: ${arg}`);
    process.exit(1);
  }
  const map: Record<string, number> = {};
  for (const s of SYMBOLS) map[s] = m;
  tasks.push({ variant: `UNIFORM_stopMult=${m.toFixed(2)}`, stopMultMap: map });
} else if (arg.startsWith("combo:")) {
  // Phase 3 — combo from aggregator-supplied spec
  const spec = arg.slice("combo:".length);
  const map: Record<string, number> = {};
  for (const s of SYMBOLS) map[s] = 1.0;
  for (const part of spec.split(",")) {
    const [idxStr, multStr] = part.split(":");
    const idx = parseInt(idxStr ?? "", 10);
    const mult = parseFloat(multStr ?? "");
    if (
      Number.isNaN(idx) ||
      Number.isNaN(mult) ||
      idx < 0 ||
      idx >= SYMBOLS.length
    ) {
      console.error(`Bad combo part "${part}"`);
      process.exit(1);
    }
    map[SYMBOLS[idx]!] = mult;
  }
  tasks.push({ variant: `COMBO_${spec}`, stopMultMap: map });
} else {
  // Phase 2 — per-asset (asset idx 0..8, 3 mults each)
  const assetIdx = parseInt(arg, 10);
  if (Number.isNaN(assetIdx) || assetIdx < 0 || assetIdx >= SYMBOLS.length) {
    console.error(`Bad task: ${arg}`);
    process.exit(1);
  }
  const sym = SYMBOLS[assetIdx]!;
  for (const m of PER_ASSET_MULTS) {
    const map: Record<string, number> = {};
    for (const s of SYMBOLS) map[s] = 1.0;
    map[sym] = m;
    tasks.push({
      variant: `${sym}_stopMult=${m.toFixed(2)}_others=1.00`,
      stopMultMap: map,
    });
  }
}

for (const task of tasks) {
  const cfg = makeCfg(task.stopMultMap);
  const r = runVariant(task.variant, cfg, aligned, minBars);
  const result: VariantResult = {
    variant: task.variant,
    task: arg,
    stopMultMap: task.stopMultMap,
    ...r,
  };
  appendFileSync(outFile, JSON.stringify(result) + "\n");
  console.log(
    `[shard ${arg}] [done] ${task.variant}: ${r.passes}/${r.windows} = ${r.rate.toFixed(2)}% / med=${r.med}d / p90=${r.p90}d / ${r.durationSec}s`,
  );
}
console.log(`[shard ${arg}] DONE`);
