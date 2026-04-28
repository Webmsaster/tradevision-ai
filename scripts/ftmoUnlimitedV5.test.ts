/**
 * Test V5 unter ECHTEN FTMO 2-Step rules (seit Juli 2024 — kein Time Limit!).
 * Vergleich: 30-Tage-Cap (was wir bisher testeten) vs unlimited.
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
const LOG_FILE = `${LOG_DIR}/V5_UNLIMITED_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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
const LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };

describe(
  "V5 Unlimited Time (FTMO 2024 rule)",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `V5_UNLIMITED START ${new Date().toISOString()}\n`,
      );

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
          dl = 0,
          timeout = 0;
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
          if (r.reason === "time") timeout++;
          w++;
        }
        passDays.sort((a, b) => a - b);
        const med = passDays[Math.floor(passDays.length * 0.5)] ?? 0;
        const p90 = passDays[Math.floor(passDays.length * 0.9)] ?? 0;
        log(
          `  ${label.padEnd(50)} pass=${((p / w) * 100).toFixed(2)}% (${p}/${w}) TL=${((tl / w) * 100).toFixed(2)}% DL=${((dl / w) * 100).toFixed(2)}% timeout=${((timeout / w) * 100).toFixed(2)}% med=${med}d p90=${p90}d`,
        );
        return { p, w, tl, dl, timeout, passRate: p / w };
      }

      log(`========== A) FTMO 2-Step BIS Juli 2024 (30-Tage-Cap) ==========`);
      evalCfg(
        {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          profitTarget: 0.08,
          maxDays: 30,
          maxDailyLoss: 0.05,
          maxTotalLoss: 0.1,
          minTradingDays: 4,
          liveCaps: LIVE_CAPS,
        },
        "Old rule: 8%/30d/4mD/5%DL",
        30,
        3,
      );

      log(
        `\n========== B) FTMO 2-Step AKTUELL (kein Time-Limit, 60-Tage-Window) ==========`,
      );
      evalCfg(
        {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          profitTarget: 0.08,
          maxDays: 999,
          maxDailyLoss: 0.05,
          maxTotalLoss: 0.1,
          minTradingDays: 4,
          liveCaps: LIVE_CAPS,
        },
        "NEW: 8%/∞/4mD/5%DL — 60d window",
        60,
        6,
      );

      log(`\n========== C) Same, 90d window ==========`);
      evalCfg(
        {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          profitTarget: 0.08,
          maxDays: 999,
          maxDailyLoss: 0.05,
          maxTotalLoss: 0.1,
          minTradingDays: 4,
          liveCaps: LIVE_CAPS,
        },
        "NEW: 8%/∞/4mD/5%DL — 90d window",
        90,
        9,
      );

      log(`\n========== D) Same, 180d window ==========`);
      evalCfg(
        {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          profitTarget: 0.08,
          maxDays: 999,
          maxDailyLoss: 0.05,
          maxTotalLoss: 0.1,
          minTradingDays: 4,
          liveCaps: LIVE_CAPS,
        },
        "NEW: 8%/∞/4mD/5%DL — 180d window",
        180,
        18,
      );

      log(
        `\n========== E) Same, 365d window (full year give-up time) ==========`,
      );
      evalCfg(
        {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          profitTarget: 0.08,
          maxDays: 999,
          maxDailyLoss: 0.05,
          maxTotalLoss: 0.1,
          minTradingDays: 4,
          liveCaps: LIVE_CAPS,
        },
        "NEW: 8%/∞/4mD/5%DL — 365d window",
        365,
        36,
      );

      expect(true).toBe(true);
    });
  },
);
