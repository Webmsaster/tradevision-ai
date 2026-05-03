/**
 * OVERNIGHT SWEEP R1 — TREND_2H_V5 → V7+
 *
 * Goal: beat current champion TREND_2H_V5 (44.57% / med 1d / p90 2d / TL 8 / EV $1684)
 *
 * Round-1 axes (cheap, high leverage):
 *   A: ADX filter sweep (period × minAdx)
 *   B: HTF Long-Confluence (lookback × threshold)
 *   C: maxConcurrentTrades
 *   D: trailing-stop fine-grain (act × trail)
 *   E: per-asset triggerBars (1/2/3 globally)
 *
 * Each round picks WINNER, feeds into next.
 * Score: pass-rate primary, p90 tiebreaker.
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

const TF_HOURS = 2;
const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R1_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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
  return `${label.padEnd(40)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

function score(a: BatchResult, b: BatchResult) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

const ASSET_SOURCES = [
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

describe("Overnight R1 — beat TREND_2H_V5", { timeout: 24 * 3600_000 }, () => {
  it("runs sequential sweeps until winner", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `OVERNIGHT R1 START ${new Date().toISOString()}\n`);

    log(`Loading 2h data for ${ASSET_SOURCES.length} assets...`);
    const data: Record<string, Candle[]> = {};
    for (const s of ASSET_SOURCES) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
      log(`  ${s}: ${data[s].length} bars`);
    }
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of ASSET_SOURCES) data[s] = data[s].slice(-n);
    log(
      `Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y) / ${ASSET_SOURCES.length} assets\n`,
    );

    let cur: FtmoDaytrade24hConfig = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5;
    const baseR = runWalkForward(data, cur);
    log(fmt("BASELINE V5", baseR));

    // ---- A: ADX filter ----
    log(`\n--- A: ADX filter sweep ---`);
    let aBest = { cfg: cur, r: baseR, label: "none" };
    for (const period of [8, 10, 14, 20, 28]) {
      for (const minAdx of [10, 12, 15, 18, 20, 25, 30]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          adxFilter: { period, minAdx },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, aBest.r) < 0) {
          aBest = { cfg, r, label: `adx p=${period} min=${minAdx}` };
          log(fmt(`  ${aBest.label}`, r));
        }
      }
    }
    log(fmt(`A WINNER (${aBest.label})`, aBest.r));
    cur = aBest.cfg;

    // ---- B: HTF Long-Confluence ----
    log(`\n--- B: HTF Long-Confluence ---`);
    let bBest = { cfg: cur, r: aBest.r, label: "none" };
    for (const lb of [12, 24, 48, 72, 120]) {
      for (const thr of [-0.02, 0, 0.01, 0.02, 0.05, 0.08]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          htfTrendFilter: { lookbackBars: lb, apply: "long", threshold: thr },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, bBest.r) < 0) {
          bBest = { cfg, r, label: `htf lb=${lb} thr=${thr}` };
          log(fmt(`  ${bBest.label}`, r));
        }
      }
    }
    log(fmt(`B WINNER (${bBest.label})`, bBest.r));
    cur = bBest.cfg;

    // ---- C: maxConcurrentTrades ----
    log(`\n--- C: maxConcurrentTrades ---`);
    let cBest = { cfg: cur, r: bBest.r, label: "6" };
    for (const cap of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const cfg: FtmoDaytrade24hConfig = { ...cur, maxConcurrentTrades: cap };
      const r = runWalkForward(data, cfg);
      if (score(r, cBest.r) < 0) {
        cBest = { cfg, r, label: `cap=${cap}` };
        log(fmt(`  ${cBest.label}`, r));
      }
    }
    log(fmt(`C WINNER (${cBest.label})`, cBest.r));
    cur = cBest.cfg;

    // ---- D: trailing-stop fine-grain ----
    log(`\n--- D: trailingStop fine-grain ---`);
    let dBest = { cfg: cur, r: cBest.r, label: "act=0.03 trail=0.005" };
    for (const act of [0.015, 0.02, 0.025, 0.03, 0.04, 0.05]) {
      for (const tr of [0.003, 0.005, 0.008, 0.012, 0.018, 0.025]) {
        if (tr >= act) continue;
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          trailingStop: { activatePct: act, trailPct: tr },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, dBest.r) < 0) {
          dBest = { cfg, r, label: `trail act=${act} tr=${tr}` };
          log(fmt(`  ${dBest.label}`, r));
        }
      }
    }
    log(fmt(`D WINNER (${dBest.label})`, dBest.r));
    cur = dBest.cfg;

    // ---- E: triggerBars ----
    log(`\n--- E: global triggerBars ---`);
    let eBest = { cfg: cur, r: dBest.r, label: "tb=1" };
    for (const tb of [1, 2, 3, 4]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...cur,
        triggerBars: tb,
        assets: cur.assets.map((a) => ({ ...a, triggerBars: tb })),
      };
      const r = runWalkForward(data, cfg);
      if (score(r, eBest.r) < 0) {
        eBest = { cfg, r, label: `tb=${tb}` };
        log(fmt(`  ${eBest.label}`, r));
      }
    }
    log(fmt(`E WINNER (${eBest.label})`, eBest.r));
    cur = eBest.cfg;

    log(`\n========== R1 FINAL ==========`);
    log(fmt("Baseline V5", baseR));
    log(fmt("After A (ADX)", aBest.r));
    log(fmt("After B (HTF)", bBest.r));
    log(fmt("After C (maxCon)", cBest.r));
    log(fmt("After D (trail)", dBest.r));
    log(fmt("After E (tb)", eBest.r));
    log(
      `\nΔ V5 → R1: +${((eBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    log(`\n--- FINAL CONFIG (paste-ready) ---`);
    log(
      JSON.stringify(
        {
          adxFilter: cur.adxFilter,
          htfTrendFilter: cur.htfTrendFilter,
          maxConcurrentTrades: cur.maxConcurrentTrades,
          trailingStop: cur.trailingStop,
          triggerBars: cur.triggerBars,
          assets_tb: cur.assets[0]?.triggerBars,
        },
        null,
        2,
      ),
    );

    writeFileSync(
      `${LOG_DIR}/R1_FINAL_CONFIG.json`,
      JSON.stringify(cur, null, 2),
    );

    expect(eBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
