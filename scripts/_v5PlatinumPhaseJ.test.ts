/**
 * Phase J — engine-level adders on V5_PLATINUM:
 *   - hour-filter sweep (drop 0-3 random/best hours)
 *   - atrStop add
 *   - lossStreakCooldown add
 *   - holdBars sweep
 *
 * Step sizes scanned: 1d (high-N), 3d (default).
 * Goal: lift step=1d pass-rate from 54.13% to 55%+.
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
const LOG_FILE = `${LOG_DIR}/V5_PLAT_PHASE_J_${STAMP}.log`;
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
  stepBars: number,
): Result {
  const c = normalize(cfg);
  const symbols = syms(c);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = c.maxDays * BARS_PER_DAY;
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
function fmtRow(r1d: Result, r3d: Result): string {
  return `${r1d.name.padEnd(36)} 1d=${(r1d.passRate * 100).toFixed(2).padStart(6)}% (${r1d.passes}/${r1d.windows}) | 3d=${(r3d.passRate * 100).toFixed(2).padStart(6)}% (${r3d.passes}/${r3d.windows}) | wr=${(r3d.winrate * 100).toFixed(2).padStart(6)}% | TL3d=${r3d.tl}`;
}

const BASE_HOURS = [2, 4, 6, 8, 10, 12, 14, 18, 20, 22];

describe("V5_PLATINUM Phase J", { timeout: 8 * 3600_000 }, () => {
  it("engine-level adders sweep", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V5_PLAT_PHASE_J START ${new Date().toISOString()}\n`,
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

    const baseR1 = evaluate(
      "V5_PLATINUM baseline",
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
      data,
      BARS_PER_DAY,
    );
    const baseR3 = evaluate(
      "V5_PLATINUM baseline",
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
      data,
      3 * BARS_PER_DAY,
    );
    log(fmtRow(baseR1, baseR3));

    const trials: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [];

    // 1) hour-filter: drop one hour at a time
    log(`\n========== Drop 1 hour ==========`);
    for (const dropHr of BASE_HOURS) {
      const hours = BASE_HOURS.filter((h) => h !== dropHr);
      trials.push({
        name: `drop hr=${dropHr}`,
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
          allowedHoursUtc: hours,
        },
      });
    }

    // 2) drop 2 hours
    for (let i = 0; i < BASE_HOURS.length; i++) {
      for (let j = i + 1; j < BASE_HOURS.length; j++) {
        if (Math.random() > 0.3) continue; // sample subset
        const hours = BASE_HOURS.filter(
          (h) => h !== BASE_HOURS[i] && h !== BASE_HOURS[j],
        );
        trials.push({
          name: `drop hrs={${BASE_HOURS[i]},${BASE_HOURS[j]}}`,
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
            allowedHoursUtc: hours,
          },
        });
      }
    }

    // 3) atrStop variants
    log(`\n========== atrStop add ==========`);
    for (const period of [14, 28]) {
      for (const mult of [2, 3, 4]) {
        trials.push({
          name: `atrStop p${period}m${mult}`,
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
            atrStop: { period, stopMult: mult },
          },
        });
      }
    }

    // 4) lossStreakCooldown variants
    log(`\n========== LSC add ==========`);
    for (const after of [2, 3]) {
      for (const cd of [12, 24, 48, 96]) {
        trials.push({
          name: `LSC ${after}/${cd}`,
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
            lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
          },
        });
      }
    }

    // 5) holdBars sweep
    log(`\n========== holdBars sweep ==========`);
    for (const hb of [120, 180, 300, 360, 480]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
        holdBars: hb,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM.assets.map(
          (a) => ({ ...a, holdBars: hb }),
        ),
      };
      trials.push({ name: `holdBars=${hb}`, cfg });
    }

    // 6) maxConcurrentTrades
    for (const mc of [3, 4, 5, 6, 8, 10]) {
      trials.push({
        name: `maxConcurrent=${mc}`,
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
          maxConcurrentTrades: mc,
        },
      });
    }

    log(`\n========== EVALUATING ${trials.length} variants ==========`);
    interface Both {
      name: string;
      r1: Result;
      r3: Result;
    }
    const results: Both[] = [{ name: "baseline", r1: baseR1, r3: baseR3 }];
    for (const t of trials) {
      const r3 = evaluate(t.name, t.cfg, data, 3 * BARS_PER_DAY);
      const r1 = evaluate(t.name, t.cfg, data, BARS_PER_DAY);
      log(fmtRow(r1, r3));
      results.push({ name: t.name, r1, r3 });
    }

    log(`\n========== TOP 15 BY 1d PASS-RATE (med ≤ 4d) ==========`);
    const top1 = results
      .filter(
        (b) => b.r1.med > 0 && b.r1.med <= 4 && b.r3.med > 0 && b.r3.med <= 4,
      )
      .sort((a, b) => b.r1.passRate - a.r1.passRate);
    for (const r of top1.slice(0, 15)) log(fmtRow(r.r1, r.r3));

    log(`\n========== TOP 15 BY 3d PASS-RATE ==========`);
    const top3 = results
      .filter((b) => b.r3.med > 0 && b.r3.med <= 4)
      .sort((a, b) => b.r3.passRate - a.r3.passRate);
    for (const r of top3.slice(0, 15)) log(fmtRow(r.r1, r.r3));

    writeFileSync(
      `${LOG_DIR}/V5_PLAT_PHASE_J_${STAMP}.json`,
      JSON.stringify(results, null, 2),
    );

    expect(top1[0]?.r1?.passRate ?? 0).toBeGreaterThan(0);
  });
});
