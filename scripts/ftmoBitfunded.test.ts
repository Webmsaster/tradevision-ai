/**
 * V5 on Bitfunded Challenge — UNLIMITED TIME, no min days, same 8%/5%/10%.
 * Theoretical: V5 should pass much higher than FTMO 2-Step.
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
const LOG_FILE = `${LOG_DIR}/V5_BITFUNDED_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("V5 on Bitfunded", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `V5_BITFUNDED START ${new Date().toISOString()}\n`);

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
      const p75 = passDays[Math.floor(passDays.length * 0.75)] ?? 0;
      const p90 = passDays[Math.floor(passDays.length * 0.9)] ?? 0;
      log(
        `  ${label.padEnd(45)} pass=${((p / w) * 100).toFixed(2)}% (${p}/${w}) TL=${((tl / w) * 100).toFixed(2)}% DL=${((dl / w) * 100).toFixed(2)}% timeout=${((timeout / w) * 100).toFixed(2)}% med=${med}d p75=${p75}d p90=${p90}d`,
      );
      return { p, w, tl, dl, passRate: p / w, med, p75, p90 };
    }

    log(`========== Reference: FTMO 2-Step (current live) ==========`);
    const ftmo2step: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      profitTarget: 0.08,
      maxDays: 30,
      maxDailyLoss: 0.05,
      maxTotalLoss: 0.1,
      minTradingDays: 4,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    };
    evalCfg(ftmo2step, "FTMO 2-Step (8%/30d/5%DL/4 mD)", 30, 3);

    log(
      `\n========== Bitfunded Stage 1 — UNLIMITED time, no min days ==========`,
    );
    const bitfunded: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      profitTarget: 0.08,
      maxDays: 999, // unlimited
      maxDailyLoss: 0.05,
      maxTotalLoss: 0.1,
      minTradingDays: 0, // no minimum!
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    };
    // Test with various effective max-window sizes (how long user is willing to trade)
    log(
      `Window size = how long user keeps the challenge active before giving up.`,
    );
    log(
      `Bitfunded charges $79 — effectively a 1-time fee for unlimited try.\n`,
    );
    evalCfg(bitfunded, "Bitfunded 30d window", 30, 3);
    evalCfg(bitfunded, "Bitfunded 60d window", 60, 6);
    evalCfg(bitfunded, "Bitfunded 90d window", 90, 9);
    evalCfg(bitfunded, "Bitfunded 180d window", 180, 18);
    evalCfg(bitfunded, "Bitfunded 365d window", 365, 36);

    log(`\n========== Bitfunded with risk variants ==========`);
    for (const [name, override] of [
      [
        "mrf=0.5 (more aggressive)",
        { liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.5 } },
      ],
      [
        "mrf=0.6 (very aggressive)",
        { liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.6 } },
      ],
      [
        "mrf=0.3 (defensive)",
        { liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.3 } },
      ],
    ] as const) {
      const cfg: FtmoDaytrade24hConfig = { ...bitfunded, ...override };
      evalCfg(cfg, `Bitfunded 90d ${name}`, 90, 9);
    }

    expect(true).toBe(true);
  });
});
