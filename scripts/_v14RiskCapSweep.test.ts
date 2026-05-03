/**
 * V14 family — push V5_NOVA / V5_QUARTZ / V5_ZIRKON beyond 46% via risk-cap
 * sweep. Hypothesis: V5's effRiskFrac=0.4 (cap) is too aggressive — one
 * losing trade = -4% equity, two = DL breach. Lower riskCap → fewer DL
 * fails → higher pass-rate, at cost of slower compounding.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY: Record<string, number> = { "30m": 48, "2h": 12 };

function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol) out.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) out.add(f.symbol);
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
  stepDays: number,
) {
  const tf = cfg.timeframe;
  const bpd = BARS_PER_DAY[tf] ?? 12;
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = cfg.maxDays * bpd;
  const stepBars = stepDays * bpd;
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
      if (res.passDay && res.passDay > 0) days.push(res.passDay);
    } else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
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
    dl,
    passRate: windows ? passes / windows : 0,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    wr: totalT > 0 ? totalW / totalT : 0,
  };
}

function withRiskCap(
  cfg: FtmoDaytrade24hConfig,
  cap: number,
): FtmoDaytrade24hConfig {
  return {
    ...cfg,
    liveCaps: cfg.liveCaps
      ? { ...cfg.liveCaps, maxRiskFrac: cap }
      : { maxStopPct: 0.05, maxRiskFrac: cap },
  };
}

const BASE_VARIANTS = [
  ["V5_ZIRKON", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON],
  ["V5_QUARTZ", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ],
  ["V5_NOVA", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA],
] as Array<[string, FtmoDaytrade24hConfig]>;

const RISK_CAPS = [0.4, 0.3, 0.25, 0.2, 0.15, 0.1];

describe("V14 risk-cap sweep — push past 55%", { timeout: 60 * 60_000 }, () => {
  it("sweep maxRiskFrac on top V5 variants", async () => {
    const allSyms = [
      ...new Set(BASE_VARIANTS.flatMap(([, cfg]) => syms(cfg))),
    ].sort();
    console.log(`\nLoading ${allSyms.length} symbols (30m + 2h)...`);
    const data30m: Record<string, Candle[]> = {};
    const data2h: Record<string, Candle[]> = {};
    for (const s of allSyms) {
      try {
        const r = await loadBinanceHistory({
          symbol: s,
          timeframe: "30m",
          targetCount: 100000,
          maxPages: 120,
        });
        data30m[s] = r.filter((c) => c.isFinal);
      } catch {}
      try {
        const r = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        data2h[s] = r.filter((c) => c.isFinal);
      } catch {}
    }

    console.log(
      `\n${"variant".padEnd(15)} ${"cap".padStart(5)} ${"3d-pass".padStart(8)}  ${"med".padStart(4)}  ${"p90".padStart(4)}  ${"TL%".padStart(5)}  ${"DL%".padStart(5)}`,
    );
    for (const [name, base] of BASE_VARIANTS) {
      const data = base.timeframe === "30m" ? data30m : data2h;
      for (const cap of RISK_CAPS) {
        const cfg = withRiskCap(base, cap);
        const r = evaluate(cfg, data, 3);
        const tlPct = r.windows ? ((r.tl / r.windows) * 100).toFixed(2) : "—";
        const dlPct = r.windows ? ((r.dl / r.windows) * 100).toFixed(2) : "—";
        const star = r.passRate >= 0.55 && r.med > 0 && r.med <= 5 ? " ✓" : "";
        console.log(
          `${name.padEnd(15)} ${cap.toFixed(2).padStart(5)} ${(r.passRate * 100).toFixed(2).padStart(7)}% ${String(r.med).padStart(3)}d ${String(r.p90).padStart(3)}d ${tlPct.padStart(5)}% ${dlPct.padStart(5)}%${star}`,
        );
      }
      console.log("");
    }
    expect(true).toBe(true);
  });
});
