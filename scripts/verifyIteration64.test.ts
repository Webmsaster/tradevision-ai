/**
 * Iter 64: Expand HF Daytrading basket from 10 → 20 alts.
 *
 * Rationale: more assets → more trade frequency without touching any edge
 * parameter. But: edge could DEGRADE on new assets (some alts are too
 * thin / too manipulated / too un-retail). We need to bootstrap-lock.
 *
 * Candidate expansion (10 new): DOGE, ADA, DOT, ATOM, LTC, UNI, AAVE, FIL,
 * XRP, BCH. Standard majors + established DeFi alts available on Binance
 * Futures.
 *
 * Test:
 *  1. Fetch 15m × 10000 bars for all 20
 *  2. Full-history: run HF_DAYTRADING_CONFIG on each, aggregate portfolio WR
 *  3. 10-chrono + 5-bootstrap windows → same metrics per window
 *  4. Compare: 10-asset baseline vs 20-asset expanded
 *  5. If expanded basket also passes (medWR ≥ 85, minWR ≥ 70, 100% profitable
 *     windows, 2+ trades/day), lock it.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  HF_DAYTRADING_CONFIG,
  HF_DAYTRADING_ASSETS,
  runHfDaytrading,
} from "../src/utils/hfDaytrading";
import type { Candle } from "../src/utils/indicators";

const NEW_CANDIDATES = [
  "DOGEUSDT",
  "ADAUSDT",
  "DOTUSDT",
  "ATOMUSDT",
  "LTCUSDT",
  "UNIUSDT",
  "AAVEUSDT",
  "FILUSDT",
  "XRPUSDT",
  "BCHUSDT",
];

function chronoSlices(c: Candle[]) {
  const cuts = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
  return cuts.map((r) => c.slice(Math.floor(c.length * r)));
}

function blockBootstrap(
  c: Candle[],
  blockBars: number,
  n: number,
  seed: number,
): Candle[] {
  const blocks: Candle[][] = [];
  for (let i = 0; i + blockBars <= c.length; i += blockBars) {
    blocks.push(c.slice(i, i + blockBars));
  }
  let s = seed;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const picked: Candle[] = [];
  const want = Math.min(n, blocks.length);
  const used = new Set<number>();
  while (picked.length < want * blockBars) {
    const idx = Math.floor(rand() * blocks.length);
    if (used.has(idx)) continue;
    used.add(idx);
    picked.push(...blocks[idx]);
  }
  let t = c[0]?.openTime ?? 0;
  return picked.map((x) => {
    const out = { ...x, openTime: t, closeTime: t + 15 * 60 * 1000 - 1 };
    t += 15 * 60 * 1000;
    return out;
  });
}

interface WindowRec {
  label: string;
  trades: number;
  wr: number;
  ret: number;
}

function aggregate(basket: string[], data: Record<string, Candle[]>) {
  // Full history aggregate
  let total = 0;
  let wins = 0;
  let sumLog = 0;
  let barMax = 0;
  for (const s of basket) {
    const c = data[s];
    if (!c) continue;
    barMax = Math.max(barMax, c.length);
    const r = runHfDaytrading(c);
    total += r.trades.length;
    wins += r.trades.filter((t) => t.totalPnl > 0).length;
    for (const t of r.trades) sumLog += Math.log(1 + t.totalPnl);
  }
  const wr = total > 0 ? wins / total : 0;
  const ret = Math.exp(sumLog) - 1;
  const days = barMax / 96;
  return { trades: total, wr, ret, days, tradesPerDay: total / days };
}

function perWindow(basket: string[], data: Record<string, Candle[]>) {
  const anchor = data[basket[0]];
  if (!anchor) return [] as WindowRec[];
  const recs: WindowRec[] = [];
  const chronos = chronoSlices(anchor);
  chronos.forEach((_, wi) => {
    const r = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8][wi];
    let n = 0;
    let wins = 0;
    let sumLog = 0;
    for (const s of basket) {
      if (!data[s]) continue;
      const cut = Math.floor(data[s].length * r);
      const slice = data[s].slice(cut);
      const res = runHfDaytrading(slice);
      n += res.trades.length;
      wins += res.trades.filter((t) => t.totalPnl > 0).length;
      for (const t of res.trades) sumLog += Math.log(1 + t.totalPnl);
    }
    recs.push({
      label: `chr${(r * 100).toFixed(0)}`,
      trades: n,
      wr: n > 0 ? wins / n : 0,
      ret: Math.exp(sumLog) - 1,
    });
  });
  // 5 bootstrap
  for (let i = 0; i < 5; i++) {
    let n = 0;
    let wins = 0;
    let sumLog = 0;
    for (const s of basket) {
      if (!data[s]) continue;
      const boot = blockBootstrap(data[s], 96 * 14, 6, 1234 + i * 17);
      const res = runHfDaytrading(boot);
      n += res.trades.length;
      wins += res.trades.filter((t) => t.totalPnl > 0).length;
      for (const t of res.trades) sumLog += Math.log(1 + t.totalPnl);
    }
    recs.push({
      label: `boot${i}`,
      trades: n,
      wr: n > 0 ? wins / n : 0,
      ret: Math.exp(sumLog) - 1,
    });
  }
  return recs;
}

function summarise(recs: WindowRec[]) {
  const wrs = recs.map((r) => r.wr);
  const rets = recs.map((r) => r.ret);
  const ns = recs.map((r) => r.trades);
  const sortedWr = [...wrs].sort((a, b) => a - b);
  const med = sortedWr[Math.floor(sortedWr.length / 2)];
  const min = Math.min(...wrs);
  const pctProf = rets.filter((r) => r > 0).length / rets.length;
  const avgTrades = ns.reduce((s, v) => s + v, 0) / ns.length;
  return { medWR: med, minWR: min, pctProf, avgTrades };
}

describe("iteration 64 — expand HF basket to 20 alts", () => {
  it(
    "bootstrap-compare 10-asset vs 20-asset basket",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 64: HF basket expansion 10 → 20 ===");
      const all = [...HF_DAYTRADING_ASSETS, ...NEW_CANDIDATES];
      const data: Record<string, Candle[]> = {};
      const available: string[] = [];
      for (const s of all) {
        try {
          data[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: "15m",
            targetCount: 10000,
          });
          if (data[s].length >= 2000) available.push(s);
        } catch {
          console.log(`  ${s}: fetch fail`);
        }
      }
      const baseline10 = HF_DAYTRADING_ASSETS.filter((s) =>
        available.includes(s),
      );
      const expanded20 = available;
      console.log(
        `Available: baseline ${baseline10.length}, expanded ${expanded20.length}`,
      );

      const baseAgg = aggregate(baseline10 as unknown as string[], data);
      const expAgg = aggregate(expanded20, data);

      console.log("\n── Full-history aggregate ──");
      console.log(
        `baseline (${baseline10.length}): trades=${baseAgg.trades}  WR=${(baseAgg.wr * 100).toFixed(1)}%  ret=${(baseAgg.ret * 100).toFixed(1)}%  trades/day=${baseAgg.tradesPerDay.toFixed(2)}`,
      );
      console.log(
        `expanded (${expanded20.length}): trades=${expAgg.trades}  WR=${(expAgg.wr * 100).toFixed(1)}%  ret=${(expAgg.ret * 100).toFixed(1)}%  trades/day=${expAgg.tradesPerDay.toFixed(2)}`,
      );

      console.log("\n── 14-window bootstrap ──");
      const baseRecs = perWindow(baseline10 as unknown as string[], data);
      const expRecs = perWindow(expanded20, data);
      const baseSum = summarise(baseRecs);
      const expSum = summarise(expRecs);
      console.log(
        `baseline: medWR=${(baseSum.medWR * 100).toFixed(1)}%  minWR=${(baseSum.minWR * 100).toFixed(1)}%  pctProf=${(baseSum.pctProf * 100).toFixed(0)}%  avgTr/win=${baseSum.avgTrades.toFixed(1)}`,
      );
      console.log(
        `expanded: medWR=${(expSum.medWR * 100).toFixed(1)}%  minWR=${(expSum.minWR * 100).toFixed(1)}%  pctProf=${(expSum.pctProf * 100).toFixed(0)}%  avgTr/win=${expSum.avgTrades.toFixed(1)}`,
      );

      // Per-asset WR breakdown to identify problem alts
      console.log("\n── Per-asset WR (new 10) ──");
      for (const s of NEW_CANDIDATES) {
        if (!data[s]) {
          console.log(`  ${s.padEnd(12)} fetch fail`);
          continue;
        }
        const r = runHfDaytrading(data[s]);
        if (r.trades.length === 0) {
          console.log(`  ${s.padEnd(12)} no trades`);
          continue;
        }
        console.log(
          `  ${s.padEnd(12)} trades=${r.trades.length.toString().padStart(3)}  WR=${(r.winRate * 100).toFixed(1).padStart(5)}%  ret=${(r.netReturnPct * 100).toFixed(1).padStart(6)}%`,
        );
      }

      // Verdict
      const lockThresholds = {
        medWR: 0.85,
        minWR: 0.7,
        pctProf: 1.0,
      };
      const expandedPasses =
        expSum.medWR >= lockThresholds.medWR &&
        expSum.minWR >= lockThresholds.minWR &&
        expSum.pctProf >= lockThresholds.pctProf;
      console.log(
        `\nExpanded basket ${expandedPasses ? "★ PASSES" : "DROPS"} lock criteria (medWR≥85 AND minWR≥70 AND pctProf=100%)`,
      );
    },
  );
});
