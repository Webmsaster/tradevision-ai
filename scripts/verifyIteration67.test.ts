/**
 * Iter 67: Bootstrap re-lock with iter66 avoid-hours config.
 *
 * iter66 showed full-history cumRet +18.9pp from skipping hour 0 & 20 UTC.
 * But was that a single-window artifact? Re-run the iter65 14-window
 * bootstrap with the updated `HF_DAYTRADING_CONFIG` (which now has
 * avoidHoursUtc=[0,20]) and compare.
 *
 * Lock criteria (strict): medWR ≥ 90% AND minWR ≥ 80% AND pctProf = 100%.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  HF_DAYTRADING_ASSETS,
  runHfDaytrading,
} from "../src/utils/hfDaytrading";
import type { Candle } from "../src/utils/indicators";

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
  for (let i = 0; i + blockBars <= c.length; i += blockBars)
    blocks.push(c.slice(i, i + blockBars));
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
  // Note: block-bootstrap shuffles chronology so hour-of-day distribution
  // within the synthetic window will differ from real chronos. This is
  // intentional — we WANT to see how the strategy behaves across diverse
  // regime-concatenations. But the hour-filter still applies per bar.
  let t = c[0]?.openTime ?? 0;
  return picked.map((x) => {
    const out = { ...x, openTime: t, closeTime: t + 15 * 60 * 1000 - 1 };
    t += 15 * 60 * 1000;
    return out;
  });
}

describe("iteration 67 — bootstrap re-lock iter66", () => {
  it(
    "14-window bootstrap with avoid-hours config",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 67: Bootstrap re-lock ===");
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
      console.log(`Available: ${avail.length}/${HF_DAYTRADING_ASSETS.length}`);

      // Full history (with avoid-hours now baked into HF_DAYTRADING_CONFIG)
      let n = 0,
        w = 0,
        sumLog = 0,
        barMax = 0;
      for (const s of avail) {
        const r = runHfDaytrading(data[s]);
        n += r.trades.length;
        w += r.trades.filter((t) => t.totalPnl > 0).length;
        for (const t of r.trades) sumLog += Math.log(1 + t.totalPnl);
        barMax = Math.max(barMax, data[s].length);
      }
      const wr = n > 0 ? w / n : 0;
      const ret = Math.exp(sumLog) - 1;
      console.log(
        `\nFull-history: trades=${n}  WR=${(wr * 100).toFixed(1)}%  ret=${(ret * 100).toFixed(1)}%  trades/day=${(n / (barMax / 96)).toFixed(2)}`,
      );

      // 14-window bootstrap
      interface Rec {
        label: string;
        trades: number;
        wr: number;
        ret: number;
      }
      const recs: Rec[] = [];
      const anchor = data[avail[0]];
      chronoSlices(anchor).forEach((_, wi) => {
        const r = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8][wi];
        let nn = 0,
          ww = 0,
          ssl = 0;
        for (const s of avail) {
          const cut = Math.floor(data[s].length * r);
          const res = runHfDaytrading(data[s].slice(cut));
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
          const res = runHfDaytrading(boot);
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

      console.log(
        "\nwindow".padEnd(10) +
          "trades".padStart(8) +
          "WR%".padStart(7) +
          "ret%".padStart(9),
      );
      for (const r of recs) {
        console.log(
          r.label.padEnd(10) +
            r.trades.toString().padStart(8) +
            (r.wr * 100).toFixed(1).padStart(7) +
            (r.ret * 100).toFixed(1).padStart(9),
        );
      }
      const wrs = recs.map((r) => r.wr).sort((a, b) => a - b);
      const medWR = wrs[Math.floor(wrs.length / 2)];
      const minWR = wrs[0];
      const pctProf = recs.filter((r) => r.ret > 0).length / recs.length;
      const avgTr = recs.reduce((s, r) => s + r.trades, 0) / recs.length;
      console.log(
        `\nSummary: medWR=${(medWR * 100).toFixed(1)}%  minWR=${(minWR * 100).toFixed(1)}%  pctProf=${(pctProf * 100).toFixed(0)}%  avgTrades/win=${avgTr.toFixed(1)}`,
      );

      const passes = medWR >= 0.9 && minWR >= 0.8 && pctProf >= 1.0;
      console.log(
        `\n${passes ? "★ PASSES" : "DROPS"} strict relock (medWR≥90 AND minWR≥80 AND pctProf=100%)`,
      );
      console.log(
        `\nVs iter65 (no avoid-hours): medWR 90.6%, minWR 86.5%, pctProf 100%, avgTr 172.1`,
      );
      console.log(
        `Vs iter66 (full-hist single): WR 93.7%, cumRet +96.7% (from 77.8%)`,
      );
    },
  );
});
