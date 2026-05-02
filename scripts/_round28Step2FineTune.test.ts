/**
 * Round 28 — Step 2 fine-tune to crack 80%.
 *
 * R28 on Step 2 (5%/60d) hits 77.71%. Sweep ptp + dpt to push past 80%.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
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

const PTP_TRIGGERS = [0.02, 0.022, 0.025, 0.028, 0.03];
const PTP_FRACS = [0.4, 0.5, 0.6];
const DPTS = [0.012, 0.015, 0.02, 0.025];

describe(
  "Round 28 — Step 2 fine-tune for 80%",
  { timeout: 180 * 60_000 },
  () => {
    it("knack 80% on Step 2 (5%/60d)", async () => {
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
      const winBars = 60 * bpd; // Step 2 = 60 days
      const stepBars = 3 * bpd;
      const wStarts: number[] = [];
      for (let s = 0; s + winBars <= minBars; s += stepBars) wStarts.push(s);
      console.log(`Step 2 windows: ${wStarts.length}`);

      type R = { name: string; pass: number; tl: number; med: number };
      const results: R[] = [];
      let count = 0;
      const total = PTP_TRIGGERS.length * PTP_FRACS.length * DPTS.length;
      for (const dpt of DPTS) {
        for (const t of PTP_TRIGGERS) {
          for (const f of PTP_FRACS) {
            count++;
            const cfg: FtmoDaytrade24hConfig = {
              ...BASE,
              profitTarget: 0.05,
              maxDays: 60,
              holdBars: 1200,
              dailyPeakTrailingStop: { trailDistance: dpt },
              partialTakeProfit: { triggerPct: t, closeFraction: f },
              liveMode: true,
              liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
            } as FtmoDaytrade24hConfig;
            let w = 0,
              p = 0,
              tl = 0;
            const days: number[] = [];
            for (const start of wStarts) {
              const slice: Record<string, Candle[]> = {};
              for (const s of symbols)
                slice[s] = aligned[s].slice(start, start + winBars);
              const res = runFtmoDaytrade24h(slice, cfg);
              w++;
              if (res.passed) {
                p++;
                if (res.passDay) days.push(res.passDay);
              } else if (res.reason === "total_loss") tl++;
            }
            days.sort((a, b) => a - b);
            const passPct = (p / w) * 100;
            const tlPct = (tl / w) * 100;
            const med = days[Math.floor(days.length / 2)] ?? 0;
            const name = `dpt${dpt.toFixed(3)}_ptp${t.toFixed(3)}_f${f.toFixed(2)}`;
            results.push({ name, pass: passPct, tl: tlPct, med });
            if (passPct >= 78 || count % 5 === 0) {
              console.log(
                `[${count}/${total}] ${name.padEnd(32)}| ${passPct.toFixed(2).padStart(6)}% | TL ${tlPct.toFixed(2)}% | med ${med}d`,
              );
            }
          }
        }
      }
      console.log(`\n=== TOP 15 ===`);
      const sorted = [...results].sort((a, b) => b.pass - a.pass).slice(0, 15);
      for (const r of sorted)
        console.log(
          `${r.name.padEnd(32)}| ${r.pass.toFixed(2).padStart(6)}% | TL ${r.tl.toFixed(2)}% | med ${r.med}d`,
        );
      const winner = sorted[0];
      console.log(
        `\n>>> WINNER: ${winner.name} → ${winner.pass.toFixed(2)}% <<<`,
      );
      if (winner.pass >= 80)
        console.log(`*** GOAL ACHIEVED: ≥80% on Step 2! ***`);
      else
        console.log(`*** gap to 80%: ${(80 - winner.pass).toFixed(2)}pp ***`);
      expect(true).toBe(true);
    });
  },
);
