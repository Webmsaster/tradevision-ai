/**
 * Validate GA Winner with standard eval (3-day step, 672 windows).
 * Compare to V5 baseline AND across out-of-sample slices.
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
const LOG_FILE = `${LOG_DIR}/V5_GA_VALIDATE_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("V5 GA Winner Validation", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V5_GA_VALIDATE START ${new Date().toISOString()}\n`,
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
      dataStart = 0,
      dataEnd = n,
    ) {
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      let p = 0,
        w = 0,
        tl = 0;
      const passDays: number[] = [];
      for (let s = dataStart; s + winBars <= dataEnd; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const sym of SOURCES) sub[sym] = data[sym].slice(s, s + winBars);
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
      const med = passDays[Math.floor(passDays.length * 0.5)] ?? 0;
      log(
        `  ${label.padEnd(40)} pass=${((p / w) * 100).toFixed(2)}% (${p}/${w}) TL=${((tl / w) * 100).toFixed(2)}% med=${med}d`,
      );
      return { p, w, tl, passRate: p / w, med };
    }

    log(`========== V5 Baseline (Standard Eval) ==========`);
    const v5: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      liveCaps: LIVE_CAPS,
    };
    evalCfg(v5, "V5 baseline");

    log(`\n========== GA Winner (full data) ==========`);
    const gaWinner: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      liveCaps: LIVE_CAPS,
      triggerBars: 1,
      holdBars: 327,
      allowedHoursUtc: [2, 6, 8, 10, 12, 16, 18],
      choppinessFilter: { period: 14, maxCi: 66.5 },
      volumeFilter: { period: 20, minRatio: 1.25 },
      assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => ({
        ...a,
        triggerBars: 1,
        holdBars: 327,
        stopPct: 0.05,
        tpPct: 0.0483,
        riskFrac: 1.149,
      })),
    };
    evalCfg(gaWinner, "GA winner (full 5.6y)");

    log(`\n========== Out-of-Sample Validation (split data) ==========`);
    // Train was full data; let's see if GA winner holds on 1st half vs 2nd half
    const half = Math.floor(n / 2);
    log(`First half (oldest ~2.8y):`);
    evalCfg(v5, "  V5 baseline first-half", 0, half);
    evalCfg(gaWinner, "  GA winner first-half ", 0, half);
    log(`Second half (recent ~2.8y):`);
    evalCfg(v5, "  V5 baseline second-half", half, n);
    evalCfg(gaWinner, "  GA winner second-half ", half, n);

    log(`\n========== Recent 1y only (most relevant) ==========`);
    const recent = n - 365 * BARS_PER_DAY;
    evalCfg(v5, "V5 baseline last 1y", recent, n);
    evalCfg(gaWinner, "GA winner last 1y ", recent, n);

    log(`\n========== Stress: subtle variations ==========`);
    // Simulate train/test split: GA optimized on full data — what if we changed costs slightly?
    const stressed: FtmoDaytrade24hConfig = {
      ...gaWinner,
      assets: gaWinner.assets.map((a) => ({
        ...a,
        costBp: a.costBp + 5,
        slippageBp: (a.slippageBp ?? 0) + 2,
      })),
    };
    evalCfg(stressed, "GA winner +5bp cost stress");

    expect(true).toBe(true);
  });
});
