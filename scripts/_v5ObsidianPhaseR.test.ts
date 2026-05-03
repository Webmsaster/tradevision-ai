/**
 * Phase R — engine adders on V5_OBSIDIAN (15 assets, 30m).
 * Tests hour-filter / atrStop / chandelier / breakEven / LSC on the 3y sample.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_OBSIDIAN_PHASE_R_${STAMP}.log`;
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
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = cfg.maxDays * BARS_PER_DAY;
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
  return `${r.name.padEnd(36)} 1d=${(r.pass1 * 100).toFixed(2).padStart(6)}% (${r.passes1}/${r.n1}) | 3d=${(r.pass3 * 100).toFixed(2).padStart(6)}% (${r.passes3}/${r.n3}) | wr=${(r.wr3 * 100).toFixed(2).padStart(6)}% TL3=${r.tl3}`;
}

describe("V5_OBSIDIAN Phase R", { timeout: 6 * 3600_000 }, () => {
  it("engine adders sweep on V5_OBSIDIAN 30m", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V5_OBSIDIAN_PHASE_R START ${new Date().toISOString()}\n`,
    );

    const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN);
    log(`\nLoading 30m: ${symbols.join(", ")}`);
    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      const raw = await loadBinanceHistory({
        symbol: s,
        timeframe: "30m",
        targetCount: 100000,
        maxPages: 120,
      });
      data[s] = raw.filter((c) => c.isFinal);
    }

    const baseR = evaluate(
      "V5_OBSIDIAN baseline",
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
      data,
    );
    log(fmt(baseR));

    const trials: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [];

    log(`\n========== atrStop ==========`);
    for (const period of [14, 28, 56]) {
      for (const mult of [2, 3, 4]) {
        trials.push({
          name: `atrStop p${period}m${mult}`,
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
            atrStop: { period, stopMult: mult },
          },
        });
      }
    }

    log(`\n========== chandelierExit ==========`);
    for (const period of [14, 28, 56]) {
      for (const mult of [2, 3, 4]) {
        trials.push({
          name: `chand p${period}m${mult}`,
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
            chandelierExit: { period, mult, minMoveR: 0.5 },
          },
        });
      }
    }

    log(`\n========== breakEven ==========`);
    for (const th of [0.015, 0.02, 0.025, 0.03]) {
      trials.push({
        name: `BE ${th}`,
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
          breakEven: { threshold: th },
        },
      });
    }

    log(`\n========== lossStreakCooldown ==========`);
    for (const after of [2, 3]) {
      for (const cd of [12, 24, 48, 96]) {
        trials.push({
          name: `LSC ${after}/${cd}`,
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
            lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
          },
        });
      }
    }

    log(`\n========== hour drops (1-2 hours) ==========`);
    const HOURS = [2, 4, 6, 8, 10, 12, 14, 18, 20, 22];
    for (const dropHr of HOURS) {
      const hours = HOURS.filter((h) => h !== dropHr);
      trials.push({
        name: `drop hr=${dropHr}`,
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
          allowedHoursUtc: hours,
        },
      });
    }

    log(`\n========== holdBars ==========`);
    for (const hb of [120, 180, 240, 300, 360, 480]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
        holdBars: hb,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN.assets.map(
          (a) => ({ ...a, holdBars: hb }),
        ),
      };
      trials.push({ name: `holdBars=${hb}`, cfg });
    }

    log(`\n========== EVALUATING ${trials.length} variants ==========`);
    const results: Array<{ name: string; r: Result }> = [
      { name: "baseline", r: baseR },
    ];
    for (const t of trials) {
      const r = evaluate(t.name, t.cfg, data);
      log(fmt(r));
      results.push({ name: t.name, r });
    }

    log(`\n========== TOP 15 BY 1d (med ≤ 4d) ==========`);
    const top1 = results
      .filter((b) => b.r.med3 > 0 && b.r.med3 <= 4)
      .sort((a, b) => b.r.pass1 - a.r.pass1);
    for (const r of top1.slice(0, 15)) log(fmt(r.r));

    log(`\n========== TOP 15 BY 3d ==========`);
    const top3 = results
      .filter((b) => b.r.med3 > 0 && b.r.med3 <= 4)
      .sort((a, b) => b.r.pass3 - a.r.pass3);
    for (const r of top3.slice(0, 15)) log(fmt(r.r));

    writeFileSync(
      `${LOG_DIR}/V5_OBSIDIAN_PHASE_R_${STAMP}.json`,
      JSON.stringify(results, null, 2),
    );
    expect(top1[0]?.r?.pass1 ?? 0).toBeGreaterThan(0);
  });
});
