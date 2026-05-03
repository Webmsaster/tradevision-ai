/**
 * Phase H — STX TP fine-tune on V5_PLATINUM + STX (15 assets).
 * Phase G found STX adds marginal +0.15pp at default tp=4% — try other TPs.
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
const LOG_FILE = `${LOG_DIR}/V5_PLAT_STX_${STAMP}.log`;
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
    totalTrades = 0,
    totalWins = 0;
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
      totalTrades++;
      if (t.effPnl > 0) totalWins++;
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
    winrate: totalTrades > 0 ? totalWins / totalTrades : 0,
  };
}
function fmt(r: Result): string {
  return `${r.name.padEnd(40)} pass=${(r.passRate * 100).toFixed(2).padStart(6)}% (${r.passes}/${r.windows}) wr=${(r.winrate * 100).toFixed(2).padStart(6)}% med=${String(r.med).padStart(2)}d p90=${String(r.p90).padStart(2)}d TL=${String(r.tl).padStart(3)} DL=${String(r.dl).padStart(3)}`;
}
function withStx(tp: number): FtmoDaytrade24hConfig {
  return {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
    assets: [
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM.assets,
      {
        symbol: "STX-TREND",
        sourceSymbol: "STXUSDT",
        costBp: 30,
        slippageBp: 8,
        swapBpPerDay: 4,
        riskFrac: 1.0,
        triggerBars: 1,
        invertDirection: true,
        disableShort: true,
        stopPct: 0.05,
        tpPct: tp,
        holdBars: 240,
      },
    ],
  };
}

describe("V5_PLATINUM + STX TP tune", { timeout: 4 * 3600_000 }, () => {
  it("scans STX TP", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `V5_PLAT_STX START ${new Date().toISOString()}\n`);

    const allSyms = [
      ...new Set([
        ...syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM),
        "STXUSDT",
      ]),
    ].sort();
    log(`\nLoading ${allSyms.length} symbols...`);
    const data: Record<string, Candle[]> = {};
    for (const s of allSyms) {
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

    log(`\n========== +STX with various TPs ==========`);
    for (const tp of [0.03, 0.035, 0.04, 0.045, 0.05, 0.055, 0.06]) {
      const r = evaluate(
        `+STX tp=${(tp * 100).toFixed(1)}%`,
        withStx(tp),
        data,
      );
      log(fmt(r));
    }

    expect(true).toBe(true);
  });
});
