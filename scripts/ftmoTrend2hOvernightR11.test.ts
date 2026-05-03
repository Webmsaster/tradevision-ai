/**
 * R11 — push V8 with safety/diversification axes
 *
 * V8 has TL=19 (vs V5's TL=8) — needs safety work.
 *
 * 11A: peakDrawdownThrottle (cap risk after drawdown peak)
 * 11B: drawdownShield (cut size when below threshold)
 * 11C: dailyGainCap (lock in gains)
 * 11D: stricter max daily-loss enforcement (per-asset stops)
 * 11E: ensemble — add 4h-Trend-V2 as parallel asset class
 * 11F: try second cross-asset gate (ETH down → skip)
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R11_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe("R11 — V8 safety + push", { timeout: 24 * 3600_000 }, () => {
  it("runs R11", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R11 START ${new Date().toISOString()}\n`);

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

    let cur: FtmoDaytrade24hConfig = JSON.parse(
      JSON.stringify(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8),
    );
    const baseR = runWalkForward(data, cur);
    log(fmt("R11 BASELINE V8", baseR));

    // 11A: peakDrawdownThrottle
    log(`\n--- 11A: peakDrawdownThrottle ---`);
    let aBest = { cfg: cur, r: baseR, label: "off" };
    for (const fp of [0.01, 0.02, 0.03, 0.05, 0.08]) {
      for (const f of [0.2, 0.3, 0.5, 0.7]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          peakDrawdownThrottle: { fromPeak: fp, factor: f },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, aBest.r) < 0) {
          aBest = { cfg, r, label: `peak fp=${fp} f=${f}` };
          log(fmt(`  ${aBest.label}`, r));
        }
      }
    }
    log(fmt(`11A WINNER (${aBest.label})`, aBest.r));
    cur = aBest.cfg;

    // 11B: drawdownShield
    log(`\n--- 11B: drawdownShield ---`);
    let bBest = { cfg: cur, r: aBest.r, label: "off" };
    for (const be of [-0.08, -0.05, -0.03, -0.02, -0.01]) {
      for (const f of [0.2, 0.3, 0.5, 0.7]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          drawdownShield: { belowEquity: be, factor: f },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, bBest.r) < 0) {
          bBest = { cfg, r, label: `dd be=${be} f=${f}` };
          log(fmt(`  ${bBest.label}`, r));
        }
      }
    }
    log(fmt(`11B WINNER (${bBest.label})`, bBest.r));
    cur = bBest.cfg;

    // 11C: dailyGainCap
    log(`\n--- 11C: dailyGainCap ---`);
    let cBest = { cfg: cur, r: bBest.r, label: "off" };
    for (const cap of [0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.07]) {
      const cfg: FtmoDaytrade24hConfig = { ...cur, dailyGainCap: cap };
      const r = runWalkForward(data, cfg);
      if (score(r, cBest.r) < 0) {
        cBest = { cfg, r, label: `dGain=${cap}` };
        log(fmt(`  ${cBest.label}`, r));
      }
    }
    log(fmt(`11C WINNER (${cBest.label})`, cBest.r));
    cur = cBest.cfg;

    // 11D: maxConcurrent restriction (lower)
    log(`\n--- 11D: maxConcurrent reduce ---`);
    let dBest = { cfg: cur, r: cBest.r, label: "6" };
    for (const cap of [2, 3, 4, 5]) {
      const cfg: FtmoDaytrade24hConfig = { ...cur, maxConcurrentTrades: cap };
      const r = runWalkForward(data, cfg);
      if (score(r, dBest.r) < 0) {
        dBest = { cfg, r, label: `cap=${cap}` };
        log(fmt(`  ${dBest.label}`, r));
      }
    }
    log(fmt(`11D WINNER (${dBest.label})`, dBest.r));
    cur = dBest.cfg;

    // 11E: ETH-down extra cross-asset filter
    log(`\n--- 11E: ETH crossAssetExtra (skip if ETH down) ---`);
    let eBest = { cfg: cur, r: dBest.r, label: "off" };
    for (const fast of [4, 8, 12]) {
      for (const slow of [12, 24, 48]) {
        if (slow <= fast) continue;
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          crossAssetFiltersExtra: [
            {
              symbol: "ETHUSDT",
              emaFastPeriod: fast,
              emaSlowPeriod: slow,
              skipLongsIfSecondaryDowntrend: true,
            },
          ],
        };
        const r = runWalkForward(data, cfg);
        if (score(r, eBest.r) < 0) {
          eBest = { cfg, r, label: `ETH ${fast}/${slow}` };
          log(fmt(`  ${eBest.label}`, r));
        }
      }
    }
    log(fmt(`11E WINNER (${eBest.label})`, eBest.r));
    cur = eBest.cfg;

    // 11F: BTC absolute downtrend gate (skipDown=true)
    log(`\n--- 11F: BTC skipDown=true variant ---`);
    let fBest = { cfg: cur, r: eBest.r, label: "off" };
    for (const fast of [4, 8, 12, 24]) {
      for (const slow of [12, 24, 48, 96]) {
        if (slow <= fast) continue;
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          crossAssetFilter: {
            ...(cur.crossAssetFilter as any),
            emaFastPeriod: fast,
            emaSlowPeriod: slow,
            skipLongsIfSecondaryDowntrend: true,
          },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, fBest.r) < 0) {
          fBest = { cfg, r, label: `BTC skipDown ${fast}/${slow}` };
          log(fmt(`  ${fBest.label}`, r));
        }
      }
    }
    log(fmt(`11F WINNER (${fBest.label})`, fBest.r));
    cur = fBest.cfg;

    // 11G: BTC stronger momentum gate
    log(`\n--- 11G: BTC mom stricter ---`);
    let gBest = { cfg: cur, r: fBest.r, label: "current" };
    if (cur.crossAssetFilter) {
      for (const mb of [12, 24, 36, 48, 72, 96]) {
        for (const ml of [-0.05, -0.03, -0.025, -0.02, -0.015, -0.01, 0]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            crossAssetFilter: {
              ...cur.crossAssetFilter,
              momentumBars: mb,
              momSkipLongBelow: ml,
            },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, gBest.r) < 0) {
            gBest = { cfg, r, label: `mb=${mb} ml=${ml}` };
            log(fmt(`  ${gBest.label}`, r));
          }
        }
      }
    }
    log(fmt(`11G WINNER (${gBest.label})`, gBest.r));
    cur = gBest.cfg;

    log(`\n========== R11 FINAL ==========`);
    log(fmt("R11 baseline V8", baseR));
    log(fmt("After 11A (peak)", aBest.r));
    log(fmt("After 11B (DD shield)", bBest.r));
    log(fmt("After 11C (dGain)", cBest.r));
    log(fmt("After 11D (concurrent)", dBest.r));
    log(fmt("After 11E (ETH extra)", eBest.r));
    log(fmt("After 11F (BTC skipDown)", fBest.r));
    log(fmt("After 11G (BTC mom)", gBest.r));
    log(
      `\nΔ V8 → R11: +${((gBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    writeFileSync(
      `${LOG_DIR}/R11_FINAL_CONFIG.json`,
      JSON.stringify(cur, null, 2),
    );

    expect(gBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
