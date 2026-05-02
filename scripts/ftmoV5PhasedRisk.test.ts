/**
 * V5 + Phased Risk — frontload aggressive when buffer is full,
 * de-risk after building cushion. Static-DD allows aggressive start.
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
const LOG_FILE = `${LOG_DIR}/V5_PHASED_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("V5 Phased Risk Sweep", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `V5_PHASED START ${new Date().toISOString()}\n`);

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
      return { passes: p, windows: w, passRate: p / w, tlRate: tl / w };
    }

    const V5_BASE: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      liveCaps: LIVE_CAPS,
    };
    const base = evalCfg(V5_BASE);
    log(
      `V5 baseline: ${(base.passRate * 100).toFixed(2)}% TL=${(base.tlRate * 100).toFixed(2)}%\n`,
    );

    const wins: any[] = [];
    function test(
      name: string,
      curve: Array<{ equityAbove: number; factor: number }>,
    ) {
      const cfg: FtmoDaytrade24hConfig = { ...V5_BASE, adaptiveSizing: curve };
      const r = evalCfg(cfg);
      const Δ = (r.passRate - base.passRate) * 100;
      const tag = Δ >= 0.5 ? "✅" : Δ >= 0.3 ? "·" : Δ < -0.5 ? "❌" : "·";
      log(
        `  ${tag} ${name.padEnd(50)} pass=${(r.passRate * 100).toFixed(2)}% Δ=${Δ.toFixed(2)}pp TL=${(r.tlRate * 100).toFixed(2)}%`,
      );
      if (Δ >= 0.3) wins.push({ name, cfg, r });
    }

    log(`========== Phased Risk Curves (frontload aggressive) ==========`);
    // Strategy: at start of challenge (equity~0), use HIGHER size to build buffer fast
    // Then drop to defensive after 4-5% built up, very low after target near
    test("Phased: 1.5x@-3, 1x@+3, 0.5x@+8", [
      { equityAbove: -0.03, factor: 1.5 },
      { equityAbove: 0.03, factor: 1.0 },
      { equityAbove: 0.08, factor: 0.5 },
    ]);
    test("Phased: 2x@-2, 1x@+4, 0.4x@+8", [
      { equityAbove: -0.02, factor: 2.0 },
      { equityAbove: 0.04, factor: 1.0 },
      { equityAbove: 0.08, factor: 0.4 },
    ]);
    test("Phased: 1.8x@-1, 1.2x@+3, 0.4x@+8", [
      { equityAbove: -0.01, factor: 1.8 },
      { equityAbove: 0.03, factor: 1.2 },
      { equityAbove: 0.08, factor: 0.4 },
    ]);
    test("Phased: 2.5x@-2, 1x@+5, 0.3x@+8", [
      { equityAbove: -0.02, factor: 2.5 },
      { equityAbove: 0.05, factor: 1.0 },
      { equityAbove: 0.08, factor: 0.3 },
    ]);
    test("Phased: 3x@-2, 1.5x@+3, 0.5x@+6, 0.3x@+8", [
      { equityAbove: -0.02, factor: 3.0 },
      { equityAbove: 0.03, factor: 1.5 },
      { equityAbove: 0.06, factor: 0.5 },
      { equityAbove: 0.08, factor: 0.3 },
    ]);
    test("Phased: 2x@-5, 1x@+2, 0.5x@+8", [
      { equityAbove: -0.05, factor: 2.0 },
      { equityAbove: 0.02, factor: 1.0 },
      { equityAbove: 0.08, factor: 0.5 },
    ]);
    test("Phased: U-shape: 1.5x@-3, 0.7x@+2, 1.5x@+5, 0.4x@+8", [
      { equityAbove: -0.03, factor: 1.5 },
      { equityAbove: 0.02, factor: 0.7 },
      { equityAbove: 0.05, factor: 1.5 },
      { equityAbove: 0.08, factor: 0.4 },
    ]);
    test("Phased: 1.3x@0, 1.0x@+4, 0.6x@+8", [
      { equityAbove: 0, factor: 1.3 },
      { equityAbove: 0.04, factor: 1.0 },
      { equityAbove: 0.08, factor: 0.6 },
    ]);
    test("Phased: 2x@0, 0.5x@+4, 0.3x@+8", [
      { equityAbove: 0, factor: 2.0 },
      { equityAbove: 0.04, factor: 0.5 },
      { equityAbove: 0.08, factor: 0.3 },
    ]);

    log(`\n========== With timeBoost (recovery push) ==========`);
    function testWithBoost(
      name: string,
      curve: any[],
      boost: { afterDay: number; equityBelow: number; factor: number },
    ) {
      const cfg: FtmoDaytrade24hConfig = {
        ...V5_BASE,
        adaptiveSizing: curve,
        timeBoost: boost,
      };
      const r = evalCfg(cfg);
      const Δ = (r.passRate - base.passRate) * 100;
      const tag = Δ >= 0.5 ? "✅" : Δ < -0.5 ? "❌" : "·";
      log(
        `  ${tag} ${name.padEnd(50)} pass=${(r.passRate * 100).toFixed(2)}% Δ=${Δ.toFixed(2)}pp TL=${(r.tlRate * 100).toFixed(2)}%`,
      );
      if (Δ >= 0.3) wins.push({ name, cfg, r });
    }
    testWithBoost(
      "Phased 2x + boost d6 below=4% f=1.5",
      [
        { equityAbove: -0.02, factor: 2.0 },
        { equityAbove: 0.04, factor: 1.0 },
        { equityAbove: 0.08, factor: 0.4 },
      ],
      { afterDay: 6, equityBelow: 0.04, factor: 1.5 },
    );
    testWithBoost(
      "Phased 1.5x + boost d4 below=2% f=2.0",
      [
        { equityAbove: -0.03, factor: 1.5 },
        { equityAbove: 0.03, factor: 1.0 },
        { equityAbove: 0.08, factor: 0.5 },
      ],
      { afterDay: 4, equityBelow: 0.02, factor: 2.0 },
    );

    log(`\n========== TOP WINS ==========`);
    wins.sort((a, b) => b.r.passRate - a.r.passRate);
    for (const w of wins.slice(0, 5))
      log(
        `  ${(w.r.passRate * 100).toFixed(2)}% Δ=${((w.r.passRate - base.passRate) * 100).toFixed(2)}pp — ${w.name}`,
      );
    if (wins.length === 0) log(`No improvements found.`);

    expect(true).toBe(true);
  });
});
