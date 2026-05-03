/**
 * R57 — Pullback-Entry sweep on V5
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
const LOG_FILE = `${LOG_DIR}/R57_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("R57 — pullback-entry sweep", { timeout: 24 * 3600_000 }, () => {
  it("runs R57", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R57 START ${new Date().toISOString()}\n`);

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

    function evalCfg(cfg: FtmoDaytrade24hConfig) {
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      let p = 0,
        w = 0,
        tl = 0;
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

    const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5);
    log(
      `V5 baseline: ${(baseR.passRate * 100).toFixed(2)}% (${baseR.passes}/${baseR.windows}) TL=${(baseR.tlRate * 100).toFixed(2)}% engineMed=${baseR.engineMed}d p90=${baseR.engineP90}d`,
    );

    const wins: any[] = [];
    log(`\n========== Pullback-entry sweep on V5 ==========`);
    for (const wait of [1, 2, 3, 4, 6, 8]) {
      for (const pb of [0.005, 0.01, 0.015, 0.02, 0.025, 0.03]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => ({
            ...a,
            pullbackEntry: { maxWaitBars: wait, pullbackPct: pb },
          })),
        };
        const r = evalCfg(cfg);
        const tag = r.passRate > baseR.passRate ? "🚀" : "·";
        log(
          `  ${tag} wait=${wait} pb=${pb}: ${(r.passRate * 100).toFixed(2)}% (${r.passes}/${r.windows}) TL=${(r.tlRate * 100).toFixed(2)}% engineMed=${r.engineMed}d p90=${r.engineP90}d`,
        );
        if (r.passRate > baseR.passRate)
          wins.push({ name: `wait=${wait} pb=${pb}`, cfg, ...r });
      }
    }

    log(`\n========== R57 SUMMARY ==========`);
    log(`Wins: ${wins.length}`);
    if (wins.length > 0) {
      wins.sort((a, b) => b.passRate - a.passRate);
      log(`Top 5:`);
      for (const w of wins.slice(0, 5)) {
        log(
          `  ${w.name.padEnd(25)} ${(w.passRate * 100).toFixed(2)}% TL=${(w.tlRate * 100).toFixed(2)}% engineMed=${w.engineMed}d p90=${w.engineP90}d`,
        );
      }
      writeFileSync(
        `${LOG_DIR}/R57_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
