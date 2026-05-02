/**
 * Test: Forex + Indices via Yahoo daily data
 *
 * Uses 1d candles. minTradingDays floor still 4 — quickly testable.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadYahooDaily } from "./_loadYahooHistory";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/FOREX_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const FOREX_INDICES = [
  "eurusd",
  "gbpusd",
  "usdjpy",
  "audusd",
  "usdcad",
  "^ndq",
  "^spx",
  "^dji",
  "gld.us",
  "uso.us",
];

function makeAsset(s: string): Daytrade24hAssetCfg {
  // Forex spreads tighter than crypto: 1-3 bp typical
  const isForex = s.includes("=X");
  const isIndex = s.startsWith("^");
  return {
    symbol: `${s.replace(/=X|\^/g, "")}-TREND`,
    sourceSymbol: s,
    costBp: isForex ? 3 : isIndex ? 5 : 10,
    slippageBp: isForex ? 1 : isIndex ? 3 : 5,
    swapBpPerDay: 1,
    riskFrac: 1.0,
    triggerBars: 1,
    invertDirection: true,
    disableShort: true,
    stopPct: 0.02, // 2% stop tighter for forex/indices (lower vol)
    tpPct: 0.03, // 3% tp = 1.5:1 R:R
    holdBars: 60, // 60 daily bars = 60 days max
  };
}

describe("Forex + Indices test", { timeout: 24 * 3600_000 }, () => {
  it("runs forex test", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `FOREX TEST ${new Date().toISOString()}\n`);

    log(`Loading daily data from Yahoo...`);
    const data: Record<string, Candle[]> = {};
    for (const s of FOREX_INDICES) {
      try {
        const c = await loadYahooDaily({ symbol: s });
        data[s] = c;
        log(`  ${s}: ${c.length} bars (${(c.length / 365).toFixed(2)}y)`);
      } catch (e) {
        log(`  ${s}: FAIL ${(e as Error).message}`);
      }
    }
    const eligible = Object.keys(data).filter((s) => data[s].length >= 1500); // ≥4y
    if (eligible.length === 0) {
      log(`No eligible symbols — Yahoo may be blocking. Stopping.`);
      return;
    }
    const n = Math.min(...eligible.map((s) => data[s].length));
    for (const s of eligible) data[s] = data[s].slice(-n);
    log(
      `\nAligned: ${n} daily bars (${(n / 365).toFixed(2)}y) / ${eligible.length} assets\n`,
    );

    const BARS_PER_DAY = 1;
    const winBars = 30 * BARS_PER_DAY;
    const stepBars = 3 * BARS_PER_DAY;

    function evalCfg(cfg: FtmoDaytrade24hConfig) {
      const out: FtmoDaytrade24hResult[] = [];
      const passDays: number[] = [];
      for (let s = 0; s + winBars <= n; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const sym of eligible) sub[sym] = data[sym].slice(s, s + winBars);
        const r = runFtmoDaytrade24h(sub, cfg);
        out.push(r);
        if (r.passed && r.trades.length > 0)
          passDays.push(r.trades[r.trades.length - 1].day + 1);
      }
      const passes = out.filter((r) => r.passed).length;
      const tl = out.filter((r) => r.reason === "total_loss").length;
      passDays.sort((a, b) => a - b);
      const pick = (q: number) =>
        passDays[Math.floor(passDays.length * q)] ?? 0;
      return {
        windows: out.length,
        passes,
        passRate: passes / out.length,
        tlRate: tl / out.length,
        engineMed: pick(0.5),
        engineP90: pick(0.9),
      };
    }

    log(`========== Forex/Indices V5-style on 1d ==========`);
    const baseCfg: FtmoDaytrade24hConfig = {
      triggerBars: 1,
      leverage: 2,
      tpPct: 0.03,
      stopPct: 0.02,
      holdBars: 60,
      timeframe: "4h" as any,
      maxConcurrentTrades: 5,
      assets: eligible.map((s) => makeAsset(s)),
      profitTarget: 0.1,
      maxDailyLoss: 0.05,
      maxTotalLoss: 0.1,
      minTradingDays: 4,
      maxDays: 30,
      pauseAtTargetReached: true,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      trailingStop: { activatePct: 0.02, trailPct: 0.005 },
    };
    const r = evalCfg(baseCfg);
    log(
      `  Forex/Indices base: ${(r.passRate * 100).toFixed(2)}% (${r.passes}/${r.windows}) TL=${(r.tlRate * 100).toFixed(2)}% engineMed=${r.engineMed}d engineP90=${r.engineP90}d`,
    );

    // Try with ADX filter
    const cfgAdx: FtmoDaytrade24hConfig = {
      ...baseCfg,
      adxFilter: { period: 10, minAdx: 15 },
    };
    const rAdx = evalCfg(cfgAdx);
    log(
      `  +ADX 10/15: ${(rAdx.passRate * 100).toFixed(2)}% (${rAdx.passes}/${rAdx.windows}) TL=${(rAdx.tlRate * 100).toFixed(2)}% engineMed=${rAdx.engineMed}d engineP90=${rAdx.engineP90}d`,
    );

    // Try triggerBars=2 (less noise on 1d)
    const cfgTb2: FtmoDaytrade24hConfig = {
      ...baseCfg,
      triggerBars: 2,
      assets: baseCfg.assets.map((a) => ({ ...a, triggerBars: 2 })),
    };
    const rTb2 = evalCfg(cfgTb2);
    log(
      `  triggerBars=2: ${(rTb2.passRate * 100).toFixed(2)}% (${rTb2.passes}/${rTb2.windows}) TL=${(rTb2.tlRate * 100).toFixed(2)}% engineMed=${rTb2.engineMed}d engineP90=${rTb2.engineP90}d`,
    );

    // Bigger stop for forex (1d candles have wider noise)
    const cfgWideStop: FtmoDaytrade24hConfig = {
      ...baseCfg,
      stopPct: 0.04,
      tpPct: 0.06,
      assets: baseCfg.assets.map((a) => ({ ...a, stopPct: 0.04, tpPct: 0.06 })),
    };
    const rWide = evalCfg(cfgWideStop);
    log(
      `  wider stop 4%/6%: ${(rWide.passRate * 100).toFixed(2)}% (${rWide.passes}/${rWide.windows}) TL=${(rWide.tlRate * 100).toFixed(2)}% engineMed=${rWide.engineMed}d engineP90=${rWide.engineP90}d`,
    );

    expect(true).toBe(true);
  });
});
