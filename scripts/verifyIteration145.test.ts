/**
 * Iter 145 — map the physical frontier of mean-per-trade for TRUE daytrade
 * (hold ≤ 24h on 1h bars). User asked for ≥ 5% mean. The 1d swing gave us
 * 5.79% but with 40-day hold — that's swing, not daytrade.
 *
 * This scan strictly respects daytrade: 1h bars, hold ≤ 24 bars (24h).
 * Wide TP/stop grid: TP 3-15%, stop 0.5-3%. If a config with bs+ ≥ 90%
 * and n ≥ 80 can reach mean ≥ 5%, we have the answer. If not, iter 146
 * tries 4h bars with hold ≤ 6 (also 24h).
 *
 * Trigger: iter135 ensemble (4 mechanics + volume + MG3 gate + HTF 168h).
 * Only TP/stop/hold vary.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

function smaLast(v: number[], n: number): number {
  if (v.length < n) return v[v.length - 1] ?? 0;
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
function medianLast(v: number[], n: number): number {
  if (v.length < n) return 0;
  const s = [...v.slice(-n)].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
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
const P = {
  htfLen: 168,
  macroBars: 720,
  nHi: 36,
  rsiTh: 42,
  redPct: 0.002,
  nDown: 2,
  capK: 4,
  volMult: 1.2,
  volMedLen: 96,
};

interface Ctx {
  closes: number[];
  highs: number[];
  volumes: number[];
  r7: number[];
  trendMask: boolean[];
  macroMask: boolean[];
  volMedian: number[];
}

function mkCtx(candles: Candle[]): Ctx {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const volumes = candles.map((c) => c.volume);
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
  const volMedian: number[] = new Array(candles.length).fill(0);
  for (let i = P.volMedLen; i < candles.length; i++) {
    volMedian[i] = medianLast(volumes.slice(i - P.volMedLen, i), P.volMedLen);
  }
  return { closes, highs, volumes, r7, trendMask, macroMask, volMedian };
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

function executeLong(
  candles: Candle[],
  i: number,
  tpPct: number,
  stopPct: number,
  hold: number,
): { exitBar: number; pnl: number; hitTp: boolean; hitStop: boolean } | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const tp = entry * (1 + tpPct);
  const stop = entry * (1 - stopPct);
  const mx = Math.min(i + 1 + hold, candles.length - 1);
  let exitBar = mx;
  let exitPrice = candles[mx].close;
  let hitTp = false;
  let hitStop = false;
  for (let j = i + 2; j <= mx; j++) {
    const bar = candles[j];
    if (bar.low <= stop) {
      exitBar = j;
      exitPrice = stop;
      hitStop = true;
      break;
    }
    if (bar.high >= tp) {
      exitBar = j;
      exitPrice = tp;
      hitTp = true;
      break;
    }
  }
  const pnl = applyCosts({
    entry,
    exit: exitPrice,
    direction: "long",
    holdingHours: exitBar - (i + 1),
    config: MAKER_COSTS,
  }).netPnlPct;
  return { exitBar, pnl, hitTp, hitStop };
}

interface Trade {
  pnl: number;
  openBar: number;
}

function run(
  candles: Candle[],
  ctx: Ctx,
  tpPct: number,
  stopPct: number,
  hold: number,
): { trades: Trade[]; tpHits: number; stopHits: number; timeExits: number } {
  const open: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  let tpHits = 0;
  let stopHits = 0;
  let timeExits = 0;
  const mechs: Mech[] = ["M1", "M4", "M5", "M6"];
  for (let i = P.macroBars + 2; i < candles.length - 1; i++) {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].exitBar < i) open.splice(k, 1);
    }
    if (open.length >= P.capK) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    if (ctx.volumes[i] <= P.volMult * ctx.volMedian[i]) continue;
    for (const m of mechs) {
      if (open.length >= P.capK) break;
      if (open.some((o) => o.mech === m)) continue;
      if (!fireM(candles, ctx, i, m)) continue;
      const r = executeLong(candles, i, tpPct, stopPct, hold);
      if (!r) continue;
      trades.push({ pnl: r.pnl / P.capK, openBar: i });
      open.push({ exitBar: r.exitBar, mech: m });
      if (r.hitTp) tpHits++;
      else if (r.hitStop) stopHits++;
      else timeExits++;
    }
  }
  return { trades, tpHits, stopHits, timeExits };
}

describe("iter 145 — daytrade frontier (1h, hold ≤ 24h)", () => {
  it(
    "map max mean-per-trade with strict daytrade hold",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 145: daytrade frontier 1h ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });
      const days = c.length / 24;
      const bpw = Math.floor(c.length / 10);
      console.log(`loaded ${c.length} 1h candles (${days.toFixed(0)} days)`);
      const ctx = mkCtx(c);

      interface Row {
        tp: number;
        stop: number;
        hold: number;
        n: number;
        mean: number;
        wr: number;
        sh: number;
        bsPos: number;
        bs5: number;
        tpHitRate: number;
      }
      const results: Row[] = [];
      for (const tp of [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.12, 0.15]) {
        for (const stop of [0.005, 0.008, 0.01, 0.015, 0.02, 0.03]) {
          for (const hold of [6, 12, 18, 24]) {
            const { trades, tpHits } = run(c, ctx, tp, stop, hold);
            if (trades.length < 30) continue;
            const pnls = trades.map((t) => t.pnl);
            const mean = pnls.reduce((a, p) => a + p, 0) / pnls.length;
            const wr = pnls.filter((p) => p > 0).length / pnls.length;
            const sh = sharpeOf(pnls);
            const bs = bootstrap(
              pnls,
              30,
              Math.max(10, Math.floor(pnls.length / 15)),
              Math.round(tp * 1000 + stop * 100 + hold),
            );
            results.push({
              tp,
              stop,
              hold,
              n: trades.length,
              mean,
              wr,
              sh,
              bsPos: bs.pctPositive,
              bs5: bs.p5,
              tpHitRate: tpHits / trades.length,
            });
          }
        }
      }

      // Sort by mean, show top 20
      const top = [...results].sort((a, b) => b.mean - a.mean).slice(0, 30);
      console.log("\n── Top 30 by mean (hold ≤ 24h = strict daytrade) ──");
      console.log(
        "tp   stop  hold   n     mean%  WR     Sharpe  bs+   bs5%    tpHitRate",
      );
      for (const r of top) {
        const robust = r.bsPos >= 0.9 && r.n >= 50 ? "★" : " ";
        console.log(
          `${(r.tp * 100).toFixed(0).padStart(2)}%  ${(r.stop * 100).toFixed(1).padStart(4)}% ${r.hold.toString().padStart(3)}h  ${r.n.toString().padStart(4)} ${(r.mean * 100).toFixed(3).padStart(7)}% ${(r.wr * 100).toFixed(1).padStart(5)}% ${r.sh.toFixed(2).padStart(6)} ${(r.bsPos * 100).toFixed(0).padStart(3)}% ${(r.bs5 * 100).toFixed(1).padStart(6)}% ${(r.tpHitRate * 100).toFixed(1).padStart(5)}% ${robust}`,
        );
      }

      // Specifically: any config with mean ≥ 5% AND bs+ ≥ 90%?
      const fiveTarget = results.filter(
        (r) => r.mean >= 0.05 && r.bsPos >= 0.9 && r.n >= 50,
      );
      console.log(
        `\nConfigs meeting mean ≥ 5% AND bs+ ≥ 90% AND n ≥ 50: **${fiveTarget.length}**`,
      );
      if (fiveTarget.length === 0) {
        console.log("  ← 5% daytrade is NOT achievable on 1h bars");
      }

      // What's the max mean with robust criteria?
      const robustTop = results
        .filter((r) => r.bsPos >= 0.9 && r.n >= 50)
        .sort((a, b) => b.mean - a.mean)[0];
      if (robustTop) {
        console.log(
          `\nMax robust mean (bs+ ≥ 90%, n ≥ 50): tp=${(robustTop.tp * 100).toFixed(0)}% s=${(robustTop.stop * 100).toFixed(1)}% h=${robustTop.hold}h → mean=${(robustTop.mean * 100).toFixed(3)}% Shp=${robustTop.sh.toFixed(2)}`,
        );
      }
    },
  );
});
