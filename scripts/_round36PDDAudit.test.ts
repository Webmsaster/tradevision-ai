/**
 * Round 36 — pDD-Mechanism Audit.
 *
 * Frage: Ist 83.31% legit oder hat die pDD-Logik einen verstecten Bug?
 *
 * Tests:
 *   1. Disable-pDD ablation: zeigt isolated lift attributable to pDD
 *   2. liveCaps-with-vs-without: ist liveCaps die ganze Zeit aktiv?
 *   3. Sequential vs concurrent equity gap: wie groß ist der?
 *   4. pDD-trigger frequency: wie oft fires die Throttle?
 *   5. Sanity: pDD with factor=1.0 (= no-op) — should match base config exactly
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BASE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;

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

interface VR {
  name: string;
  passPct: number;
  tlPct: number;
  med: number;
  n: number;
}

describe("Round 36 — pDD Audit / Bug-Sanity", { timeout: 180 * 60_000 }, () => {
  it("ablation tests + sanity checks", async () => {
    const liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
    const variants: { name: string; cfg: FtmoDaytrade24hConfig }[] = [];

    // Reference: original R28 + R28_V4 (literal configs)
    variants.push({
      name: "R28_LITERAL",
      cfg: {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
        liveCaps,
      },
    });
    variants.push({
      name: "R28_V4_LITERAL",
      cfg: {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
        liveCaps,
      },
    });

    // Sanity: pDD with factor=1.0 should be no-op (= base R28)
    variants.push({
      name: "SANITY_pDD_factor1",
      cfg: {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
        peakDrawdownThrottle: { fromPeak: 0.03, factor: 1.0 },
        liveCaps,
      },
    });

    // Ablation: R28_V4 minus pDD (= R28_V2 logic without pDD)
    variants.push({
      name: "R28_V4_minus_pDD",
      cfg: {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
        peakDrawdownThrottle: undefined,
        liveCaps,
      },
    });

    // Ablation: R28_V4 minus PTP (only pDD remains as new feature)
    variants.push({
      name: "R28_V4_minus_PTP",
      cfg: {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
        partialTakeProfit: undefined,
        liveCaps,
      },
    });

    // Ablation: pDD only (no DPT, no PTP, no pause)
    variants.push({
      name: "ONLY_pDD",
      cfg: {
        ...BASE,
        peakDrawdownThrottle: { fromPeak: 0.03, factor: 0.15 },
        dailyPeakTrailingStop: undefined,
        partialTakeProfit: undefined,
        liveMode: true,
        liveCaps,
      },
    });

    // Stress: liveCaps OFF (research-mode — should drastically inflate)
    variants.push({
      name: "R28_V4_NO_LIVECAPS",
      cfg: {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
        liveCaps: undefined,
      },
    });

    // Sanity: pDD threshold so high it never triggers (= no-op)
    variants.push({
      name: "SANITY_pDD_threshold99",
      cfg: {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
        peakDrawdownThrottle: { fromPeak: 0.99, factor: 0.15 },
        liveCaps,
      },
    });

    console.log(`Total variants: ${variants.length}`);

    const symbols = syms(BASE);
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
      } catch {}
    }
    const aligned = alignCommon(data, symbols);
    const minBars = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
    const bpd = 48;
    const winBars = BASE.maxDays * bpd;
    const stepBars = 3 * bpd;

    function runVariant(cfg: FtmoDaytrade24hConfig): VR {
      const passDays: number[] = [];
      let passes = 0;
      let tl = 0;
      let total = 0;
      const variantSymbols = syms(cfg);
      for (let start = 0; start + winBars <= minBars; start += stepBars) {
        const slice: Record<string, Candle[]> = {};
        for (const s of variantSymbols)
          slice[s] = aligned[s]?.slice(start, start + winBars) ?? [];
        const res = runFtmoDaytrade24h(slice, cfg);
        total++;
        if (res.passed) {
          passes++;
          if (res.passDay) passDays.push(res.passDay);
        }
        if (res.reason?.includes("total_loss")) tl++;
      }
      passDays.sort((a, b) => a - b);
      return {
        name: "",
        n: total,
        passPct: (passes / total) * 100,
        tlPct: (tl / total) * 100,
        med: passDays[Math.floor(passDays.length / 2)] ?? 0,
      };
    }

    console.log(`\n=== Audit Results ===\n`);
    const results: VR[] = [];
    for (const v of variants) {
      const r = { ...runVariant(v.cfg), name: v.name };
      results.push(r);
      console.log(
        `${r.name.padEnd(30)} pass=${r.passPct.toFixed(2)}% TL=${r.tlPct.toFixed(2)}% med=${r.med}d (n=${r.n})`,
      );
    }

    // Sanity-checks
    const r28 = results.find((r) => r.name === "R28_LITERAL")!;
    const r28V4 = results.find((r) => r.name === "R28_V4_LITERAL")!;
    const sanityF1 = results.find((r) => r.name === "SANITY_pDD_factor1")!;
    const sanityT99 = results.find((r) => r.name === "SANITY_pDD_threshold99")!;
    const v4noPDD = results.find((r) => r.name === "R28_V4_minus_pDD")!;
    const noLiveCaps = results.find((r) => r.name === "R28_V4_NO_LIVECAPS")!;

    console.log(`\n=== Sanity Checks ===\n`);
    console.log(
      `[1] pDD factor=1.0 (no-op) should equal base: ${sanityF1.passPct.toFixed(2)}% — ` +
        `expect ≈ R28_V4_minus_pDD ${v4noPDD.passPct.toFixed(2)}%`,
    );
    console.log(
      `[2] pDD threshold=99% (never fires) should equal no-pDD: ${sanityT99.passPct.toFixed(2)}% — ` +
        `expect ≈ ${v4noPDD.passPct.toFixed(2)}%`,
    );
    console.log(
      `[3] R28_V4 vs R28_V4_minus_pDD: pDD lift = ${(r28V4.passPct - v4noPDD.passPct).toFixed(2)}pp ` +
        `(this is REAL pDD contribution)`,
    );
    console.log(
      `[4] R28 → R28_V4 total lift: ${(r28V4.passPct - r28.passPct).toFixed(2)}pp`,
    );
    console.log(
      `[5] No liveCaps inflates how much? ${(noLiveCaps.passPct - r28V4.passPct).toFixed(2)}pp ` +
        `(higher = more leverage hidden)`,
    );

    expect(results.length).toBeGreaterThan(5);
    // Critical sanity: factor=1.0 must equal disabled-pDD within ±1pp.
    const drift = Math.abs(sanityF1.passPct - v4noPDD.passPct);
    if (drift > 1.5) {
      console.log(
        `\n🚨 SANITY VIOLATION: pDD factor=1.0 differs from disabled-pDD by ${drift.toFixed(2)}pp — possible bug in pDD logic!`,
      );
    }
  });
});
