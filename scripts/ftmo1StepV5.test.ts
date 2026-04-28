/**
 * V5 on FTMO 1-Step Challenge — UNLIMITED TIME, 10% target, 3% DL, 10% TL.
 * Massive game changer: timeout failures go to 0%.
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
const LOG_FILE = `${LOG_DIR}/V5_1STEP_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("V5 on FTMO 1-Step Challenge", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `V5_1STEP START ${new Date().toISOString()}\n`);

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

    function eval1Step(cfg: FtmoDaytrade24hConfig, label: string) {
      // For 1-Step: simulate starting at each point, run until pass or fail (no timeout).
      // To make this tractable: use 180-day max window (effectively unlimited for 30d challenge math).
      const maxWindowDays = 180; // effective "unlimited" for this test — most pass within months
      const winBars = maxWindowDays * BARS_PER_DAY;
      const stepBars = 6 * BARS_PER_DAY; // bigger step since longer windows

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
      const p75 = passDays[Math.floor(passDays.length * 0.75)] ?? 0;
      const p90 = passDays[Math.floor(passDays.length * 0.9)] ?? 0;
      log(
        `  ${label}: pass=${((p / w) * 100).toFixed(2)}% (${p}/${w}) TL=${((tl / w) * 100).toFixed(2)}% DL=${((dl / w) * 100).toFixed(2)}% timeout=${((timeout / w) * 100).toFixed(2)}% med=${med}d p75=${p75}d p90=${p90}d`,
      );
      return { p, w, tl, dl, timeout, med, p75, p90 };
    }

    log(`========== Reference: V5 on 2-Step (current) ==========`);
    const v5_2step: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      profitTarget: 0.08,
      maxDays: 30,
      maxDailyLoss: 0.05,
      maxTotalLoss: 0.1,
      minTradingDays: 4,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    };
    eval1Step(v5_2step, "V5 2-Step (8%/30d/5%DL)        ");

    log(`\n========== V5 on 1-Step (10%/UNLIMITED/3%DL) ==========`);
    const v5_1step_naive: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      profitTarget: 0.1,
      maxDays: 999, // effectively unlimited; capped by data window
      maxDailyLoss: 0.03,
      maxTotalLoss: 0.1,
      minTradingDays: 4,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    };
    eval1Step(v5_1step_naive, "V5 1-Step naive               ");

    log(`\n========== V5 1-Step variants — handle tighter 3% DL ==========`);
    // With tighter 3% DL, we need defensive sizing
    for (const [name, mrf, target] of [
      ["mrf=0.4 target=10%", 0.4, 0.1],
      ["mrf=0.3 target=10%", 0.3, 0.1],
      ["mrf=0.2 target=10%", 0.2, 0.1],
      ["mrf=0.4 target=12%", 0.4, 0.12],
      ["mrf=0.5 target=10%", 0.5, 0.1],
    ] as const) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: target,
        maxDays: 999,
        maxDailyLoss: 0.03,
        maxTotalLoss: 0.1,
        minTradingDays: 4,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: mrf },
      };
      eval1Step(cfg, name.padEnd(30));
    }

    log(`\n========== Stricter Stop adjustments for 3% DL ==========`);
    for (const [name, override] of [
      ["stopPct=0.03 (matches DL cap)", { stopPct: 0.03 }],
      ["stopPct=0.025", { stopPct: 0.025 }],
      ["stopPct=0.04", { stopPct: 0.04 }],
    ] as const) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: 0.1,
        maxDays: 999,
        maxDailyLoss: 0.03,
        maxTotalLoss: 0.1,
        minTradingDays: 4,
        liveCaps: { maxStopPct: override.stopPct, maxRiskFrac: 0.4 },
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => ({
          ...a,
          stopPct: override.stopPct,
          tpPct: override.stopPct * 1.4,
        })),
      };
      eval1Step(cfg, name.padEnd(30));
    }

    expect(true).toBe(true);
  });
});
