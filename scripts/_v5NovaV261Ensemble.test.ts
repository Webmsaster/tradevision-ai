/**
 * Multi-Strategy Ensemble: V5_NOVA (long-trend) + V261_2H_OPT (mean-rev short).
 * Both forced to FTMO-compliant: liveCaps + profitTarget=0.08.
 * Run on shared equity to assess combined production pass-rate.
 */
import { describe, it, expect } from "vitest";
import {
  detectAsset,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  type FtmoDaytrade24hConfig,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY_2H = 12;
const PRAGUE_OFFSET_MS = 1 * 3600 * 1000;
const LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };

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

/**
 * Process trades sequentially on shared equity. Returns ensemble result.
 */
function ensembleWindow(
  trades: Daytrade24hTrade[],
  cfg: {
    profitTarget: number;
    maxDailyLoss: number;
    maxTotalLoss: number;
    minTradingDays: number;
    maxDays: number;
    pauseAtTargetReached: boolean;
  },
  ts0: number,
): { passed: boolean; reason: string; passDay?: number; finalEq: number } {
  trades.sort((a, b) => a.exitTime - b.exitTime);
  let equity = 1.0;
  let firstTargetHitDay: number | null = null;
  const dayStart = new Map<number, number>();
  const tradingDays = new Set<number>();
  for (const t of trades) {
    if (t.entryDay >= cfg.maxDays) continue;
    if (!dayStart.has(t.day)) dayStart.set(t.day, equity);
    if (cfg.pauseAtTargetReached && equity >= 1 + cfg.profitTarget) {
      if (firstTargetHitDay === null) firstTargetHitDay = t.day;
      // ping
      let pingDay = (firstTargetHitDay ?? t.day) + 1;
      while (tradingDays.size < cfg.minTradingDays && pingDay < cfg.maxDays) {
        tradingDays.add(pingDay);
        pingDay++;
      }
      if (tradingDays.size >= cfg.minTradingDays) {
        return {
          passed: true,
          reason: "profit_target_paused",
          passDay: pingDay,
          finalEq: equity,
        };
      }
      continue;
    }
    if (Number.isFinite(t.effPnl)) {
      equity *= 1 + t.effPnl;
      tradingDays.add(t.entryDay);
    }
    if (equity <= 1 - cfg.maxTotalLoss) {
      return { passed: false, reason: "total_loss", finalEq: equity };
    }
    const sod = dayStart.get(t.day)!;
    if (equity / sod - 1 <= -cfg.maxDailyLoss) {
      return { passed: false, reason: "daily_loss", finalEq: equity };
    }
    if (firstTargetHitDay === null && equity >= 1 + cfg.profitTarget) {
      firstTargetHitDay = t.day;
    }
    if (
      equity >= 1 + cfg.profitTarget &&
      tradingDays.size >= cfg.minTradingDays
    ) {
      return {
        passed: true,
        reason: "profit_target",
        passDay: (firstTargetHitDay ?? t.day) + 1,
        finalEq: equity,
      };
    }
  }
  // Post-loop ping
  if (cfg.pauseAtTargetReached && equity >= 1 + cfg.profitTarget) {
    let pingDay = (firstTargetHitDay ?? 0) + 1;
    while (tradingDays.size < cfg.minTradingDays && pingDay < cfg.maxDays) {
      tradingDays.add(pingDay);
      pingDay++;
    }
    if (tradingDays.size >= cfg.minTradingDays) {
      return {
        passed: true,
        reason: "profit_target_paused_post",
        passDay: pingDay,
        finalEq: equity,
      };
    }
  }
  return {
    passed: false,
    reason:
      tradingDays.size < cfg.minTradingDays ? "insufficient_days" : "time",
    finalEq: equity,
  };
}

