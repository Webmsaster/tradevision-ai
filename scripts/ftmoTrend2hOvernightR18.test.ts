/**
 * R18 — different primary CAF asset + ADD hours back + try multi-CAF stack
 *
 * 18A: ETH as primary CAF (BTC moves to extra)
 * 18B: BNB / LINK / SOL as primary CAF
 * 18C: ADD hours to V9 (greedy add)
 * 18D: relax adxFilter (try minAdx <10)
 * 18E: longer trail (act/tr larger range)
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V9,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R18_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe(
  "R18 — primary CAF swap + hour-add",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R18", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `R18 START ${new Date().toISOString()}\n`);

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

      let cur = JSON.parse(
        JSON.stringify(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V9),
      ) as FtmoDaytrade24hConfig;
      const baseR = runWalkForward(data, cur);
      log(fmt("R18 BASELINE V9", baseR));

      // 18A: ETH as primary (BTC moves to extra)
      log(`\n--- 18A: ETH as PRIMARY CAF ---`);
      let aBest = { cfg: cur, r: baseR, label: "current (BTC primary)" };
      for (const fast of [4, 6, 8, 12]) {
        for (const slow of [12, 16, 24, 36, 48]) {
          if (slow <= fast) continue;
          for (const mb of [12, 24, 36, 48]) {
            for (const ml of [-0.05, -0.03, -0.02, -0.01]) {
              const cfg: FtmoDaytrade24hConfig = {
                ...cur,
                crossAssetFilter: {
                  symbol: "ETHUSDT",
                  emaFastPeriod: fast,
                  emaSlowPeriod: slow,
                  skipLongsIfSecondaryDowntrend: false,
                  momentumBars: mb,
                  momSkipLongBelow: ml,
                },
                crossAssetFiltersExtra: [
                  {
                    symbol: "BTCUSDT",
                    emaFastPeriod: 4,
                    emaSlowPeriod: 48,
                    skipLongsIfSecondaryDowntrend: true,
                  },
                ],
              };
              const r = runWalkForward(data, cfg);
              if (score(r, aBest.r) < 0) {
                aBest = {
                  cfg,
                  r,
                  label: `ETH ${fast}/${slow} mb=${mb} ml=${ml}`,
                };
                log(fmt(`  ${aBest.label}`, r));
              }
            }
          }
        }
      }
      log(fmt(`18A WINNER (${aBest.label})`, aBest.r));
      cur = aBest.cfg;

      // 18B: BNB or LINK as primary
      log(`\n--- 18B: BNB/LINK/AVAX as primary ---`);
      let bBest = { cfg: cur, r: aBest.r, label: "current" };
      for (const sym of ["BNBUSDT", "LINKUSDT", "AVAXUSDT", "LTCUSDT"]) {
        for (const fast of [4, 8, 12]) {
          for (const slow of [24, 48, 96]) {
            if (slow <= fast) continue;
            const cfg: FtmoDaytrade24hConfig = {
              ...cur,
              crossAssetFilter: {
                symbol: sym,
                emaFastPeriod: fast,
                emaSlowPeriod: slow,
                skipLongsIfSecondaryDowntrend: true,
                momentumBars: 24,
                momSkipLongBelow: -0.02,
              },
            };
            const r = runWalkForward(data, cfg);
            if (score(r, bBest.r) < 0) {
              bBest = { cfg, r, label: `${sym} ${fast}/${slow}` };
              log(fmt(`  ${bBest.label}`, r));
            }
          }
        }
      }
      log(fmt(`18B WINNER (${bBest.label})`, bBest.r));
      cur = bBest.cfg;

      // 18C: ADD hours back to V9
      log(`\n--- 18C: ADD hours ---`);
      let cBest = { cfg: cur, r: bBest.r };
      let hours = (
        cur.allowedHoursUtc ?? Array.from({ length: 24 }, (_, i) => i)
      ).slice();
      const allHours = Array.from({ length: 24 }, (_, i) => i);
      const missing = allHours.filter((h) => !hours.includes(h));
      let stillImp = true;
      while (stillImp && missing.length > 0) {
        stillImp = false;
        let stepBest: {
          cfg: FtmoDaytrade24hConfig;
          r: BatchResult;
          h: number;
        } | null = null;
        for (const h of [...missing]) {
          const cand = [...hours, h].sort((a, b) => a - b);
          const cfg: FtmoDaytrade24hConfig = {
            ...cBest.cfg,
            allowedHoursUtc: cand,
          };
          const r = runWalkForward(data, cfg);
          if (score(r, cBest.r) < 0) {
            if (stepBest === null || score(r, stepBest.r) < 0)
              stepBest = { cfg, r, h };
          }
        }
        if (stepBest) {
          cBest = { cfg: stepBest.cfg, r: stepBest.r };
          hours = [...hours, stepBest.h].sort((a, b) => a - b);
          const idx = missing.indexOf(stepBest.h);
          if (idx >= 0) missing.splice(idx, 1);
          stillImp = true;
          log(fmt(`  +hour ${stepBest.h}`, stepBest.r));
        }
      }
      log(fmt(`18C WINNER (h=${hours.length})`, cBest.r));
      cur = cBest.cfg;

      // 18D: relax ADX
      log(`\n--- 18D: relax/strict ADX ---`);
      let dBest = { cfg: cur, r: cBest.r, label: "current" };
      for (const period of [4, 6, 8, 10, 14, 20, 28, 40]) {
        for (const minAdx of [0, 2, 5, 8, 10, 12, 15, 18, 22, 28, 35]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            adxFilter: { period, minAdx },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, dBest.r) < 0) {
            dBest = { cfg, r, label: `adx ${period}/${minAdx}` };
            log(fmt(`  ${dBest.label}`, r));
          }
        }
      }
      log(fmt(`18D WINNER (${dBest.label})`, dBest.r));
      cur = dBest.cfg;

      // 18E: longer trail
      log(`\n--- 18E: long trail ---`);
      let eBest = { cfg: cur, r: dBest.r, label: "current" };
      for (const act of [
        0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.08,
      ]) {
        for (const tr of [
          0.001, 0.002, 0.003, 0.005, 0.008, 0.012, 0.018, 0.025, 0.03,
        ]) {
          if (tr >= act) continue;
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            trailingStop: { activatePct: act, trailPct: tr },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, eBest.r) < 0) {
            eBest = { cfg, r, label: `trail ${act}/${tr}` };
            log(fmt(`  ${eBest.label}`, r));
          }
        }
      }
      log(fmt(`18E WINNER (${eBest.label})`, eBest.r));
      cur = eBest.cfg;

      log(`\n========== R18 FINAL ==========`);
      log(fmt("R18 baseline V9", baseR));
      log(fmt("After 18A (ETH primary)", aBest.r));
      log(fmt("After 18B (other primary)", bBest.r));
      log(fmt("After 18C (hour-add)", cBest.r));
      log(fmt("After 18D (ADX wider)", dBest.r));
      log(fmt("After 18E (trail wider)", eBest.r));
      log(
        `\nΔ V9 → R18: +${((eBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
      );

      if (score(eBest.r, baseR) < 0) {
        writeFileSync(
          `${LOG_DIR}/R18_FINAL_CONFIG.json`,
          JSON.stringify(cur, null, 2),
        );
      }

      expect(eBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
    });
  },
);
