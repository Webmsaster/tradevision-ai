/**
 * V5 on Atlas Funded — 4% target, 1-Step, no time limit, no min days.
 * V5 wins are typically +5.6% per trade — should pass on FIRST winning trade.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_ATLAS_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}
const SOURCES = [
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

describe("V5 Multi-PropFirm Comparison", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `V5_ATLAS START ${new Date().toISOString()}\n`);

    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES)
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of SOURCES) data[s] = data[s].slice(-n);
    log(`Data: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

    function evalCfg(
      cfg: FtmoDaytrade24hConfig,
      label: string,
      windowDays: number,
      stepDays: number,
    ) {
      const winBars = windowDays * BARS_PER_DAY;
      const stepBars = stepDays * BARS_PER_DAY;
      let p = 0,
        w = 0,
        tl = 0,
        dl = 0;
      const passDays: number[] = [];
      for (let s = 0; s + winBars <= n; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const sym of SOURCES) sub[sym] = data[sym].slice(s, s + winBars);
        const r = runFtmoDaytrade24h(sub, cfg);
        if (r.passed) {
          p++;
          if (r.trades.length > 0)
            passDays.push(r.trades[r.trades.length - 1].day + 1);
        }
        if (r.reason === "total_loss") tl++;
        if (r.reason === "daily_loss") dl++;
        w++;
      }
      passDays.sort((a, b) => a - b);
      const med = passDays[Math.floor(passDays.length * 0.5)] ?? 0;
      const p90 = passDays[Math.floor(passDays.length * 0.9)] ?? 0;
      log(
        `  ${label.padEnd(50)} pass=${((p / w) * 100).toFixed(2)}% (${p}/${w}) TL=${((tl / w) * 100).toFixed(2)}% DL=${((dl / w) * 100).toFixed(2)}% med=${med}d p90=${p90}d`,
      );
      return { p, w, tl, dl, passRate: p / w, med, p90 };
    }

    log(`========== Reference: FTMO 2-Step ==========`);
    evalCfg(
      {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: 0.08,
        maxDays: 30,
        maxDailyLoss: 0.05,
        maxTotalLoss: 0.1,
        minTradingDays: 4,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      },
      "FTMO 2-Step (8%/30d/4 mD/$155)",
      30,
      3,
    );

    log(
      `\n========== 🚀 Atlas Funded: 4% target, no min days, unlimited ==========`,
    );
    evalCfg(
      {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: 0.04,
        maxDays: 999,
        maxDailyLoss: 0.05,
        maxTotalLoss: 0.1,
        minTradingDays: 0,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      },
      "Atlas (4%/∞/0 mD/$1)",
      30,
      3,
    );
    evalCfg(
      {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: 0.04,
        maxDays: 999,
        maxDailyLoss: 0.05,
        maxTotalLoss: 0.1,
        minTradingDays: 0,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      },
      "Atlas 90d window",
      90,
      9,
    );
    evalCfg(
      {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: 0.04,
        maxDays: 999,
        maxDailyLoss: 0.05,
        maxTotalLoss: 0.1,
        minTradingDays: 0,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      },
      "Atlas 180d window",
      180,
      18,
    );

    log(`\n========== Goat Funded Trader: 8%/3 mD/$22 ==========`);
    evalCfg(
      {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: 0.08,
        maxDays: 999,
        maxDailyLoss: 0.05,
        maxTotalLoss: 0.1,
        minTradingDays: 3,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      },
      "Goat Funded (8%/∞/3 mD/$22)",
      30,
      3,
    );

    log(`\n========== MCF: 8%/0 mD/unlimited ==========`);
    evalCfg(
      {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: 0.08,
        maxDays: 999,
        maxDailyLoss: 0.05,
        maxTotalLoss: 0.1,
        minTradingDays: 0,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      },
      "MCF (8%/∞/0 mD)",
      30,
      3,
    );

    log(`\n========== Bitfunded: 8%/0 mD/unlimited ==========`);
    evalCfg(
      {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: 0.08,
        maxDays: 999,
        maxDailyLoss: 0.05,
        maxTotalLoss: 0.1,
        minTradingDays: 0,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      },
      "Bitfunded (8%/∞/0 mD/$79)",
      30,
      3,
    );

    expect(true).toBe(true);
  });
});
