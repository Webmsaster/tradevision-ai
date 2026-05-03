/**
 * Forex via Binance stablecoin pairs (EURUSDT, GBPUSDT, etc).
 * No new API needed — existing Binance pipeline handles these.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/FOREX_BINANCE_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const FOREX_CANDIDATES = [
  "EURUSDT",
  "GBPUSDT",
  "AUDUSDT",
  "JPYUSDT",
  "TRYUSDT",
  "BRLUSDT",
];

function makeForexAsset(s: string): Daytrade24hAssetCfg {
  return {
    symbol: `${s.replace("USDT", "")}-FX`,
    sourceSymbol: s,
    costBp: 5, // forex pairs tighter spread
    slippageBp: 2,
    swapBpPerDay: 1,
    riskFrac: 1.0,
    triggerBars: 1,
    invertDirection: true,
    disableShort: true,
    stopPct: 0.02, // 2% — forex less volatile than crypto
    tpPct: 0.03, // 3% (1.5:1)
    holdBars: 240,
  };
}

describe("Forex via Binance pairs", { timeout: 24 * 3600_000 }, () => {
  it("tests forex", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `FOREX TEST ${new Date().toISOString()}\n`);

    log(`Loading Binance forex pairs at 2h...`);
    const data: Record<string, Candle[]> = {};
    for (const s of FOREX_CANDIDATES) {
      try {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        log(
          `  ${s}: ${data[s].length} bars (${(data[s].length / BARS_PER_DAY / 365).toFixed(2)}y)`,
        );
      } catch (e) {
        log(`  ${s}: FAIL ${(e as Error).message}`);
      }
    }
    const eligible = Object.keys(data).filter((s) => data[s].length >= 12000); // ≥2.7y
    if (eligible.length === 0) {
      log("No eligible forex pairs from Binance.");
      return;
    }
    const n = Math.min(...eligible.map((s) => data[s].length));
    for (const s of eligible) data[s] = data[s].slice(-n);
    log(`\nEligible: ${eligible.join(", ")}`);
    log(`Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

    const winBars = 30 * BARS_PER_DAY;
    const stepBars = 3 * BARS_PER_DAY;
    function evalCfg(cfg: FtmoDaytrade24hConfig) {
      let p = 0,
        w = 0,
        tl = 0;
      const passDays: number[] = [];
      for (let s = 0; s + winBars <= n; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const sym of eligible) sub[sym] = data[sym].slice(s, s + winBars);
        const r = runFtmoDaytrade24h(sub, cfg);
        if (r.passed) {
          p++;
          if (r.trades.length > 0)
            passDays.push(r.trades[r.trades.length - 1].day + 1);
        }
        if (r.reason === "total_loss") tl++;
        w++;
      }
      passDays.sort((a, b) => a - b);
      const pick = (q: number) =>
        passDays[Math.floor(passDays.length * q)] ?? 0;
      return {
        passes: p,
        windows: w,
        passRate: p / w,
        tlRate: tl / w,
        engineMed: pick(0.5),
        engineP90: pick(0.9),
      };
    }

    log(`========== Forex-only V5-style ==========`);
    const baseCfg: FtmoDaytrade24hConfig = {
      triggerBars: 1,
      leverage: 2,
      tpPct: 0.03,
      stopPct: 0.02,
      holdBars: 240,
      timeframe: "2h" as any,
      maxConcurrentTrades: 4,
      assets: eligible.map(makeForexAsset),
      profitTarget: 0.1,
      maxDailyLoss: 0.05,
      maxTotalLoss: 0.1,
      minTradingDays: 4,
      maxDays: 30,
      pauseAtTargetReached: true,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      trailingStop: { activatePct: 0.015, trailPct: 0.003 },
      allowedHoursUtc: [2, 4, 6, 8, 10, 12, 14, 18, 20, 22],
    };
    const r = evalCfg(baseCfg);
    log(
      `  ${(r.passRate * 100).toFixed(2)}% (${r.passes}/${r.windows}) TL=${(r.tlRate * 100).toFixed(2)}% engineMed=${r.engineMed}d p90=${r.engineP90}d`,
    );

    // Variants
    log(`\n========== Variants ==========`);
    for (const [name, override] of [
      ["wider stop 3%/4.5%", { stopPct: 0.03, tpPct: 0.045 }],
      ["narrower 1.5%/2.5%", { stopPct: 0.015, tpPct: 0.025 }],
      ["tb=2", { triggerBars: 2 }],
      ["holdBars=120", { holdBars: 120 }],
    ] as const) {
      const cfg: FtmoDaytrade24hConfig = {
        ...baseCfg,
        ...override,
        assets: baseCfg.assets.map((a) => ({ ...a, ...override })),
      };
      const r2 = evalCfg(cfg);
      log(
        `  ${name}: ${(r2.passRate * 100).toFixed(2)}% (${r2.passes}/${r2.windows}) TL=${(r2.tlRate * 100).toFixed(2)}% engineMed=${r2.engineMed}d p90=${r2.engineP90}d`,
      );
    }

    expect(true).toBe(true);
  });
});
