/**
 * Phase ZB — V5_TOPAZ basket on 15m timeframe.
 * 15m has 96 bars/day vs 30m's 48 — finer entry timing, potentially different
 * mean-reversion regime. Untested for V5 family.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_TOPAZ_PHASE_ZB_${STAMP}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, `${s}\n`);
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
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    winrate: totalT > 0 ? totalW / totalT : 0,
  };
}

const TFS: Array<{
  tf: "5m" | "15m" | "30m";
  barsPerDay: number;
  targetCount: number;
  maxPages: number;
}> = [
  { tf: "5m", barsPerDay: 288, targetCount: 200000, maxPages: 250 },
  { tf: "15m", barsPerDay: 96, targetCount: 150000, maxPages: 180 },
  { tf: "30m", barsPerDay: 48, targetCount: 100000, maxPages: 120 },
];

describe(
  "V5_TOPAZ Phase ZB — 5m/15m/30m TF shootout",
  { timeout: 8 * 3600_000 },
  () => {
    it("compares TFs with V5_TOPAZ basket", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `V5_TOPAZ_PHASE_ZB START ${new Date().toISOString()}\n`,
      );

      const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ);
      log(`\nLoading 14 symbols across 3 short TFs...`);
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

      log(`\n========== TF shootout (step=3d / step=1d) ==========`);
      for (const t of TFS) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ,
          timeframe: t.tf,
        };
        const r3 = evaluate(cfg, dataByTf[t.tf], t.barsPerDay, 3);
        const r1 = evaluate(cfg, dataByTf[t.tf], t.barsPerDay, 1);
        log(
          `  ${t.tf.padEnd(4)} step=3d pass=${(r3.passRate * 100).toFixed(2).padStart(6)}% (${r3.passes}/${r3.windows}) wr=${(r3.winrate * 100).toFixed(2).padStart(6)}% med=${r3.med}d p90=${r3.p90}d TL=${r3.tl}`,
        );
        log(
          `  ${t.tf.padEnd(4)} step=1d pass=${(r1.passRate * 100).toFixed(2).padStart(6)}% (${r1.passes}/${r1.windows}) wr=${(r1.winrate * 100).toFixed(2).padStart(6)}% med=${r1.med}d p90=${r1.p90}d TL=${r1.tl}`,
        );
      }

      expect(true).toBe(true);
    });
  },
);
