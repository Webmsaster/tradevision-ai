/**
 * Test the new Donchian Ensemble engine on FTMO Step 1 (8% target / 30d / 4 mD).
 * Compare to V5 (47% baseline). Goal: beat V5 with truly different strategy.
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
const LOG_FILE = `${LOG_DIR}/DONCHIAN_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("Donchian Engine", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `DONCHIAN START ${new Date().toISOString()}\n`);

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

    function evalCfg(cfg: DonchianEngineConfig, label: string) {
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
        const r = runDonchianEngine(sub, cfg);
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
      const med = passDays[Math.floor(passDays.length * 0.5)] ?? 0;
      const p90 = passDays[Math.floor(passDays.length * 0.9)] ?? 0;
      log(
        `  ${label.padEnd(50)} pass=${((p / w) * 100).toFixed(2)}% (${p}/${w}) TL=${((tl / w) * 100).toFixed(2)}% DL=${((dl / w) * 100).toFixed(2)}% med=${med}d p90=${p90}d`,
      );
      return { p, w, tl, dl, passRate: p / w };
    }

    log(
      `========== Donchian Baseline (5-lookback ensemble, atr m=2, tp m=3.5) ==========`,
    );
    const base = evalCfg(FTMO_DONCHIAN_CONFIG_BASE, "Donchian baseline");

    log(`\n========== Lookback Ensemble Variants ==========`);
    for (const [name, lookbacks, minVotes] of [
      ["lookbacks=[20,40,60] minVotes=2", [20, 40, 60], 2],
      ["lookbacks=[5,10,20,40] minVotes=2", [5, 10, 20, 40], 2],
      ["lookbacks=[10,20,30,40,50,60] minVotes=4", [10, 20, 30, 40, 50, 60], 4],
      ["lookbacks=[10,20,30] minVotes=2", [10, 20, 30], 2],
      ["lookbacks=[10,20,30] minVotes=3 (all confirm)", [10, 20, 30], 3],
      ["lookbacks=[15,30,60] minVotes=2", [15, 30, 60], 2],
    ] as const) {
      const cfg: DonchianEngineConfig = {
        ...FTMO_DONCHIAN_CONFIG_BASE,
        assets: FTMO_DONCHIAN_CONFIG_BASE.assets.map((a) => ({
          ...a,
          lookbacks: [...lookbacks],
          minVotes,
        })),
      };
      evalCfg(cfg, name);
    }

    log(`\n========== ATR Stop/TP Variants ==========`);
    for (const [name, stopMult, tpMult] of [
      ["atr stop=1.5 tp=2.5", 1.5, 2.5],
      ["atr stop=2.0 tp=3.0", 2.0, 3.0],
      ["atr stop=2.5 tp=4.0", 2.5, 4.0],
      ["atr stop=3.0 tp=5.0", 3.0, 5.0],
      ["atr stop=2.0 tp=4.0", 2.0, 4.0],
    ] as const) {
      const cfg: DonchianEngineConfig = {
        ...FTMO_DONCHIAN_CONFIG_BASE,
        assets: FTMO_DONCHIAN_CONFIG_BASE.assets.map((a) => ({
          ...a,
          atrStopMult: stopMult,
          tpAtrMult: tpMult,
        })),
      };
      evalCfg(cfg, name);
    }

    log(`\n========== Long-only vs Both ==========`);
    evalCfg(
      {
        ...FTMO_DONCHIAN_CONFIG_BASE,
        assets: FTMO_DONCHIAN_CONFIG_BASE.assets.map((a) => ({
          ...a,
          allowShort: true,
        })),
      },
      "Long+Short",
    );

    expect(true).toBe(true);
  });
});
