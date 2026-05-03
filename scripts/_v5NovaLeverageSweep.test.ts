/**
 * V5_NOVA leverage + R:R sweep — push pass-rate above 55%.
 * Variations: leverage 2/3, asymmetric R:R, tighter stops, smaller basket.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12;

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
function evaluate(cfg: FtmoDaytrade24hConfig, data: Record<string, Candle[]>) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = cfg.maxDays * BARS_PER_DAY;
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
    windows,
    passes,
    passRate: windows ? passes / windows : 0,
    tl,
    dl,
    avgTradesPerWindow: windows ? totalT / windows : 0,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    wr: totalT > 0 ? totalW / totalT : 0,
  };
}

describe("V5_NOVA push-to-55 sweep", { timeout: 60 * 60_000 }, () => {
  it("leverage + R:R variations", async () => {
    const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA);
    console.log(`\nLoading ${symbols.length} symbols (2h)...`);
    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      try {
        const r = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        data[s] = r.filter((c) => c.isFinal);
      } catch {}
    }

    const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA;

    // Tweaks
    const cases: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [
      { name: "NOVA baseline (lev=2)", cfg: base },
      { name: "NOVA lev=3 (Aggressive)", cfg: { ...base, leverage: 3 } },
      {
        name: "NOVA lev=3 + maxRiskFrac=0.3",
        cfg: {
          ...base,
          leverage: 3,
          liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.3 },
        },
      },
      {
        name: "NOVA tpPct 7%→10% (TP wider)",
        cfg: {
          ...base,
          tpPct: 0.1,
          assets: base.assets.map((a) => ({ ...a, tpPct: 0.1 })),
        },
      },
      {
        name: "NOVA stopPct 5%→3.5% (tighter)",
        cfg: {
          ...base,
          stopPct: 0.035,
          assets: base.assets.map((a) => ({ ...a, stopPct: 0.035 })),
        },
      },
      {
        name: "NOVA tp=10% + stop=3.5%",
        cfg: {
          ...base,
          tpPct: 0.1,
          stopPct: 0.035,
          assets: base.assets.map((a) => ({
            ...a,
            tpPct: 0.1,
            stopPct: 0.035,
          })),
        },
      },
      {
        name: "NOVA lev=3 + tp=10%",
        cfg: {
          ...base,
          leverage: 3,
          tpPct: 0.1,
          assets: base.assets.map((a) => ({ ...a, tpPct: 0.1 })),
        },
      },
      {
        name: "NOVA top-4 assets only",
        cfg: {
          ...base,
          assets: base.assets.filter((a) =>
            ["ETH-TREND", "BTC-TREND", "BNB-TREND", "BCH-TREND"].includes(
              a.symbol,
            ),
          ),
        },
      },
      {
        name: "NOVA holdBars 240→480",
        cfg: {
          ...base,
          holdBars: 480,
          assets: base.assets.map((a) => ({ ...a, holdBars: 480 })),
        },
      },
      {
        name: "NOVA + V5 hours [0,2,6,8,10,12,14,18,20,22]",
        cfg: { ...base, allowedHoursUtc: [0, 2, 6, 8, 10, 12, 14, 18, 20, 22] },
      },
    ];

    console.log(
      `\n${"variant".padEnd(38)} 3d-pass    wr      med   p90  TL%   DL%`,
    );
    for (const c of cases) {
      const r = evaluate(c.cfg, data);
      const tlPct = r.windows ? ((r.tl / r.windows) * 100).toFixed(2) : "—";
      const dlPct = r.windows ? ((r.dl / r.windows) * 100).toFixed(2) : "—";
      const star = r.passRate >= 0.55 ? " ✓55%+" : "";
      console.log(
        `${c.name.padEnd(38)} ${(r.passRate * 100).toFixed(2).padStart(7)}% ${(r.wr * 100).toFixed(1).padStart(5)}%  ${String(r.med).padStart(2)}d  ${String(r.p90).padStart(2)}d  ${tlPct.padStart(5)}% ${dlPct.padStart(5)}%${star}`,
      );
    }
    expect(true).toBe(true);
  });
});
