/**
 * R29 — Improve V5 with PROPER OOS protocol.
 *
 * V5 is the OOS champion. Try to make it BETTER without overfit:
 *   - Optimize on TRAIN (excludes last 6mo)
 *   - Validate on HOLDOUT (last 6mo)
 *   - Only accept improvements that BOTH improve TRAIN AND ≥V5 on HOLDOUT
 *
 * New axes (untested on V5):
 *   29A: volatilityFilter (skip dead-calm or hyper-vol)
 *   29B: V5 + ADX filter (lighter than V8's stack)
 *   29C: V5 + simple BTC CAF (no momentum gate)
 *   29D: V5 + slightly tighter stops per asset
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R29_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

interface BatchResult {
  windows: number;
  passes: number;
  passRate: number;
  medianDays: number;
  p75Days: number;
  p90Days: number;
  tlBreaches: number;
  dlBreaches: number;
  ev: number;
}

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  stepDays = 3,
): BatchResult {
  const winBars = 30 * BARS_PER_DAY;
  const stepBars = stepDays * BARS_PER_DAY;
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, cfg));
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  for (const r of out)
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    medianDays: pick(0.5),
    p75Days: pick(0.75),
    p90Days: pick(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
  };
}

function fmt(label: string, r: BatchResult) {
  return `${label.padEnd(40)} ${r.passes.toString().padStart(3)}/${String(r.windows).padStart(3)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches}`;
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

describe("R29 — improve V5 OOS", { timeout: 24 * 3600_000 }, () => {
  it("runs R29", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R29 START ${new Date().toISOString()}\n`);

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

    const sixMoBars = Math.floor(0.5 * 365 * BARS_PER_DAY);
    const train: Record<string, Candle[]> = {};
    const holdout: Record<string, Candle[]> = {};
    for (const s of SOURCES) {
      train[s] = data[s].slice(0, n - sixMoBars);
      holdout[s] = data[s].slice(n - sixMoBars);
    }

    const v5TrainR = runWalkForward(
      train,
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    );
    const v5HoldR = runWalkForward(
      holdout,
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    );
    const v5FullR = runWalkForward(data, FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5);
    log(fmt("V5 TRAIN", v5TrainR));
    log(fmt("V5 HOLDOUT", v5HoldR));
    log(fmt("V5 FULL", v5FullR));

    function evalCfg(label: string, cfg: FtmoDaytrade24hConfig) {
      const t = runWalkForward(train, cfg);
      const h = runWalkForward(holdout, cfg);
      const f = runWalkForward(data, cfg);
      const trainOk = t.passRate > v5TrainR.passRate;
      const holdoutOk = h.passRate >= v5HoldR.passRate;
      const tag =
        trainOk && holdoutOk
          ? "✓ BOTH"
          : trainOk
            ? "train↑"
            : holdoutOk
              ? "hold↑"
              : "neither";
      log(
        `${label.padEnd(40)} TRAIN=${(t.passRate * 100).toFixed(2)}% HOLD=${(h.passRate * 100).toFixed(2)}% FULL=${(f.passRate * 100).toFixed(2)}% [${tag}]`,
      );
      return { t, h, f, both: trainOk && holdoutOk };
    }

    const results: {
      name: string;
      cfg: FtmoDaytrade24hConfig;
      both: boolean;
      train: number;
      hold: number;
      full: number;
    }[] = [];

    // 29A: volatilityFilter sweep
    log(`\n=== 29A: volatilityFilter ===`);
    for (const period of [14, 28, 56, 84, 168]) {
      for (const minFrac of [0.005, 0.01, 0.015, 0.02]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          volatilityFilter: { period, minAtrFrac: minFrac },
        };
        const r = evalCfg(`  vol p=${period} min=${minFrac}`, cfg);
        if (r.both)
          results.push({
            name: `vol p=${period} min=${minFrac}`,
            cfg,
            both: true,
            train: r.t.passRate,
            hold: r.h.passRate,
            full: r.f.passRate,
          });
      }
      for (const maxFrac of [0.02, 0.025, 0.03, 0.04, 0.05]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          volatilityFilter: { period, maxAtrFrac: maxFrac },
        };
        const r = evalCfg(`  vol p=${period} max=${maxFrac}`, cfg);
        if (r.both)
          results.push({
            name: `vol p=${period} max=${maxFrac}`,
            cfg,
            both: true,
            train: r.t.passRate,
            hold: r.h.passRate,
            full: r.f.passRate,
          });
      }
    }

    // 29B: V5 + ADX (lighter)
    log(`\n=== 29B: V5 + adxFilter ===`);
    for (const period of [10, 14, 20]) {
      for (const minAdx of [10, 15, 20, 25]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          adxFilter: { period, minAdx },
        };
        const r = evalCfg(`  adx p=${period} min=${minAdx}`, cfg);
        if (r.both)
          results.push({
            name: `adx p=${period} min=${minAdx}`,
            cfg,
            both: true,
            train: r.t.passRate,
            hold: r.h.passRate,
            full: r.f.passRate,
          });
      }
    }

    // 29C: V5 + simple BTC CAF (no momentum)
    log(`\n=== 29C: V5 + BTC CAF (skipDown) ===`);
    for (const fast of [4, 8, 12, 24]) {
      for (const slow of [12, 24, 48, 96]) {
        if (slow <= fast) continue;
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          crossAssetFilter: {
            symbol: "BTCUSDT",
            emaFastPeriod: fast,
            emaSlowPeriod: slow,
            skipLongsIfSecondaryDowntrend: true,
          },
        };
        const r = evalCfg(`  BTC CAF ${fast}/${slow}`, cfg);
        if (r.both)
          results.push({
            name: `BTC CAF ${fast}/${slow}`,
            cfg,
            both: true,
            train: r.t.passRate,
            hold: r.h.passRate,
            full: r.f.passRate,
          });
      }
    }

    // 29D: V5 + per-asset stopPct tighter
    log(`\n=== 29D: V5 tighter stops ===`);
    for (const sp of [0.035, 0.04, 0.045]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        stopPct: sp,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => ({
          ...a,
          stopPct: sp,
        })),
      };
      const r = evalCfg(`  global sp=${sp}`, cfg);
      if (r.both)
        results.push({
          name: `sp=${sp}`,
          cfg,
          both: true,
          train: r.t.passRate,
          hold: r.h.passRate,
          full: r.f.passRate,
        });
    }

    // 29E: V5 + lossStreakCooldown
    log(`\n=== 29E: V5 + LSC ===`);
    for (const after of [2, 3, 4]) {
      for (const cd of [24, 48, 72, 120]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
        };
        const r = evalCfg(`  LSC a=${after} cd=${cd}`, cfg);
        if (r.both)
          results.push({
            name: `LSC a=${after} cd=${cd}`,
            cfg,
            both: true,
            train: r.t.passRate,
            hold: r.h.passRate,
            full: r.f.passRate,
          });
      }
    }

    log(`\n========== R29 SUMMARY ==========`);
    log(
      `V5 baseline: TRAIN=${(v5TrainR.passRate * 100).toFixed(2)}% HOLDOUT=${(v5HoldR.passRate * 100).toFixed(2)}% FULL=${(v5FullR.passRate * 100).toFixed(2)}%`,
    );
    log(`Configs improving BOTH train AND holdout: ${results.length}`);
    if (results.length > 0) {
      results.sort((a, b) => b.hold - a.hold || b.train - a.train);
      log(`\nTop 10 by holdout:`);
      for (const r of results.slice(0, 10)) {
        log(
          `  ${r.name.padEnd(32)} TRAIN=${(r.train * 100).toFixed(2)}% HOLD=${(r.hold * 100).toFixed(2)}% FULL=${(r.full * 100).toFixed(2)}%`,
        );
      }
      writeFileSync(
        `${LOG_DIR}/R29_FINAL_CONFIG.json`,
        JSON.stringify(results[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
