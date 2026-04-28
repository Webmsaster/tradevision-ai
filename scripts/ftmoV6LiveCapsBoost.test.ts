/**
 * V6 Live-Caps Boost Sweep — push V6 (47.17%) higher under realistic live caps.
 * Apply liveCaps {maxStopPct=0.05, maxRiskFrac=0.4} to ALL variants.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V6_LIVECAPS_BOOST_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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
const ALL_HOURS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

describe("V6 Live-Caps Boost Sweep", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V6_LIVECAPS_BOOST START ${new Date().toISOString()}\n`,
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

    // ALL configs get live caps applied
    const V6_BASE: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
      liveCaps: LIVE_CAPS,
    };

    const base = evalCfg(V6_BASE);
    log(`========== V6 Baseline (with Live-Caps) ==========`);
    log(
      `V6 baseline: ${(base.passRate * 100).toFixed(2)}% (${base.passes}/${base.windows}) TL=${(base.tlRate * 100).toFixed(2)}% med=${base.engineMed}d\n`,
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
          ? override(V6_BASE)
          : { ...V6_BASE, ...override };
      const r = evalCfg(cfg);
      const Δ = (r.passRate - base.passRate) * 100;
      const tag = Δ >= 1.0 ? "🚀" : Δ >= 0.3 ? "✅" : Δ <= -0.3 ? "❌" : "·";
      log(
        `  ${tag} ${name.padEnd(45)} ${(r.passRate * 100).toFixed(2)}% Δ=${Δ.toFixed(2)}pp TL=${(r.tlRate * 100).toFixed(2)}% med=${r.engineMed}d`,
      );
      if (Δ >= 0.3) wins.push({ name, cfg, r });
    }

    log(`========== Hour-Filter Sweep (drop different hours) ==========`);
    // Drop pairs of hours
    for (let i = 0; i < ALL_HOURS.length; i++) {
      for (let j = i + 1; j < ALL_HOURS.length; j++) {
        const drop = [ALL_HOURS[i], ALL_HOURS[j]];
        const allowedHoursUtc = ALL_HOURS.filter((h) => !drop.includes(h));
        test(`drop hours [${drop.join(",")}]`, { allowedHoursUtc });
      }
    }

    log(`\n========== holdBars sweep ==========`);
    for (const h of [120, 180, 240, 300, 360, 480]) {
      test(`holdBars=${h}`, (c) => ({
        ...c,
        holdBars: h,
        assets: c.assets.map((a) => ({ ...a, holdBars: h })),
      }));
    }

    log(`\n========== triggerBars sweep ==========`);
    for (const tb of [1, 2, 3]) {
      test(`triggerBars=${tb}`, (c) => ({
        ...c,
        triggerBars: tb,
        assets: c.assets.map((a) => ({ ...a, triggerBars: tb })),
      }));
    }

    log(`\n========== adaptiveSizing curves ==========`);
    for (const [name, curve] of [
      [
        "adaptive [1.5x@+3, 0.5x@+8]",
        [
          { equityAbove: 0.03, factor: 1.5 },
          { equityAbove: 0.08, factor: 0.5 },
        ],
      ],
      [
        "adaptive [2x@+4, 0.4x@+8]",
        [
          { equityAbove: 0.04, factor: 2.0 },
          { equityAbove: 0.08, factor: 0.4 },
        ],
      ],
      [
        "adaptive [0.7x@-2, 1.4x@+3, 0.5x@+8]",
        [
          { equityAbove: -0.02, factor: 0.7 },
          { equityAbove: 0.03, factor: 1.4 },
          { equityAbove: 0.08, factor: 0.5 },
        ],
      ],
    ] as const) {
      test(name, { adaptiveSizing: [...curve] });
    }

    log(`\n========== timeBoost ==========`);
    for (const [name, tb] of [
      [
        "timeBoost d6 below=0.05 f=1.5",
        { afterDay: 6, equityBelow: 0.05, factor: 1.5 },
      ],
      [
        "timeBoost d4 below=0.04 f=2.0",
        { afterDay: 4, equityBelow: 0.04, factor: 2.0 },
      ],
      [
        "timeBoost d10 below=0.06 f=2.0",
        { afterDay: 10, equityBelow: 0.06, factor: 2.0 },
      ],
    ] as const) {
      test(name, { timeBoost: tb });
    }

    log(`\n========== breakEven + chandelier (engine fields) ==========`);
    for (const beAt of [0.02, 0.03, 0.04, 0.05]) {
      test(`breakEven@+${(beAt * 100).toFixed(0)}%`, {
        breakEven: { threshold: beAt },
      });
    }

    log(`\n========== Combos (top wins stacked) ==========`);
    if (wins.length >= 2) {
      const sorted = [...wins].sort((a, b) => b.r.passRate - a.r.passRate);
      for (const k of [2, 3]) {
        const top = sorted.slice(0, k);
        const combo = Object.assign(
          {},
          V6_BASE,
          ...top.map((w) => {
            const { liveCaps, ...rest } = w.cfg;
            return rest;
          }),
        );
        const r = evalCfg(combo);
        const Δ = (r.passRate - base.passRate) * 100;
        log(
          `  COMBO top-${k}: ${(r.passRate * 100).toFixed(2)}% Δ=${Δ.toFixed(2)}pp TL=${(r.tlRate * 100).toFixed(2)}%`,
        );
      }
    }

    log(`\n========== TOP 10 ==========`);
    wins.sort((a, b) => b.r.passRate - a.r.passRate);
    for (const w of wins.slice(0, 10)) {
      log(
        `  ${(w.r.passRate * 100).toFixed(2)}% Δ=${((w.r.passRate - base.passRate) * 100).toFixed(2)}pp TL=${(w.r.tlRate * 100).toFixed(2)}%  ${w.name}`,
      );
    }
    if (wins.length > 0) {
      writeFileSync(
        `${LOG_DIR}/V6_LIVECAPS_BOOST_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
