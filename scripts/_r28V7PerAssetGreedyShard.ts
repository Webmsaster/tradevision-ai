/**
 * Per-asset TP-multiplier greedy sweep — shard runner (Round 53 follow-up).
 *
 * Each shard runs 5 variants for ONE asset (assetIdx ∈ 0..8): varies that
 * asset's tpMult across {0.45, 0.50, 0.55, 0.60, 0.65} keeping all others
 * at 0.55 (= R28_V6 baseline).
 *
 * Args:
 *   process.argv[2] = assetIdx  (0-based index into SYMBOLS, or "baseline")
 *
 * Outputs JSON-line per variant to scripts/cache_bakeoff/r28v7_greedy_<idx>.jsonl.
 *
 * The aggregator (`_r28V7PerAssetGreedyAggregate.ts`) finds the per-asset
 * optimum, builds the greedy combo, and runs it as a final step.
 *
 * Performance budget: ~10 min per shard (5 variants × ~120s). 9 shards in
 * parallel ≈ 10-15 min wall-clock on 16-core box.
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

// Reduced from {0.45, 0.50, 0.55, 0.60, 0.65} to a single 0.50 probe per
// asset to fit the 90-min time budget under heavy CPU contention from a
// concurrent Claude session running its own vitest jobs. R28_V5 fine-grid
// (2026-05-02) already mapped the parabolic shape: 0.55 (=R28_V6 baseline)
// is the global plateau optimum on UNIFORM, but per-asset probes at 0.65
// (others=0.60) all UNDER-performed 60.29% by 0-1.47pp. So per-asset 0.50
// (= TIGHTER side of the plateau) is the only direction with a realistic
// chance of beating baseline.
const MULTS = [0.5];

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
 * Build a config where `overrideSymbol` uses `overrideMult` and all other
 * assets use `defaultMult` (= R28_V6 uniform 0.55).
 *
 * R28_V6's PTP tweak (triggerPct=0.012) is preserved via spread on the base
 * config so the gap to tightened TPs stays >=30%.
 */
function makePerAssetCfg(
  overrideSymbol: string | null,
  overrideMult: number,
  defaultMult: number,
): FtmoDaytrade24hConfig {
  // R28_V6 already applies ×0.55 to assets — we start from R28_V4 to get the
  // unmultiplied base tpPct values, then apply the per-asset map.
  const baseV4 = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4;
  const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
  return {
    ...base,
    assets: baseV4.assets.map((a) => {
      const sym = a.sourceSymbol ?? a.symbol;
      const mult =
        overrideSymbol !== null && sym === overrideSymbol
          ? overrideMult
          : defaultMult;
      return { ...a, tpPct: (a.tpPct ?? 0.05) * mult };
    }),
    liveCaps: base.liveCaps ?? { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    partialTakeProfit: base.partialTakeProfit ?? {
      triggerPct: 0.012,
      closeFraction: 0.7,
    },
  };
}

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

const arg = process.argv[2] ?? "0";
const isBaseline = arg === "baseline";
const assetIdx = isBaseline ? -1 : parseInt(arg, 10);
const outFile = `${CACHE_DIR}/r28v7_greedy_${arg}.jsonl`;
writeFileSync(outFile, "");

const { aligned, minBars } = loadAligned();
console.log(`[shard ${arg}] setup: ${SYMBOLS.length} syms, ${minBars} bars`);

const tasks: { variant: string; asset: string | null; mult: number }[] = [];
if (isBaseline) {
  // Single baseline run: uniform 0.55
  tasks.push({ variant: "BASELINE_uniform_0.55", asset: null, mult: 0.55 });
} else {
  const sym = SYMBOLS[assetIdx]!;
  for (const m of MULTS) {
    tasks.push({
      variant: `${sym}_tpMult=${m.toFixed(2)}`,
      asset: sym,
      mult: m,
    });
  }
}

for (const task of tasks) {
  const cfg = makePerAssetCfg(task.asset, task.mult, 0.55);
  const r = runVariant(task.variant, cfg, aligned, minBars);
  const result: VariantResult = {
    variant: task.variant,
    asset: task.asset,
    mult: task.mult,
    ...r,
  };
  appendFileSync(outFile, JSON.stringify(result) + "\n");
  console.log(
    `[shard ${arg}] [done] ${task.variant}: ${r.passes}/${r.windows} = ${r.rate.toFixed(2)}% / med=${r.med}d / p90=${r.p90}d / ${r.durationSec}s`,
  );
}
console.log(`[shard ${arg}] DONE`);
