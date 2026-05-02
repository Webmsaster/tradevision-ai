/**
 * V5 + MR Ensemble — multi-stage backtest.
 *
 * Stage 1: Baseline reference V5 alone on the full 9-asset 2h universe.
 * Stage 2: Tune MR-2H alone (stopPct × tpPct × holdBars × riskFrac sweep)
 *          to find the best stand-alone MR variant.
 * Stage 3: Build ensemble = V5 trend assets ∪ best MR assets on a unified
 *          engine + equity pool (Option C from task description). Test a
 *          handful of maxConcurrentTrades / risk-scaling permutations.
 * Stage 4: Print live-mapping snippet if ensemble ≥ 50% pass-rate.
 *
 * Hypothesis: V5 trend fires only in trending markets; MR fires only in
 * sideway markets → minimal overlap → combined > single.
 *
 * Run:
 *   node ./node_modules/vitest/vitest.mjs run --config vitest.scripts.config.ts \
 *     scripts/ftmoV5MrEnsemble.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_MR_2H,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ENSEMBLE,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const ASSETS_USDT = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "LINKUSDT",
];

const LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
const CHALLENGE_DAYS = 30;
const TF_HOURS = 2;
const STEP_DAYS = 3;

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
) {
  const barsPerDay = 24 / TF_HOURS;
  const winBars = Math.round(CHALLENGE_DAYS * barsPerDay);
  const stepBars = Math.round(STEP_DAYS * barsPerDay);
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, cfg));
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  const tlBreaches = out.filter((r) => r.reason === "total_loss").length;
  const dlBreaches = out.filter((r) => r.reason === "daily_loss").length;
  const tradeCounts: number[] = [];
  for (const r of out) {
    tradeCounts.push(r.trades.length);
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  }
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  const totalTrades = tradeCounts.reduce((a, b) => a + b, 0);
  const avgTrades = totalTrades / Math.max(1, out.length);
  return {
    windows: out.length,
    passes,
    passRate: passes / Math.max(1, out.length),
    medianDays: pick(0.5),
    p25Days: pick(0.25),
    p75Days: pick(0.75),
    p90Days: pick(0.9),
    tlBreaches,
    dlBreaches,
    totalTrades,
    avgTrades,
  };
}

function fmt(label: string, r: ReturnType<typeof runWalkForward>) {
  return (
    `${label.padEnd(38)} ${r.passes.toString().padStart(3)}/${String(r.windows).padStart(3)} = ` +
    `${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  ` +
    `TL=${r.tlBreaches} DL=${r.dlBreaches}  trades=${r.totalTrades} (avg ${r.avgTrades.toFixed(1)}/win)`
  );
}

/**
 * Build a MR config with overridden stop/tp/hold/risk applied to all assets
 * AND root-level (so engine defaults match too).
 */
function buildMrCfg(
  base: FtmoDaytrade24hConfig,
  stopPct: number,
  tpPct: number,
  holdBars: number,
  riskFrac: number,
): FtmoDaytrade24hConfig {
  return {
    ...base,
    stopPct,
    tpPct,
    holdBars,
    liveCaps: LIVE_CAPS,
    assets: base.assets.map((a) => ({
      ...a,
      stopPct,
      tpPct,
      holdBars,
      riskFrac,
    })),
  };
}

