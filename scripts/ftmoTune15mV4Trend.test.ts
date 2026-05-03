/**
 * V4: Trend-Following + BULL-mode integration on 15m.
 *
 * Adds long-momentum assets to existing MR-short stack:
 *   - ETH-LONG: 2 consecutive green closes → LONG (continuation)
 *   - BTC-LONG / SOL-LONG / BNB-LONG / ADA-LONG: same logic
 *   - All with invertDirection=true (flips signal interpretation)
 *   - All with disableShort=true (long-only)
 *   - Gated by minEquityGain to avoid early aggression
 *
 * Hypothesis: longs in uptrend phases offset short losses in 2023-style
 * markets, lifting overall pass-rate beyond MR-only ceiling.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

const LONG_BASE_TRIGGER = 2; // 2 consecutive greens for momentum entry
const ASSETS_FOR_LONGS = [
  { sym: "ETH-LONG", source: "ETHUSDT" },
  { sym: "BTC-LONG", source: "BTCUSDT" },
  { sym: "SOL-LONG", source: "SOLUSDT" },
  { sym: "BNB-LONG", source: "BNBUSDT" },
  { sym: "ADA-LONG", source: "ADAUSDT" },
];

function makeLong(asset: { sym: string; source: string }): Daytrade24hAssetCfg {
  return {
    symbol: asset.sym,
    sourceSymbol: asset.source,
    costBp: 35,
    slippageBp: 10,
    swapBpPerDay: 5,
    riskFrac: 1.0,
    triggerBars: LONG_BASE_TRIGGER,
    invertDirection: true, // 2 greens → LONG (momentum, not MR)
    disableShort: true,
    disableLong: false,
    minEquityGain: 0.005, // small profit cushion before going long
  };
}

describe("15m V4 Trend-Following + BULL mode", { timeout: 1800_000 }, () => {
  it("adds long-momentum assets and sweeps params", async () => {
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "15m",
      targetCount: 250000,
      maxPages: 250,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount: 250000,
      maxPages: 250,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "15m",
      targetCount: 250000,
      maxPages: 250,
    });
    const bnb = await loadBinanceHistory({
      symbol: "BNBUSDT",
      timeframe: "15m",
      targetCount: 250000,
      maxPages: 250,
    });
    const ada = await loadBinanceHistory({
      symbol: "ADAUSDT",
      timeframe: "15m",
      targetCount: 250000,
      maxPages: 250,
    });
    const n = Math.min(
      eth.length,
      btc.length,
      sol.length,
      bnb.length,
      ada.length,
    );
    const data: Record<string, Candle[]> = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
      BNBUSDT: bnb.slice(-n),
      ADAUSDT: ada.slice(-n),
    };
    console.log(
      `\n=== 15m V4 Trend-Following — ${(n / 96 / 365).toFixed(2)}y / ${n} bars ===`,
    );

    // Baseline: re-tuned V2 config (after engine fix)
    let cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
      // Apply latest re-tuned V2 winner from honest-caps sweep
      allowedHoursUtc: [0, 2, 5, 12, 13, 14, 19],
      chandelierExit: { period: 14, mult: 4, minMoveR: 0.5 },
      partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.7 },
      timeBoost: { afterDay: 4, equityBelow: 0.07, factor: 3 },
      liveCaps: LIVE_CAPS,
    };
    let curR = runWalkForward(data, cur, 0.25);
    console.log(fmt("V2-honest BASELINE (shorts only)", curR));

    // R1: greedy add of long-momentum assets
    console.log(`\n--- R1: greedy add long-momentum assets ---`);
    let r1Best = { cfg: cur, r: curR };
    let candidates = [...ASSETS_FOR_LONGS];
    while (true) {
      let stepBest: { cfg: FtmoDaytrade24hConfig; r: any; sym: string } | null =
        null;
      for (const c of candidates) {
        const trial = {
          ...r1Best.cfg,
          assets: [...r1Best.cfg.assets, makeLong(c)],
        };
        const r = runWalkForward(data, trial, 0.25);
        if (score(r, r1Best.r) < 0) {
          if (stepBest === null || score(r, stepBest.r) < 0) {
            stepBest = { cfg: trial, r, sym: c.sym };
          }
        }
      }
      if (stepBest === null) break;
      r1Best = { cfg: stepBest.cfg, r: stepBest.r };
      candidates = candidates.filter((c) => c.sym !== stepBest!.sym);
      console.log(fmt(`  +${stepBest.sym}`, stepBest.r));
    }
    cur = r1Best.cfg;
    console.log(fmt("R1 winner", r1Best.r));

    // R2: per-LONG triggerBars sweep (1 vs 2 vs 3)
    console.log(`\n--- R2: long triggerBars ---`);
    let r2Best = { cfg: cur, r: r1Best.r };
    for (const tb of [1, 2, 3, 4]) {
      const cfg = {
        ...cur,
        assets: cur.assets.map((a) =>
          a.symbol.endsWith("-LONG") ? { ...a, triggerBars: tb } : a,
        ),
      };
      const r = runWalkForward(data, cfg, 0.25);
      if (score(r, r2Best.r) < 0) {
        r2Best = { cfg, r };
        console.log(fmt(`  long-tb=${tb}`, r));
      }
    }
    cur = r2Best.cfg;
    console.log(fmt("R2 winner", r2Best.r));

    // R3: long-asset minEquityGain (when to activate longs)
    console.log(`\n--- R3: long asset gates ---`);
    let r3Best = { cfg: cur, r: r2Best.r };
    for (const gate of [0, 0.001, 0.005, 0.01, 0.02, 0.03]) {
      const cfg = {
        ...cur,
        assets: cur.assets.map((a) =>
          a.symbol.endsWith("-LONG") ? { ...a, minEquityGain: gate } : a,
        ),
      };
      const r = runWalkForward(data, cfg, 0.25);
      if (score(r, r3Best.r) < 0) {
        r3Best = { cfg, r };
        console.log(fmt(`  long-gate=${gate}`, r));
      }
    }
    cur = r3Best.cfg;
    console.log(fmt("R3 winner", r3Best.r));

    // R4: per-LONG stopPct/tpPct override
    console.log(`\n--- R4: long stopPct × tpPct ---`);
    let r4Best = { cfg: cur, r: r3Best.r };
    for (const sp of [0.005, 0.008, 0.012, 0.018, 0.025]) {
      for (const tp of [0.015, 0.02, 0.03, 0.04, 0.05, 0.07]) {
        const cfg = {
          ...cur,
          assets: cur.assets.map((a) =>
            a.symbol.endsWith("-LONG") ? { ...a, stopPct: sp, tpPct: tp } : a,
          ),
        };
        const r = runWalkForward(data, cfg, 0.25);
        if (score(r, r4Best.r) < 0) {
          r4Best = { cfg, r };
          console.log(fmt(`  long sp=${sp} tp=${tp}`, r));
        }
      }
    }
    cur = r4Best.cfg;
    console.log(fmt("R4 winner", r4Best.r));

    console.log(`\n========== V4 FINAL ==========`);
    console.log(fmt("V2 baseline (shorts only)", curR));
    console.log(fmt("V4 final (with trends)   ", r4Best.r));
    console.log(
      `Δ V2→V4: +${((r4Best.r.passRate - curR.passRate) * 100).toFixed(2)}pp pass, ${r4Best.r.p90Days - curR.p90Days}d p90`,
    );
    console.log(`\nFinal config (long subset):`);
    console.log(
      JSON.stringify(
        cur.assets.filter((a) => a.symbol.endsWith("-LONG")),
        null,
        2,
      ),
    );
    expect(r4Best.r.passRate).toBeGreaterThan(0);
  });
});
