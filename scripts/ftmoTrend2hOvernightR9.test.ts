/**
 * R9 — clean rebuild based on R8 ablation findings
 *
 * R8 ablation showed: chand, chop, HTF, LSC ALL hurt; per-asset tp hurts;
 * Only ADX, trailing, and the new BTC CAF help.
 *
 * Build minimum-viable champion from V5 base:
 *   V5 + adxFilter + BTC CAF momentum
 *
 * Then sweep to push that further.
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
const LOG_FILE = `${LOG_DIR}/R9_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe(
  "R9 — clean rebuild from V5 + ADX + BTC CAF",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R9", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `R9 START ${new Date().toISOString()}\n`);

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

      // CLEAN base: V5 + ADX + BTC CAF
      const cleanV8: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        adxFilter: { period: 14, minAdx: 10 },
        crossAssetFilter: {
          symbol: "BTCUSDT",
          emaFastPeriod: 4,
          emaSlowPeriod: 12,
          skipLongsIfSecondaryDowntrend: false,
          momentumBars: 24,
          momSkipLongBelow: -0.02,
        },
      };
      const v5R = runWalkForward(data, FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5);
      log(fmt("V5 baseline", v5R));
      const baseR = runWalkForward(data, cleanV8);
      log(fmt("V5+ADX+BTC-CAF (clean)", baseR));

      let cur: FtmoDaytrade24hConfig = JSON.parse(JSON.stringify(cleanV8));

      // 9A: BTC CAF re-tune
      log(`\n--- 9A: BTC CAF re-tune ---`);
      let aBest = { cfg: cur, r: baseR, label: "current" };
      for (const fast of [4, 6, 8, 12]) {
        for (const slow of [12, 16, 24, 36, 48]) {
          if (slow <= fast) continue;
          for (const mb of [12, 18, 24, 36, 48]) {
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
              if (score(r, aBest.r) < 0) {
                aBest = {
                  cfg,
                  r,
                  label: `BTC ${fast}/${slow} mb=${mb} ml=${ml}`,
                };
                log(fmt(`  ${aBest.label}`, r));
              }
            }
          }
        }
      }
      log(fmt(`9A WINNER (${aBest.label})`, aBest.r));
      cur = aBest.cfg;

      // 9B: ADX re-tune on clean
      log(`\n--- 9B: ADX re-tune ---`);
      let bBest = { cfg: cur, r: aBest.r, label: "current" };
      for (const period of [6, 8, 10, 14, 20, 28]) {
        for (const minAdx of [5, 8, 10, 12, 15, 18, 20, 25]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            adxFilter: { period, minAdx },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, bBest.r) < 0) {
            bBest = { cfg, r, label: `adx p=${period} m=${minAdx}` };
            log(fmt(`  ${bBest.label}`, r));
          }
        }
      }
      log(fmt(`9B WINNER (${bBest.label})`, bBest.r));
      cur = bBest.cfg;

      // 9C: trailingStop re-tune
      log(`\n--- 9C: trailing re-tune ---`);
      let cBest = { cfg: cur, r: bBest.r, label: "current" };
      for (const act of [0.015, 0.02, 0.025, 0.03, 0.035, 0.04, 0.05, 0.06]) {
        for (const tr of [
          0.002, 0.003, 0.005, 0.008, 0.012, 0.018, 0.025, 0.04,
        ]) {
          if (tr >= act) continue;
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            trailingStop: { activatePct: act, trailPct: tr },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, cBest.r) < 0) {
            cBest = { cfg, r, label: `trail act=${act} tr=${tr}` };
            log(fmt(`  ${cBest.label}`, r));
          }
        }
      }
      log(fmt(`9C WINNER (${cBest.label})`, cBest.r));
      cur = cBest.cfg;

      // 9D: hour drop greedy
      log(`\n--- 9D: greedy hour-drop ---`);
      let dBest = { cfg: cur, r: cBest.r };
      let hours = (
        cur.allowedHoursUtc ?? Array.from({ length: 24 }, (_, i) => i)
      ).slice();
      for (let it = 0; it < 8; it++) {
        let stepBest: {
          cfg: FtmoDaytrade24hConfig;
          r: BatchResult;
          h: number;
        } | null = null;
        for (const h of [...hours]) {
          if (hours.length < 4) break;
          const cand = hours.filter((x) => x !== h);
          const cfg: FtmoDaytrade24hConfig = {
            ...dBest.cfg,
            allowedHoursUtc: cand,
          };
          const r = runWalkForward(data, cfg);
          if (score(r, dBest.r) < 0) {
            if (stepBest === null || score(r, stepBest.r) < 0)
              stepBest = { cfg, r, h };
          }
        }
        if (stepBest === null) break;
        dBest = { cfg: stepBest.cfg, r: stepBest.r };
        hours = hours.filter((h) => h !== stepBest!.h);
        log(fmt(`  drop ${stepBest.h}`, stepBest.r));
      }
      log(fmt(`9D WINNER (h=${hours.length})`, dBest.r));
      cur = dBest.cfg;

      // 9E: maxConcurrent
      log(`\n--- 9E: maxConcurrent ---`);
      let eBest = { cfg: cur, r: dBest.r, label: "6" };
      for (const cap of [3, 4, 5, 6, 7, 8, 9]) {
        const cfg: FtmoDaytrade24hConfig = { ...cur, maxConcurrentTrades: cap };
        const r = runWalkForward(data, cfg);
        if (score(r, eBest.r) < 0) {
          eBest = { cfg, r, label: `cap=${cap}` };
          log(fmt(`  ${eBest.label}`, r));
        }
      }
      log(fmt(`9E WINNER (${eBest.label})`, eBest.r));
      cur = eBest.cfg;

      // 9F: ETH cross-asset extra (ETH-CAF)
      log(`\n--- 9F: ETH crossAssetExtra ---`);
      let fBest = { cfg: cur, r: eBest.r, label: "off" };
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
          if (score(r, fBest.r) < 0) {
            fBest = { cfg, r, label: `ETH ${fast}/${slow}` };
            log(fmt(`  ${fBest.label}`, r));
          }
        }
      }
      log(fmt(`9F WINNER (${fBest.label})`, fBest.r));
      cur = fBest.cfg;

      log(`\n========== R9 FINAL (CLEAN V8 BUILD) ==========`);
      log(fmt("V5 baseline", v5R));
      log(fmt("Clean V8 base", baseR));
      log(fmt("After 9A (BTC retune)", aBest.r));
      log(fmt("After 9B (ADX retune)", bBest.r));
      log(fmt("After 9C (trail retune)", cBest.r));
      log(fmt("After 9D (hour drop)", dBest.r));
      log(fmt("After 9E (concurrent)", eBest.r));
      log(fmt("After 9F (ETH extra)", fBest.r));
      log(
        `\nΔ V5 → R9: +${((fBest.r.passRate - v5R.passRate) * 100).toFixed(2)}pp`,
      );

      writeFileSync(
        `${LOG_DIR}/R9_FINAL_CONFIG.json`,
        JSON.stringify(cur, null, 2),
      );

      expect(fBest.r.passRate).toBeGreaterThanOrEqual(v5R.passRate);
    });
  },
);
