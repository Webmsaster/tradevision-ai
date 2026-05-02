/**
 * V5 + reEntryAfterStop sweep — last attempt to push V5 past 47% plateau.
 * Engine already supports reEntryAfterStop, agents missed it.
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
const LOG_FILE = `${LOG_DIR}/V5_REENTRY_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("V5 + reEntryAfterStop sweep", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `V5_REENTRY START ${new Date().toISOString()}\n`);

    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
    }
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
      const pick = (q: number) =>
        passDays[Math.floor(passDays.length * q)] ?? 0;
      return {
        passes: p,
        windows: w,
        passRate: p / w,
        tlRate: tl / w,
        dlRate: dl / w,
        engineMed: pick(0.5),
        engineP90: pick(0.9),
      };
    }

    log(`========== Baseline V5 ==========`);
    const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5);
    log(
      `V5 baseline: ${(baseR.passRate * 100).toFixed(2)}% (${baseR.passes}/${baseR.windows}) TL=${baseR.tlRate * 100}% DL=${(baseR.dlRate * 100).toFixed(1)}% engineMed=${baseR.engineMed}d`,
    );

    const wins: any[] = [];
    log(`\n========== reEntryAfterStop Sweep ==========`);
    for (const maxRetries of [1, 2, 3]) {
      for (const windowBars of [3, 6, 12, 24, 48]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          reEntryAfterStop: { maxRetries, windowBars },
        };
        const r = evalCfg(cfg);
        const Δ = (r.passRate - baseR.passRate) * 100;
        const tag = Δ > 0.3 ? "🚀" : Δ < -0.3 ? "❌" : "·";
        log(
          `  ${tag} retries=${maxRetries} window=${windowBars}: ${(r.passRate * 100).toFixed(2)}% Δ=${Δ.toFixed(2)}pp TL=${(r.tlRate * 100).toFixed(2)}% engineMed=${r.engineMed}d`,
        );
        if (Δ >= 0.3)
          wins.push({ name: `r${maxRetries}_w${windowBars}`, cfg, r });
      }
    }

    log(`\n========== SUMMARY ==========`);
    log(`Wins (≥+0.3pp): ${wins.length}`);
    if (wins.length > 0) {
      wins.sort((a, b) => b.r.passRate - a.r.passRate);
      log(`Top 5:`);
      for (const w of wins.slice(0, 5)) {
        log(
          `  ${w.name.padEnd(15)} ${(w.r.passRate * 100).toFixed(2)}% TL=${(w.r.tlRate * 100).toFixed(2)}% Δ=${((w.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
        );
      }
      writeFileSync(
        `${LOG_DIR}/V5_REENTRY_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
      log(`\nBest config saved to V5_REENTRY_BEST.json`);
    } else {
      log(`No improvements found. reEntryAfterStop is not the missing edge.`);
    }

    expect(true).toBe(true);
  });
});