describe("V5_NOVA + V261 Ensemble", { timeout: 60 * 60_000 }, () => {
  it("Shared equity ensemble", async () => {
    // Force both to FTMO-compliant
    const novaCfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
      profitTarget: 0.08,
      liveCaps: LIVE_CAPS,
    };
    const v261Cfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
      profitTarget: 0.08,
      liveCaps: LIVE_CAPS,
    };

    const allSyms = [...new Set([...syms(novaCfg), ...syms(v261Cfg)])].sort();
    console.log(`\nLoading ${allSyms.length} symbols (2h)...`);
    const data: Record<string, Candle[]> = {};
    for (const s of allSyms) {
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

    // Use NOVA's full asset universe (8 assets) for shared candles
    const novaSymbols = syms(novaCfg);
    const v261Symbols = syms(v261Cfg);
    const combinedSymbols = [
      ...new Set([...novaSymbols, ...v261Symbols]),
    ].sort();
    const aligned = alignCommon(data, combinedSymbols);
    const n = Math.min(...combinedSymbols.map((s) => aligned[s].length));
    const winBars = 30 * BARS_PER_DAY_2H;
    const stepBars = 3 * BARS_PER_DAY_2H;

    const cases = [
      {
        name: "NOVA only",
        run: (slice: Record<string, Candle[]>) => detectAllNova(novaCfg, slice),
      },
      {
        name: "V261 only",
        run: (slice: Record<string, Candle[]>) => detectAllV261(v261Cfg, slice),
      },
      {
        name: "ENSEMBLE NOVA+V261",
        run: (slice: Record<string, Candle[]>) => [
          ...detectAllNova(novaCfg, slice),
          ...detectAllV261(v261Cfg, slice),
        ],
      },
    ];

    function detectAllNova(
      cfg: FtmoDaytrade24hConfig,
      slice: Record<string, Candle[]>,
    ): Daytrade24hTrade[] {
      const all: Daytrade24hTrade[] = [];
      for (const a of cfg.assets) {
        const src = a.sourceSymbol ?? a.symbol;
        if (!slice[src]) continue;
        const trades = detectAsset(slice[src], a, cfg);
        all.push(...trades);
      }
      return all;
    }
    function detectAllV261(
      cfg: FtmoDaytrade24hConfig,
      slice: Record<string, Candle[]>,
    ): Daytrade24hTrade[] {
      const all: Daytrade24hTrade[] = [];
      for (const a of cfg.assets) {
        const src = a.sourceSymbol ?? a.symbol;
        if (!slice[src]) continue;
        const trades = detectAsset(slice[src], a, cfg);
        all.push(...trades);
      }
      return all;
    }

    console.log(`\n${"variant".padEnd(28)} 3d-pass    med   p90   TL%   DL%`);
    for (const c of cases) {
      let windows = 0,
        passes = 0,
        tl = 0,
        dl = 0;
      const days: number[] = [];
      for (let start = 0; start + winBars <= n; start += stepBars) {
        const slice: Record<string, Candle[]> = {};
        for (const s of combinedSymbols)
          slice[s] = aligned[s].slice(start, start + winBars);
        const trades = c.run(slice);
        const ts0 = slice[combinedSymbols[0]][0].openTime;
        const res = ensembleWindow(
          trades,
          {
            profitTarget: 0.08,
            maxDailyLoss: 0.05,
            maxTotalLoss: 0.1,
            minTradingDays: 4,
            maxDays: 30,
            pauseAtTargetReached: true,
          },
          ts0,
        );
        windows++;
        if (res.passed) {
          passes++;
          if (res.passDay) days.push(res.passDay);
        } else if (res.reason === "total_loss") tl++;
        else if (res.reason === "daily_loss") dl++;
      }
      days.sort((a, b) => a - b);
      const med = days[Math.floor(days.length * 0.5)] ?? 0;
      const p90 = days[Math.floor(days.length * 0.9)] ?? 0;
      const passRate = windows ? passes / windows : 0;
      const tlPct = windows ? ((tl / windows) * 100).toFixed(2) : "—";
      const dlPct = windows ? ((dl / windows) * 100).toFixed(2) : "—";
      const star = passRate >= 0.55 ? " ✓55%+" : "";
      console.log(
        `${c.name.padEnd(28)} ${(passRate * 100).toFixed(2).padStart(7)}% ${String(med).padStart(2)}d  ${String(p90).padStart(2)}d  ${tlPct.padStart(5)}% ${dlPct.padStart(5)}%${star}`,
      );
    }
    expect(true).toBe(true);
  });
});
