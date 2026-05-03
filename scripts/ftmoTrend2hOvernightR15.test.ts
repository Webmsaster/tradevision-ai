/**
 * R15 — late-stage push on V8: asset-mix re-evaluation + multi-stacked CAF
 *
 * 15A: drop each asset on V8 (with new filters, the right asset mix may have shifted)
 * 15B: greedy add long-history candidates (XRP, TRX, ATOM)
 * 15C: stack multiple crossAssetFiltersExtra (BTC + ETH + LINK confluence)
 * 15D: maxConcurrentTrades very tight (2-3)
 * 15E: per-asset triggerBars (now with V8 stack)
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R15_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

const SOURCES_BASE = [
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
const SOURCES_EXTRA = ["XRPUSDT", "TRXUSDT", "ATOMUSDT"];

describe(
  "R15 — V8 asset-mix re-eval + multi-CAF",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R15", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `R15 START ${new Date().toISOString()}\n`);

      log(`Loading 2h data...`);
      const data: Record<string, Candle[]> = {};
      for (const s of [...SOURCES_BASE, ...SOURCES_EXTRA]) {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
      }
      const eligible = [...SOURCES_BASE, ...SOURCES_EXTRA].filter(
        (s) => data[s].length >= 24000,
      );
      const n = Math.min(...eligible.map((s) => data[s].length));
      for (const s of eligible) data[s] = data[s].slice(-n);
      log(
        `Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y) / ${eligible.length} eligible\n`,
      );

      let cur = JSON.parse(
        JSON.stringify(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8),
      ) as FtmoDaytrade24hConfig;
      const baseR = runWalkForward(data, cur);
      log(fmt("R15 BASELINE V8", baseR));

      // 15A: drop each asset
      log(`\n--- 15A: drop each asset ---`);
      let aBest = { cfg: cur, r: baseR, label: "no-drop" };
      let stillImp = true;
      while (stillImp && aBest.cfg.assets.length > 4) {
        stillImp = false;
        let stepBest: {
          cfg: FtmoDaytrade24hConfig;
          r: BatchResult;
          sym: string;
        } | null = null;
        for (const a of aBest.cfg.assets) {
          const trial = {
            ...aBest.cfg,
            assets: aBest.cfg.assets.filter((x) => x.symbol !== a.symbol),
          };
          const r = runWalkForward(data, trial);
          if (score(r, aBest.r) < 0) {
            if (stepBest === null || score(r, stepBest.r) < 0)
              stepBest = { cfg: trial, r, sym: a.symbol };
          }
        }
        if (stepBest) {
          aBest = {
            cfg: stepBest.cfg,
            r: stepBest.r,
            label: `drop ${stepBest.sym}`,
          };
          stillImp = true;
          log(fmt(`  ${aBest.label}`, stepBest.r));
        }
      }
      log(fmt(`15A WINNER (${aBest.label})`, aBest.r));
      cur = aBest.cfg;

      // 15B: greedy add candidates
      log(`\n--- 15B: greedy add ---`);
      let bBest = { cfg: cur, r: aBest.r };
      let pool = SOURCES_EXTRA.filter(
        (s) => data[s] && !cur.assets.some((a) => a.sourceSymbol === s),
      );
      while (pool.length > 0) {
        let stepBest: {
          cfg: FtmoDaytrade24hConfig;
          r: BatchResult;
          sym: string;
        } | null = null;
        for (const s of pool) {
          const trial = {
            ...bBest.cfg,
            assets: [...bBest.cfg.assets, trendAsset(s)],
          };
          const r = runWalkForward(data, trial);
          if (score(r, bBest.r) < 0) {
            if (stepBest === null || score(r, stepBest.r) < 0)
              stepBest = { cfg: trial, r, sym: s };
          }
        }
        if (!stepBest) break;
        bBest = { cfg: stepBest.cfg, r: stepBest.r };
        pool = pool.filter((s) => s !== stepBest!.sym);
        log(fmt(`  +${stepBest.sym}`, stepBest.r));
      }
      log(fmt(`15B WINNER (n=${bBest.cfg.assets.length})`, bBest.r));
      cur = bBest.cfg;

      // 15C: stack multiple cross-asset extras
      log(`\n--- 15C: multi-stack CAF extras ---`);
      let cBest = { cfg: cur, r: bBest.r, label: "current" };
      const candidateExtras = [
        [
          {
            symbol: "ETHUSDT",
            emaFastPeriod: 4,
            emaSlowPeriod: 48,
            skipLongsIfSecondaryDowntrend: true,
          },
        ],
        [
          {
            symbol: "ETHUSDT",
            emaFastPeriod: 4,
            emaSlowPeriod: 48,
            skipLongsIfSecondaryDowntrend: true,
          },
          {
            symbol: "LINKUSDT",
            emaFastPeriod: 4,
            emaSlowPeriod: 48,
            skipLongsIfSecondaryDowntrend: true,
          },
        ],
        [
          {
            symbol: "ETHUSDT",
            emaFastPeriod: 4,
            emaSlowPeriod: 48,
            skipLongsIfSecondaryDowntrend: true,
          },
          {
            symbol: "BNBUSDT",
            emaFastPeriod: 4,
            emaSlowPeriod: 48,
            skipLongsIfSecondaryDowntrend: true,
          },
        ],
        [
          {
            symbol: "ETHUSDT",
            emaFastPeriod: 8,
            emaSlowPeriod: 24,
            skipLongsIfSecondaryDowntrend: true,
          },
        ],
        [
          {
            symbol: "ETHUSDT",
            emaFastPeriod: 12,
            emaSlowPeriod: 96,
            skipLongsIfSecondaryDowntrend: true,
          },
        ],
        [
          {
            symbol: "BTCUSDT",
            emaFastPeriod: 24,
            emaSlowPeriod: 168,
            skipLongsIfSecondaryDowntrend: true,
          },
        ],
      ];
      for (let i = 0; i < candidateExtras.length; i++) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          crossAssetFiltersExtra: candidateExtras[i],
        };
        const r = runWalkForward(data, cfg);
        if (score(r, cBest.r) < 0) {
          cBest = {
            cfg,
            r,
            label: `extras[${i}] n=${candidateExtras[i].length}`,
          };
          log(
            fmt(
              `  ${cBest.label}: ${JSON.stringify(candidateExtras[i].map((e) => e.symbol))}`,
              r,
            ),
          );
        }
      }
      log(fmt(`15C WINNER (${cBest.label})`, cBest.r));
      cur = cBest.cfg;

      // 15D: maxConcurrentTrades tight
      log(`\n--- 15D: maxConcurrentTrades tight ---`);
      let dBest = { cfg: cur, r: cBest.r, label: "6" };
      for (const cap of [1, 2, 3, 4, 5]) {
        const cfg = { ...cur, maxConcurrentTrades: cap };
        const r = runWalkForward(data, cfg);
        if (score(r, dBest.r) < 0) {
          dBest = { cfg, r, label: `cap=${cap}` };
          log(fmt(`  ${dBest.label}`, r));
        }
      }
      log(fmt(`15D WINNER (${dBest.label})`, dBest.r));
      cur = dBest.cfg;

      // 15E: per-asset triggerBars
      log(`\n--- 15E: per-asset triggerBars ---`);
      let eBest = { cfg: cur, r: dBest.r };
      for (const a of eBest.cfg.assets) {
        let aBest2 = { cfg: eBest.cfg, r: eBest.r, tb: a.triggerBars };
        for (const tb of [1, 2, 3]) {
          const trial = {
            ...eBest.cfg,
            assets: eBest.cfg.assets.map((x) =>
              x.symbol === a.symbol ? { ...x, triggerBars: tb } : x,
            ),
          };
          const r = runWalkForward(data, trial);
          if (score(r, aBest2.r) < 0) {
            aBest2 = { cfg: trial, r, tb };
          }
        }
        if (score(aBest2.r, eBest.r) < 0) {
          eBest = { cfg: aBest2.cfg, r: aBest2.r };
          log(fmt(`  ${a.symbol} tb=${aBest2.tb}`, aBest2.r));
        }
      }
      log(fmt(`15E WINNER`, eBest.r));
      cur = eBest.cfg;

      log(`\n========== R15 FINAL ==========`);
      log(fmt("R15 baseline V8", baseR));
      log(fmt("After 15A (drop)", aBest.r));
      log(fmt("After 15B (add)", bBest.r));
      log(fmt("After 15C (multi-CAF)", cBest.r));
      log(fmt("After 15D (concurrent)", dBest.r));
      log(fmt("After 15E (per-asset tb)", eBest.r));
      log(
        `\nΔ V8 → R15: +${((eBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
      );

      writeFileSync(
        `${LOG_DIR}/R15_FINAL_CONFIG.json`,
        JSON.stringify(cur, null, 2),
      );

      expect(eBest.r.passRate).toBeGreaterThan(0);
    });
  },
);
