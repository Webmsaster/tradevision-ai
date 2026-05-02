/**
 * V5 + engine extensions sweep — final attempt at 50%.
 * Tests adaptiveSizing, timeBoost, kellySizing, correlationFilter on V5 baseline.
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
const LOG_FILE = `${LOG_DIR}/V5_ENGINE_EXT_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("V5 engine extensions sweep", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V5_ENGINE_EXT START ${new Date().toISOString()}\n`,
    );

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

    log(`========== Baseline V5 ==========`);
    const base = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5);
    log(
      `V5 baseline: ${(base.passRate * 100).toFixed(2)}% (${base.passes}/${base.windows}) TL=${(base.tlRate * 100).toFixed(2)}% engineMed=${base.engineMed}d`,
    );

    const wins: any[] = [];
    function test(name: string, override: Partial<FtmoDaytrade24hConfig>) {
      const cfg = { ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5, ...override };
      const r = evalCfg(cfg);
      const Δ = (r.passRate - base.passRate) * 100;
      const tag = Δ >= 1.0 ? "🚀" : Δ >= 0.3 ? "✅" : Δ <= -0.3 ? "❌" : "·";
      log(
        `  ${tag} ${name.padEnd(40)} ${(r.passRate * 100).toFixed(2)}% Δ=${Δ.toFixed(2)}pp TL=${(r.tlRate * 100).toFixed(2)}% med=${r.engineMed}d`,
      );
      if (Δ >= 0.3) wins.push({ name, override, r });
    }

    log(`\n========== adaptiveSizing curves ==========`);
    for (const [name, curve] of [
      [
        "adaptive [0.5x@-2%, 1.5x@+3%, 0.5x@+8%]",
        [
          { equityAbove: -0.02, factor: 0.5 },
          { equityAbove: 0.03, factor: 1.5 },
          { equityAbove: 0.08, factor: 0.5 },
        ],
      ],
      [
        "adaptive [1.5x@+2%, 0.4x@+8%]",
        [
          { equityAbove: 0.02, factor: 1.5 },
          { equityAbove: 0.08, factor: 0.4 },
        ],
      ],
      [
        "adaptive [2x@+4%, 0.3x@+8%]",
        [
          { equityAbove: 0.04, factor: 2.0 },
          { equityAbove: 0.08, factor: 0.3 },
        ],
      ],
      [
        "adaptive [0.7x@-1%, 1.3x@+4%, 0.5x@+8%]",
        [
          { equityAbove: -0.01, factor: 0.7 },
          { equityAbove: 0.04, factor: 1.3 },
          { equityAbove: 0.08, factor: 0.5 },
        ],
      ],
    ] as const) {
      test(name, { adaptiveSizing: [...curve] });
    }

    log(`\n========== timeBoost ==========`);
    for (const [name, tb] of [
      [
        "timeBoost d4 below=0.04 f=2.0",
        { afterDay: 4, equityBelow: 0.04, factor: 2.0 },
      ],
      [
        "timeBoost d6 below=0.05 f=1.5",
        { afterDay: 6, equityBelow: 0.05, factor: 1.5 },
      ],
      [
        "timeBoost d3 below=0.03 f=2.5",
        { afterDay: 3, equityBelow: 0.03, factor: 2.5 },
      ],
      [
        "timeBoost d10 below=0.04 f=2.0",
        { afterDay: 10, equityBelow: 0.04, factor: 2.0 },
      ],
    ] as const) {
      test(name, { timeBoost: tb });
    }

    log(`\n========== kellySizing ==========`);
    for (const [name, ks] of [
      [
        "kelly w10 m5 [0.7→1.5, 0.5→1.0, 0→0.6]",
        {
          windowSize: 10,
          minTrades: 5,
          tiers: [
            { winRateAbove: 0.7, multiplier: 1.5 },
            { winRateAbove: 0.5, multiplier: 1.0 },
            { winRateAbove: 0, multiplier: 0.6 },
          ],
        },
      ],
      [
        "kelly w8 m4 [0.6→1.4, 0.4→1.0, 0→0.5]",
        {
          windowSize: 8,
          minTrades: 4,
          tiers: [
            { winRateAbove: 0.6, multiplier: 1.4 },
            { winRateAbove: 0.4, multiplier: 1.0 },
            { winRateAbove: 0, multiplier: 0.5 },
          ],
        },
      ],
      [
        "kelly w15 m8 [0.7→1.3, 0.5→1.0, 0→0.7]",
        {
          windowSize: 15,
          minTrades: 8,
          tiers: [
            { winRateAbove: 0.7, multiplier: 1.3 },
            { winRateAbove: 0.5, multiplier: 1.0 },
            { winRateAbove: 0, multiplier: 0.7 },
          ],
        },
      ],
    ] as const) {
      test(name, { kellySizing: ks as any });
    }

    log(`\n========== correlationFilter ==========`);
    for (const max of [2, 3, 4, 5]) {
      test(`correlation max=${max} same dir`, {
        correlationFilter: { maxOpenSameDirection: max },
      });
    }

    log(`\n========== COMBOS (best winners stacked) ==========`);
    if (wins.length >= 2) {
      // Top 3 wins combined
      wins.sort((a, b) => b.r.passRate - a.r.passRate);
      const top = wins.slice(0, 3);
      const combo = Object.assign({}, ...top.map((w) => w.override));
      test(`COMBO[${top.map((t) => t.name.split(" ")[0]).join("+")}]`, combo);
    }

    log(`\n========== SUMMARY ==========`);
    log(`Wins (≥+0.3pp): ${wins.length}`);
    if (wins.length > 0) {
      wins.sort((a, b) => b.r.passRate - a.r.passRate);
      log(`Top 5 individual:`);
      for (const w of wins.slice(0, 5)) {
        log(
          `  ${(w.r.passRate * 100).toFixed(2)}%  Δ=${((w.r.passRate - base.passRate) * 100).toFixed(2)}pp  ${w.name}`,
        );
      }
      writeFileSync(
        `${LOG_DIR}/V5_ENGINE_EXT_BEST.json`,
        JSON.stringify(wins[0], null, 2),
      );
    } else {
      log(`No engine extension helped V5. Plateau confirmed final.`);
    }

    expect(true).toBe(true);
  });
});