describe("V5 + MR Ensemble (2h)", { timeout: 24 * 3600_000 }, () => {
  it("Stage 1+2+3: baseline V5 → tune MR → ensemble", async () => {
    // ----- Load 2h history for all 9 USDT pairs -----
    console.log("\n=== Loading 2h history for 9 cryptos ===");
    const byAsset: Record<string, Candle[]> = {};
    for (const s of ASSETS_USDT) {
      byAsset[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
      console.log(`  ${s}: ${byAsset[s].length} bars`);
    }
    const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
    const yrs = (aligned / 12 / 365).toFixed(2);
    console.log(`Aligned: ${aligned} bars (${yrs}y, 2h-bar)`);
    // Truncate all assets to common tail
    for (const s of ASSETS_USDT) byAsset[s] = byAsset[s].slice(-aligned);

    // ----- Stage 1: V5 baseline reference -----
    console.log("\n=== Stage 1: V5 alone (reference) ===");
    const v5Cfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      liveCaps: LIVE_CAPS,
    };
    const v5Result = runWalkForward(byAsset, v5Cfg);
    console.log(fmt("V5 (live-caps)", v5Result));

    // ----- Stage 2: MR sweep -----
    console.log("\n=== Stage 2: MR-2H stand-alone sweep ===");
    const stops = [0.015, 0.02, 0.025, 0.03];
    const tps = [0.01, 0.015, 0.02, 0.025];
    const holds = [12, 24, 36, 48];
    const risks = [0.3, 0.5, 0.8, 1.0];
    type MrRow = {
      stopPct: number;
      tpPct: number;
      holdBars: number;
      riskFrac: number;
      r: ReturnType<typeof runWalkForward>;
    };
    const mrRows: MrRow[] = [];
    let totalCombos = stops.length * tps.length * holds.length * risks.length;
    let done = 0;
    console.log(`Total combos: ${totalCombos}`);
    for (const stopPct of stops) {
      for (const tpPct of tps) {
        for (const holdBars of holds) {
          for (const riskFrac of risks) {
            done++;
            const cfg = buildMrCfg(
              FTMO_DAYTRADE_24H_CONFIG_MR_2H,
              stopPct,
              tpPct,
              holdBars,
              riskFrac,
            );
            const r = runWalkForward(byAsset, cfg);
            mrRows.push({ stopPct, tpPct, holdBars, riskFrac, r });
            if (done % 16 === 0 || done === totalCombos) {
              console.log(
                `  [${done}/${totalCombos}] sp=${stopPct} tp=${tpPct} hb=${holdBars} rf=${riskFrac} → ${(r.passRate * 100).toFixed(2)}% TL=${r.tlBreaches} trades=${r.totalTrades}`,
              );
            }
          }
        }
      }
    }
    // Top-15 MR variants by passRate
    mrRows.sort((a, b) => b.r.passRate - a.r.passRate);
    console.log("\n  Top 15 MR variants by pass-rate:");
    for (const row of mrRows.slice(0, 15)) {
      console.log(
        fmt(
          `MR sp=${row.stopPct} tp=${row.tpPct} hb=${row.holdBars} rf=${row.riskFrac}`,
          row.r,
        ),
      );
    }
    const bestMrAlone = mrRows[0];
    console.log(
      `\nBest MR alone: sp=${bestMrAlone.stopPct} tp=${bestMrAlone.tpPct} hb=${bestMrAlone.holdBars} rf=${bestMrAlone.riskFrac} → ${(bestMrAlone.r.passRate * 100).toFixed(2)}% pass`,
    );

    // ----- Stage 3: Ensemble V5 + best MR on a single engine -----
    console.log("\n=== Stage 3: Ensemble V5 + MR ===");

    // Helper: build ensemble with given MR overrides + maxConcurrent
    function buildEnsemble(
      mrSp: number,
      mrTp: number,
      mrHb: number,
      mrRf: number,
      maxConc: number,
      v5RfScale = 1.0,
    ): FtmoDaytrade24hConfig {
      const v5Assets: Daytrade24hAssetCfg[] =
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => ({
          ...a,
          riskFrac: (a.riskFrac ?? 1.0) * v5RfScale,
        }));
      const mrAssets: Daytrade24hAssetCfg[] =
        FTMO_DAYTRADE_24H_CONFIG_MR_2H.assets.map((a) => ({
          ...a,
          stopPct: mrSp,
          tpPct: mrTp,
          holdBars: mrHb,
          riskFrac: mrRf,
        }));
      return {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        maxConcurrentTrades: maxConc,
        liveCaps: LIVE_CAPS,
        assets: [...v5Assets, ...mrAssets],
      };
    }

    // Test top-3 MR settings × multiple ensemble shapes
    const top3 = mrRows.slice(0, 3);
    const ensembleRows: Array<{
      label: string;
      cfg: FtmoDaytrade24hConfig;
      r: ReturnType<typeof runWalkForward>;
    }> = [];
    const ensembleVariants: Array<{
      maxConc: number;
      v5RfScale: number;
      label: string;
    }> = [
      { maxConc: 12, v5RfScale: 1.0, label: "ens12_v5x1.0" },
      { maxConc: 12, v5RfScale: 0.7, label: "ens12_v5x0.7" },
      { maxConc: 12, v5RfScale: 0.5, label: "ens12_v5x0.5" },
      { maxConc: 18, v5RfScale: 1.0, label: "ens18_v5x1.0" },
      { maxConc: 9, v5RfScale: 1.0, label: "ens9_v5x1.0" },
    ];
    for (const top of top3) {
      for (const v of ensembleVariants) {
        const cfg = buildEnsemble(
          top.stopPct,
          top.tpPct,
          top.holdBars,
          top.riskFrac,
          v.maxConc,
          v.v5RfScale,
        );
        const r = runWalkForward(byAsset, cfg);
        const label = `${v.label} mr(sp${top.stopPct}/tp${top.tpPct}/hb${top.holdBars}/rf${top.riskFrac})`;
        ensembleRows.push({ label, cfg, r });
        console.log(fmt(label, r));
      }
    }
    ensembleRows.sort((a, b) => b.r.passRate - a.r.passRate);
    const bestEnsemble = ensembleRows[0];

    // ----- Stage 4: Summary + recommendation -----
    console.log("\n=== Stage 4: Summary ===");
    console.log(fmt("V5 (baseline)", v5Result));
    console.log(fmt("Best MR alone", bestMrAlone.r));
    console.log(fmt(`Best Ensemble: ${bestEnsemble.label}`, bestEnsemble.r));

    const v5Pp = v5Result.passRate * 100;
    const ensPp = bestEnsemble.r.passRate * 100;
    const delta = ensPp - v5Pp;
    console.log(
      `\nΔ Ensemble vs V5: ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}pp`,
    );
    const target = 50;
    console.log(
      `\nDeploy recommendation: ${ensPp >= target && delta > 1 ? "YES" : "NO"} ` +
        `(ensemble ${ensPp.toFixed(2)}% vs target ${target}%, Δ vs V5 ${delta.toFixed(2)}pp)`,
    );

    // ----- Stage 5: Live mapping snippet -----
    if (ensPp >= target && delta > 1) {
      console.log(`\n--- Live Mapping Snippet ---`);
      console.log(`// In src/utils/ftmoLiveSignalV231.ts:`);
      console.log(`//`);
      console.log(
        `//   import { FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ENSEMBLE } from "./ftmoDaytrade24h";`,
      );
      console.log(
        `//   const USE_2H_TREND_V5_ENSEMBLE = process.env.FTMO_TF === "2h-trend-v5-ensemble";`,
      );
      console.log(
        `//   ... USE_2H_TREND_V5_ENSEMBLE ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ENSEMBLE : ...`,
      );
      console.log(`//`);
      console.log(`// Best ensemble settings:`);
      console.log(
        `//   maxConcurrentTrades = ${bestEnsemble.cfg.maxConcurrentTrades}`,
      );
      console.log(
        `//   MR override: stop=${bestEnsemble.cfg.assets.find((a) => a.symbol.endsWith("-MR2"))?.stopPct ?? "n/a"} tp=${bestEnsemble.cfg.assets.find((a) => a.symbol.endsWith("-MR2"))?.tpPct} hb=${bestEnsemble.cfg.assets.find((a) => a.symbol.endsWith("-MR2"))?.holdBars} rf=${bestEnsemble.cfg.assets.find((a) => a.symbol.endsWith("-MR2"))?.riskFrac}`,
      );
    }

    // Sanity assertions
    expect(v5Result.windows).toBeGreaterThan(50);
    expect(mrRows.length).toBe(totalCombos);
  });
});
