/**
 * Test the new SMC (Smart Money Concepts) engine.
 */
import { describe, it, expect } from "vitest";
import {
  runSmcEngine,
  FTMO_SMC_CONFIG_BASE,
  type SmcEngineConfig,
} from "../src/utils/ftmoSmcEngine";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/SMC_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("SMC Engine", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `SMC START ${new Date().toISOString()}\n`);

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

    function evalCfg(cfg: SmcEngineConfig) {
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      let p = 0,
        w = 0,
        tl = 0;
      for (let s = 0; s + winBars <= n; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const sym of SOURCES) sub[sym] = data[sym].slice(s, s + winBars);
        const r = runSmcEngine(sub, cfg);
        if (r.passed) p++;
        if (r.reason === "total_loss") tl++;
        w++;
      }
      return { passRate: p / w, tlRate: tl / w, p, w };
    }

    log(
      `========== SMC Baseline (FVG+OB+Sweep, atr 1.5/2.5 stop/tp) ==========`,
    );
    const base = evalCfg(FTMO_SMC_CONFIG_BASE);
    log(
      `SMC baseline: ${(base.passRate * 100).toFixed(2)}% (${base.p}/${base.w}) TL=${(base.tlRate * 100).toFixed(2)}%\n`,
    );

    function test(name: string, mod: (c: SmcEngineConfig) => SmcEngineConfig) {
      const cfg = mod(FTMO_SMC_CONFIG_BASE);
      const r = evalCfg(cfg);
      const tag =
        r.passRate >= 0.4
          ? "🚀"
          : r.passRate >= 0.25
            ? "✅"
            : r.passRate >= 0.15
              ? "·"
              : "❌";
      log(
        `  ${tag} ${name.padEnd(50)} pass=${(r.passRate * 100).toFixed(2)}% TL=${(r.tlRate * 100).toFixed(2)}%`,
      );
      return r;
    }

    log(`========== Setup Variants (which SMC pattern works?) ==========`);
    test("FVG only", (c) => ({
      ...c,
      assets: c.assets.map((a) => ({
        ...a,
        fvgEnabled: true,
        obEnabled: false,
        sweepEnabled: false,
      })),
    }));
    test("OB only", (c) => ({
      ...c,
      assets: c.assets.map((a) => ({
        ...a,
        fvgEnabled: false,
        obEnabled: true,
        sweepEnabled: false,
      })),
    }));
    test("Sweep only", (c) => ({
      ...c,
      assets: c.assets.map((a) => ({
        ...a,
        fvgEnabled: false,
        obEnabled: false,
        sweepEnabled: true,
      })),
    }));
    test("FVG + OB", (c) => ({
      ...c,
      assets: c.assets.map((a) => ({
        ...a,
        fvgEnabled: true,
        obEnabled: true,
        sweepEnabled: false,
      })),
    }));
    test("FVG + Sweep", (c) => ({
      ...c,
      assets: c.assets.map((a) => ({
        ...a,
        fvgEnabled: true,
        obEnabled: false,
        sweepEnabled: true,
      })),
    }));

    log(`\n========== ATR Stop/TP variants ==========`);
    for (const [s, t] of [
      [1.0, 2.0],
      [1.5, 3.0],
      [2.0, 4.0],
      [2.5, 5.0],
      [3.0, 6.0],
    ] as const) {
      test(`atr stop=${s} tp=${t}`, (c) => ({
        ...c,
        assets: c.assets.map((a) => ({ ...a, atrStopMult: s, atrTpMult: t })),
      }));
    }

    log(`\n========== Allow shorts? ==========`);
    test("Long+Short", (c) => ({
      ...c,
      assets: c.assets.map((a) => ({ ...a, allowShort: true })),
    }));

    log(`\n========== Sweep wick depth variants ==========`);
    for (const w of [0.0005, 0.001, 0.002, 0.005, 0.01]) {
      test(`sweep wickPct=${w}`, (c) => ({
        ...c,
        assets: c.assets.map((a) => ({
          ...a,
          fvgEnabled: false,
          obEnabled: false,
          sweepEnabled: true,
          sweepWickPct: w,
        })),
      }));
    }

    expect(true).toBe(true);
  });
});
