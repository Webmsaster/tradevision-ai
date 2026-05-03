/**
 * V5 Last-Shot Sweep — try the truly-untested edges:
 * 1. holdBars longer (V5_STEP2 used 300 — does it help in Step 1 too?)
 * 2. Volume filter (V5 doesn't use it)
 * 3. Choppiness filter (V5 doesn't use it)
 * 4. htfTrendFilter for trends (V5 doesn't use, V261 does)
 * 5. Combos
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
const LOG_FILE = `${LOG_DIR}/V5_LASTSHOT_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("V5 Last-Shot Sweep", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `V5_LASTSHOT START ${new Date().toISOString()}\n`);

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
      return {
        passes: p,
        windows: w,
        passRate: p / w,
        tlRate: tl / w,
        engineMed: passDays[Math.floor(passDays.length * 0.5)] ?? 0,
      };
    }

    const V5_BASE: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      liveCaps: LIVE_CAPS,
    };
    const base = evalCfg(V5_BASE);
    log(
      `V5 baseline: ${(base.passRate * 100).toFixed(2)}% TL=${(base.tlRate * 100).toFixed(2)}% med=${base.engineMed}d\n`,
    );

    const wins: any[] = [];
    function test(
      name: string,
      override:
        | Partial<FtmoDaytrade24hConfig>
        | ((c: FtmoDaytrade24hConfig) => FtmoDaytrade24hConfig),
    ) {
      const cfg =
        typeof override === "function"
          ? override(V5_BASE)
          : { ...V5_BASE, ...override };
      const r = evalCfg(cfg);
      const Δ = (r.passRate - base.passRate) * 100;
      const tag = Δ >= 1.0 ? "🚀" : Δ >= 0.3 ? "✅" : Δ <= -0.3 ? "❌" : "·";
      log(
        `  ${tag} ${name.padEnd(50)} ${(r.passRate * 100).toFixed(2)}% Δ=${Δ.toFixed(2)}pp TL=${(r.tlRate * 100).toFixed(2)}%`,
      );
      if (Δ >= 0.3) wins.push({ name, cfg, r });
    }

    log(
      `========== holdBars sweep (Step 2 used 300, what about Step 1?) ==========`,
    );
    for (const hb of [240, 300, 360, 480, 600, 720]) {
      test(`holdBars=${hb}`, (c) => ({
        ...c,
        holdBars: hb,
        assets: c.assets.map((a) => ({ ...a, holdBars: hb })),
      }));
    }

    log(`\n========== volumeFilter ==========`);
    for (const period of [10, 20, 40]) {
      for (const minRatio of [0.5, 0.8, 1.0, 1.2, 1.5]) {
        test(`volumeFilter p=${period} min=${minRatio}`, {
          volumeFilter: { period, minRatio },
        });
      }
    }

    log(`\n========== choppinessFilter ==========`);
    for (const period of [14, 28]) {
      for (const maxCi of [50, 55, 61.8, 70]) {
        test(`choppy p=${period} maxCi=${maxCi}`, {
          choppinessFilter: { period, maxCi },
        });
      }
    }

    log(`\n========== htfTrendFilter (multi-tf) ==========`);
    for (const lb of [12, 24, 42, 60]) {
      for (const thr of [0.005, 0.01, 0.02, 0.05]) {
        test(`htfTrend lb=${lb} thr=${thr}`, {
          htfTrendFilter: { lookbackBars: lb, apply: "short", threshold: thr },
        });
      }
    }

    log(`\n========== Combos: top winners stacked ==========`);
    if (wins.length >= 2) {
      wins.sort((a, b) => b.r.passRate - a.r.passRate);
      for (const k of [2, 3]) {
        const top = wins.slice(0, k);
        const merge = Object.assign({}, V5_BASE);
        for (const w of top) {
          // copy override fields that aren't already in V5_BASE
          if ((w.cfg as any).volumeFilter)
            (merge as any).volumeFilter = (w.cfg as any).volumeFilter;
          if ((w.cfg as any).choppinessFilter)
            (merge as any).choppinessFilter = (w.cfg as any).choppinessFilter;
          if ((w.cfg as any).htfTrendFilter)
            (merge as any).htfTrendFilter = (w.cfg as any).htfTrendFilter;
          if ((w.cfg as any).holdBars !== V5_BASE.holdBars) {
            (merge as any).holdBars = (w.cfg as any).holdBars;
            merge.assets = merge.assets.map((a) => ({
              ...a,
              holdBars: (w.cfg as any).holdBars,
            }));
          }
        }
        const r = evalCfg(merge);
        const Δ = (r.passRate - base.passRate) * 100;
        log(
          `  COMBO top-${k}: ${(r.passRate * 100).toFixed(2)}% Δ=${Δ.toFixed(2)}pp TL=${(r.tlRate * 100).toFixed(2)}%`,
        );
      }
    }

    log(`\n========== Top 10 ==========`);
    wins.sort((a, b) => b.r.passRate - a.r.passRate);
    for (const w of wins.slice(0, 10)) {
      log(
        `  ${(w.r.passRate * 100).toFixed(2)}% Δ=${((w.r.passRate - base.passRate) * 100).toFixed(2)}pp — ${w.name}`,
      );
    }
    if (wins.length > 0) {
      writeFileSync(
        `${LOG_DIR}/V5_LASTSHOT_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
