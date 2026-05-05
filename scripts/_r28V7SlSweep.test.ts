/**
 * R28_V7 Stop-Loss Multiplier Sweep — vitest single-process driver.
 *
 * Tests if per-asset stopPct (stopMult) variation improves R28_V6 from
 * 60.29% baseline (post-R56/R57/R58 V4 Live Engine).
 *
 * NOTE: For "all night" wall-clock execution prefer the sharded driver:
 *   bash scripts/_r28V7SlSweepRunAll.sh
 * which runs each task as a separate node process and aggregates via
 * `scripts/_r28V7SlSweepAggregate.ts`. This vitest file runs the same
 * variants single-threaded; it works but takes ~9-12h vs ~2-3h sharded
 * (sequential) on this codebase post-R56/R57/R58 speed regression.
 *
 * Phases:
 *   1. Uniform stopMult ∈ {0.6, 0.8, 1.0, 1.2, 1.4, 1.6}  (6 variants)
 *   2. Per-asset stopMult ∈ {0.7, 1.0, 1.4} (others=1.0)  (9 × 3 = 27)
 *   3. Combo: greedy combination of per-asset winners (1 variant if any)
 *
 * Win criteria:
 *   ≥63.29% (+3.0pp) → SHIP as R28_V7_SL_TUNED
 *   ≥62.29%          → marginal+, ship behind flag
 *   ≥61.29%          → marginal, document only
 *   <61.29%          → no winner, R28_V6 remains champion
 */
import { describe, it } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = "scripts/cache_bakeoff/r28v7_sl_sweep.log";
writeFileSync(LOG_FILE, `[${new Date().toISOString()}] start (vitest)\n`);
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

interface Result {
  name: string;
  passes: number;
  windows: number;
  rate: number;
  med: number;
  p90: number;
  stopMultMap: Record<string, number>;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * sorted.length)),
  );
  return sorted[idx]!;
}

function run(
  name: string,
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  minBars: number,
  stopMultMap: Record<string, number>,
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
    if (windows % 20 === 0) {
      plog(
        `[progress ${name}] win=${windows} passes=${passes} t+${Math.round((Date.now() - t0) / 1000)}s`,
      );
    }
  }
  passDays.sort((a, b) => a - b);
  const med =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const p90 = quantile(passDays, 0.9);
  const rate = (passes / windows) * 100;
  plog(
    `[done] ${name}: ${passes}/${windows} = ${rate.toFixed(2)}% / med=${med}d / p90=${p90}d / ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  return { name, passes, windows, rate, med, p90, stopMultMap };
}

const BASELINE = 60.29;

describe("R28_V7 SL-Mult Sweep", { timeout: 24 * 60 * 60_000 }, () => {
  it("runs Phase 1 + Phase 2 + Phase 3 combo", () => {
    const { aligned, minBars } = loadAligned();
    plog(`[setup] ${SYMBOLS.length} syms, ${minBars} bars`);
    plog(`[setup] baseline R28_V6 = ${BASELINE.toFixed(2)}%`);

    const results: Result[] = [];

    // PHASE 1 — uniform
    plog("\n=== Phase 1: uniform stopMult ===");
    for (const m of [0.6, 0.8, 1.0, 1.2, 1.4, 1.6]) {
      const map: Record<string, number> = {};
      for (const s of SYMBOLS) map[s] = m;
      results.push(
        run(
          `UNIFORM_stopMult=${m.toFixed(2)}`,
          makeCfg(map),
          aligned,
          minBars,
          map,
        ),
      );
    }

    // PHASE 2 — per-asset
    plog("\n=== Phase 2: per-asset stopMult (others=1.00) ===");
    for (const sym of SYMBOLS) {
      for (const m of [0.7, 1.0, 1.4]) {
        const map: Record<string, number> = {};
        for (const s of SYMBOLS) map[s] = 1.0;
        map[sym] = m;
        results.push(
          run(
            `${sym}_stopMult=${m.toFixed(2)}_others=1.00`,
            makeCfg(map),
            aligned,
            minBars,
            map,
          ),
        );
      }
    }

    // Find best per-asset multiplier
    const baselineP2 = results.find(
      (r) => r.name === "AAVEUSDT_stopMult=1.00_others=1.00",
    );
    const baselineRate = baselineP2?.rate ?? BASELINE;

    const perAssetBest: Record<string, { mult: number; rate: number }> = {};
    for (const sym of SYMBOLS) {
      const variants = results.filter((r) => r.name.startsWith(`${sym}_`));
      const sorted = [...variants].sort((a, b) => b.rate - a.rate);
      const best = sorted[0]!;
      perAssetBest[sym] = {
        mult: best.stopMultMap[sym] ?? 1.0,
        rate: best.rate,
      };
    }

    // PHASE 3 — combo of helpful per-asset picks
    const helpful: { sym: string; mult: number; delta: number }[] = [];
    for (const sym of SYMBOLS) {
      const b = perAssetBest[sym];
      if (!b || b.mult === 1.0) continue;
      const delta = b.rate - baselineRate;
      if (delta >= 0.5) helpful.push({ sym, mult: b.mult, delta });
    }
    helpful.sort((a, b) => b.delta - a.delta);

    if (helpful.length > 0) {
      plog(
        `\n=== Phase 3: combo of ${helpful.length} helpful per-asset picks ===`,
      );
      const map: Record<string, number> = {};
      for (const s of SYMBOLS) map[s] = 1.0;
      for (const p of helpful) map[p.sym] = p.mult;
      results.push(
        run(
          `COMBO_${helpful.map((p) => `${p.sym}=${p.mult}`).join("_")}`,
          makeCfg(map),
          aligned,
          minBars,
          map,
        ),
      );
    } else {
      plog("\nNo per-asset pick beats baseline by ≥0.5pp — skip Phase 3.");
    }

    // RANKING
    plog("\n=== R28_V7 SL-MULT RANKING ===");
    const sorted = [...results].sort((a, b) => b.rate - a.rate);
    for (const r of sorted) {
      const delta = r.rate - BASELINE;
      const sign = delta >= 0 ? "+" : "";
      plog(
        `${r.name.padEnd(50)} ${r.rate.toFixed(2).padStart(5)}%  med=${r.med}d  p90=${r.p90}d  (${sign}${delta.toFixed(2)}pp)`,
      );
    }
    const winner = sorted[0]!;
    plog(
      `\n>>> WINNER: ${winner.name} → ${winner.rate.toFixed(2)}% / ${winner.med}d`,
    );
    plog(
      `>>> vs R28_V6 baseline (${BASELINE.toFixed(2)}%): ${winner.rate - BASELINE >= 0 ? "+" : ""}${(winner.rate - BASELINE).toFixed(2)}pp`,
    );

    if (winner.rate >= 63.29) plog("VERDICT: SHIP as R28_V7_SL_TUNED (+3pp)");
    else if (winner.rate >= 62.29)
      plog("VERDICT: marginal+ — ship behind flag");
    else if (winner.rate >= 61.29) plog("VERDICT: marginal — document only");
    else if (winner.rate >= 60.29) plog("VERDICT: neutral — no improvement");
    else plog("VERDICT: regression — R28_V6 remains champion");
  });
});
