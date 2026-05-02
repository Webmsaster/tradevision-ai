/**
 * OVERNIGHT R4 — ATR stop + hour-filter + ensemble micro-axis
 *
 * Q: replace fixed stopPct with atrStop (period × mult)
 * R: greedy hour-drop (leave-one-out)
 * S: htfTrendFilter further refinement (asymmetric apply, threshold curve)
 * T: adxFilter further refinement
 * U: adaptiveSizing (equity-tier sizing)
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
const LOG_FILE = `${LOG_DIR}/R4_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe(
  "Overnight R4 — ATR/hours/refinement",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R4", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `OVERNIGHT R4 START ${new Date().toISOString()}\n`,
      );

      log(`Loading 2h data...`);
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
      log(`Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

      // Read most recent winner: R3 > R2 > R1 > V5
      const order = [
        "R3_FINAL_CONFIG.json",
        "R2_FINAL_CONFIG.json",
        "R1_FINAL_CONFIG.json",
      ];
      let cur: FtmoDaytrade24hConfig = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5;
      for (const f of order) {
        const p = `${LOG_DIR}/${f}`;
        if (existsSync(p)) {
          cur = JSON.parse(readFileSync(p, "utf-8"));
          log(`Loaded base from ${f}`);
          break;
        }
      }
      const baseR = runWalkForward(data, cur);
      log(fmt("R4 BASELINE", baseR));

      // Q: atrStop
      log(`\n--- Q: atrStop sweep ---`);
      let qBest = { cfg: cur, r: baseR, label: "off" };
      for (const period of [14, 28, 56, 84, 168]) {
        for (const mult of [1.5, 2, 2.5, 3, 3.5, 4]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            atrStop: { period, stopMult: mult },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, qBest.r) < 0) {
            qBest = { cfg, r, label: `atr p=${period} m=${mult}` };
            log(fmt(`  ${qBest.label}`, r));
          }
        }
      }
      log(fmt(`Q WINNER (${qBest.label})`, qBest.r));
      cur = qBest.cfg;

      // R: greedy hour-drop
      log(`\n--- R: greedy hour-drop ---`);
      let rBest = { cfg: cur, r: qBest.r };
      let hours = (
        cur.allowedHoursUtc ?? Array.from({ length: 24 }, (_, i) => i)
      ).slice();
      let it = 0;
      while (it < 5) {
        let stepBest: {
          cfg: FtmoDaytrade24hConfig;
          r: BatchResult;
          h: number;
        } | null = null;
        for (const h of [...hours]) {
          if (hours.length < 5) break;
          const cand = hours.filter((x) => x !== h);
          const cfg: FtmoDaytrade24hConfig = {
            ...rBest.cfg,
            allowedHoursUtc: cand,
          };
          const r = runWalkForward(data, cfg);
          if (score(r, rBest.r) < 0) {
            if (stepBest === null || score(r, stepBest.r) < 0)
              stepBest = { cfg, r, h };
          }
        }
        if (stepBest === null) break;
        rBest = { cfg: stepBest.cfg, r: stepBest.r };
        hours = hours.filter((h) => h !== stepBest!.h);
        log(fmt(`  drop ${stepBest.h}`, stepBest.r));
        it++;
      }
      log(fmt(`R WINNER (hours=${hours.length})`, rBest.r));
      cur = rBest.cfg;

      // S: HTF refinement
      log(`\n--- S: HTF refinement ---`);
      let sBest = { cfg: cur, r: rBest.r, label: "current" };
      for (const apply of ["long", "short", "both"] as const) {
        for (const lb of [12, 24, 48, 72, 120, 168]) {
          for (const thr of [-0.05, -0.02, 0, 0.01, 0.02, 0.05, 0.08, 0.1]) {
            const cfg: FtmoDaytrade24hConfig = {
              ...cur,
              htfTrendFilter: { lookbackBars: lb, apply, threshold: thr },
            };
            const r = runWalkForward(data, cfg);
            if (score(r, sBest.r) < 0) {
              sBest = { cfg, r, label: `htf ${apply} lb=${lb} thr=${thr}` };
              log(fmt(`  ${sBest.label}`, r));
            }
          }
        }
      }
      log(fmt(`S WINNER (${sBest.label})`, sBest.r));
      cur = sBest.cfg;

      // T: ADX refinement
      log(`\n--- T: ADX refinement ---`);
      let tBest = { cfg: cur, r: sBest.r, label: "current" };
      for (const period of [6, 8, 10, 14, 20, 28]) {
        for (const minAdx of [5, 8, 10, 12, 15, 18, 20, 25]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            adxFilter: { period, minAdx },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, tBest.r) < 0) {
            tBest = { cfg, r, label: `adx p=${period} m=${minAdx}` };
            log(fmt(`  ${tBest.label}`, r));
          }
        }
      }
      log(fmt(`T WINNER (${tBest.label})`, tBest.r));
      cur = tBest.cfg;

      // U: adaptiveSizing
      log(`\n--- U: adaptiveSizing ---`);
      let uBest = { cfg: cur, r: tBest.r, label: "off" };
      const sizings = [
        { label: "off", tiers: undefined },
        {
          label: "1.0/1.5/2.0",
          tiers: [
            { equityAbove: 0, factor: 1.0 },
            { equityAbove: 0.03, factor: 1.5 },
            { equityAbove: 0.06, factor: 2.0 },
          ],
        },
        {
          label: "0.7/1.5/2.0",
          tiers: [
            { equityAbove: 0, factor: 0.7 },
            { equityAbove: 0.03, factor: 1.5 },
            { equityAbove: 0.06, factor: 2.0 },
          ],
        },
        {
          label: "0.5/1.0/1.5",
          tiers: [
            { equityAbove: 0, factor: 0.5 },
            { equityAbove: 0.02, factor: 1.0 },
            { equityAbove: 0.05, factor: 1.5 },
          ],
        },
        {
          label: "1.5/2.0/2.5",
          tiers: [
            { equityAbove: 0, factor: 1.5 },
            { equityAbove: 0.03, factor: 2.0 },
            { equityAbove: 0.06, factor: 2.5 },
          ],
        },
        {
          label: "1.0/2.0",
          tiers: [
            { equityAbove: 0, factor: 1.0 },
            { equityAbove: 0.04, factor: 2.0 },
          ],
        },
      ];
      for (const v of sizings) {
        const cfg: FtmoDaytrade24hConfig = { ...cur, adaptiveSizing: v.tiers };
        const r = runWalkForward(data, cfg);
        if (score(r, uBest.r) < 0) {
          uBest = { cfg, r, label: v.label };
          log(fmt(`  ${uBest.label}`, r));
        }
      }
      log(fmt(`U WINNER (${uBest.label})`, uBest.r));
      cur = uBest.cfg;

      log(`\n========== R4 FINAL ==========`);
      log(fmt("R4 baseline", baseR));
      log(fmt("After Q (atr)", qBest.r));
      log(fmt("After R (hour)", rBest.r));
      log(fmt("After S (htf)", sBest.r));
      log(fmt("After T (adx)", tBest.r));
      log(fmt("After U (size)", uBest.r));
      log(
        `\nΔ baseline → R4: +${((uBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
      );

      writeFileSync(
        `${LOG_DIR}/R4_FINAL_CONFIG.json`,
        JSON.stringify(cur, null, 2),
      );

      expect(uBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
    });
  },
);
