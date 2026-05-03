/**
 * Test the new MR engine — RSI-based mean reversion.
 * Compare to V5 (47% pass) to see if MR alone is viable, then ensemble.
 */
import { describe, it, expect } from "vitest";
import {
  runMrEngine,
  FTMO_MR_CONFIG_BASE,
  type MrEngineConfig,
} from "../src/utils/ftmoMrEngine";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/MR_ENGINE_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("MR Engine Test", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `MR_ENGINE START ${new Date().toISOString()}\n`);

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

    function evalCfg(cfg: MrEngineConfig) {
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
        const r = runMrEngine(sub, cfg);
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

    log(`========== MR Baseline (RSI 30/70, sp=2.5%, tp=2%, hb=24) ==========`);
    const base = evalCfg(FTMO_MR_CONFIG_BASE);
    log(
      `MR baseline: pass=${(base.passRate * 100).toFixed(2)}% TL=${(base.tlRate * 100).toFixed(2)}% DL=${(base.dlRate * 100).toFixed(2)}% med=${base.engineMed}d p90=${base.p90}d  trades-with-pass-windows=${base.passes}\n`,
    );

    const wins: any[] = [];
    function test(
      name: string,
      override:
        | Partial<MrEngineConfig>
        | ((c: MrEngineConfig) => MrEngineConfig),
    ) {
      const cfg =
        typeof override === "function"
          ? override(FTMO_MR_CONFIG_BASE)
          : { ...FTMO_MR_CONFIG_BASE, ...override };
      const r = evalCfg(cfg);
      const Δ = (r.passRate - base.passRate) * 100;
      const tag =
        r.passRate > 0.3
          ? "🚀"
          : r.passRate > 0.15
            ? "✅"
            : r.passRate > 0.05
              ? "·"
              : "❌";
      log(
        `  ${tag} ${name.padEnd(50)} pass=${(r.passRate * 100).toFixed(2)}% TL=${(r.tlRate * 100).toFixed(2)}% DL=${(r.dlRate * 100).toFixed(2)}% med=${r.engineMed}d`,
      );
      if (r.passRate > base.passRate + 0.01) wins.push({ name, cfg, r });
    }

    log(`========== RSI thresholds sweep ==========`);
    for (const oversold of [20, 25, 30, 35]) {
      const overbought = 100 - oversold;
      test(`RSI ${oversold}/${overbought}`, (c) => ({
        ...c,
        assets: c.assets.map((a) => ({
          ...a,
          rsiOversold: oversold,
          rsiOverbought: overbought,
        })),
      }));
    }

    log(`\n========== TP/Stop sweep ==========`);
    for (const sp of [0.015, 0.02, 0.025, 0.03]) {
      for (const tp of [0.015, 0.02, 0.025, 0.03]) {
        test(`sp=${sp} tp=${tp}`, (c) => ({
          ...c,
          assets: c.assets.map((a) => ({ ...a, stopPct: sp, tpPct: tp })),
        }));
      }
    }

    log(`\n========== holdBars sweep ==========`);
    for (const hb of [12, 24, 48, 72]) {
      test(`holdBars=${hb}`, (c) => ({
        ...c,
        assets: c.assets.map((a) => ({ ...a, holdBars: hb })),
      }));
    }

    log(`\n========== Long-only vs Short-only vs Both ==========`);
    test(`long-only`, (c) => ({
      ...c,
      assets: c.assets.map((a) => ({ ...a, allowShort: false })),
    }));
    test(`short-only`, (c) => ({
      ...c,
      assets: c.assets.map((a) => ({ ...a, allowLong: false })),
    }));

    log(`\n========== Top 10 ==========`);
    wins.sort((a, b) => b.r.passRate - a.r.passRate);
    for (const w of wins.slice(0, 10)) {
      log(
        `  ${(w.r.passRate * 100).toFixed(2)}% (Δ=${((w.r.passRate - base.passRate) * 100).toFixed(2)}pp) — ${w.name}`,
      );
    }

    log(`\nTotal wins (>${(base.passRate * 100).toFixed(1)}%): ${wins.length}`);
    if (wins.length > 0) {
      writeFileSync(
        `${LOG_DIR}/MR_ENGINE_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
