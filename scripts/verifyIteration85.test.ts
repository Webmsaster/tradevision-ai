/**
 * Iter 85: Trailing-stop after tp1 (variant of current BE-stop).
 *
 * Current: after tp1 hits, stop moves to entry (BE). Remaining 50% exits
 * at tp2 OR at BE (whichever first).
 *
 * Variant: after tp1 hits, stop trails the favorable price bar-by-bar
 * (long: stop = max(current_bar_low - buffer)). Should capture more tp2
 * and avoid give-back to BE.
 *
 * Test on 15-asset basket + bootstrap. Must not regress minWR.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  HF_DAYTRADING_ASSETS,
  HF_DAYTRADING_CONFIG,
} from "../src/utils/hfDaytrading";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

function median(a: number[]) {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function stdReturns(c: number[]) {
  if (c.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < c.length; i++) {
    if (c[i - 1] <= 0) continue;
    r.push((c[i] - c[i - 1]) / c[i - 1]);
  }
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}
function smaLast(v: number[], n: number) {
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

interface Trade {
  pnl: number;
}

function run(candles: Candle[], useTrailing: boolean): Trade[] {
  const cfg = HF_DAYTRADING_CONFIG;
  const trades: Trade[] = [];
  for (let i = cfg.lookback; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (prev.close <= 0) continue;
    const w = candles.slice(i - cfg.lookback, i);
    const mv = median(w.map((c) => c.volume));
    if (mv <= 0) continue;
    const vZ = cur.volume / mv;
    if (vZ < cfg.volMult) continue;
    const sd = stdReturns(w.map((c) => c.close));
    if (sd <= 0) continue;
    const ret = (cur.close - prev.close) / prev.close;
    const pZ = Math.abs(ret) / sd;
    if (pZ < cfg.priceZ) continue;
    const direction: "long" | "short" =
      cfg.mode === "fade"
        ? ret > 0
          ? "short"
          : "long"
        : ret > 0
          ? "long"
          : "short";
    if (cfg.avoidHoursUtc?.length) {
      const h = new Date(cur.openTime).getUTCHours();
      if (cfg.avoidHoursUtc.includes(h)) continue;
    }
    if (cfg.htfTrend) {
      const sma48 = smaLast(
        w.slice(-48).map((c) => c.close),
        48,
      );
      const aligned = cur.close > sma48;
      if (direction === "long" && !aligned) continue;
      if (direction === "short" && aligned) continue;
    }
    if (cfg.microPullback) {
      const p = candles[i - 1];
      const b = candles[i - 2];
      if (!p || !b) continue;
      const sameDir = ret > 0 ? p.close > b.close : p.close < b.close;
      if (!sameDir) continue;
    }
    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp1L =
      direction === "long"
        ? entry * (1 + cfg.tp1Pct)
        : entry * (1 - cfg.tp1Pct);
    const tp2L =
      direction === "long"
        ? entry * (1 + cfg.tp2Pct)
        : entry * (1 - cfg.tp2Pct);
    let sL =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);
    const mx = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
    let tp1Hit = false;
    let tp1Bar = -1;
    let l2P = candles[mx].close;
    let l2B = mx;
    // For trailing: track best price seen after tp1
    let bestPrice = entry;
    const trailBuffer = 0.005; // 0.5% trail gap

    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      const sH = direction === "long" ? bar.low <= sL : bar.high >= sL;
      const t1 = direction === "long" ? bar.high >= tp1L : bar.low <= tp1L;
      const t2 = direction === "long" ? bar.high >= tp2L : bar.low <= tp2L;
      if (!tp1Hit) {
        if ((t1 && sH) || sH) {
          l2B = j;
          l2P = sL;
          break;
        }
        if (t1) {
          tp1Hit = true;
          tp1Bar = j;
          if (cfg.useBreakeven) sL = entry;
          bestPrice = direction === "long" ? bar.high : bar.low;
          if (t2) {
            l2B = j;
            l2P = tp2L;
            break;
          }
          continue;
        }
      } else {
        // Post-tp1 phase
        if (useTrailing) {
          // Update trailing stop based on best price
          if (direction === "long") {
            if (bar.high > bestPrice) bestPrice = bar.high;
            const trailStop = bestPrice * (1 - trailBuffer);
            if (trailStop > sL) sL = trailStop;
          } else {
            if (bar.low < bestPrice) bestPrice = bar.low;
            const trailStop = bestPrice * (1 + trailBuffer);
            if (trailStop < sL) sL = trailStop;
          }
        }
        const s2 = direction === "long" ? bar.low <= sL : bar.high >= sL;
        const t22 = direction === "long" ? bar.high >= tp2L : bar.low <= tp2L;
        if ((t22 && s2) || s2) {
          l2B = j;
          l2P = sL;
          break;
        }
        if (t22) {
          l2B = j;
          l2P = tp2L;
          break;
        }
      }
    }
    const l2c = applyCosts({
      entry,
      exit: l2P,
      direction,
      holdingHours: (l2B - (i + 1)) * 0.25,
      config: MAKER_COSTS,
    });
    const leg2 = l2c.netPnlPct;
    let leg1: number;
    if (tp1Hit) {
      const l1c = applyCosts({
        entry,
        exit: tp1L,
        direction,
        holdingHours: (tp1Bar - (i + 1)) * 0.25,
        config: MAKER_COSTS,
      });
      leg1 = l1c.netPnlPct;
    } else {
      leg1 = leg2;
    }
    trades.push({ pnl: 0.5 * leg1 + 0.5 * leg2 });
    i = l2B;
  }
  return trades;
}

function chronoSlices(c: Candle[]) {
  const cuts = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
  return cuts.map((r) => c.slice(Math.floor(c.length * r)));
}

describe("iteration 85 — trailing-stop comparison", () => {
  it(
    "bootstrap BE vs trailing on 15-asset basket",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 85: trailing-stop test ===");
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

      for (const [label, trailing] of [
        ["BE-stop (current)", false],
        ["Trailing-stop (0.5%)", true],
      ] as Array<[string, boolean]>) {
        console.log(`\n── ${label} ──`);
        let fullN = 0,
          fullW = 0,
          fullLog = 0;
        interface Rec {
          label: string;
          trades: number;
          wr: number;
          ret: number;
        }
        const recs: Rec[] = [];
        for (const s of avail) {
          const r = run(data[s], trailing);
          fullN += r.length;
          fullW += r.filter((t) => t.pnl > 0).length;
          for (const t of r) fullLog += Math.log(1 + t.pnl);
        }
        console.log(
          `full-hist: trades=${fullN} WR=${((fullW / fullN) * 100).toFixed(1)}% cumRet=${((Math.exp(fullLog) - 1) * 100).toFixed(1)}%`,
        );

        const anchor = data[avail[0]];
        chronoSlices(anchor).forEach((_, wi) => {
          const r = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8][wi];
          let nn = 0,
            ww = 0,
            ssl = 0;
          for (const s of avail) {
            const cut = Math.floor(data[s].length * r);
            const res = run(data[s].slice(cut), trailing);
            nn += res.length;
            ww += res.filter((t) => t.pnl > 0).length;
            for (const t of res) ssl += Math.log(1 + t.pnl);
          }
          recs.push({
            label: `chr${(r * 100).toFixed(0)}`,
            trades: nn,
            wr: nn > 0 ? ww / nn : 0,
            ret: Math.exp(ssl) - 1,
          });
        });
        const wrs = recs.map((r) => r.wr).sort((a, b) => a - b);
        const medWR = wrs[Math.floor(wrs.length / 2)];
        const minWR = wrs[0];
        const pctProf = recs.filter((r) => r.ret > 0).length / recs.length;
        console.log(
          `bootstrap: medWR=${(medWR * 100).toFixed(1)}% minWR=${(minWR * 100).toFixed(1)}% pctProf=${(pctProf * 100).toFixed(0)}%`,
        );
      }
    },
  );
});
