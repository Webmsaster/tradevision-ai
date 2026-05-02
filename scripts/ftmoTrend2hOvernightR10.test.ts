/**
 * R10 — chase the 46.20% peak from R8 ablation
 *
 * Key R8 finding: V7 + BTC-CAF + universal tp=0.07 = 46.20% (310/671)
 * R9 clean V5+ADX+CAF only got 45.60%.
 *
 * Build properly:
 *   V7 (with filters) + BTC CAF + force universal tp=0.07
 * Then sweep tp/sp universally.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V7,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R10_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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
  return a.p90Days - b.p90Days;
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

describe("R10 — V7+CAF+uniform tp", { timeout: 24 * 3600_000 }, () => {
  it("runs R10", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R10 START ${new Date().toISOString()}\n`);

    log(`Loading 2h data...`);
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
    log(`Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

    const v5R = runWalkForward(data, FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5);
    log(fmt("V5 baseline", v5R));

    // Build: V7 base + BTC CAF + uniform tp=0.07
    const candidate: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V7,
      assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V7.assets.map((a) => ({
        ...a,
        tpPct: 0.07,
      })),
      crossAssetFilter: {
        symbol: "BTCUSDT",
        emaFastPeriod: 4,
        emaSlowPeriod: 12,
        skipLongsIfSecondaryDowntrend: false,
        momentumBars: 24,
        momSkipLongBelow: -0.02,
      },
    };
    const baseR = runWalkForward(data, candidate);
    log(fmt("V7+CAF+tp=0.07 (R8 ablation peak)", baseR));

    let cur = JSON.parse(JSON.stringify(candidate)) as FtmoDaytrade24hConfig;

    // 10A: universal tp sweep
    log(`\n--- 10A: universal tp sweep ---`);
    let aBest = { cfg: cur, r: baseR, label: "tp=0.07" };
    for (const tp of [
      0.05, 0.055, 0.06, 0.065, 0.07, 0.075, 0.08, 0.09, 0.1, 0.12,
    ]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...cur,
        tpPct: tp,
        assets: cur.assets.map((a) => ({ ...a, tpPct: tp })),
      };
      const r = runWalkForward(data, cfg);
      if (score(r, aBest.r) < 0) {
        aBest = { cfg, r, label: `tp=${tp}` };
        log(fmt(`  ${aBest.label}`, r));
      }
    }
    log(fmt(`10A WINNER (${aBest.label})`, aBest.r));
    cur = aBest.cfg;

    // 10B: universal sp sweep
    log(`\n--- 10B: universal sp sweep ---`);
    let bBest = { cfg: cur, r: aBest.r, label: "sp=0.05" };
    for (const sp of [0.03, 0.035, 0.04, 0.045, 0.05]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...cur,
        stopPct: sp,
        assets: cur.assets.map((a) => ({ ...a, stopPct: sp })),
      };
      const r = runWalkForward(data, cfg);
      if (score(r, bBest.r) < 0) {
        bBest = { cfg, r, label: `sp=${sp}` };
        log(fmt(`  ${bBest.label}`, r));
      }
    }
    log(fmt(`10B WINNER (${bBest.label})`, bBest.r));
    cur = bBest.cfg;

    // 10C: re-run filter ablation now (which features still hurt?)
    log(`\n--- 10C: filter ablation re-test ---`);
    const ablations = [
      { name: "no LSC", cfg: { ...cur, lossStreakCooldown: undefined } },
      { name: "no ADX", cfg: { ...cur, adxFilter: undefined } },
      { name: "no HTF", cfg: { ...cur, htfTrendFilter: undefined } },
      { name: "no chand", cfg: { ...cur, chandelierExit: undefined } },
      { name: "no chop", cfg: { ...cur, choppinessFilter: undefined } },
      { name: "no trail", cfg: { ...cur, trailingStop: undefined } },
      { name: "no CAF", cfg: { ...cur, crossAssetFilter: undefined } },
    ];
    let absBest = { cfg: cur, r: bBest.r, label: "current" };
    for (const a of ablations) {
      const r = runWalkForward(data, a.cfg);
      const tag = score(r, absBest.r) < 0 ? "BETTER" : "worse";
      log(fmt(`  ${a.name} [${tag}]`, r));
      if (score(r, absBest.r) < 0) {
        absBest = { cfg: a.cfg, r, label: a.name };
      }
    }
    cur = absBest.cfg;
    log(fmt(`10C WINNER (${absBest.label})`, absBest.r));

    // 10D: BTC CAF re-tune AGAIN with new base
    log(`\n--- 10D: BTC CAF re-tune ---`);
    let dBest = { cfg: cur, r: absBest.r, label: "current" };
    for (const fast of [4, 6, 8, 12]) {
      for (const slow of [12, 16, 24, 36, 48, 72]) {
        if (slow <= fast) continue;
        for (const mb of [12, 18, 24, 36, 48, 72]) {
          for (const ml of [-0.05, -0.03, -0.02, -0.01, 0]) {
            const cfg: FtmoDaytrade24hConfig = {
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
    log(fmt(`10D WINNER (${dBest.label})`, dBest.r));
    cur = dBest.cfg;

    // 10E: ADX re-tune
    log(`\n--- 10E: ADX re-tune ---`);
    let eBest = { cfg: cur, r: dBest.r, label: "current" };
    for (const period of [6, 8, 10, 14, 20, 28]) {
      for (const minAdx of [5, 8, 10, 12, 15, 18, 20, 25]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          adxFilter: { period, minAdx },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, eBest.r) < 0) {
          eBest = { cfg, r, label: `adx p=${period} m=${minAdx}` };
          log(fmt(`  ${eBest.label}`, r));
        }
      }
    }
    log(fmt(`10E WINNER (${eBest.label})`, eBest.r));
    cur = eBest.cfg;

    // 10F: trailing re-tune
    log(`\n--- 10F: trailing re-tune ---`);
    let fBest = { cfg: cur, r: eBest.r, label: "current" };
    for (const act of [0.015, 0.02, 0.025, 0.03, 0.04, 0.05]) {
      for (const tr of [0.002, 0.003, 0.005, 0.008, 0.012, 0.018, 0.025]) {
        if (tr >= act) continue;
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          trailingStop: { activatePct: act, trailPct: tr },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, fBest.r) < 0) {
          fBest = { cfg, r, label: `trail act=${act} tr=${tr}` };
          log(fmt(`  ${fBest.label}`, r));
        }
      }
    }
    log(fmt(`10F WINNER (${fBest.label})`, fBest.r));
    cur = fBest.cfg;

    log(`\n========== R10 FINAL ==========`);
    log(fmt("V5 baseline", v5R));
    log(fmt("V7+CAF+tp=0.07 base", baseR));
    log(fmt("After 10A (uni tp)", aBest.r));
    log(fmt("After 10B (uni sp)", bBest.r));
    log(fmt("After 10C (ablation)", absBest.r));
    log(fmt("After 10D (CAF retune)", dBest.r));
    log(fmt("After 10E (ADX retune)", eBest.r));
    log(fmt("After 10F (trail retune)", fBest.r));
    log(
      `\nΔ V5 → R10: +${((fBest.r.passRate - v5R.passRate) * 100).toFixed(2)}pp`,
    );

    writeFileSync(
      `${LOG_DIR}/R10_FINAL_CONFIG.json`,
      JSON.stringify(cur, null, 2),
    );

    expect(fBest.r.passRate).toBeGreaterThanOrEqual(v5R.passRate);
  });
});
