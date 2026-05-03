/**
 * R28_V5 Tighter TP-Mult Fine-Grid (Round 53 Priority 4).
 *
 * Round 52 found ×0.6 = 58.82% as the parabolic peak across {0.4, 0.5, 0.6,
 * 0.7, 0.8, 1.0}.  This sweep tightens the grid around 0.6 in 0.02 steps to
 * either confirm 0.6 is the exact optimum or find a marginal +0.5-1.0pp
 * improvement.
 *
 * Variants:
 *   tpMult ∈ {0.55, 0.57, 0.59, 0.60, 0.61, 0.63, 0.65}
 *
 * Plus per-asset tpMult-search: starting from uniform ×0.6, ablate each
 * asset to ±0.05 (keeping others at 0.6) to surface assets with locally
 * different optima — these can later be combined into a per-asset config.
 */
import { describe, it } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = "scripts/cache_bakeoff/r28v5_tp_finegrid.log";
writeFileSync(LOG_FILE, `[${new Date().toISOString()}] start\n`);
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

/** Uniform tpMult applied to every asset's tpPct. */
function makeUniformCfg(tpMult: number): FtmoDaytrade24hConfig {
  const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4;
  return {
    ...base,
    assets: base.assets.map((a) => ({
      ...a,
      tpPct: (a.tpPct ?? 0.05) * tpMult,
    })),
    liveCaps: base.liveCaps ?? { maxStopPct: 0.05, maxRiskFrac: 0.4 },
  };
}

/** Per-asset override on top of the ×0.6 baseline. */
function makePerAssetCfg(
  overrideSymbol: string,
  overrideMult: number,
): FtmoDaytrade24hConfig {
  const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4;
  return {
    ...base,
    assets: base.assets.map((a) => {
      const sym = a.sourceSymbol ?? a.symbol;
      const mult = sym === overrideSymbol ? overrideMult : 0.6;
      return { ...a, tpPct: (a.tpPct ?? 0.05) * mult };
    }),
    liveCaps: base.liveCaps ?? { maxStopPct: 0.05, maxRiskFrac: 0.4 },
  };
}

interface Result {
  name: string;
  passes: number;
  windows: number;
  rate: number;
  med: number;
}

function run(
  name: string,
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  minBars: number,
): Result {
  const winBars = cfg.maxDays * 48;
  const stepBars = 14 * 48;
  const WARMUP = 5000;
  let passes = 0,
    windows = 0;
  const passDays: number[] = [];
  const t0 = Date.now();
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
  const rate = (passes / windows) * 100;
  plog(
    `[done] ${name}: ${passes}/${windows} = ${rate.toFixed(2)}% / med=${med}d / ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  return { name, passes, windows, rate, med };
}

describe("R28_V5 TP Fine-Grid", { timeout: 180 * 60_000 }, () => {
  it("sweeps tpMult in 0.02-step grid + per-asset ablation", () => {
    const { aligned, minBars } = loadAligned();
    plog(`[setup] ${SYMBOLS.length} syms, ${minBars} bars`);

    const results: Result[] = [];

    // 1. Uniform fine-grid around 0.6
    plog("\n=== Phase 1: uniform tpMult fine-grid ===");
    for (const m of [0.55, 0.57, 0.59, 0.6, 0.61, 0.63, 0.65]) {
      results.push(
        run(
          `uniform tpMult=${m.toFixed(2)}`,
          makeUniformCfg(m),
          aligned,
          minBars,
        ),
      );
    }

    // 2. Per-asset ablation: each asset to {0.55, 0.65} keeping others at 0.6
    plog("\n=== Phase 2: per-asset ablation around uniform 0.6 ===");
    for (const sym of SYMBOLS) {
      for (const m of [0.55, 0.65]) {
        results.push(
          run(
            `${sym} tpMult=${m.toFixed(2)} (others=0.60)`,
            makePerAssetCfg(sym, m),
            aligned,
            minBars,
          ),
        );
      }
    }

    plog("\n=== R28_V5 TP FINE-GRID RANKING ===");
    plog("variant                                    | pass% | med | windows");
    plog("-------------------------------------------+-------+-----+--------");
    const sorted = [...results].sort((a, b) => b.rate - a.rate);
    for (const r of sorted) {
      plog(
        `${r.name.padEnd(42)} | ${r.rate.toFixed(2).padStart(5)} | ${String(r.med).padStart(3)} | ${String(r.windows).padStart(7)}`,
      );
    }
    const winner = sorted[0]!;
    plog(
      `\n>>> BEST: ${winner.name} → ${winner.rate.toFixed(2)}% / ${winner.med}d`,
    );

    // 3. Combine winners: if any per-asset variant beats uniform 0.6 by >0.3pp,
    //    flag for follow-up combo run.
    const baseline = results.find((r) => r.name === "uniform tpMult=0.60")!;
    plog(`\n--- vs uniform 0.60 baseline (${baseline.rate.toFixed(2)}%) ---`);
    for (const r of sorted) {
      const delta = r.rate - baseline.rate;
      if (delta >= 0.3 && r.name !== baseline.name) {
        plog(`  +${delta.toFixed(2)}pp  ${r.name}  (combo candidate)`);
      }
    }
  });
});
