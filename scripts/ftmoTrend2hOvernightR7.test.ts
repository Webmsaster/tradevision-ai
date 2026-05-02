/**
 * R7 — push beyond V7
 *
 * HH: per-asset holdBars (each asset gets own optimal)
 * II: per-asset riskFrac
 * JJ: re-test atrStop AFTER V7 stack
 * KK: re-test choppiness deeper grid
 * LL: re-test HTF deeper (lb=100..500)
 * MM: combined: ADX + HTF + chop joint re-tune
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V7,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import {
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R7_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe("R7 — per-asset deep tuning", { timeout: 24 * 3600_000 }, () => {
  it("runs R7", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R7 START ${new Date().toISOString()}\n`);

    log(`Loading 2h data...`);
    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
      log(`  ${s}: ${data[s].length} bars`);
    }
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of SOURCES) data[s] = data[s].slice(-n);
    log(`Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

    let cur: FtmoDaytrade24hConfig = JSON.parse(
      JSON.stringify(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V7),
    );
    const baseR = runWalkForward(data, cur);
    log(fmt("R7 BASELINE V7", baseR));

    // HH: per-asset holdBars
    log(`\n--- HH: per-asset holdBars ---`);
    let hhBest = { cfg: cur, r: baseR };
    for (const a of hhBest.cfg.assets) {
      let aBest = { cfg: hhBest.cfg, r: hhBest.r, hb: a.holdBars };
      for (const hb of [60, 120, 180, 240, 360, 480]) {
        const trial = {
          ...hhBest.cfg,
          assets: hhBest.cfg.assets.map((x) =>
            x.symbol === a.symbol ? { ...x, holdBars: hb } : x,
          ),
        };
        const r = runWalkForward(data, trial);
        if (score(r, aBest.r) < 0) {
          aBest = { cfg: trial, r, hb };
        }
      }
      if (score(aBest.r, hhBest.r) < 0) {
        hhBest = { cfg: aBest.cfg, r: aBest.r };
        log(fmt(`  ${a.symbol} hb=${aBest.hb}`, aBest.r));
      }
    }
    log(fmt(`HH WINNER`, hhBest.r));
    cur = hhBest.cfg;

    // II: per-asset riskFrac
    log(`\n--- II: per-asset riskFrac ---`);
    let iiBest = { cfg: cur, r: hhBest.r };
    for (const a of iiBest.cfg.assets) {
      let aBest = { cfg: iiBest.cfg, r: iiBest.r, rf: a.riskFrac };
      for (const rf of [0.5, 0.7, 1.0, 1.2, 1.5]) {
        const trial = {
          ...iiBest.cfg,
          assets: iiBest.cfg.assets.map((x) =>
            x.symbol === a.symbol ? { ...x, riskFrac: rf } : x,
          ),
        };
        const r = runWalkForward(data, trial);
        if (score(r, aBest.r) < 0) {
          aBest = { cfg: trial, r, rf };
        }
      }
      if (score(aBest.r, iiBest.r) < 0) {
        iiBest = { cfg: aBest.cfg, r: aBest.r };
        log(fmt(`  ${a.symbol} rf=${aBest.rf}`, aBest.r));
      }
    }
    log(fmt(`II WINNER`, iiBest.r));
    cur = iiBest.cfg;

    // JJ: re-test atrStop with V7 stack
    log(`\n--- JJ: atrStop re-test ---`);
    let jjBest = { cfg: cur, r: iiBest.r, label: "off" };
    for (const period of [14, 28, 56, 84, 168]) {
      for (const mult of [1.5, 2, 2.5, 3, 3.5, 4, 5, 6]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          atrStop: { period, stopMult: mult },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, jjBest.r) < 0) {
          jjBest = { cfg, r, label: `atr p=${period} m=${mult}` };
          log(fmt(`  ${jjBest.label}`, r));
        }
      }
    }
    log(fmt(`JJ WINNER (${jjBest.label})`, jjBest.r));
    cur = jjBest.cfg;

    // KK: deeper choppiness grid
    log(`\n--- KK: choppiness deeper ---`);
    let kkBest = { cfg: cur, r: jjBest.r, label: "current" };
    for (const period of [8, 10, 14, 20, 28, 40]) {
      for (const maxCi of [55, 60, 65, 68, 70, 72, 75, 78, 82]) {
        for (const minCi of [undefined, 30, 35, 40]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            choppinessFilter: {
              period,
              maxCi,
              ...(minCi !== undefined ? { minCi } : {}),
            },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, kkBest.r) < 0) {
            kkBest = {
              cfg,
              r,
              label: `chop p=${period} max=${maxCi} min=${minCi}`,
            };
            log(fmt(`  ${kkBest.label}`, r));
          }
        }
      }
    }
    log(fmt(`KK WINNER (${kkBest.label})`, kkBest.r));
    cur = kkBest.cfg;

    // LL: HTF deeper (long lookbacks)
    log(`\n--- LL: HTF deeper ---`);
    let llBest = { cfg: cur, r: kkBest.r, label: "current" };
    for (const lb of [100, 168, 240, 336, 500, 720]) {
      for (const thr of [-0.05, 0, 0.05, 0.1, 0.15, 0.2]) {
        for (const apply of ["long", "both"] as const) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            htfTrendFilter: { lookbackBars: lb, apply, threshold: thr },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, llBest.r) < 0) {
            llBest = { cfg, r, label: `htf ${apply} lb=${lb} thr=${thr}` };
            log(fmt(`  ${llBest.label}`, r));
          }
        }
      }
    }
    log(fmt(`LL WINNER (${llBest.label})`, llBest.r));
    cur = llBest.cfg;

    // MM: ADX + HTF + chop joint re-tune
    log(`\n--- MM: ADX+HTF+chop joint ---`);
    let mmBest = { cfg: cur, r: llBest.r, label: "current" };
    for (const adxP of [10, 14, 20]) {
      for (const adxM of [10, 15, 20]) {
        for (const cmax of [65, 70, 75, 78]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            adxFilter: { period: adxP, minAdx: adxM },
            choppinessFilter: { period: 10, maxCi: cmax },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, mmBest.r) < 0) {
            mmBest = { cfg, r, label: `adx ${adxP}/${adxM} chop ${cmax}` };
            log(fmt(`  ${mmBest.label}`, r));
          }
        }
      }
    }
    log(fmt(`MM WINNER (${mmBest.label})`, mmBest.r));
    cur = mmBest.cfg;

    log(`\n========== R7 FINAL ==========`);
    log(fmt("R7 baseline V7", baseR));
    log(fmt("After HH (hb)", hhBest.r));
    log(fmt("After II (rf)", iiBest.r));
    log(fmt("After JJ (atr)", jjBest.r));
    log(fmt("After KK (chop)", kkBest.r));
    log(fmt("After LL (HTF)", llBest.r));
    log(fmt("After MM (joint)", mmBest.r));
    log(
      `\nΔ V7 → R7: +${((mmBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    log(`\nFinal asset list:`);
    for (const a of cur.assets)
      log(
        `  ${a.symbol} sp=${a.stopPct} tp=${a.tpPct} hb=${a.holdBars} rf=${a.riskFrac}`,
      );

    writeFileSync(
      `${LOG_DIR}/R7_FINAL_CONFIG.json`,
      JSON.stringify(cur, null, 2),
    );

    expect(mmBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
