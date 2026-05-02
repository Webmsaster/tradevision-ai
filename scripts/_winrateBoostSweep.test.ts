/**
 * Winrate-Boost Sweep — test 8 R28_V4 variants on V4 Live Engine.
 *
 *   1. base                    — R28_V4 unchanged (control)
 *   2. +htfTrendFilter         — V12 setting (lookback 24, threshold 0.02)
 *   3. +lossStreakCooldown     — V261 setting (after 2 losses, 72-bar CD)
 *   4. +htf+lsc                — both grafts combined
 *   5. +regime-aggressive      — skip windows starting in trend-down or high-vol
 *   6. +tightTP                — per-asset tpPct halved (3-3.5% instead of 4-7%)
 *   7. +multiStagePTP          — partialTakeProfitLevels [0.015@30%, 0.03@40%, 0.05@30%]
 *   8. +chandelierMult1.5      — tighter trail (mult 2 → 1.5)
 *   9. assetPrune-WORST        — drop the lowest-WR asset (data-driven)
 *
 * Plus per-asset breakdown for prune candidate identification.
 */
import { describe, it } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = "scripts/cache_bakeoff/winrate_boost.log";
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
    const path = `${CACHE_DIR}/${s}_30m.json`;
    if (!existsSync(path)) throw new Error(`missing cache ${path}`);
    data[s] = JSON.parse(readFileSync(path, "utf-8")) as Candle[];
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

type Regime = "trend-up" | "trend-down" | "chop" | "high-vol" | "calm";
function classifyAt(candles: Candle[], startBarIdx: number): Regime {
  const lookback = 7 * 48;
  const from = Math.max(0, startBarIdx - lookback);
  const slice = candles.slice(from, startBarIdx);
  if (slice.length < 100) return "chop";
  const trend =
    (slice[slice.length - 1]!.close - slice[0]!.close) / slice[0]!.close;
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1]!.close > 0)
      rets.push(Math.log(slice[i]!.close / slice[i - 1]!.close));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length);
  const annualVol = Math.sqrt(variance) * Math.sqrt(48 * 365);
  if (annualVol >= 0.6) return "high-vol";
  if (Math.abs(trend) <= 0.02 && annualVol < 0.15) return "calm";
  if (trend > 0.05) return "trend-up";
  if (trend < -0.05) return "trend-down";
  return "chop";
}

interface VariantResult {
  name: string;
  passes: number;
  windows: number;
  rate: number;
  median: number;
  perAsset: Record<string, { trades: number; wins: number }>;
}

function runVariant(
  name: string,
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  minBars: number,
  regimeBlockList: Set<Regime> = new Set(),
): VariantResult {
  const winBars = cfg.maxDays * 48;
  const stepBars = 14 * 48;
  const WARMUP = 5000;
  let passes = 0;
  let windows = 0;
  const passDays: number[] = [];
  const perAsset: Record<string, { trades: number; wins: number }> = {};
  const tStart = Date.now();
  const btc = aligned.BTCUSDT!;
  for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
    if (regimeBlockList.size > 0) {
      const reg = classifyAt(btc, start);
      if (regimeBlockList.has(reg)) continue;
    }
    windows++;
    const trimStart = start - WARMUP;
    const trimEnd = start + winBars;
    const trimmed: Record<string, Candle[]> = {};
    for (const k of Object.keys(aligned))
      trimmed[k] = aligned[k]!.slice(trimStart, trimEnd);
    try {
      const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, name);
      if (r.passed) {
        passes++;
        if (r.passDay) passDays.push(r.passDay);
      }
      for (const t of r.trades ?? []) {
        const sym = t.sourceSymbol ?? t.symbol;
        perAsset[sym] ??= { trades: 0, wins: 0 };
        perAsset[sym]!.trades++;
        if ((t.pnlPct ?? 0) > 0) perAsset[sym]!.wins++;
      }
    } catch (e) {
      plog(`[err] ${name} @${start}: ${(e as Error).message}`);
    }
  }
  passDays.sort((a, b) => a - b);
  const median =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const rate = windows > 0 ? (passes / windows) * 100 : 0;
  plog(
    `[done] ${name}: ${passes}/${windows} = ${rate.toFixed(2)}% / med=${median}d / sim=${Math.round((Date.now() - tStart) / 1000)}s`,
  );
  return { name, passes, windows, rate, median, perAsset };
}

