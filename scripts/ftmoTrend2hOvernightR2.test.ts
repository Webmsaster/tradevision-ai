/**
 * OVERNIGHT SWEEP R2 — exit-side & timing on R1 winner
 *
 * Reads R1_FINAL_CONFIG.json as base, sweeps:
 *   F: chandelierExit (period × mult)
 *   G: partialTakeProfit (trigger × frac)
 *   H: timeBoost (afterDay × equityBelow × factor)
 *   I: lossStreakCooldown (afterLosses × cooldownBars)
 *   J: breakEven threshold
 *   K: holdBars sweep
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
const LOG_FILE = `${LOG_DIR}/R2_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe("Overnight R2 — exit-side", { timeout: 24 * 3600_000 }, () => {
  it("runs R2 on R1 winner", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `OVERNIGHT R2 START ${new Date().toISOString()}\n`);

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
    log(`Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

    // Read R1 winner (or fall back to V5)
    const r1Path = `${LOG_DIR}/R1_FINAL_CONFIG.json`;
    let cur: FtmoDaytrade24hConfig;
    if (existsSync(r1Path)) {
      cur = JSON.parse(readFileSync(r1Path, "utf-8"));
      log(`Loaded R1 winner from ${r1Path}`);
    } else {
      cur = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5;
      log(`R1 winner not found — using V5 baseline`);
    }
    const baseR = runWalkForward(data, cur);
    log(fmt("R2 BASELINE (R1-winner)", baseR));

    // F: chandelierExit
    log(`\n--- F: chandelierExit ---`);
    let fBest = { cfg: cur, r: baseR, label: "off" };
    for (const period of [14, 28, 56, 84, 168]) {
      for (const mult of [2, 2.5, 3, 3.5, 4, 5]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          chandelierExit: { period, mult, minMoveR: 0.5 },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, fBest.r) < 0) {
          fBest = { cfg, r, label: `chand p=${period} m=${mult}` };
          log(fmt(`  ${fBest.label}`, r));
        }
      }
    }
    log(fmt(`F WINNER (${fBest.label})`, fBest.r));
    cur = fBest.cfg;

    // G: partialTakeProfit
    log(`\n--- G: partialTakeProfit ---`);
    let gBest = { cfg: cur, r: fBest.r, label: "off" };
    for (const trig of [0.005, 0.01, 0.015, 0.02, 0.03, 0.04]) {
      for (const frac of [0.2, 0.3, 0.5, 0.7]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          partialTakeProfit: { triggerPct: trig, closeFraction: frac },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, gBest.r) < 0) {
          gBest = { cfg, r, label: `PTP t=${trig} f=${frac}` };
          log(fmt(`  ${gBest.label}`, r));
        }
      }
    }
    log(fmt(`G WINNER (${gBest.label})`, gBest.r));
    cur = gBest.cfg;

    // H: timeBoost
    log(`\n--- H: timeBoost ---`);
    let hBest = { cfg: cur, r: gBest.r, label: "off" };
    for (const day of [2, 4, 6, 8, 12, 18]) {
      for (const eb of [0.02, 0.04, 0.06, 0.08]) {
        for (const f of [1.5, 2, 2.5, 3]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            timeBoost: { afterDay: day, equityBelow: eb, factor: f },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, hBest.r) < 0) {
            hBest = { cfg, r, label: `tb d=${day} eb=${eb} f=${f}` };
            log(fmt(`  ${hBest.label}`, r));
          }
        }
      }
    }
    log(fmt(`H WINNER (${hBest.label})`, hBest.r));
    cur = hBest.cfg;

    // I: lossStreakCooldown
    log(`\n--- I: lossStreakCooldown ---`);
    let iBest = { cfg: cur, r: hBest.r, label: "off" };
    for (const after of [2, 3, 4, 5]) {
      for (const cd of [6, 12, 24, 48, 72, 120, 200]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, iBest.r) < 0) {
          iBest = { cfg, r, label: `LSC a=${after} cd=${cd}` };
          log(fmt(`  ${iBest.label}`, r));
        }
      }
    }
    log(fmt(`I WINNER (${iBest.label})`, iBest.r));
    cur = iBest.cfg;

    // J: breakEven
    log(`\n--- J: breakEven ---`);
    let jBest = { cfg: cur, r: iBest.r, label: "off" };
    for (const thr of [0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...cur,
        breakEven: { threshold: thr },
      };
      const r = runWalkForward(data, cfg);
      if (score(r, jBest.r) < 0) {
        jBest = { cfg, r, label: `BE thr=${thr}` };
        log(fmt(`  ${jBest.label}`, r));
      }
    }
    log(fmt(`J WINNER (${jBest.label})`, jBest.r));
    cur = jBest.cfg;

    // K: holdBars (per-asset uniform)
    log(`\n--- K: holdBars (per-asset uniform) ---`);
    let kBest = { cfg: cur, r: jBest.r, label: "240" };
    for (const hb of [60, 120, 180, 240, 360, 480]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...cur,
        holdBars: hb,
        assets: cur.assets.map((a) => ({ ...a, holdBars: hb })),
      };
      const r = runWalkForward(data, cfg);
      if (score(r, kBest.r) < 0) {
        kBest = { cfg, r, label: `hb=${hb}` };
        log(fmt(`  ${kBest.label}`, r));
      }
    }
    log(fmt(`K WINNER (${kBest.label})`, kBest.r));
    cur = kBest.cfg;

    log(`\n========== R2 FINAL ==========`);
    log(fmt("R2 baseline", baseR));
    log(fmt("After F (chand)", fBest.r));
    log(fmt("After G (PTP)", gBest.r));
    log(fmt("After H (tb)", hBest.r));
    log(fmt("After I (LSC)", iBest.r));
    log(fmt("After J (BE)", jBest.r));
    log(fmt("After K (hb)", kBest.r));
    log(
      `\nΔ R1 → R2: +${((kBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    writeFileSync(
      `${LOG_DIR}/R2_FINAL_CONFIG.json`,
      JSON.stringify(cur, null, 2),
    );
    log(`\nFinal config written to R2_FINAL_CONFIG.json`);

    expect(kBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
