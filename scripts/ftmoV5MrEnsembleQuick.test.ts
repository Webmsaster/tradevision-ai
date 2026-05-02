/**
 * V5 trend + MR ensemble — direct test.
 * Add MR-variants of same 9 cryptos to V5's asset list.
 * MR = no invertDirection (so bot trades both directions on signals).
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
const LOG_FILE = `${LOG_DIR}/V5_MR_ENSEMBLE_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("V5 + MR ensemble", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V5_MR_ENSEMBLE START ${new Date().toISOString()}\n`,
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

    // Helper: build MR asset variant from a V5 trend asset
    function makeMrAsset(
      trendAsset: any,
      params: {
        stopPct: number;
        tpPct: number;
        holdBars: number;
        riskFrac: number;
      },
    ) {
      return {
        ...trendAsset,
        symbol: trendAsset.symbol.replace("-TREND", "-MR"),
        invertDirection: false, // MR: trade BOTH directions
        disableShort: false, // allow shorts
        ...params,
      };
    }

    const V5_BASE: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      liveCaps: LIVE_CAPS,
    };

    log(`========== V5 baseline (Live-Caps) ==========`);
    const baseR = evalCfg(V5_BASE);
    log(
      `V5 alone: pass=${(baseR.passRate * 100).toFixed(2)}% TL=${(baseR.tlRate * 100).toFixed(2)}% DL=${(baseR.dlRate * 100).toFixed(2)}% med=${baseR.engineMed}d p90=${baseR.p90}d\n`,
    );

    log(`========== Ensemble Variants ==========`);
    const wins: any[] = [];
    function test(
      name: string,
      mrParams: {
        stopPct: number;
        tpPct: number;
        holdBars: number;
        riskFrac: number;
      },
      maxConcurrent = 12,
    ) {
      const mrAssets = V5_BASE.assets.map((a) => makeMrAsset(a, mrParams));
      const cfg: FtmoDaytrade24hConfig = {
        ...V5_BASE,
        maxConcurrentTrades: maxConcurrent,
        assets: [...V5_BASE.assets, ...mrAssets],
      };
      const r = evalCfg(cfg);
      const Δ = (r.passRate - baseR.passRate) * 100;
      const tag = Δ >= 1.0 ? "🚀" : Δ >= 0.3 ? "✅" : Δ <= -0.3 ? "❌" : "·";
      log(
        `  ${tag} ${name.padEnd(50)} pass=${(r.passRate * 100).toFixed(2)}% Δ=${Δ.toFixed(2)}pp TL=${(r.tlRate * 100).toFixed(2)}% DL=${(r.dlRate * 100).toFixed(2)}% med=${r.engineMed}d`,
      );
      if (Δ >= 0.3) wins.push({ name, cfg, r });
    }

    // Vary MR params
    for (const stop of [0.02, 0.025, 0.03]) {
      for (const tp of [0.015, 0.02, 0.025]) {
        for (const hold of [12, 24, 48]) {
          for (const risk of [0.3, 0.5, 0.7]) {
            test(`MR sp=${stop} tp=${tp} hb=${hold} rf=${risk}`, {
              stopPct: stop,
              tpPct: tp,
              holdBars: hold,
              riskFrac: risk,
            });
          }
        }
      }
    }

    log(`\n========== Top 10 ==========`);
    wins.sort((a, b) => b.r.passRate - a.r.passRate);
    for (const w of wins.slice(0, 10)) {
      log(
        `  ${(w.r.passRate * 100).toFixed(2)}% Δ=${((w.r.passRate - baseR.passRate) * 100).toFixed(2)}pp TL=${(w.r.tlRate * 100).toFixed(2)}% — ${w.name}`,
      );
    }
    if (wins.length > 0) {
      writeFileSync(
        `${LOG_DIR}/V5_MR_ENSEMBLE_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    } else {
      log(`No improvements. MR ensemble doesn't help.`);
    }

    expect(true).toBe(true);
  });
});
