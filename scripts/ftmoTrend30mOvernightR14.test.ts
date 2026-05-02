/**
 * R14 — 30m TREND with full history (chase 47.24% from R13 with proper sample)
 *
 * R13 hint: 30m on 199 windows = 47.24%. Need ≥500 windows for confidence.
 * Increase maxPages=200 → ~96000 bars = 5.5y on 30m.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const TF_HOURS = 0.5;
const BARS_PER_DAY = 48;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R14_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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
  return `${label.padEnd(45)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

function score(a: BatchResult, b: BatchResult) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.tlBreaches - b.tlBreaches;
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

describe("R14 — 30m TREND full history", { timeout: 24 * 3600_000 }, () => {
  it("runs R14", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R14 START ${new Date().toISOString()}\n`);

    log(`Loading 30m data with maxPages=200...`);
    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "30m",
        targetCount: 100000,
        maxPages: 200,
      });
      const yrs = (data[s].length / BARS_PER_DAY / 365).toFixed(2);
      log(`  ${s}: ${data[s].length} bars (${yrs}y)`);
    }
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of SOURCES) data[s] = data[s].slice(-n);
    log(`Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

    // Adapt V8 config for 30m: holdBars 240(2h) → 960(30m) = 20 days
    const v8For30m: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
      timeframe: "30m" as any,
      holdBars: 960,
      assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8.assets.map((a) => ({
        ...a,
        holdBars: 960,
      })),
    };
    const baseR = runWalkForward(data, v8For30m);
    log(fmt("V8 30m base (hb=960)", baseR));

    // Also test V5-style on 30m for comparison
    const v5For30m: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      timeframe: "30m" as any,
      holdBars: 960,
      assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => ({
        ...a,
        holdBars: 960,
      })),
    };
    const v5R = runWalkForward(data, v5For30m);
    log(fmt("V5 30m base", v5R));

    let cur = JSON.parse(JSON.stringify(v8For30m)) as FtmoDaytrade24hConfig;
    let best = { cfg: cur, r: baseR, label: "V8-30m" };

    // 14A: holdBars sweep (30m needs different scale)
    log(`\n--- 14A: 30m holdBars ---`);
    for (const hb of [240, 480, 720, 960, 1200, 1440, 1920, 2400]) {
      const cfg = {
        ...cur,
        holdBars: hb,
        assets: cur.assets.map((a) => ({ ...a, holdBars: hb })),
      };
      const r = runWalkForward(data, cfg);
      if (score(r, best.r) < 0) {
        best = { cfg, r, label: `hb=${hb}` };
        log(fmt(`  ${best.label}`, r));
      }
    }
    cur = best.cfg;
    log(fmt(`14A WINNER`, best.r));

    // 14B: triggerBars (on 30m, more bars confirms trend better)
    log(`\n--- 14B: triggerBars ---`);
    let bBest = { cfg: cur, r: best.r };
    for (const tb of [1, 2, 3, 4, 6, 8]) {
      const cfg = {
        ...cur,
        triggerBars: tb,
        assets: cur.assets.map((a) => ({ ...a, triggerBars: tb })),
      };
      const r = runWalkForward(data, cfg);
      if (score(r, bBest.r) < 0) {
        bBest = { cfg, r };
        log(fmt(`  tb=${tb}`, r));
      }
    }
    cur = bBest.cfg;
    log(fmt(`14B WINNER`, bBest.r));

    // 14C: ADX re-tune for 30m
    log(`\n--- 14C: ADX 30m ---`);
    let cBest = { cfg: cur, r: bBest.r, label: "current" };
    for (const period of [8, 14, 20, 28, 40]) {
      for (const minAdx of [8, 10, 12, 15, 18, 20]) {
        const cfg = { ...cur, adxFilter: { period, minAdx } };
        const r = runWalkForward(data, cfg);
        if (score(r, cBest.r) < 0) {
          cBest = { cfg, r, label: `adx ${period}/${minAdx}` };
          log(fmt(`  ${cBest.label}`, r));
        }
      }
    }
    cur = cBest.cfg;
    log(fmt(`14C WINNER (${cBest.label})`, cBest.r));

    // 14D: BTC CAF re-tune (different periods on 30m)
    log(`\n--- 14D: BTC CAF 30m ---`);
    let dBest = { cfg: cur, r: cBest.r, label: "current" };
    for (const fast of [12, 24, 48, 96]) {
      for (const slow of [48, 96, 168, 240]) {
        if (slow <= fast) continue;
        for (const mb of [48, 96, 192, 288]) {
          for (const ml of [-0.05, -0.03, -0.02, -0.01, 0]) {
            const cfg = {
              ...cur,
              crossAssetFilter: {
                symbol: "BTCUSDT",
                emaFastPeriod: fast,
                emaSlowPeriod: slow,
                skipLongsIfSecondaryDowntrend: false,
                momentumBars: mb,
                momSkipLongBelow: ml,
              },
            };
            const r = runWalkForward(data, cfg);
            if (score(r, dBest.r) < 0) {
              dBest = {
                cfg,
                r,
                label: `BTC ${fast}/${slow} mb=${mb} ml=${ml}`,
              };
              log(fmt(`  ${dBest.label}`, r));
            }
          }
        }
      }
    }
    cur = dBest.cfg;
    log(fmt(`14D WINNER (${dBest.label})`, dBest.r));

    // 14E: stopPct/tpPct sweep
    log(`\n--- 14E: stopPct/tpPct ---`);
    let eBest = { cfg: cur, r: dBest.r, label: "current" };
    for (const sp of [0.03, 0.04, 0.05]) {
      for (const tp of [0.05, 0.06, 0.07, 0.08, 0.1]) {
        if (tp <= sp) continue;
        const cfg = {
          ...cur,
          stopPct: sp,
          tpPct: tp,
          assets: cur.assets.map((a) => ({ ...a, stopPct: sp, tpPct: tp })),
        };
        const r = runWalkForward(data, cfg);
        if (score(r, eBest.r) < 0) {
          eBest = { cfg, r, label: `sp=${sp} tp=${tp}` };
          log(fmt(`  ${eBest.label}`, r));
        }
      }
    }
    cur = eBest.cfg;
    log(fmt(`14E WINNER (${eBest.label})`, eBest.r));

    log(`\n========== R14 FINAL (30m) ==========`);
    log(fmt("V8 30m baseline", baseR));
    log(fmt("V5 30m baseline", v5R));
    log(fmt("After 14A (hb)", best.r));
    log(fmt("After 14B (tb)", bBest.r));
    log(fmt("After 14C (adx)", cBest.r));
    log(fmt("After 14D (CAF)", dBest.r));
    log(fmt("After 14E (sp/tp)", eBest.r));
    log(
      `\nΔ V8 30m → R14: +${((eBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    writeFileSync(
      `${LOG_DIR}/R14_FINAL_CONFIG.json`,
      JSON.stringify(cur, null, 2),
    );

    expect(eBest.r.passRate).toBeGreaterThan(0);
  });
});
