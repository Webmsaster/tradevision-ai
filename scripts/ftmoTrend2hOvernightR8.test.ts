/**
 * R8 — wild combos & escape local optimum
 *
 * NN: BTC cross-asset filter (skipLongs if BTC down)
 * OO: adaptiveSizing tier sweep
 * PP: drop ALL filters, try clean V5+per-tp only (which feature is critical?)
 * QQ: very tight HTF (lb=12,24 short)
 * RR: maxTotalTrades cap (variance reduction)
 * SS: NEW idea — partialTakeProfit lvls with multiple trigger
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
const LOG_FILE = `${LOG_DIR}/R8_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe("R8 — wild combos", { timeout: 24 * 3600_000 }, () => {
  it("runs R8", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R8 START ${new Date().toISOString()}\n`);

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
      JSON.stringify(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V7),
    );
    const baseR = runWalkForward(data, cur);
    log(fmt("R8 BASELINE V7", baseR));

    // NN: BTC cross-asset filter
    log(`\n--- NN: BTC cross-asset filter ---`);
    let nnBest = { cfg: cur, r: baseR, label: "off" };
    for (const fast of [4, 8, 12, 24]) {
      for (const slow of [12, 24, 48, 96, 168]) {
        if (slow <= fast) continue;
        for (const skipDown of [true, false]) {
          for (const mb of [0, 4, 8, 24]) {
            for (const ml of [-0.05, -0.02, 0]) {
              const cfg: FtmoDaytrade24hConfig = {
                ...cur,
                crossAssetFilter: {
                  symbol: "BTCUSDT",
                  emaFastPeriod: fast,
                  emaSlowPeriod: slow,
                  skipLongsIfSecondaryDowntrend: skipDown,
                  ...(mb > 0 ? { momentumBars: mb, momSkipLongBelow: ml } : {}),
                },
              };
              const r = runWalkForward(data, cfg);
              if (score(r, nnBest.r) < 0) {
                nnBest = {
                  cfg,
                  r,
                  label: `BTC ${fast}/${slow} skip=${skipDown} mb=${mb} ml=${ml}`,
                };
                log(fmt(`  ${nnBest.label}`, r));
              }
            }
          }
        }
      }
    }
    log(fmt(`NN WINNER (${nnBest.label})`, nnBest.r));
    cur = nnBest.cfg;

    // OO: adaptiveSizing tier sweep
    log(`\n--- OO: adaptiveSizing ---`);
    let ooBest = { cfg: cur, r: nnBest.r, label: "off" };
    const sizings = [
      { label: "off", tiers: undefined },
      {
        label: "0.5/1.0/1.5",
        tiers: [
          { equityAbove: 0, factor: 0.5 },
          { equityAbove: 0.02, factor: 1.0 },
          { equityAbove: 0.05, factor: 1.5 },
        ],
      },
      {
        label: "0.7/1.0/1.5",
        tiers: [
          { equityAbove: 0, factor: 0.7 },
          { equityAbove: 0.02, factor: 1.0 },
          { equityAbove: 0.05, factor: 1.5 },
        ],
      },
      {
        label: "1.0/1.5/2.0",
        tiers: [
          { equityAbove: 0, factor: 1.0 },
          { equityAbove: 0.03, factor: 1.5 },
          { equityAbove: 0.06, factor: 2.0 },
        ],
      },
      {
        label: "0.5/1.0/2.0",
        tiers: [
          { equityAbove: 0, factor: 0.5 },
          { equityAbove: 0.02, factor: 1.0 },
          { equityAbove: 0.05, factor: 2.0 },
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
      { label: "2.0", tiers: [{ equityAbove: 0, factor: 2.0 }] },
      { label: "1.5", tiers: [{ equityAbove: 0, factor: 1.5 }] },
      {
        label: "0.7/1.5",
        tiers: [
          { equityAbove: 0, factor: 0.7 },
          { equityAbove: 0.04, factor: 1.5 },
        ],
      },
    ];
    for (const v of sizings) {
      const cfg: FtmoDaytrade24hConfig = { ...cur, adaptiveSizing: v.tiers };
      const r = runWalkForward(data, cfg);
      if (score(r, ooBest.r) < 0) {
        ooBest = { cfg, r, label: v.label };
        log(fmt(`  ${ooBest.label}`, r));
      }
    }
    log(fmt(`OO WINNER (${ooBest.label})`, ooBest.r));
    cur = ooBest.cfg;

    // PP: ablation - drop one filter at a time to confirm necessity
    log(`\n--- PP: filter ablation ---`);
    const ablations = [
      { name: "no LSC", cfg: { ...cur, lossStreakCooldown: undefined } },
      { name: "no ADX", cfg: { ...cur, adxFilter: undefined } },
      { name: "no HTF", cfg: { ...cur, htfTrendFilter: undefined } },
      { name: "no chand", cfg: { ...cur, chandelierExit: undefined } },
      { name: "no chop", cfg: { ...cur, choppinessFilter: undefined } },
      { name: "no trail", cfg: { ...cur, trailingStop: undefined } },
      {
        name: "tp=0.07 all",
        cfg: { ...cur, assets: cur.assets.map((a) => ({ ...a, tpPct: 0.07 })) },
      },
    ];
    for (const a of ablations) {
      const r = runWalkForward(data, a.cfg);
      const tag = score(r, baseR) < 0 ? "BETTER" : "worse";
      log(fmt(`  ${a.name} [${tag}]`, r));
    }

    // QQ: very tight HTF
    log(`\n--- QQ: tight HTF apply=long ---`);
    let qqBest = { cfg: cur, r: ooBest.r, label: "current" };
    for (const lb of [6, 8, 12, 16, 24, 36]) {
      for (const thr of [-0.05, -0.02, 0, 0.01, 0.02, 0.03]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          htfTrendFilter: { lookbackBars: lb, apply: "long", threshold: thr },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, qqBest.r) < 0) {
          qqBest = { cfg, r, label: `htf lb=${lb} thr=${thr}` };
          log(fmt(`  ${qqBest.label}`, r));
        }
      }
    }
    log(fmt(`QQ WINNER (${qqBest.label})`, qqBest.r));
    cur = qqBest.cfg;

    // RR: maxTotalTrades cap
    log(`\n--- RR: maxTotalTrades ---`);
    let rrBest = { cfg: cur, r: qqBest.r, label: "off" };
    for (const mt of [5, 8, 12, 16, 20, 30, 50, 80]) {
      const cfg: FtmoDaytrade24hConfig = { ...cur, maxTotalTrades: mt };
      const r = runWalkForward(data, cfg);
      if (score(r, rrBest.r) < 0) {
        rrBest = { cfg, r, label: `maxT=${mt}` };
        log(fmt(`  ${rrBest.label}`, r));
      }
    }
    log(fmt(`RR WINNER (${rrBest.label})`, rrBest.r));
    cur = rrBest.cfg;

    // SS: partialTakeProfitLevels (multi-stage)
    log(`\n--- SS: partialTakeProfitLevels ---`);
    let ssBest = { cfg: cur, r: rrBest.r, label: "off" };
    const ptpLevels = [
      [
        { triggerPct: 0.02, closeFraction: 0.3 },
        { triggerPct: 0.04, closeFraction: 0.3 },
      ],
      [
        { triggerPct: 0.015, closeFraction: 0.3 },
        { triggerPct: 0.03, closeFraction: 0.3 },
        { triggerPct: 0.05, closeFraction: 0.3 },
      ],
      [{ triggerPct: 0.025, closeFraction: 0.5 }],
      [
        { triggerPct: 0.01, closeFraction: 0.2 },
        { triggerPct: 0.025, closeFraction: 0.3 },
      ],
      [{ triggerPct: 0.04, closeFraction: 0.5 }],
      [
        { triggerPct: 0.03, closeFraction: 0.3 },
        { triggerPct: 0.06, closeFraction: 0.5 },
      ],
    ];
    for (let i = 0; i < ptpLevels.length; i++) {
      const cfg: FtmoDaytrade24hConfig = {
        ...cur,
        partialTakeProfitLevels: ptpLevels[i],
      };
      const r = runWalkForward(data, cfg);
      if (score(r, ssBest.r) < 0) {
        ssBest = { cfg, r, label: `PTP_LVL_${i}` };
        log(fmt(`  ${ssBest.label} ${JSON.stringify(ptpLevels[i])}`, r));
      }
    }
    log(fmt(`SS WINNER (${ssBest.label})`, ssBest.r));
    cur = ssBest.cfg;

    log(`\n========== R8 FINAL ==========`);
    log(fmt("R8 baseline V7", baseR));
    log(fmt("After NN (BTC CAF)", nnBest.r));
    log(fmt("After OO (size)", ooBest.r));
    log(fmt("After QQ (tight HTF)", qqBest.r));
    log(fmt("After RR (maxT)", rrBest.r));
    log(fmt("After SS (PTP_LVL)", ssBest.r));
    log(
      `\nΔ V7 → R8: +${((ssBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    writeFileSync(
      `${LOG_DIR}/R8_FINAL_CONFIG.json`,
      JSON.stringify(cur, null, 2),
    );

    expect(ssBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
