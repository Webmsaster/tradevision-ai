/**
 * Focused 15m live-capped check for the fast challenge selector.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Candle } from "../src/utils/indicators";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  type FtmoDaytrade24hConfig,
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3,
} from "../src/utils/ftmoDaytrade24h";

const LOG_DIR = "scripts/overnight_results";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = `${LOG_DIR}/FAST_CHALLENGE_15M_${STAMP}.log`;
const BARS_PER_DAY = 96;

interface Result {
  name: string;
  years: number;
  windows: number;
  passes: number;
  passRate: number;
  tl: number;
  dl: number;
  timeout: number;
  med: number;
  p75: number;
  p90: number;
}

function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, `${s}\n`);
}

function sourceSymbols(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol) out.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) out.add(f.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}

function normalize(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  const c = structuredClone(cfg);
  c.timeframe = "15m";
  c.profitTarget = 0.08;
  c.maxDailyLoss = 0.05;
  c.maxTotalLoss = 0.1;
  c.minTradingDays = 4;
  c.maxDays = 30;
  c.pauseAtTargetReached = true;
  c.liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
  return c;
}

function alignCommon(data: Record<string, Candle[]>, symbols: string[]) {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const commonSet = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => commonSet.has(c.openTime));
  return aligned;
}

function evaluate(
  name: string,
  rawCfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
): Result {
  const cfg = normalize(rawCfg);
  const symbols = sourceSymbols(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = cfg.maxDays * BARS_PER_DAY;
  const stepBars = 3 * BARS_PER_DAY;
  let windows = 0;
  let passes = 0;
  let tl = 0;
  let dl = 0;
  let timeout = 0;
  const days: number[] = [];
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    windows++;
    if (res.passed) {
      passes++;
      days.push(
        res.passDay ?? (res.trades[res.trades.length - 1]?.day ?? 0) + 1,
      );
    } else if (res.reason === "total_loss") {
      tl++;
    } else if (res.reason === "daily_loss") {
      dl++;
    } else if (res.reason === "time") {
      timeout++;
    }
  }
  days.sort((a, b) => a - b);
  return {
    name,
    years: n / BARS_PER_DAY / 365,
    windows,
    passes,
    passRate: windows > 0 ? passes / windows : 0,
    tl,
    dl,
    timeout,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p75: days[Math.floor(days.length * 0.75)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
  };
}

function fmt(r: Result) {
  return `${r.name.padEnd(14)} ${String(r.passes).padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}% TL=${String(r.tl).padStart(3)} DL=${String(r.dl).padStart(3)} TO=${String(r.timeout).padStart(3)} med=${String(r.med).padStart(2)}d p75=${String(r.p75).padStart(2)}d p90=${String(r.p90).padStart(2)}d years=${r.years.toFixed(2)}`;
}

describe("15m fast challenge check", { timeout: 24 * 3600_000 }, () => {
  it("checks live 15m family under current caps", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `FAST_CHALLENGE_15M START ${new Date().toISOString()}\n`,
    );
    const candidates: Array<[string, FtmoDaytrade24hConfig]> = [
      ["LIVE_15M_V1", FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1],
      ["LIVE_15M_V2", FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2],
      ["LIVE_15M_V3", FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3],
    ];
    const symbols = [
      ...new Set(
        candidates.flatMap(([, cfg]) => sourceSymbols(normalize(cfg))),
      ),
    ].sort();
    const data: Record<string, Candle[]> = {};
    log(`Loading 15m: ${symbols.join(", ")}`);
    for (const s of symbols) {
      const raw = await loadBinanceHistory({
        symbol: s,
        timeframe: "15m",
        targetCount: 120000,
        maxPages: 140,
      });
      data[s] = raw.filter((c) => c.isFinal);
      const cs = data[s];
      log(
        `  ${s.padEnd(8)} final=${cs.length} first=${new Date(cs[0]?.openTime ?? 0).toISOString()} last=${new Date(cs[cs.length - 1]?.openTime ?? 0).toISOString()}`,
      );
    }
    const rows = candidates
      .map(([name, cfg]) => evaluate(name, cfg, data))
      .sort((a, b) => b.passRate - a.passRate || a.p90 - b.p90);
    log("\n========== 15M RESULTS ==========");
    for (const row of rows) log(fmt(row));
    writeFileSync(
      `${LOG_DIR}/FAST_CHALLENGE_15M_${STAMP}.json`,
      JSON.stringify(rows, null, 2),
    );
    expect(rows[0].windows).toBeGreaterThan(0);
  });
});
