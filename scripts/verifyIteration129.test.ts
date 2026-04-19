/**
 * Iter 129 — multi-asset portfolio extension of iter123.
 *
 * Same iter123 engine (HTF 168h + macro 30d + 4 mechanics + cap 4 concurrent
 * scale-out) applied to BTC + ETH + SOL + BNB + XRP + LINK + AVAX.
 * Each asset runs INDEPENDENTLY with its OWN macro gate — asset i only
 * trades when asset-i's own 30-day return is positive.
 *
 * Concurrent cap is asset-local (each asset gets 4 slots). Portfolio-level
 * trades are gathered chronologically across all assets; total capital
 * deployment is normalised by dividing each trade's PnL by (capK × N_assets)
 * so the portfolio's book-level return is a weighted average.
 *
 * Goal: lift portfolio tpd from 1.87 (BTC-only) to 5-8 tpd with equal or
 * better Sharpe (diversification lowers per-trade correlation).
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const ASSETS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "LINKUSDT",
  "AVAXUSDT",
];
const TARGET_CANDLES = 50_000;

function smaLast(v: number[], n: number): number {
  if (v.length < n) return v[v.length - 1] ?? 0;
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
function maxLast(v: number[], n: number): number {
  const s = v.slice(-n);
  let m = -Infinity;
  for (const x of s) if (x > m) m = x;
  return m;
}
function rsiSeries(closes: number[], len: number): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= len) return out;
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss += -d;
  }
  gain /= len;
  loss /= len;
  out[len] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (len - 1) + g) / len;
    loss = (loss * (len - 1) + l) / len;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
function sharpeOf(pnls: number[]): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(365 * 24);
}
function bootstrap(
  pnls: number[],
  resamples: number,
  blockLen: number,
  seed: number,
): { pctPositive: number; p5: number } {
  if (pnls.length < blockLen) return { pctPositive: 0, p5: 0 };
  let s = seed;
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const rets: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sampled: number[] = [];
    const nBlocks = Math.ceil(pnls.length / blockLen);
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rng() * Math.max(1, pnls.length - blockLen));
      for (let k = 0; k < blockLen; k++) sampled.push(pnls[start + k]);
    }
    const ret = sampled.reduce((a, p) => a * (1 + p), 1) - 1;
    rets.push(ret);
  }
  const sorted = [...rets].sort((a, b) => a - b);
  return {
    pctPositive: rets.filter((r) => r > 0).length / rets.length,
    p5: sorted[Math.floor(sorted.length * 0.05)],
  };
}

type Mech = "M1" | "M4" | "M5" | "M6";

interface Params {
  htfLen: number;
  macroBars: number;
  nHi: number;
  rsiTh: number;
  redPct: number;
  nDown: number;
  capK: number;
  tp1: number;
  tp2: number;
  stop: number;
  hold: number;
}

const P: Params = {
  htfLen: 168,
  macroBars: 720,
  nHi: 36,
  rsiTh: 42,
  redPct: 0.002,
  nDown: 2,
  capK: 4,
  tp1: 0.008,
  tp2: 0.04,
  stop: 0.01,
  hold: 24,
};

interface Ctx {
  closes: number[];
  highs: number[];
  r7: number[];
  trendMask: boolean[];
  macroMask: boolean[];
}
function mkCtx(candles: Candle[]): Ctx {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const r7 = rsiSeries(closes, 7);
  const trendMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = P.htfLen; i < candles.length; i++) {
    const s = smaLast(closes.slice(i - P.htfLen, i), P.htfLen);
    trendMask[i] = candles[i].close > s;
  }
  const macroMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = P.macroBars; i < candles.length; i++) {
    const past = closes[i - P.macroBars];
    if (past > 0) macroMask[i] = (closes[i] - past) / past > 0;
  }
  return { closes, highs, r7, trendMask, macroMask };
}

function fireM(candles: Candle[], ctx: Ctx, i: number, m: Mech): boolean {
  if (!ctx.trendMask[i] || !ctx.macroMask[i]) return false;
  switch (m) {
    case "M1":
      if (i < P.nDown + 1) return false;
      for (let k = 0; k < P.nDown; k++) {
        if (ctx.closes[i - k] >= ctx.closes[i - k - 1]) return false;
      }
      return true;
    case "M4":
      return ctx.r7[i] <= P.rsiTh;
    case "M5":
      if (i < P.nHi + 1) return false;
      return candles[i].close > maxLast(ctx.highs.slice(i - P.nHi, i), P.nHi);
    case "M6": {
      const o = candles[i].open;
      const c = candles[i].close;
      if (o <= 0) return false;
      return (c - o) / o <= -P.redPct;
    }
  }
}

function executeLongScaleOut(
  candles: Candle[],
  i: number,
): { exitBar: number; pnl: number } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const tp1L = entry * (1 + P.tp1);
  const tp2L = entry * (1 + P.tp2);
  let sL = entry * (1 - P.stop);
  const mx = Math.min(i + 1 + P.hold, candles.length - 1);
  let tp1Hit = false;
  let tp1Bar = -1;
  let l2P = candles[mx].close;
  let l2B = mx;
  for (let j = i + 2; j <= mx; j++) {
    const bar = candles[j];
    if (!tp1Hit) {
      if (bar.low <= sL) {
        l2B = j;
        l2P = sL;
        break;
      }
      if (bar.high >= tp1L) {
        tp1Hit = true;
        tp1Bar = j;
        sL = entry;
        if (bar.high >= tp2L) {
          l2B = j;
          l2P = tp2L;
          break;
        }
        continue;
      }
    } else {
      if (bar.low <= sL) {
        l2B = j;
        l2P = sL;
        break;
      }
      if (bar.high >= tp2L) {
        l2B = j;
        l2P = tp2L;
        break;
      }
    }
  }
  const leg2 = applyCosts({
    entry,
    exit: l2P,
    direction: "long",
    holdingHours: l2B - (i + 1),
    config: MAKER_COSTS,
  }).netPnlPct;
  const leg1 = tp1Hit
    ? applyCosts({
        entry,
        exit: tp1L,
        direction: "long",
        holdingHours: tp1Bar - (i + 1),
        config: MAKER_COSTS,
      }).netPnlPct
    : leg2;
  return { exitBar: l2B, pnl: 0.5 * leg1 + 0.5 * leg2 };
}

interface Trade {
  pnl: number;
  openBar: number;
  sym: string;
  mech: Mech;
}

function runAsset(candles: Candle[], sym: string, ctx: Ctx): Trade[] {
  const open: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const mechs: Mech[] = ["M1", "M4", "M5", "M6"];
  for (let i = P.macroBars + 2; i < candles.length - 1; i++) {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].exitBar < i) open.splice(k, 1);
    }
    if (open.length >= P.capK) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    for (const m of mechs) {
      if (open.length >= P.capK) break;
      if (open.some((o) => o.mech === m)) continue;
      if (!fireM(candles, ctx, i, m)) continue;
      const r = executeLongScaleOut(candles, i);
      if (!r) continue;
      // Size: 1 / (capK × N_assets) to normalize portfolio full deployment
      trades.push({
        pnl: r.pnl / (P.capK * ASSETS.length),
        openBar: i,
        sym,
        mech: m,
      });
      open.push({ exitBar: r.exitBar, mech: m });
    }
  }
  return trades;
}

describe("iter 129 — multi-asset portfolio", () => {
  it(
    "BTC + 6 alts on iter123 engine (2083 days)",
    { timeout: 1_500_000 },
    async () => {
      console.log("\n=== ITER 129: Multi-asset portfolio ===");
      const dataBy: Record<string, Candle[]> = {};
      for (const s of ASSETS) {
        console.log(`loading ${s}...`);
        dataBy[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "1h",
          targetCount: TARGET_CANDLES,
          maxPages: 100,
        });
        console.log(`  ${s}: ${dataBy[s].length} candles`);
      }

      // All-sym chronological trades
      let allTrades: Trade[] = [];
      const perAsset: Record<string, Trade[]> = {};
      const maxLen = Math.max(...Object.values(dataBy).map((d) => d.length));
      const days = maxLen / 24;

      for (const sym of ASSETS) {
        const c = dataBy[sym];
        const ctx = mkCtx(c);
        const t = runAsset(c, sym, ctx);
        perAsset[sym] = t;
        allTrades = allTrades.concat(t);
      }
      allTrades.sort((a, b) => a.openBar - b.openBar);

      // Per-asset summary
      console.log("\n── Per-asset ──");
      console.log("sym       n     tpd    WR     meanPct  cumRet   Shp");
      for (const sym of ASSETS) {
        const t = perAsset[sym];
        if (t.length === 0) continue;
        const pnls = t.map((x) => x.pnl);
        const wins = pnls.filter((p) => p > 0).length;
        const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const mean = pnls.reduce((a, p) => a + p, 0) / pnls.length;
        const sh = sharpeOf(pnls);
        const tpd = t.length / (dataBy[sym].length / 24);
        const wr = wins / t.length;
        console.log(
          `${sym.padEnd(10)} ${t.length.toString().padStart(4)} ${tpd.toFixed(2)} ${(wr * 100).toFixed(1)}% ${(mean * 100).toFixed(3).padStart(6)}% ${(ret * 100).toFixed(1).padStart(6)}% ${sh.toFixed(2)}`,
        );
      }

      // Portfolio-level
      console.log("\n── PORTFOLIO (combined chronological) ──");
      const pnls = allTrades.map((t) => t.pnl);
      const wins = pnls.filter((p) => p > 0).length;
      const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
      const mean = pnls.reduce((a, p) => a + p, 0) / pnls.length;
      const sh = sharpeOf(pnls);
      const tpd = allTrades.length / days;
      const wr = wins / allTrades.length;
      const bs = bootstrap(
        pnls,
        100,
        Math.max(20, Math.floor(pnls.length / 15)),
        777,
      );
      console.log(
        `n=${allTrades.length} tpd=${tpd.toFixed(2)} WR=${(wr * 100).toFixed(
          1,
        )}% mean=${(mean * 100).toFixed(3)}% cumRet=${(ret * 100).toFixed(1)}% Shp=${sh.toFixed(2)} bs+=${(bs.pctPositive * 100).toFixed(0)}% bs5%=${(bs.p5 * 100).toFixed(1)}%`,
      );

      // 10-window analysis
      const bpw = Math.floor(maxLen / 10);
      const winRet: number[] = [];
      for (let w = 0; w < 10; w++) {
        const lo = w * bpw;
        const hi = (w + 1) * bpw;
        const wt = allTrades.filter((t) => t.openBar >= lo && t.openBar < hi);
        winRet.push(wt.reduce((a, t) => a * (1 + t.pnl), 1) - 1);
      }
      const pctProf = winRet.filter((r) => r > 0).length / winRet.length;
      const minWin = Math.min(...winRet);
      console.log(
        `%prof=${(pctProf * 100).toFixed(0)}% minW=${(minWin * 100).toFixed(1)}% windows=[${winRet.map((r) => (r * 100).toFixed(1) + "%").join(", ")}]`,
      );

      // Quarters
      const qSize = Math.floor(maxLen / 4);
      for (let k = 0; k < 4; k++) {
        const lo = k * qSize;
        const hi = (k + 1) * qSize;
        const qT = allTrades.filter((t) => t.openBar >= lo && t.openBar < hi);
        const qP = qT.map((x) => x.pnl);
        const qW = qP.filter((p) => p > 0).length;
        const qR = qP.reduce((a, p) => a * (1 + p), 1) - 1;
        const qM =
          qP.length > 0 ? qP.reduce((a, p) => a + p, 0) / qP.length : 0;
        const qSh = sharpeOf(qP);
        const qTpd = qT.length / (qSize / 24);
        console.log(
          `Q${k + 1} n=${qT.length} tpd=${qTpd.toFixed(2)} WR=${((qW / qT.length) * 100).toFixed(1)}% mean=${(qM * 100).toFixed(3)}% ret=${(qR * 100).toFixed(1)}% Shp=${qSh.toFixed(2)}`,
        );
      }
    },
  );
});
