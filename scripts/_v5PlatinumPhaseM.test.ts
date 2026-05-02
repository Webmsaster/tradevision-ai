/**
 * Phase M — Timeframe shootout: V5_PLATINUM 14-asset basket on 30m / 1h / 2h / 4h.
 * Hypothesis: maybe 30m/1h gives better entry-timing precision and pushes pass-rate
 * above 2h's 58.46% plateau.
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

const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_PLAT_PHASE_M_${STAMP}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, `${s}\n`);
}
function normalize(
  cfg: FtmoDaytrade24hConfig,
  tf: "30m" | "1h" | "2h" | "4h",
): FtmoDaytrade24hConfig {
  const c = structuredClone(cfg);
  c.timeframe = tf;
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
function evaluate(
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  barsPerDay: number,
  stepDays: number,
) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = cfg.maxDays * barsPerDay;
  const stepBars = stepDays * barsPerDay;
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
    const res = runFtmoDaytrade24h(slice, cfg);
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
    passRate: passes / windows,
    passes,
    windows,
    tl,
    dl,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    winrate: totalT > 0 ? totalW / totalT : 0,
    years: n / barsPerDay / 365,
  };
}

const TFS: Array<{
  tf: "30m" | "1h" | "2h" | "4h";
  barsPerDay: number;
  targetCount: number;
  maxPages: number;
}> = [
  { tf: "30m", barsPerDay: 48, targetCount: 100000, maxPages: 120 },
  { tf: "1h", barsPerDay: 24, targetCount: 50000, maxPages: 60 },
  { tf: "2h", barsPerDay: 12, targetCount: 30000, maxPages: 40 },
  { tf: "4h", barsPerDay: 6, targetCount: 30000, maxPages: 40 },
];

describe("V5_PLATINUM TF shootout", { timeout: 6 * 3600_000 }, () => {
  it("runs PLATINUM basket on 30m/1h/2h/4h", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V5_PLAT_PHASE_M START ${new Date().toISOString()}\n`,
    );

    const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM);
    log(`\nLoading 14 symbols across 4 timeframes...`);
    const dataByTf: Record<string, Record<string, Candle[]>> = {};
    for (const t of TFS) {
      dataByTf[t.tf] = {};
      log(`  ${t.tf}:`);
      for (const s of symbols) {
        try {
          const raw = await loadBinanceHistory({
            symbol: s,
            timeframe: t.tf,
            targetCount: t.targetCount,
            maxPages: t.maxPages,
          });
          dataByTf[t.tf][s] = raw.filter((c) => c.isFinal);
          log(`    ${s.padEnd(10)} final=${dataByTf[t.tf][s].length}`);
        } catch (e) {
          log(`    ${s.padEnd(10)} LOAD FAILED: ${String(e).slice(0, 60)}`);
        }
      }
    }

    log(`\n========== Step=3d, all TFs ==========`);
    for (const t of TFS) {
      const cfg = normalize(
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
        t.tf,
      );
      const r = evaluate(cfg, dataByTf[t.tf], t.barsPerDay, 3);
      log(
        `  ${t.tf.padEnd(4)} pass=${(r.passRate * 100).toFixed(2).padStart(6)}% (${r.passes}/${r.windows}) wr=${(r.winrate * 100).toFixed(2).padStart(6)}% med=${r.med}d p90=${r.p90}d TL=${r.tl} years=${r.years.toFixed(2)}`,
      );
    }

    log(`\n========== Step=1d, all TFs ==========`);
    for (const t of TFS) {
      const cfg = normalize(
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
        t.tf,
      );
      const r = evaluate(cfg, dataByTf[t.tf], t.barsPerDay, 1);
      log(
        `  ${t.tf.padEnd(4)} pass=${(r.passRate * 100).toFixed(2).padStart(6)}% (${r.passes}/${r.windows}) wr=${(r.winrate * 100).toFixed(2).padStart(6)}% med=${r.med}d p90=${r.p90}d TL=${r.tl} years=${r.years.toFixed(2)}`,
      );
    }

    expect(true).toBe(true);
  });
});
