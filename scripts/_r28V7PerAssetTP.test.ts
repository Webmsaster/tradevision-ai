/**
 * R28_V7 Per-Asset TP-Mult Combo Sweep (Round 53 follow-up).
 *
 * Round 53 R28_V5 fine-grid found uniform tpMult=0.55 = 60.29% (R28_V6).
 * Per-asset ablation (one asset varied, others fixed at 0.60) showed several
 * +0.74pp and +1.47pp single-asset combo candidates but no full per-asset
 * combination has been tested.
 *
 * Hypothesis: each asset has its own optimal tpMult; combining individual
 * optima could lift R28_V6's 60.29% by +0.5-2pp.
 *
 * Method (directed, 3-combo screen — runtime budget ~10 min on full 5.55y):
 *   C0: uniform 0.55 (R28_V6 baseline; sanity check vs prior log 60.29%)
 *   C1: BTC=0.50 + AAVE=0.50 + others=0.55  (probe tighter on R53 winners)
 *   C2: ALL assets 0.50 (extreme tighter — R52 sweep tested 0.50 uniform =
 *       58.09%; here we re-confirm under R28_V6's PTP=0.012 inheritance)
 *
 * Each variant runs on full 5.55y / 136 windows (matches R28_V5 fine-grid
 * for direct comparison). At ~120s/variant total runtime ~6-10min.
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
const LOG_FILE = "scripts/cache_bakeoff/r28v7_perasset.log";
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

/**
 * Per-asset tpMult map. Assets not in the map default to `defaultMult`.
 * Inherits R28_V6's PTP triggerPct=0.012 fix so PTP stays clearly below
 * tightened TPs (≥30% gap on every asset).
 */
function makeComboCfg(
  perAsset: Record<string, number>,
  defaultMult: number,
): FtmoDaytrade24hConfig {
  const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4;
  return {
    ...base,
    assets: base.assets.map((a) => {
      const sym = a.sourceSymbol ?? a.symbol;
      const mult = perAsset[sym] ?? defaultMult;
      return { ...a, tpPct: (a.tpPct ?? 0.05) * mult };
    }),
    liveCaps: base.liveCaps ?? { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    partialTakeProfit: { triggerPct: 0.012, closeFraction: 0.7 },
  };
}

interface Result {
  name: string;
  passes: number;
  windows: number;
  rate: number;
  med: number;
  tpMap: Record<string, number>;
}

function run(
  name: string,
  cfg: FtmoDaytrade24hConfig,
  tpMap: Record<string, number>,
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
    if (windows % 20 === 0) {
      plog(
        `[progress] ${name}: ${windows} windows, ${passes} passes (${((passes / windows) * 100).toFixed(1)}%)`,
      );
    }
  }
  passDays.sort((a, b) => a - b);
  const med =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const rate = (passes / windows) * 100;
  plog(
    `[done] ${name}: ${passes}/${windows} = ${rate.toFixed(2)}% / med=${med}d / ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  return { name, passes, windows, rate, med, tpMap };
}

describe("R28_V7 Per-Asset TP Combo Sweep", { timeout: 60 * 60_000 }, () => {
  it("tests 3 directed per-asset tpMult combinations", () => {
    const { aligned, minBars } = loadAligned();
    plog(`[setup] ${SYMBOLS.length} syms, ${minBars} bars`);

    const results: Result[] = [];

    // C0: R28_V6 baseline (uniform 0.55) — sanity check
    {
      const tp: Record<string, number> = {};
      for (const s of SYMBOLS) tp[s] = 0.55;
      results.push(
        run(
          "C0 baseline uniform=0.55",
          makeComboCfg(tp, 0.55),
          tp,
          aligned,
          minBars,
        ),
      );
    }

    // C1: BTC=0.50 + AAVE=0.50 + others=0.55
    {
      const tp: Record<string, number> = {};
      for (const s of SYMBOLS) tp[s] = 0.55;
      tp.BTCUSDT = 0.5;
      tp.AAVEUSDT = 0.5;
      results.push(
        run(
          "C1 BTC=AAVE=0.50 others=0.55",
          makeComboCfg(tp, 0.55),
          tp,
          aligned,
          minBars,
        ),
      );
    }

    // C2: All assets 0.50
    {
      const tp: Record<string, number> = {};
      for (const s of SYMBOLS) tp[s] = 0.5;
      results.push(
        run("C2 all=0.50", makeComboCfg(tp, 0.5), tp, aligned, minBars),
      );
    }

    plog("\n=== R28_V7 PER-ASSET TP COMBO RANKING ===");
    plog("variant                                | pass% | med | windows");
    plog("---------------------------------------+-------+-----+--------");
    const sorted = [...results].sort((a, b) => b.rate - a.rate);
    for (const r of sorted) {
      plog(
        `${r.name.padEnd(38)} | ${r.rate.toFixed(2).padStart(5)} | ${String(r.med).padStart(3)} | ${String(r.windows).padStart(7)}`,
      );
    }
    const winner = sorted[0]!;
    plog(
      `\n>>> BEST: ${winner.name} → ${winner.rate.toFixed(2)}% / ${winner.med}d`,
    );

    // Compare vs R28_V6 baseline (60.29% from prior log; here C0 should
    // re-confirm it). If best > C0 by ≥1pp → ship as R28_V7.
    const c0 = results.find((r) => r.name.startsWith("C0"))!;
    const delta = winner.rate - c0.rate;
    plog(
      `\n--- vs R28_V6 baseline C0 (${c0.rate.toFixed(2)}%) ---  Δ=${delta >= 0 ? "+" : ""}${delta.toFixed(2)}pp`,
    );

    if (delta >= 1.0 && winner.name !== c0.name) {
      plog("\n>>> WINNER beats baseline by ≥1pp — candidate for R28_V7");
      plog(`per-asset tpMult map: ${JSON.stringify(winner.tpMap)}`);
    } else {
      plog("\n>>> No improvement ≥1pp found. R28_V6 holds.");
    }
  });
});
