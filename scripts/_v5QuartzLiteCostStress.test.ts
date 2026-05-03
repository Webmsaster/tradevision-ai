/**
 * V5_QUARTZ_LITE Cost-Stress Audit (2026-04-29).
 *
 * V5_QUARTZ_LITE inherits per-asset costs from V5 base:
 *   costBp     = 30 bp  (per-side incl. spread + commission)
 *   slippageBp = 8  bp  (extra execution slippage)
 *   swapBpPerDay = 4 bp (overnight financing)
 *
 * Round 19 baseline (5.71y / 30m / 368 windows / FTMO-real liveCaps):
 *   80.72% pass / 1d med / TL 18.52% — claim was generated on Binance-historical
 *   spreads. FTMO MT5 live spreads on crypto are wider (5-15bp typical) AND
 *   slippage can spike to 30-50bp during volatility. This test stresses both
 *   axes independently to bracket the realistic live pass-rate.
 *
 * Stress matrix:
 *   - baseline (1× cost, 1× slip)
 *   - 1.5× cost (realistic FTMO uplift)
 *   - 2× cost (cautious estimate)
 *   - 3× cost (worst-case)
 *   - 5× cost (extreme stress)
 *   - 5× slippage independently (cost untouched)
 *   - 2× spread → encoded as wider per-asset stopPct (+25bp absolute) and
 *     slightly reduced tpPct (-25bp) to simulate worse fill levels at entry/exit
 *
 * Output per case: pass-rate, median, TL-rate.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48; // 30m bars

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
    dl = 0;
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
  }
  days.sort((a, b) => a - b);
  return {
    windows,
    passes,
    passRate: windows ? passes / windows : 0,
    tl,
    tlRate: windows ? tl / windows : 0,
    dl,
    dlRate: windows ? dl / windows : 0,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
  };
}

const scaleCost = (
  cfg: FtmoDaytrade24hConfig,
  costMult: number,
  slipMult: number,
): FtmoDaytrade24hConfig => ({
  ...cfg,
  assets: cfg.assets.map((a) => ({
    ...a,
    costBp: (a.costBp ?? 30) * costMult,
    slippageBp: (a.slippageBp ?? 8) * slipMult,
  })),
});

// 2× spread modelled as wider effective stop / narrower TP by 25bp each side.
const doubledSpread = (cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig => ({
  ...cfg,
  assets: cfg.assets.map((a) => ({
    ...a,
    stopPct: (a.stopPct ?? 0.05) + 0.0025,
    tpPct: Math.max(0.01, (a.tpPct ?? 0.04) - 0.0025),
    costBp: (a.costBp ?? 30) * 2,
    slippageBp: (a.slippageBp ?? 8) * 2,
  })),
});

describe(
  "V5_QUARTZ_LITE COST STRESS (FTMO real-cost bracketing)",
  { timeout: 60 * 60_000 },
  () => {
    it("baseline + 1.5×/2×/3×/5× cost + 5× slip + 2× spread", async () => {
      const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;
      const symbols = syms(base);
      console.log(
        `\nBaseline assets (9): ${base.assets.map((a) => a.symbol).join(", ")}`,
      );
      console.log(`Per-asset cost: costBp=30  slippageBp=8  swapBpPerDay=4`);
      console.log(
        `Loading ${symbols.length} symbols (30m, max 100k bars / 120 pages)...`,
      );

      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "30m",
            targetCount: 100000,
            maxPages: 120,
          });
          data[s] = r.filter((c) => c.isFinal);
        } catch (e) {
          console.warn(`Failed to load ${s}: ${(e as Error).message}`);
        }
      }
      console.log(
        `Loaded: ${Object.keys(data).length}/${symbols.length} symbols`,
      );

      const cases: { name: string; cfg: FtmoDaytrade24hConfig }[] = [
        { name: "baseline (1× cost)", cfg: base },
        { name: "1.5× cost", cfg: scaleCost(base, 1.5, 1.5) },
        { name: "2× cost", cfg: scaleCost(base, 2, 2) },
        { name: "3× cost", cfg: scaleCost(base, 3, 3) },
        { name: "5× cost (extreme)", cfg: scaleCost(base, 5, 5) },
        { name: "5× slip only", cfg: scaleCost(base, 1, 5) },
        { name: "2× spread (wider SL/TP)", cfg: doubledSpread(base) },
      ];

      console.log(
        `\n=== V5_QUARTZ_LITE COST-STRESS RESULTS ===\n` +
          `${"variant".padEnd(26)} pass-rate   med   p90   TL%     DL%`,
      );
      for (const c of cases) {
        const r = evaluate(c.cfg, data);
        const star = r.passRate >= 0.55 ? " ✓55%+" : "";
        console.log(
          `${c.name.padEnd(26)} ${(r.passRate * 100).toFixed(2).padStart(6)}% (${String(r.passes).padStart(3)}/${String(
            r.windows,
          ).padStart(
            3,
          )}) ${String(r.med).padStart(2)}d  ${String(r.p90).padStart(2)}d  ${(
            r.tlRate * 100
          )
            .toFixed(2)
            .padStart(5)}% ${(r.dlRate * 100).toFixed(2).padStart(5)}%${star}`,
        );
      }

      expect(true).toBe(true);
    });
  },
);
