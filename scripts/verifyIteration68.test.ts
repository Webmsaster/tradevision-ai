/**
 * Iter 68: Minimal avoid-hours — test [0] only vs [0, 20].
 *
 * iter67 bootstrap with [0, 20]: medWR 92.3%, minWR 85.7%, pctProf 93%
 * (chr80 window went to -0.9% — hour 20 filter appears to cost this window).
 *
 * Hypothesis: hour 0 (funding toxicity, 50% WR clear) is the stronger
 * signal. Hour 20 is borderline (8 trades, 75% WR, -0.12% cumPnL — within
 * statistical noise). Drop hour 20, keep hour 0.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  HF_DAYTRADING_ASSETS,
  HF_DAYTRADING_CONFIG,
  runHfDaytrading,
  type HfConfig,
} from "../src/utils/hfDaytrading";
import type { Candle } from "../src/utils/indicators";

function chronoSlices(c: Candle[]) {
  const cuts = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
  return cuts.map((r) => c.slice(Math.floor(c.length * r)));
}
function blockBootstrap(c: Candle[], b: number, n: number, seed: number) {
  const blocks: Candle[][] = [];
  for (let i = 0; i + b <= c.length; i += b) blocks.push(c.slice(i, i + b));
  let s = seed;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const picked: Candle[] = [];
  const used = new Set<number>();
  const want = Math.min(n, blocks.length);
  while (picked.length < want * b) {
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

describe("iteration 68 — avoid-hour [0] only", () => {
  it(
    "test [0] vs [0,20] on 14-window bootstrap",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 68: minimal avoid-hour ===");
      const data: Record<string, Candle[]> = {};
      const avail: string[] = [];
      for (const s of HF_DAYTRADING_ASSETS) {
        try {
          data[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: "15m",
            targetCount: 10000,
          });
          if (data[s].length >= 2000) avail.push(s);
        } catch {
          // skip
        }
      }

      const cfgA: HfConfig = { ...HF_DAYTRADING_CONFIG, avoidHoursUtc: [] };
      const cfgB: HfConfig = { ...HF_DAYTRADING_CONFIG, avoidHoursUtc: [0] };
      const cfgC: HfConfig = {
        ...HF_DAYTRADING_CONFIG,
        avoidHoursUtc: [0, 20],
      };

      interface Rec {
        label: string;
        trades: number;
        wr: number;
        ret: number;
      }
      function allRuns(cfg: HfConfig): Rec[] {
        const recs: Rec[] = [];
        const anchor = data[avail[0]];
        chronoSlices(anchor).forEach((_, wi) => {
          const r = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8][wi];
          let nn = 0,
            ww = 0,
            ssl = 0;
          for (const s of avail) {
            const cut = Math.floor(data[s].length * r);
            const res = runHfDaytrading(data[s].slice(cut), cfg);
            nn += res.trades.length;
            ww += res.trades.filter((t) => t.totalPnl > 0).length;
            for (const t of res.trades) ssl += Math.log(1 + t.totalPnl);
          }
          recs.push({
            label: `chr${(r * 100).toFixed(0)}`,
            trades: nn,
            wr: nn > 0 ? ww / nn : 0,
            ret: Math.exp(ssl) - 1,
          });
        });
        for (let i = 0; i < 5; i++) {
          let nn = 0,
            ww = 0,
            ssl = 0;
          for (const s of avail) {
            const boot = blockBootstrap(data[s], 96 * 14, 6, 1234 + i * 17);
            const res = runHfDaytrading(boot, cfg);
            nn += res.trades.length;
            ww += res.trades.filter((t) => t.totalPnl > 0).length;
            for (const t of res.trades) ssl += Math.log(1 + t.totalPnl);
          }
          recs.push({
            label: `boot${i}`,
            trades: nn,
            wr: nn > 0 ? ww / nn : 0,
            ret: Math.exp(ssl) - 1,
          });
        }
        return recs;
      }

      function summary(recs: Rec[]) {
        const wrs = recs.map((r) => r.wr).sort((a, b) => a - b);
        const medWR = wrs[Math.floor(wrs.length / 2)];
        const minWR = wrs[0];
        const rets = recs.map((r) => r.ret);
        const pctProf = rets.filter((x) => x > 0).length / rets.length;
        const minRet = Math.min(...rets);
        const avgTr = recs.reduce((s, r) => s + r.trades, 0) / recs.length;
        return { medWR, minWR, pctProf, minRet, avgTr };
      }

      console.log("\nCompare 3 configs:");
      for (const [label, cfg] of [
        ["none       ", cfgA],
        ["[0]        ", cfgB],
        ["[0, 20]    ", cfgC],
      ] as Array<[string, HfConfig]>) {
        const recs = allRuns(cfg);
        const s = summary(recs);
        console.log(
          `  avoid=${label}  medWR=${(s.medWR * 100).toFixed(1)}%  minWR=${(s.minWR * 100).toFixed(1)}%  pctProf=${(s.pctProf * 100).toFixed(0)}%  minRet=${(s.minRet * 100).toFixed(1)}%  avgTr=${s.avgTr.toFixed(0)}`,
        );
      }

      // Detailed per-window for [0] only
      console.log("\n[0]-only per-window detail:");
      const recsB = allRuns(cfgB);
      for (const r of recsB) {
        console.log(
          `  ${r.label.padEnd(8)} trades=${r.trades.toString().padStart(4)}  WR=${(r.wr * 100).toFixed(1).padStart(5)}%  ret=${(r.ret * 100).toFixed(1).padStart(6)}%`,
        );
      }
    },
  );
});
