/**
 * Donchian Mega Sweep — proper optimization across all dimensions.
 * Try to find a Donchian config that beats V5's 47%.
 */
import { describe, it, expect } from "vitest";
import {
  runDonchianEngine,
  FTMO_DONCHIAN_CONFIG_BASE,
  type DonchianEngineConfig,
} from "../src/utils/ftmoDonchianEngine";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/DONCHIAN_MEGA_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("Donchian Mega Sweep", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `DONCHIAN_MEGA START ${new Date().toISOString()}\n`,
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

    function evalCfg(cfg: DonchianEngineConfig) {
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      let p = 0,
        w = 0,
        tl = 0;
      for (let s = 0; s + winBars <= n; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const sym of SOURCES) sub[sym] = data[sym].slice(s, s + winBars);
        const r = runDonchianEngine(sub, cfg);
        if (r.passed) p++;
        if (r.reason === "total_loss") tl++;
        w++;
      }
      return { passRate: p / w, tlRate: tl / w, p, w };
    }

    const wins: any[] = [];
    function test(
      name: string,
      override:
        | Partial<DonchianEngineConfig>
        | ((c: DonchianEngineConfig) => DonchianEngineConfig),
    ) {
      const cfg =
        typeof override === "function"
          ? override(FTMO_DONCHIAN_CONFIG_BASE)
          : { ...FTMO_DONCHIAN_CONFIG_BASE, ...override };
      const r = evalCfg(cfg);
      const tag =
        r.passRate >= 0.3
          ? "🚀"
          : r.passRate >= 0.2
            ? "✅"
            : r.passRate >= 0.1
              ? "·"
              : "❌";
      log(
        `  ${tag} ${name.padEnd(60)} pass=${(r.passRate * 100).toFixed(2)}% TL=${(r.tlRate * 100).toFixed(2)}%`,
      );
      if (r.passRate > 0.1) wins.push({ name, cfg, r });
    }

    log(`========== Risk-Frac sweep (key for DL budget) ==========`);
    for (const mrf of [0.05, 0.1, 0.15, 0.2, 0.3, 0.4]) {
      test(`mrf=${mrf} (atr 3.0/5.0)`, (c) => ({
        ...c,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: mrf },
        assets: c.assets.map((a) => ({
          ...a,
          atrStopMult: 3.0,
          tpAtrMult: 5.0,
        })),
      }));
    }

    log(`\n========== Aggressive ATR multipliers + smaller risk ==========`);
    for (const stopMult of [3.0, 4.0, 5.0]) {
      for (const tpMult of [4.0, 6.0, 8.0]) {
        for (const mrf of [0.1, 0.15, 0.2]) {
          test(`stop=${stopMult} tp=${tpMult} mrf=${mrf}`, (c) => ({
            ...c,
            liveCaps: { maxStopPct: 0.05, maxRiskFrac: mrf },
            assets: c.assets.map((a) => ({
              ...a,
              atrStopMult: stopMult,
              tpAtrMult: tpMult,
            })),
          }));
        }
      }
    }

    log(`\n========== Lookback ensembles + best ATR/risk combo ==========`);
    for (const [lbName, lookbacks, minVotes] of [
      ["[55,90]/2", [55, 90], 2],
      ["[20,55,90]/2", [20, 55, 90], 2],
      ["[8,21]/2", [8, 21], 2],
      ["[8,21,55]/2", [8, 21, 55], 2],
      ["[5,10,15,20,25]/3", [5, 10, 15, 20, 25], 3],
      ["[34,55,89]/2", [34, 55, 89], 2],
    ] as const) {
      test(`lb=${lbName} (atr 3.0/5.0 mrf=0.15)`, (c) => ({
        ...c,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.15 },
        assets: c.assets.map((a) => ({
          ...a,
          atrStopMult: 3.0,
          tpAtrMult: 5.0,
          lookbacks: [...lookbacks],
          minVotes,
        })),
      }));
    }

    log(`\n========== HoldBars (longer = more trend ride) ==========`);
    for (const hb of [120, 240, 360, 480, 720]) {
      test(`hb=${hb} (atr 3.0/5.0 mrf=0.15)`, (c) => ({
        ...c,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.15 },
        assets: c.assets.map((a) => ({
          ...a,
          atrStopMult: 3.0,
          tpAtrMult: 5.0,
          holdBars: hb,
        })),
      }));
    }

    log(`\n========== Higher Leverage ==========`);
    for (const lev of [2, 3, 4, 5]) {
      test(`leverage=${lev} (atr 3.0/5.0 mrf=0.15)`, (c) => ({
        ...c,
        leverage: lev,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.15 },
        assets: c.assets.map((a) => ({
          ...a,
          atrStopMult: 3.0,
          tpAtrMult: 5.0,
        })),
      }));
    }

    log(`\n========== TOP 10 ==========`);
    wins.sort((a, b) => b.r.passRate - a.r.passRate);
    for (const w of wins.slice(0, 10)) {
      log(
        `  ${(w.r.passRate * 100).toFixed(2)}% TL=${(w.r.tlRate * 100).toFixed(2)}% — ${w.name}`,
      );
    }
    if (wins.length > 0) {
      writeFileSync(
        `${LOG_DIR}/DONCHIAN_MEGA_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
