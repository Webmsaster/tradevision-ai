/**
 * Phase N — per-asset triggerBars + holdBars sweep on V5_PLATINUM.
 * Phase F tuned tpPct, Phase I tuned stopPct (no improvement).
 * Untested per-asset dimensions: triggerBars (currently 1) + holdBars (currently 240).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_PLAT_PHASE_N_${STAMP}.log`;

function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, `${s}\n`);
}
function normalize(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  const c = structuredClone(cfg);
  c.timeframe = "2h";
  c.profitTarget = 0.08;
  c.maxDailyLoss = 0.05;
  c.maxTotalLoss = 0.1;
  c.minTradingDays = 4;
  c.maxDays = 30;
  c.pauseAtTargetReached = true;
  c.liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
  return c;
}
function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}
function alignCommon(data: Record<string, Candle[]>, symbols: string[]) {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
}
interface Result {
  name: string;
  pass1: number;
  pass3: number;
  passes1: number;
  passes3: number;
  n1: number;
  n3: number;
  tl3: number;
  med3: number;
  wr3: number;
}
function evaluate(
  name: string,
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
): Result {
  const c = normalize(cfg);
  const symbols = syms(c);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = c.maxDays * BARS_PER_DAY;
  const compute = (stepBars: number) => {
    let windows = 0,
      passes = 0,
      tl = 0,
      totalT = 0,
      totalW = 0;
    const days: number[] = [];
    for (let start = 0; start + winBars <= n; start += stepBars) {
      const slice: Record<string, Candle[]> = {};
      for (const s of symbols)
        slice[s] = aligned[s].slice(start, start + winBars);
      const res = runFtmoDaytrade24h(slice, c);
      windows++;
      if (res.passed) {
        passes++;
        days.push(res.passDay ?? 0);
      } else if (res.reason === "total_loss") tl++;
      for (const t of res.trades) {
        totalT++;
        if (t.effPnl > 0) totalW++;
      }
    }
    days.sort((a, b) => a - b);
    return {
      passes,
      windows,
      tl,
      med: days[Math.floor(days.length * 0.5)] ?? 0,
      wr: totalT > 0 ? totalW / totalT : 0,
    };
  };
  const r1 = compute(BARS_PER_DAY);
  const r3 = compute(3 * BARS_PER_DAY);
  return {
    name,
    pass1: r1.passes / r1.windows,
    pass3: r3.passes / r3.windows,
    passes1: r1.passes,
    passes3: r3.passes,
    n1: r1.windows,
    n3: r3.windows,
    tl3: r3.tl,
    med3: r3.med,
    wr3: r3.wr,
  };
}
function fmt(r: Result): string {
  return `${r.name.padEnd(36)} 1d=${(r.pass1 * 100).toFixed(2).padStart(6)}% (${r.passes1}/${r.n1}) | 3d=${(r.pass3 * 100).toFixed(2).padStart(6)}% (${r.passes3}/${r.n3}) | wr=${(r.wr3 * 100).toFixed(2).padStart(6)}% TL3=${r.tl3} med3=${r.med3}`;
}
function setAssetField(
  cfg: FtmoDaytrade24hConfig,
  label: string,
  field: "triggerBars" | "holdBars",
  value: number,
): FtmoDaytrade24hConfig {
  return {
    ...cfg,
    assets: cfg.assets.map((a) =>
      a.symbol === label ? { ...a, [field]: value } : a,
    ),
  };
}

describe("V5_PLATINUM Phase N", { timeout: 8 * 3600_000 }, () => {
  it("greedy per-asset triggerBars + holdBars", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V5_PLAT_PHASE_N START ${new Date().toISOString()}\n`,
    );

    const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM);
    log(`\nLoading: ${symbols.join(", ")}`);
    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      const raw = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
      data[s] = raw.filter((c) => c.isFinal);
    }

    const baseR = evaluate(
      "V5_PLATINUM baseline",
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
      data,
    );
    log(fmt(baseR));

    let best = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM;
    let bestR = baseR;

    log(`\n========== Phase N1: per-asset triggerBars ==========`);
    for (const asset of best.assets.map((a) => a.symbol)) {
      let aBest = bestR;
      let aBestVal =
        best.assets.find((a) => a.symbol === asset)?.triggerBars ?? 1;
      for (const tb of [1, 2, 3]) {
        const trial = setAssetField(best, asset, "triggerBars", tb);
        const r = evaluate(`${asset} tb=${tb}`, trial, data);
        log(fmt(r));
        if (r.pass3 > aBest.pass3 && r.med3 <= 4) {
          aBest = r;
          aBestVal = tb;
        }
      }
      best = setAssetField(best, asset, "triggerBars", aBestVal);
      bestR = aBest;
      log(
        `  → ${asset} best tb=${aBestVal} (running 3d=${(bestR.pass3 * 100).toFixed(2)}%)`,
      );
    }

    log(`\n========== Phase N2: per-asset holdBars ==========`);
    for (const asset of best.assets.map((a) => a.symbol)) {
      let aBest = bestR;
      let aBestVal =
        best.assets.find((a) => a.symbol === asset)?.holdBars ?? 240;
      for (const hb of [120, 180, 240, 300, 360]) {
        const trial = setAssetField(best, asset, "holdBars", hb);
        const r = evaluate(`${asset} hb=${hb}`, trial, data);
        log(fmt(r));
        if (r.pass3 > aBest.pass3 && r.med3 <= 4) {
          aBest = r;
          aBestVal = hb;
        }
      }
      best = setAssetField(best, asset, "holdBars", aBestVal);
      bestR = aBest;
      log(
        `  → ${asset} best hb=${aBestVal} (running 3d=${(bestR.pass3 * 100).toFixed(2)}%)`,
      );
    }

    log(`\n========== FINAL ==========`);
    log(fmt(bestR));
    log(
      `vs baseline: 3d=+${((bestR.pass3 - baseR.pass3) * 100).toFixed(2)}pp / 1d=+${((bestR.pass1 - baseR.pass1) * 100).toFixed(2)}pp`,
    );
    for (const a of best.assets)
      log(
        `  ${a.symbol.padEnd(15)} tb=${a.triggerBars} hb=${a.holdBars} sp=${a.stopPct} tp=${a.tpPct}`,
      );

    writeFileSync(
      `${LOG_DIR}/V5_PLAT_PHASE_N_${STAMP}.json`,
      JSON.stringify(
        {
          baseline: baseR,
          finalAssets: best.assets.map((a) => ({
            symbol: a.symbol,
            sourceSymbol: a.sourceSymbol,
            triggerBars: a.triggerBars,
            holdBars: a.holdBars,
            stopPct: a.stopPct,
            tpPct: a.tpPct,
          })),
          finalResult: bestR,
        },
        null,
        2,
      ),
    );

    expect(bestR.pass3).toBeGreaterThanOrEqual(baseR.pass3);
  });
});
