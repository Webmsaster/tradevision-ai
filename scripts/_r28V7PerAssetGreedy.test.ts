/**
 * R28_V7 Per-Asset TP-Multiplier Greedy Sweep (Round 53 follow-up).
 *
 * Goal: find per-asset tpMult optima that beat R28_V6's uniform-0.55 plateau
 * (60.29% on 5.55y / 136 windows). For each of the 9 R28_V6 assets vary its
 * tpMult across {0.45, 0.50, 0.55, 0.60, 0.65} keeping all other 8 assets
 * pinned at 0.55. After 9 × 5 = 45 single-asset variants identify the
 * per-asset optimum and combine them all into R28_V7_GREEDY.
 *
 * Win criteria:
 *   ≥ baseline + 2pp  → ship as R28_V7_GREEDY (new champion)
 *   baseline … +2pp   → marginal — document but don't ship
 *   < baseline        → no winner — R28_V6 remains champion
 *
 * Performance:
 *   Vitest single-thread budget = ~90 min for 45 variants × ~2min/variant.
 *   PREFERRED runner = sharded direct-tsx via:
 *     for i in 0 1 2 3 4 5 6 7 8; do
 *       node --import tsx scripts/_r28V7PerAssetGreedyShard.ts $i \
 *         > /tmp/r28v7_greedy_$i.log 2>&1 &
 *     done
 *     node --import tsx scripts/_r28V7PerAssetGreedyShard.ts baseline \
 *       > /tmp/r28v7_greedy_baseline.log 2>&1
 *     wait
 *     node --import tsx scripts/_r28V7PerAssetGreedyAggregate.ts
 *
 * This vitest harness exists for parity with the R28_V5 fine-grid sweep
 * pattern. For wall-clock <30 min, use the sharded runner instead.
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
const LOG_FILE = "scripts/cache_bakeoff/r28v7_perasset_greedy.log";
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

const MULTS = [0.45, 0.5, 0.55, 0.6, 0.65];

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
 * Build a config where `overrideSymbol` uses `overrideMult` and all others
 * use `defaultMult`. Starts from R28_V4's untouched per-asset tpPct values.
 */
function makePerAssetCfg(
  overrideSymbol: string | null,
  overrideMult: number,
  defaultMult: number,
): FtmoDaytrade24hConfig {
  const baseV4 = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4;
  const baseV6 = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
  return {
    ...baseV6,
    assets: baseV4.assets.map((a) => {
      const sym = a.sourceSymbol ?? a.symbol;
      const mult =
        overrideSymbol !== null && sym === overrideSymbol
          ? overrideMult
          : defaultMult;
      return { ...a, tpPct: (a.tpPct ?? 0.05) * mult };
    }),
    liveCaps: baseV6.liveCaps ?? { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    partialTakeProfit: baseV6.partialTakeProfit ?? {
      triggerPct: 0.012,
      closeFraction: 0.7,
    },
  };
}

/** Build greedy combo using each asset's individually-best tpMult. */
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

interface Result {
  name: string;
  asset: string | null;
  mult: number;
  passes: number;
  windows: number;
  rate: number;
  med: number;
  p90: number;
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
  asset: string | null,
  mult: number,
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
  const p90 = quantile(passDays, 0.9);
  const rate = (passes / windows) * 100;
  plog(
    `[done] ${name}: ${passes}/${windows} = ${rate.toFixed(2)}% / med=${med}d / p90=${p90}d / ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  return { name, asset, mult, passes, windows, rate, med, p90 };
}

describe(
  "R28_V7 Per-Asset Greedy TP-Mult Sweep",
  { timeout: 180 * 60_000 },
  () => {
    it("9 assets × 5 mults + greedy combo", () => {
      const { aligned, minBars } = loadAligned();
      plog(`[setup] ${SYMBOLS.length} syms, ${minBars} bars`);

      const results: Result[] = [];

      // Baseline (uniform 0.55 = R28_V6)
      results.push(
        run(
          "BASELINE_uniform_0.55",
          makePerAssetCfg(null, 0.55, 0.55),
          aligned,
          minBars,
          null,
          0.55,
        ),
      );

      // 9 × 5 single-asset variants
      for (const sym of SYMBOLS) {
        for (const m of MULTS) {
          results.push(
            run(
              `${sym}_tpMult=${m.toFixed(2)}`,
              makePerAssetCfg(sym, m, 0.55),
              aligned,
              minBars,
              sym,
              m,
            ),
          );
        }
      }

      // Ranking
      plog("\n=== R28_V7 PER-ASSET GREEDY SWEEP RANKING ===");
      const sorted = [...results].sort((a, b) => b.rate - a.rate);
      const baseline = results.find((r) => r.name === "BASELINE_uniform_0.55")!;
      plog(`baseline R28_V6 (uniform 0.55): ${baseline.rate.toFixed(2)}%`);
      plog("");
      plog("variant                          | pass% | med | p90 | Δ vs base");
      plog("---------------------------------+-------+-----+-----+----------");
      for (const r of sorted) {
        const delta = r.rate - baseline.rate;
        const sign = delta >= 0 ? "+" : "";
        plog(
          `${r.name.padEnd(32)} | ${r.rate.toFixed(2).padStart(5)} | ${String(r.med).padStart(3)} | ${String(r.p90).padStart(3)} | ${sign}${delta.toFixed(2)}pp`,
        );
      }

      // Per-asset optima
      const perAssetOpt: Record<string, number> = {};
      plog("\n=== PER-ASSET OPTIMA ===");
      for (const sym of SYMBOLS) {
        const variants = results.filter((r) => r.asset === sym);
        variants.sort((a, b) => {
          if (b.rate !== a.rate) return b.rate - a.rate;
          return Math.abs(a.mult - 0.55) - Math.abs(b.mult - 0.55);
        });
        const best = variants[0]!;
        perAssetOpt[sym] = best.mult;
        const delta = best.rate - baseline.rate;
        const sign = delta >= 0 ? "+" : "";
        plog(
          `  ${sym.padEnd(10)}  optimum tpMult=${best.mult.toFixed(2)}  →  ${best.rate.toFixed(2)}% (${sign}${delta.toFixed(2)}pp)`,
        );
      }

      // Greedy combo
      plog("\n=== R28_V7_GREEDY ===");
      plog(`map: ${JSON.stringify(perAssetOpt)}`);
      const allBaseline = SYMBOLS.every((s) => perAssetOpt[s] === 0.55);
      if (allBaseline) {
        plog("[note] all per-asset optima = 0.55 → greedy == baseline.");
      } else {
        const combo = run(
          "R28_V7_GREEDY",
          makeComboCfg(perAssetOpt),
          aligned,
          minBars,
          null,
          NaN,
        );
        const delta = combo.rate - baseline.rate;
        const sign = delta >= 0 ? "+" : "";
        plog(
          `\nDECISION: ${combo.rate.toFixed(2)}% vs baseline ${baseline.rate.toFixed(2)}% → ${sign}${delta.toFixed(2)}pp`,
        );
        if (combo.rate >= baseline.rate + 2.0)
          plog("SHIP — new champion R28_V7_GREEDY.");
        else if (combo.rate >= baseline.rate)
          plog("NO-SHIP (marginal) — improvement <+2pp.");
        else plog("NO-SHIP — below baseline. R28_V6 holds.");
      }
    });
  },
);
