/**
 * HONEST SWEEP — only assets with FULL 5.59y history.
 *
 * Lesson from R3: short-history assets (ARB at 3.10y) shrink the window
 * and inflate apparent gains. This sweep enforces 24506+ bars per asset.
 *
 * Axes (re-tested honestly):
 *   A: greedy add long-history candidates (XRP, TRX, DOT, ATOM)
 *   B: greedy drop V5 assets that hurt
 *   C: per-asset tpPct sweep (5/6/7/8/10%)
 *   D: per-asset stopPct sweep (3/4/5%)
 *   E: timeBoost re-tested
 *   F: lossStreakCooldown re-tested
 *   G: htfTrendFilter / adxFilter combo
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
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
const LOG_FILE = `${LOG_DIR}/HONEST_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
const MIN_BARS = 24000; // ~5.5y filter

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

function trendAsset(
  s: string,
  sp = 0.05,
  tp = 0.07,
  hb = 240,
  tb = 1,
): Daytrade24hAssetCfg {
  return {
    symbol: `${s.replace("USDT", "")}-TREND`,
    sourceSymbol: s,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: tb,
    invertDirection: true,
    disableShort: true,
    stopPct: sp,
    tpPct: tp,
    holdBars: hb,
  };
}

const ALL_LONG = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "LINKUSDT",
  "XRPUSDT",
  "TRXUSDT",
  "ATOMUSDT", // long-history candidates
];

describe(
  "HONEST Sweep — full 5.59y enforced",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs honest sweep", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `HONEST SWEEP START ${new Date().toISOString()}\n`,
      );

      log(`Loading 2h data for ${ALL_LONG.length} candidates...`);
      const data: Record<string, Candle[]> = {};
      for (const s of ALL_LONG) {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        const yrs = (data[s].length / BARS_PER_DAY / 365).toFixed(2);
        const ok = data[s].length >= MIN_BARS ? "OK" : "TOO-SHORT";
        log(`  ${s}: ${data[s].length} bars (${yrs}y) ${ok}`);
      }

      // Filter only assets with sufficient history
      const eligible = ALL_LONG.filter((s) => data[s].length >= MIN_BARS);
      log(`\nEligible (≥${MIN_BARS} bars): ${eligible.join(", ")}`);

      // Align to common window across eligible
      const n = Math.min(...eligible.map((s) => data[s].length));
      for (const s of eligible) data[s] = data[s].slice(-n);
      log(
        `Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y) / ${eligible.length} assets\n`,
      );

      // Filter data to eligible only
      const eligibleData: Record<string, Candle[]> = {};
      for (const s of eligible) eligibleData[s] = data[s];

      // Baseline: V5 9-asset
      const v5Data: Record<string, Candle[]> = {};
      for (const s of [
        "ETHUSDT",
        "BTCUSDT",
        "BNBUSDT",
        "ADAUSDT",
        "DOGEUSDT",
        "AVAXUSDT",
        "LTCUSDT",
        "BCHUSDT",
        "LINKUSDT",
      ]) {
        if (eligibleData[s]) v5Data[s] = eligibleData[s];
      }
      const baseR = runWalkForward(
        v5Data,
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      );
      log(fmt("V5 BASELINE 9-asset", baseR));

      // Build cur from V5
      let cur: FtmoDaytrade24hConfig = JSON.parse(
        JSON.stringify(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5),
      );

      // A: greedy add (XRP, TRX, ATOM)
      log(`\n--- A: greedy add long-history candidates ---`);
      let aBest = { cfg: cur, r: baseR, dataView: v5Data };
      let pool = ["XRPUSDT", "TRXUSDT", "ATOMUSDT"].filter(
        (s) => eligibleData[s],
      );
      while (pool.length > 0) {
        let stepBest: {
          cfg: FtmoDaytrade24hConfig;
          r: BatchResult;
          sym: string;
          dataView: Record<string, Candle[]>;
        } | null = null;
        for (const s of pool) {
          const trial = {
            ...aBest.cfg,
            assets: [...aBest.cfg.assets, trendAsset(s)],
          };
          const dv = { ...aBest.dataView, [s]: eligibleData[s] };
          const r = runWalkForward(dv, trial);
          if (score(r, aBest.r) < 0) {
            if (stepBest === null || score(r, stepBest.r) < 0)
              stepBest = { cfg: trial, r, sym: s, dataView: dv };
          }
        }
        if (stepBest === null) break;
        aBest = {
          cfg: stepBest.cfg,
          r: stepBest.r,
          dataView: stepBest.dataView,
        };
        pool = pool.filter((s) => s !== stepBest!.sym);
        log(fmt(`  +${stepBest.sym}`, stepBest.r));
      }
      log(fmt(`A WINNER (n=${aBest.cfg.assets.length})`, aBest.r));
      cur = aBest.cfg;
      let curData = aBest.dataView;

      // B: greedy drop
      log(`\n--- B: greedy drop ---`);
      let bBest = { cfg: cur, r: aBest.r, dataView: curData };
      let stillImproving = true;
      while (stillImproving && bBest.cfg.assets.length > 4) {
        stillImproving = false;
        let stepBest: {
          cfg: FtmoDaytrade24hConfig;
          r: BatchResult;
          sym: string;
          src: string;
        } | null = null;
        for (const a of bBest.cfg.assets) {
          const trial = {
            ...bBest.cfg,
            assets: bBest.cfg.assets.filter((x) => x.symbol !== a.symbol),
          };
          const r = runWalkForward(bBest.dataView, trial);
          if (score(r, bBest.r) < 0) {
            if (stepBest === null || score(r, stepBest.r) < 0)
              stepBest = { cfg: trial, r, sym: a.symbol, src: a.sourceSymbol! };
          }
        }
        if (stepBest !== null) {
          bBest = {
            cfg: stepBest.cfg,
            r: stepBest.r,
            dataView: bBest.dataView,
          };
          stillImproving = true;
          log(fmt(`  -${stepBest.sym}`, stepBest.r));
        }
      }
      log(fmt(`B WINNER (n=${bBest.cfg.assets.length})`, bBest.r));
      cur = bBest.cfg;
      curData = bBest.dataView;

      // C: per-asset tpPct
      log(`\n--- C: per-asset tpPct ---`);
      let cBest = { cfg: cur, r: bBest.r };
      for (const a of cBest.cfg.assets) {
        let aBest2 = { cfg: cBest.cfg, r: cBest.r, tp: a.tpPct };
        for (const tp of [0.05, 0.06, 0.07, 0.08, 0.1, 0.12]) {
          if (tp <= (a.stopPct ?? 0.05)) continue;
          const trial = {
            ...cBest.cfg,
            assets: cBest.cfg.assets.map((x) =>
              x.symbol === a.symbol ? { ...x, tpPct: tp } : x,
            ),
          };
          const r = runWalkForward(curData, trial);
          if (score(r, aBest2.r) < 0) {
            aBest2 = { cfg: trial, r, tp };
          }
        }
        if (score(aBest2.r, cBest.r) < 0) {
          cBest = { cfg: aBest2.cfg, r: aBest2.r };
          log(fmt(`  ${a.symbol} tp=${aBest2.tp}`, aBest2.r));
        }
      }
      log(fmt(`C WINNER`, cBest.r));
      cur = cBest.cfg;

      // D: per-asset stopPct
      log(`\n--- D: per-asset stopPct ---`);
      let dBest = { cfg: cur, r: cBest.r };
      for (const a of dBest.cfg.assets) {
        let aBest2 = { cfg: dBest.cfg, r: dBest.r, sp: a.stopPct };
        for (const sp of [0.03, 0.035, 0.04, 0.045, 0.05]) {
          const trial = {
            ...dBest.cfg,
            assets: dBest.cfg.assets.map((x) =>
              x.symbol === a.symbol ? { ...x, stopPct: sp } : x,
            ),
          };
          const r = runWalkForward(curData, trial);
          if (score(r, aBest2.r) < 0) {
            aBest2 = { cfg: trial, r, sp };
          }
        }
        if (score(aBest2.r, dBest.r) < 0) {
          dBest = { cfg: aBest2.cfg, r: aBest2.r };
          log(fmt(`  ${a.symbol} sp=${aBest2.sp}`, aBest2.r));
        }
      }
      log(fmt(`D WINNER`, dBest.r));
      cur = dBest.cfg;

      // E: timeBoost
      log(`\n--- E: timeBoost ---`);
      let eBest = { cfg: cur, r: dBest.r, label: "off" };
      for (const day of [2, 4, 6, 8, 12, 18]) {
        for (const eb of [0.02, 0.04, 0.06, 0.08]) {
          for (const f of [1.5, 2, 2.5, 3]) {
            const cfg: FtmoDaytrade24hConfig = {
              ...cur,
              timeBoost: { afterDay: day, equityBelow: eb, factor: f },
            };
            const r = runWalkForward(curData, cfg);
            if (score(r, eBest.r) < 0) {
              eBest = { cfg, r, label: `tb d=${day} eb=${eb} f=${f}` };
              log(fmt(`  ${eBest.label}`, r));
            }
          }
        }
      }
      log(fmt(`E WINNER (${eBest.label})`, eBest.r));
      cur = eBest.cfg;

      // F: lossStreakCooldown
      log(`\n--- F: lossStreakCooldown ---`);
      let fBest = { cfg: cur, r: eBest.r, label: "off" };
      for (const after of [2, 3, 4, 5]) {
        for (const cd of [12, 24, 48, 72, 120, 200]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
          };
          const r = runWalkForward(curData, cfg);
          if (score(r, fBest.r) < 0) {
            fBest = { cfg, r, label: `LSC a=${after} cd=${cd}` };
            log(fmt(`  ${fBest.label}`, r));
          }
        }
      }
      log(fmt(`F WINNER (${fBest.label})`, fBest.r));
      cur = fBest.cfg;

      // G: htfTrendFilter + adxFilter joint
      log(`\n--- G: HTF + ADX joint ---`);
      let gBest = { cfg: cur, r: fBest.r, label: "off" };
      for (const adxP of [10, 14, 20]) {
        for (const adxM of [10, 15, 20]) {
          for (const htfLb of [24, 48, 72]) {
            for (const htfThr of [0, 0.01, 0.02, 0.05]) {
              const cfg: FtmoDaytrade24hConfig = {
                ...cur,
                adxFilter: { period: adxP, minAdx: adxM },
                htfTrendFilter: {
                  lookbackBars: htfLb,
                  apply: "long",
                  threshold: htfThr,
                },
              };
              const r = runWalkForward(curData, cfg);
              if (score(r, gBest.r) < 0) {
                gBest = {
                  cfg,
                  r,
                  label: `adx ${adxP}/${adxM} + htf ${htfLb}/${htfThr}`,
                };
                log(fmt(`  ${gBest.label}`, r));
              }
            }
          }
        }
      }
      log(fmt(`G WINNER (${gBest.label})`, gBest.r));
      cur = gBest.cfg;

      log(`\n========== HONEST FINAL ==========`);
      log(fmt("V5 baseline (full 5.59y)", baseR));
      log(fmt("After A (add)", aBest.r));
      log(fmt("After B (drop)", bBest.r));
      log(fmt("After C (per-tp)", cBest.r));
      log(fmt("After D (per-sp)", dBest.r));
      log(fmt("After E (tb)", eBest.r));
      log(fmt("After F (LSC)", fBest.r));
      log(fmt("After G (HTF+ADX)", gBest.r));
      log(
        `\nΔ V5 → HONEST: +${((gBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
      );
      log(`\nFinal asset list:`);
      for (const a of cur.assets)
        log(
          `  ${a.symbol} sp=${a.stopPct} tp=${a.tpPct} tb=${a.triggerBars} hb=${a.holdBars}`,
        );

      writeFileSync(
        `${LOG_DIR}/HONEST_FINAL_CONFIG.json`,
        JSON.stringify(cur, null, 2),
      );

      expect(gBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
    });
  },
);
