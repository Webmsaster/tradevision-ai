/**
 * OVERNIGHT R3 — asset universe expansion + per-asset R:R
 *
 * L: greedy add candidate assets (XRP, MATIC, DOT, ATOM, NEAR, FIL, ARB)
 * M: greedy drop assets that hurt
 * N: per-asset stopPct sweep (find each asset's optimal)
 * O: per-asset tpPct sweep
 * P: per-asset triggerBars (heterogeneous tb)
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

const TF_HOURS = 2;
const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R3_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

const CORE = [
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
const CANDIDATES = [
  "XRPUSDT",
  "DOTUSDT",
  "MATICUSDT",
  "ATOMUSDT",
  "NEARUSDT",
  "FILUSDT",
  "ARBUSDT",
  "TRXUSDT",
  "INJUSDT",
];

describe(
  "Overnight R3 — assets + per-asset R:R",
  { timeout: 24 * 3600_000 },
  () => {
    it("expands universe", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `OVERNIGHT R3 START ${new Date().toISOString()}\n`,
      );

      log(`Loading 2h data for ${CORE.length + CANDIDATES.length} assets...`);
      const data: Record<string, Candle[]> = {};
      for (const s of [...CORE, ...CANDIDATES]) {
        try {
          data[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: "2h",
            targetCount: 30000,
            maxPages: 40,
          });
          log(`  ${s}: ${data[s].length} bars`);
        } catch (e) {
          log(`  ${s}: SKIP (${(e as Error).message})`);
        }
      }
      const haveAll = Object.keys(data);
      const n = Math.min(...Object.values(data).map((c) => c.length));
      for (const s of haveAll) data[s] = data[s].slice(-n);
      log(`Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

      // Read R2 winner (or fall back)
      const r2Path = `${LOG_DIR}/R2_FINAL_CONFIG.json`;
      let cur: FtmoDaytrade24hConfig;
      if (existsSync(r2Path)) {
        cur = JSON.parse(readFileSync(r2Path, "utf-8"));
        log(`Loaded R2 winner from ${r2Path}`);
      } else {
        const r1Path = `${LOG_DIR}/R1_FINAL_CONFIG.json`;
        if (existsSync(r1Path)) {
          cur = JSON.parse(readFileSync(r1Path, "utf-8"));
          log(`R2 not found — using R1 winner`);
        } else {
          cur = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5;
          log(`Using V5 baseline`);
        }
      }
      const baseR = runWalkForward(data, cur);
      log(fmt("R3 BASELINE", baseR));

      // L: greedy add candidates
      log(`\n--- L: greedy add ---`);
      let lBest = { cfg: cur, r: baseR };
      let pool = CANDIDATES.filter((s) => haveAll.includes(s));
      while (pool.length > 0) {
        let stepBest: {
          cfg: FtmoDaytrade24hConfig;
          r: BatchResult;
          sym: string;
        } | null = null;
        for (const s of pool) {
          const trial = {
            ...lBest.cfg,
            assets: [...lBest.cfg.assets, trendAsset(s)],
          };
          const r = runWalkForward(data, trial);
          if (score(r, lBest.r) < 0) {
            if (stepBest === null || score(r, stepBest.r) < 0)
              stepBest = { cfg: trial, r, sym: s };
          }
        }
        if (stepBest === null) break;
        lBest = { cfg: stepBest.cfg, r: stepBest.r };
        pool = pool.filter((s) => s !== stepBest!.sym);
        log(fmt(`  +${stepBest.sym}`, stepBest.r));
      }
      log(fmt(`L WINNER`, lBest.r));
      cur = lBest.cfg;

      // M: greedy drop
      log(`\n--- M: greedy drop ---`);
      let mBest = { cfg: cur, r: lBest.r };
      let stillImproving = true;
      while (stillImproving) {
        stillImproving = false;
        let stepBest: {
          cfg: FtmoDaytrade24hConfig;
          r: BatchResult;
          sym: string;
        } | null = null;
        for (const a of mBest.cfg.assets) {
          if (mBest.cfg.assets.length <= 4) break;
          const trial = {
            ...mBest.cfg,
            assets: mBest.cfg.assets.filter((x) => x.symbol !== a.symbol),
          };
          const r = runWalkForward(data, trial);
          if (score(r, mBest.r) < 0) {
            if (stepBest === null || score(r, stepBest.r) < 0)
              stepBest = { cfg: trial, r, sym: a.symbol };
          }
        }
        if (stepBest !== null) {
          mBest = { cfg: stepBest.cfg, r: stepBest.r };
          stillImproving = true;
          log(fmt(`  -${stepBest.sym}`, stepBest.r));
        }
      }
      log(fmt(`M WINNER`, mBest.r));
      cur = mBest.cfg;

      // N: per-asset stopPct sweep (try tightening each)
      log(`\n--- N: per-asset stopPct ---`);
      let nBest = { cfg: cur, r: mBest.r };
      for (const a of nBest.cfg.assets) {
        let aBest = { cfg: nBest.cfg, r: nBest.r, sp: a.stopPct };
        for (const sp of [0.03, 0.035, 0.04, 0.045, 0.05]) {
          const trial = {
            ...nBest.cfg,
            assets: nBest.cfg.assets.map((x) =>
              x.symbol === a.symbol ? { ...x, stopPct: sp } : x,
            ),
          };
          const r = runWalkForward(data, trial);
          if (score(r, aBest.r) < 0) {
            aBest = { cfg: trial, r, sp };
          }
        }
        if (score(aBest.r, nBest.r) < 0) {
          nBest = { cfg: aBest.cfg, r: aBest.r };
          log(fmt(`  ${a.symbol} sp=${aBest.sp}`, aBest.r));
        }
      }
      log(fmt(`N WINNER`, nBest.r));
      cur = nBest.cfg;

      // O: per-asset tpPct sweep
      log(`\n--- O: per-asset tpPct ---`);
      let oBest = { cfg: cur, r: nBest.r };
      for (const a of oBest.cfg.assets) {
        let aBest = { cfg: oBest.cfg, r: oBest.r, tp: a.tpPct };
        for (const tp of [0.05, 0.06, 0.07, 0.08, 0.1, 0.12]) {
          if (tp <= (a.stopPct ?? 0.05)) continue;
          const trial = {
            ...oBest.cfg,
            assets: oBest.cfg.assets.map((x) =>
              x.symbol === a.symbol ? { ...x, tpPct: tp } : x,
            ),
          };
          const r = runWalkForward(data, trial);
          if (score(r, aBest.r) < 0) {
            aBest = { cfg: trial, r, tp };
          }
        }
        if (score(aBest.r, oBest.r) < 0) {
          oBest = { cfg: aBest.cfg, r: aBest.r };
          log(fmt(`  ${a.symbol} tp=${aBest.tp}`, aBest.r));
        }
      }
      log(fmt(`O WINNER`, oBest.r));
      cur = oBest.cfg;

      // P: per-asset triggerBars
      log(`\n--- P: per-asset triggerBars ---`);
      let pBest = { cfg: cur, r: oBest.r };
      for (const a of pBest.cfg.assets) {
        let aBest = { cfg: pBest.cfg, r: pBest.r, tb: a.triggerBars };
        for (const tb of [1, 2, 3]) {
          const trial = {
            ...pBest.cfg,
            assets: pBest.cfg.assets.map((x) =>
              x.symbol === a.symbol ? { ...x, triggerBars: tb } : x,
            ),
          };
          const r = runWalkForward(data, trial);
          if (score(r, aBest.r) < 0) {
            aBest = { cfg: trial, r, tb };
          }
        }
        if (score(aBest.r, pBest.r) < 0) {
          pBest = { cfg: aBest.cfg, r: aBest.r };
          log(fmt(`  ${a.symbol} tb=${aBest.tb}`, aBest.r));
        }
      }
      log(fmt(`P WINNER`, pBest.r));
      cur = pBest.cfg;

      log(`\n========== R3 FINAL ==========`);
      log(fmt("R3 baseline", baseR));
      log(fmt("After L (add)", lBest.r));
      log(fmt("After M (drop)", mBest.r));
      log(fmt("After N (sp)", nBest.r));
      log(fmt("After O (tp)", oBest.r));
      log(fmt("After P (tb)", pBest.r));
      log(
        `\nΔ R2 → R3: +${((pBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
      );
      log(
        `\nFinal asset list: ${cur.assets.map((a) => `${a.symbol}(sp=${a.stopPct},tp=${a.tpPct},tb=${a.triggerBars})`).join("\n  ")}`,
      );

      writeFileSync(
        `${LOG_DIR}/R3_FINAL_CONFIG.json`,
        JSON.stringify(cur, null, 2),
      );

      expect(pBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
    });
  },
);
