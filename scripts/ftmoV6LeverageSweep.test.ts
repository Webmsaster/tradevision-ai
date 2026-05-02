/**
 * V6 leverage sweep under live caps.
 * Higher leverage = bigger wins AND bigger losses. Find the sweet spot.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V6_LEVERAGE_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("V6 leverage sweep", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `V6_LEVERAGE START ${new Date().toISOString()}\n`);

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

    function evalCfg(cfg: FtmoDaytrade24hConfig) {
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
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
      return {
        passes: p,
        windows: w,
        passRate: p / w,
        tlRate: tl / w,
        dlRate: dl / w,
        engineMed: passDays[Math.floor(passDays.length * 0.5)] ?? 0,
        p90: passDays[Math.floor(passDays.length * 0.9)] ?? 0,
      };
    }

    const V6_BASE: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
      liveCaps: LIVE_CAPS,
    };
    log(`========== V6 + leverage sweep (with Live-Caps) ==========`);
    const results: any[] = [];
    for (const lev of [1.5, 1.8, 2.0, 2.2, 2.5, 3.0, 3.5, 4.0, 5.0]) {
      const cfg: FtmoDaytrade24hConfig = { ...V6_BASE, leverage: lev };
      const r = evalCfg(cfg);
      log(
        `  leverage=${lev}: pass=${(r.passRate * 100).toFixed(2)}% TL=${(r.tlRate * 100).toFixed(2)}% DL=${(r.dlRate * 100).toFixed(2)}% med=${r.engineMed}d p90=${r.p90}d`,
      );
      results.push({ lev, ...r });
    }

    log(
      `\n========== Combo: leverage + maxRiskFrac sweep (live caps) ==========`,
    );
    log(
      "(higher riskFrac under live caps = more risk per trade, but capped)\n",
    );
    for (const lev of [2.0, 2.5, 3.0]) {
      for (const mrf of [0.3, 0.4, 0.5, 0.6, 0.8]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...V6_BASE,
          leverage: lev,
          liveCaps: { maxStopPct: 0.05, maxRiskFrac: mrf },
        };
        const r = evalCfg(cfg);
        log(
          `  lev=${lev} mrf=${mrf}: pass=${(r.passRate * 100).toFixed(2)}% TL=${(r.tlRate * 100).toFixed(2)}% DL=${(r.dlRate * 100).toFixed(2)}% med=${r.engineMed}d`,
        );
      }
    }

    log(`\n========== TOP RANK ==========`);
    results.sort((a, b) => b.passRate - a.passRate);
    log(
      `Best leverage = ${results[0].lev}: ${(results[0].passRate * 100).toFixed(2)}% TL=${(results[0].tlRate * 100).toFixed(2)}%`,
    );

    expect(true).toBe(true);
  });
});
