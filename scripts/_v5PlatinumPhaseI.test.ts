/**
 * Phase I — per-asset stopPct tuning on V5_PLATINUM.
 * Phase F tuned TP per-asset; SL is currently 5% uniform. Try per-asset SL.
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
const LOG_FILE = `${LOG_DIR}/V5_PLAT_PHASE_I_${STAMP}.log`;
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
  passRate: number;
  passes: number;
  windows: number;
  tl: number;
  dl: number;
  med: number;
  p90: number;
  winrate: number;
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
  const stepBars = 3 * BARS_PER_DAY;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0,
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
    else if (res.reason === "daily_loss") dl++;
    for (const t of res.trades) {
      totalT++;
      if (t.effPnl > 0) totalW++;
    }
  }
  days.sort((a, b) => a - b);
  return {
    name,
    passRate: passes / windows,
    passes,
    windows,
    tl,
    dl,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    winrate: totalT > 0 ? totalW / totalT : 0,
  };
}
function fmt(r: Result): string {
  return `${r.name.padEnd(40)} pass=${(r.passRate * 100).toFixed(2).padStart(6)}% (${r.passes}/${r.windows}) wr=${(r.winrate * 100).toFixed(2).padStart(6)}% med=${String(r.med).padStart(2)}d p90=${String(r.p90).padStart(2)}d TL=${String(r.tl).padStart(3)} DL=${String(r.dl).padStart(3)}`;
}
function setAssetSp(
  cfg: FtmoDaytrade24hConfig,
  label: string,
  sp: number,
): FtmoDaytrade24hConfig {
  return {
    ...cfg,
    assets: cfg.assets.map((a) =>
      a.symbol === label ? { ...a, stopPct: sp } : a,
    ),
  };
}

describe("V5_PLATINUM Phase I", { timeout: 6 * 3600_000 }, () => {
  it("greedily tunes stopPct per asset", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V5_PLAT_PHASE_I START ${new Date().toISOString()}\n`,
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

    const SPs = [0.035, 0.04, 0.045, 0.05]; // bounded by liveCaps maxStopPct=0.05
    let best = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM;
    let bestR = baseR;
    const perAssetBest: Record<string, number> = {};

    for (const asset of best.assets.map((a) => a.symbol)) {
      log(`\n========== ${asset} ==========`);
      let aBest = bestR;
      let aBestSp =
        best.assets.find((a) => a.symbol === asset)?.stopPct ?? 0.05;
      for (const sp of SPs) {
        const trial = setAssetSp(best, asset, sp);
        const r = evaluate(
          `${asset} sp=${(sp * 100).toFixed(1)}%`,
          trial,
          data,
        );
        log(fmt(r));
        if (r.passRate > aBest.passRate && r.med <= 4) {
          aBest = r;
          aBestSp = sp;
        }
      }
      best = setAssetSp(best, asset, aBestSp);
      bestR = aBest;
      perAssetBest[asset] = aBestSp;
      log(
        `  → ${asset} best sp=${(aBestSp * 100).toFixed(1)}% (running ${(bestR.passRate * 100).toFixed(2)}%)`,
      );
    }

    log(`\n========== FINAL ==========`);
    log(fmt(bestR));
    for (const a of best.assets)
      log(
        `  ${a.symbol.padEnd(15)} sp=${((a.stopPct ?? 0) * 100).toFixed(1)}% tp=${((a.tpPct ?? 0) * 100).toFixed(1)}%`,
      );
    log(
      `vs V5_PLATINUM: +${((bestR.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    writeFileSync(
      `${LOG_DIR}/V5_PLAT_PHASE_I_${STAMP}.json`,
      JSON.stringify(
        {
          baseline: baseR,
          perAssetBestSp: perAssetBest,
          finalAssets: best.assets.map((a) => ({
            symbol: a.symbol,
            sourceSymbol: a.sourceSymbol,
            stopPct: a.stopPct,
            tpPct: a.tpPct,
          })),
          finalResult: bestR,
        },
        null,
        2,
      ),
    );

    expect(bestR.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
