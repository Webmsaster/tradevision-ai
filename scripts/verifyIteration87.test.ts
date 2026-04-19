/**
 * Iter 87: Vol-regime filter — skip when realized vol is extreme.
 *
 * Hypothesis: in very low vol, volume spikes are too small to capture
 * tp1/tp2. In very high vol, stops get swept. Middle vol regimes may
 * have best edge.
 *
 * Test 3 variants:
 *   A) no filter (current)
 *   B) skip top 10% vol (avoid chaos)
 *   C) skip both tails (10-90% band)
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
function realizedVol(closes: number[]): number {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] <= 0) continue;
    r.push(Math.log(closes[i] / closes[i - 1]));
  }
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}
function pct(a: number[], p: number): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length * p)];
}

interface Trade {
  pnl: number;
}

function run(
  candles: Candle[],
  volGate: "off" | "skip-top" | "mid-80",
): Trade[] {
  const cfg = HF_DAYTRADING_CONFIG;
  // Pre-compute vol percentiles across full history
  const vwin = 96; // 24h
  const rvs: number[] = [];
  for (let i = vwin; i < candles.length; i++) {
    rvs.push(realizedVol(candles.slice(i - vwin, i).map((c) => c.close)));
  }
  const p90 = pct(rvs, 0.9);
  const p10 = pct(rvs, 0.1);

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

    // VOL REGIME GATE
    if (volGate !== "off") {
      const rv = realizedVol(w.slice(-vwin).map((c) => c.close));
      if (volGate === "skip-top" && rv > p90) continue;
      if (volGate === "mid-80" && (rv > p90 || rv < p10)) continue;
    }

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
          if (t2) {
            l2B = j;
            l2P = tp2L;
            break;
          }
          continue;
        }
      } else {
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

describe("iter 87 — vol-regime filter", () => {
  it(
    "compare no-filter vs skip-top vs mid-80",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 87: vol-regime filter ===");
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
      for (const gate of ["off", "skip-top", "mid-80"] as const) {
        console.log(`\n── vol-gate: ${gate} ──`);
        let n = 0,
          w = 0,
          sl = 0;
        for (const s of avail) {
          const r = run(data[s], gate);
          n += r.length;
          w += r.filter((t) => t.pnl > 0).length;
          for (const t of r) sl += Math.log(1 + t.pnl);
        }
        console.log(
          `full-hist: trades=${n} WR=${((w / n) * 100).toFixed(1)}% cumRet=${((Math.exp(sl) - 1) * 100).toFixed(1)}%`,
        );
        // Bootstrap
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
            const res = run(data[s].slice(cut), gate);
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