describe("Winrate Boost Sweep", { timeout: 90 * 60_000 }, () => {
  it("compares 9 R28_V4 variants on V4 Live Engine", () => {
    const { aligned, minBars } = loadAligned();
    plog(
      `[setup] ${SYMBOLS.length} syms, ${minBars} bars (${(minBars / 48 / 365).toFixed(2)}y)`,
    );

    const baseCfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
      liveCaps:
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4.liveCaps ?? {
          maxStopPct: 0.05,
          maxRiskFrac: 0.4,
        },
    };

    const htfCfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      htfTrendFilter: { lookbackBars: 24, apply: "both", threshold: 0.02 },
    };
    const lscCfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      lossStreakCooldown: { afterLosses: 2, cooldownBars: 72 },
    };
    const bothCfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      htfTrendFilter: { lookbackBars: 24, apply: "both", threshold: 0.02 },
      lossStreakCooldown: { afterLosses: 2, cooldownBars: 72 },
    };
    // Tight TP — halve all per-asset tpPct (4-7% → 2-3.5%)
    const tightTpCfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      assets: baseCfg.assets.map((a) => ({
        ...a,
        tpPct: (a.tpPct ?? 0.05) * 0.5,
      })),
    };
    // Multi-stage partial-TP
    const multiPtpCfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      partialTakeProfit: undefined,
      partialTakeProfitLevels: [
        { triggerPct: 0.015, closeFraction: 0.3 },
        { triggerPct: 0.03, closeFraction: 0.4 },
        { triggerPct: 0.05, closeFraction: 0.3 },
      ],
    };
    const chand15Cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      chandelierExit: baseCfg.chandelierExit
        ? { ...baseCfg.chandelierExit, mult: 1.5 }
        : { period: 56, mult: 1.5, minMoveR: 0.5 },
    };

    // Sequence: base first to know per-asset WR; later variants can skip
    const variants: {
      name: string;
      cfg: FtmoDaytrade24hConfig;
      regimeBlock?: Set<Regime>;
    }[] = [
      { name: "1. base", cfg: baseCfg },
      { name: "2. +htfTrendFilter", cfg: htfCfg },
      { name: "3. +lossStreakCooldown", cfg: lscCfg },
      { name: "4. +htf+lsc", cfg: bothCfg },
      {
        name: "5. +regime-aggressive",
        cfg: baseCfg,
        regimeBlock: new Set<Regime>(["trend-down", "high-vol"]),
      },
      { name: "6. +tightTP (×0.5)", cfg: tightTpCfg },
      { name: "7. +multiStagePTP", cfg: multiPtpCfg },
      { name: "8. +chandelierMult1.5", cfg: chand15Cfg },
    ];

    const results: VariantResult[] = [];
    for (const v of variants) {
      results.push(runVariant(v.name, v.cfg, aligned, minBars, v.regimeBlock));
    }

    // Asset-prune variant — drop the lowest-WR asset (≥30 trades for stat)
    const baseAsset = results[0]!.perAsset;
    const sortedAssets = Object.entries(baseAsset)
      .filter(([_, v]) => v.trades >= 30)
      .sort((a, b) => {
        const wr1 = a[1].wins / a[1].trades;
        const wr2 = b[1].wins / b[1].trades;
        return wr1 - wr2;
      });
    if (sortedAssets.length > 0) {
      const dropSym = sortedAssets[0]![0];
      plog(
        `\n[prune] Dropping ${dropSym} (lowest WR ${((sortedAssets[0]![1].wins / sortedAssets[0]![1].trades) * 100).toFixed(2)}%)`,
      );
      const prunedCfg: FtmoDaytrade24hConfig = {
        ...baseCfg,
        assets: baseCfg.assets.filter(
          (a) => (a.sourceSymbol ?? a.symbol) !== dropSym,
        ),
      };
      results.push(
        runVariant(
          `9. assetPrune (drop ${dropSym})`,
          prunedCfg,
          aligned,
          minBars,
        ),
      );
    }

    // Final ranking
    plog("\n=== WINRATE BOOST SWEEP — RANKING ===");
    plog("variant                       | pass% | med | windows | Δ vs base");
    plog("------------------------------+-------+-----+---------+----------");
    const base = results[0]!.rate;
    const sortedResults = [...results].sort((a, b) => b.rate - a.rate);
    for (const r of sortedResults) {
      const delta = r.rate - base;
      plog(
        `${r.name.padEnd(29)} | ${r.rate.toFixed(2).padStart(5)} | ${String(r.median).padStart(3)} | ${String(r.windows).padStart(7)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}pp`,
      );
    }

    // Per-asset breakdown
    plog("\n=== PER-ASSET BREAKDOWN (R28_V4 base) ===");
    plog("asset      | trades | wins | wr%");
    plog("-----------+--------+------+------");
    const sortedByWr = Object.entries(baseAsset).sort((a, b) => {
      const wr1 = a[1].trades > 0 ? a[1].wins / a[1].trades : 0;
      const wr2 = b[1].trades > 0 ? b[1].wins / b[1].trades : 0;
      return wr2 - wr1;
    });
    for (const [s, v] of sortedByWr) {
      const wr = v.trades > 0 ? (v.wins / v.trades) * 100 : 0;
      plog(
        `${s.padEnd(10)} | ${String(v.trades).padStart(6)} | ${String(v.wins).padStart(4)} | ${wr.toFixed(2).padStart(5)}`,
      );
    }

    const winner = sortedResults[0]!;
    plog(
      `\n>>> BEST: ${winner.name} → ${winner.rate.toFixed(2)}% (Δ ${(winner.rate - base).toFixed(2)}pp vs base)`,
    );
  });
});
