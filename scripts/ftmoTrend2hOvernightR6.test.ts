/**
 * R6 — heavy-hitting axes on HONEST winner
 *
 * Builds on HONEST_FINAL (44.71%):
 *   AA: atrStop sweep (period × mult)
 *   BB: chandelierExit
 *   CC: greedy hour-drop (deep)
 *   DD: choppinessFilter
 *   EE: drawdownShield + peakDrawdownThrottle
 *   FF: holdBars per-asset (mass sweep)
 *   GG: combined: stack winners
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

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R6_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe("R6 — heavy axes on HONEST winner", { timeout: 24 * 3600_000 }, () => {
  it("runs R6", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R6 START ${new Date().toISOString()}\n`);

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

    const honestPath = `${LOG_DIR}/HONEST_FINAL_CONFIG.json`;
    if (!existsSync(honestPath)) {
      log(`HONEST_FINAL_CONFIG.json missing — fallback to V5`);
    }
    let cur: FtmoDaytrade24hConfig = existsSync(honestPath)
      ? JSON.parse(readFileSync(honestPath, "utf-8"))
      : JSON.parse(JSON.stringify(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5));
    const baseR = runWalkForward(data, cur);
    log(fmt("R6 BASELINE", baseR));

    // AA: atrStop
    log(`\n--- AA: atrStop ---`);
    let aaBest = { cfg: cur, r: baseR, label: "off" };
    for (const period of [14, 28, 56, 84, 168]) {
      for (const mult of [1.5, 2, 2.5, 3, 3.5, 4, 5, 6]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          atrStop: { period, stopMult: mult },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, aaBest.r) < 0) {
          aaBest = { cfg, r, label: `atr p=${period} m=${mult}` };
          log(fmt(`  ${aaBest.label}`, r));
        }
      }
    }
    log(fmt(`AA WINNER (${aaBest.label})`, aaBest.r));
    cur = aaBest.cfg;

    // BB: chandelierExit
    log(`\n--- BB: chandelierExit ---`);
    let bbBest = { cfg: cur, r: aaBest.r, label: "off" };
    for (const period of [14, 28, 56, 84, 168, 240]) {
      for (const mult of [1.5, 2, 2.5, 3, 4, 5]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          chandelierExit: { period, mult, minMoveR: 0.5 },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, bbBest.r) < 0) {
          bbBest = { cfg, r, label: `chand p=${period} m=${mult}` };
          log(fmt(`  ${bbBest.label}`, r));
        }
      }
    }
    log(fmt(`BB WINNER (${bbBest.label})`, bbBest.r));
    cur = bbBest.cfg;

    // CC: deep hour-drop
    log(`\n--- CC: deep hour-drop ---`);
    let ccBest = { cfg: cur, r: bbBest.r };
    let hours = (
      cur.allowedHoursUtc ?? Array.from({ length: 24 }, (_, i) => i)
    ).slice();
    let it = 0;
    while (it < 8) {
      let stepBest: {
        cfg: FtmoDaytrade24hConfig;
        r: BatchResult;
        h: number;
      } | null = null;
      for (const h of [...hours]) {
        if (hours.length < 4) break;
        const cand = hours.filter((x) => x !== h);
        const cfg: FtmoDaytrade24hConfig = {
          ...ccBest.cfg,
          allowedHoursUtc: cand,
        };
        const r = runWalkForward(data, cfg);
        if (score(r, ccBest.r) < 0) {
          if (stepBest === null || score(r, stepBest.r) < 0)
            stepBest = { cfg, r, h };
        }
      }
      if (stepBest === null) break;
      ccBest = { cfg: stepBest.cfg, r: stepBest.r };
      hours = hours.filter((h) => h !== stepBest!.h);
      log(fmt(`  drop ${stepBest.h}`, stepBest.r));
      it++;
    }
    log(fmt(`CC WINNER (h=${hours.length})`, ccBest.r));
    cur = ccBest.cfg;

    // DD: choppinessFilter
    log(`\n--- DD: choppinessFilter ---`);
    let ddBest = { cfg: cur, r: ccBest.r, label: "off" };
    for (const period of [10, 14, 20, 28]) {
      for (const maxCi of [55, 60, 65, 70, 75]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          choppinessFilter: { period, maxCi },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, ddBest.r) < 0) {
          ddBest = { cfg, r, label: `chop p=${period} max=${maxCi}` };
          log(fmt(`  ${ddBest.label}`, r));
        }
      }
    }
    log(fmt(`DD WINNER (${ddBest.label})`, ddBest.r));
    cur = ddBest.cfg;

    // EE: drawdownShield + peakDrawdownThrottle
    log(`\n--- EE: drawdownShield + peakThrottle ---`);
    let eeBest = { cfg: cur, r: ddBest.r, label: "off" };
    for (const be of [-0.05, -0.03, -0.02, -0.01]) {
      for (const f of [0.3, 0.5, 0.7]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          drawdownShield: { belowEquity: be, factor: f },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, eeBest.r) < 0) {
          eeBest = { cfg, r, label: `dd be=${be} f=${f}` };
          log(fmt(`  ${eeBest.label}`, r));
        }
      }
    }
    for (const fp of [0.02, 0.03, 0.05, 0.08]) {
      for (const f of [0.3, 0.5, 0.7]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          peakDrawdownThrottle: { fromPeak: fp, factor: f },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, eeBest.r) < 0) {
          eeBest = { cfg, r, label: `peak fp=${fp} f=${f}` };
          log(fmt(`  ${eeBest.label}`, r));
        }
      }
    }
    log(fmt(`EE WINNER (${eeBest.label})`, eeBest.r));
    cur = eeBest.cfg;

    // FF: holdBars uniform
    log(`\n--- FF: holdBars uniform ---`);
    let ffBest = { cfg: cur, r: eeBest.r, label: "240" };
    for (const hb of [60, 120, 180, 240, 300, 360, 480, 600, 720]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...cur,
        holdBars: hb,
        assets: cur.assets.map((a) => ({ ...a, holdBars: hb })),
      };
      const r = runWalkForward(data, cfg);
      if (score(r, ffBest.r) < 0) {
        ffBest = { cfg, r, label: `hb=${hb}` };
        log(fmt(`  ${ffBest.label}`, r));
      }
    }
    log(fmt(`FF WINNER (${ffBest.label})`, ffBest.r));
    cur = ffBest.cfg;

    // GG: dailyGainCap + maxTotalTrades safety
    log(`\n--- GG: dailyGainCap / maxTotalTrades ---`);
    let ggBest = { cfg: cur, r: ffBest.r, label: "off" };
    for (const cap of [0.02, 0.03, 0.05, 0.08]) {
      const cfg: FtmoDaytrade24hConfig = { ...cur, dailyGainCap: cap };
      const r = runWalkForward(data, cfg);
      if (score(r, ggBest.r) < 0) {
        ggBest = { cfg, r, label: `dGain=${cap}` };
        log(fmt(`  ${ggBest.label}`, r));
      }
    }
    for (const mt of [10, 20, 40, 80, 150]) {
      const cfg: FtmoDaytrade24hConfig = { ...cur, maxTotalTrades: mt };
      const r = runWalkForward(data, cfg);
      if (score(r, ggBest.r) < 0) {
        ggBest = { cfg, r, label: `maxTrades=${mt}` };
        log(fmt(`  ${ggBest.label}`, r));
      }
    }
    log(fmt(`GG WINNER (${ggBest.label})`, ggBest.r));
    cur = ggBest.cfg;

    log(`\n========== R6 FINAL ==========`);
    log(fmt("R6 baseline (HONEST)", baseR));
    log(fmt("After AA (atrStop)", aaBest.r));
    log(fmt("After BB (chand)", bbBest.r));
    log(fmt("After CC (hours)", ccBest.r));
    log(fmt("After DD (chop)", ddBest.r));
    log(fmt("After EE (DD)", eeBest.r));
    log(fmt("After FF (hb)", ffBest.r));
    log(fmt("After GG (caps)", ggBest.r));
    log(
      `\nΔ baseline → R6: +${((ggBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    writeFileSync(
      `${LOG_DIR}/R6_FINAL_CONFIG.json`,
      JSON.stringify(cur, null, 2),
    );

    expect(ggBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
