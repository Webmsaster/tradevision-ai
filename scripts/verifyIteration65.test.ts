/**
 * Iter 65: Selective 3-asset expansion (DOT, LTC, AAVE).
 *
 * iter64 showed full 20-asset expansion drops from 93% → 79% profitable
 * windows because 7 of the 10 new alts have negative ret despite high WR.
 *
 * Per-asset iter64 results on the new 10:
 *   ★ DOT: 96.0% WR, +3.8% ret — keep
 *   ★ LTC: 92.0% WR, +5.4% ret — keep
 *   ★ AAVE: 93.3% WR, +3.5% ret — keep
 *     DOGE/ADA/ATOM/UNI/FIL/XRP/BCH: all negative ret — drop
 *
 * New basket: baseline 10 + {DOT, LTC, AAVE} = 13 assets. Re-bootstrap.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  HF_DAYTRADING_ASSETS,
  runHfDaytrading,
} from "../src/utils/hfDaytrading";
import type { Candle } from "../src/utils/indicators";

const KEEP = ["DOTUSDT", "LTCUSDT", "AAVEUSDT"];
const EXPANDED_13 = [...HF_DAYTRADING_ASSETS, ...KEEP];

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

describe("iteration 65 — selective 13-basket expansion", () => {
  it("bootstrap lock 13-asset basket", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 65: 13-asset selective expansion ===");
    const data: Record<string, Candle[]> = {};
    const avail: string[] = [];
    for (const s of EXPANDED_13) {
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
    console.log(
      `Available: ${avail.length}/${EXPANDED_13.length} (${avail.join(", ")})`,
    );

    // Full-history
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
    const days = barMax / 96;
    console.log(
      `\nFull-history (13-asset): trades=${n}  WR=${(wr * 100).toFixed(1)}%  ret=${(ret * 100).toFixed(1)}%  trades/day=${(n / days).toFixed(2)}`,
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
      "\n" +
        "window".padEnd(10) +
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
    console.log(
      `\nSummary: medWR=${(medWR * 100).toFixed(1)}%  minWR=${(minWR * 100).toFixed(1)}%  pctProf=${(pctProf * 100).toFixed(0)}%`,
    );

    const passes = medWR >= 0.85 && minWR >= 0.7 && pctProf >= 1.0;
    console.log(
      `\n13-basket ${passes ? "★ PASSES" : "DROPS"} lock criteria (medWR≥85 AND minWR≥70 AND pctProf=100%)`,
    );
  });
});
