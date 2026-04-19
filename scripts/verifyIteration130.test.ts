/**
 * Iter 130 — volume confirmation on iter123 BTC baseline.
 *
 * Hypothesis: requiring elevated volume on the entry bar filters out weak
 * signals that don't have institutional participation → higher WR, less
 * trades, but mean profit/trade should rise because stops are less often
 * triggered on genuine breakouts.
 *
 * Tests on BTC 1h, same iter123 params + volume filter:
 *   V1: volume[i] > median(volume[i-N..i-1])
 *   V2: volume[i] > K × median(volume[i-N..i-1])
 *   V3: takerBuyVolume[i] / volume[i] > 0.5  (bullish taker-buy imbalance)
 *   V4: combination V2 × V3
 *
 * Baseline reference: iter123 BTC tpd 1.87, WR 58.0%, mean 0.032%, Sharpe 7.06
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const BTC = "BTCUSDT";
const TARGET_CANDLES = 50_000;

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
  tp1: 0.008,
  tp2: 0.04,
  stop: 0.01,
  hold: 24,
};

interface Ctx {
  closes: number[];
  highs: number[];
  volumes: number[];
  takerBuys: number[];
  r7: number[];
  trendMask: boolean[];
  macroMask: boolean[];
  volMedian24: number[];
  volMedian96: number[];
}
function mkCtx(candles: Candle[]): Ctx {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const volumes = candles.map((c) => c.volume);
  const takerBuys = candles.map((c) => c.takerBuyVolume ?? c.volume / 2);
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
  const volMedian24: number[] = new Array(candles.length).fill(0);
  const volMedian96: number[] = new Array(candles.length).fill(0);
  for (let i = 24; i < candles.length; i++) {
    volMedian24[i] = medianLast(volumes.slice(i - 24, i), 24);
  }
  for (let i = 96; i < candles.length; i++) {
    volMedian96[i] = medianLast(volumes.slice(i - 96, i), 96);
  }
  return {
    closes,
    highs,
    volumes,
    takerBuys,
    r7,
    trendMask,
    macroMask,
    volMedian24,
    volMedian96,
  };
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

type VolFilter =
  | { kind: "none" }
  | { kind: "med24"; mult: number }
  | { kind: "med96"; mult: number }
  | { kind: "takerBuyRatio"; min: number }
  | { kind: "med24_and_tbr"; mult: number; min: number };

function volOk(ctx: Ctx, i: number, f: VolFilter): boolean {
  if (f.kind === "none") return true;
  if (f.kind === "med24") return ctx.volumes[i] > f.mult * ctx.volMedian24[i];
  if (f.kind === "med96") return ctx.volumes[i] > f.mult * ctx.volMedian96[i];
  if (f.kind === "takerBuyRatio") {
    if (ctx.volumes[i] <= 0) return false;
    return ctx.takerBuys[i] / ctx.volumes[i] >= f.min;
  }
  if (f.kind === "med24_and_tbr") {
    if (ctx.volumes[i] <= 0) return false;
    return (
      ctx.volumes[i] > f.mult * ctx.volMedian24[i] &&
      ctx.takerBuys[i] / ctx.volumes[i] >= f.min
    );
  }
  return true;
}

function executeLong(
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
}

function runWithFilter(
  candles: Candle[],
  ctx: Ctx,
  filter: VolFilter,
): Trade[] {
  const open: { exitBar: number; mech: Mech }[] = [];
  const trades: Trade[] = [];
  const mechs: Mech[] = ["M1", "M4", "M5", "M6"];
  for (let i = P.macroBars + 2; i < candles.length - 1; i++) {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].exitBar < i) open.splice(k, 1);
    }
    if (open.length >= P.capK) continue;
    if (new Date(candles[i].openTime).getUTCHours() === 0) continue;
    if (!volOk(ctx, i, filter)) continue;
    for (const m of mechs) {
      if (open.length >= P.capK) break;
      if (open.some((o) => o.mech === m)) continue;
      if (!fireM(candles, ctx, i, m)) continue;
      const r = executeLong(candles, i);
      if (!r) continue;
      trades.push({ pnl: r.pnl / P.capK, openBar: i });
      open.push({ exitBar: r.exitBar, mech: m });
    }
  }
  return trades;
}

describe("iter 130 — volume confirmation", () => {
  it(
    "add volume/taker-buy filter to BTC iter123 baseline",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 130: volume confirmation ===");
      const c = await loadBinanceHistory({
        symbol: BTC,
        timeframe: "1h",
        targetCount: TARGET_CANDLES,
        maxPages: 100,
      });
      const days = c.length / 24;
      const bpw = Math.floor(c.length / 10);
      console.log(
        `loaded ${c.length} BTC 1h candles (${days.toFixed(0)} days)`,
      );
      const ctx = mkCtx(c);

      const filters: Array<{ label: string; f: VolFilter }> = [
        { label: "baseline (no filter)", f: { kind: "none" } },
        { label: "vol > 1.0× med24", f: { kind: "med24", mult: 1.0 } },
        { label: "vol > 1.2× med24", f: { kind: "med24", mult: 1.2 } },
        { label: "vol > 1.5× med24", f: { kind: "med24", mult: 1.5 } },
        { label: "vol > 1.0× med96", f: { kind: "med96", mult: 1.0 } },
        { label: "vol > 1.2× med96", f: { kind: "med96", mult: 1.2 } },
        { label: "TBR >= 0.50", f: { kind: "takerBuyRatio", min: 0.5 } },
        { label: "TBR >= 0.55", f: { kind: "takerBuyRatio", min: 0.55 } },
        { label: "TBR >= 0.60", f: { kind: "takerBuyRatio", min: 0.6 } },
        {
          label: "vol>1.2×med24 AND TBR≥0.50",
          f: { kind: "med24_and_tbr", mult: 1.2, min: 0.5 },
        },
        {
          label: "vol>1.0×med24 AND TBR≥0.55",
          f: { kind: "med24_and_tbr", mult: 1.0, min: 0.55 },
        },
      ];

      console.log(
        "\nlabel                           n      tpd    WR     meanPct   cumRet     Shp    bs+    bs5%    %prof  minW",
      );
      for (const f of filters) {
        const t = runWithFilter(c, ctx, f.f);
        if (t.length < 30) {
          console.log(`${f.label.padEnd(32)} n=${t.length} SKIP`);
          continue;
        }
        const pnls = t.map((x) => x.pnl);
        const wins = pnls.filter((p) => p > 0).length;
        const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const mean = pnls.reduce((a, p) => a + p, 0) / pnls.length;
        const sh = sharpeOf(pnls);
        const tpd = t.length / days;
        const wr = wins / t.length;
        const bs = bootstrap(
          pnls,
          50,
          Math.max(10, Math.floor(pnls.length / 15)),
          42,
        );
        // windows
        const winRet: number[] = [];
        for (let w = 0; w < 10; w++) {
          const lo = w * bpw;
          const hi = (w + 1) * bpw;
          const wt = t.filter((x) => x.openBar >= lo && x.openBar < hi);
          winRet.push(wt.reduce((a, x) => a * (1 + x.pnl), 1) - 1);
        }
        const pctProf = winRet.filter((r) => r > 0).length / winRet.length;
        const minWin = Math.min(...winRet);
        console.log(
          `${f.label.padEnd(32)} ${t.length.toString().padStart(5)} ${tpd.toFixed(2)} ${(wr * 100).toFixed(1).padStart(5)}% ${(mean * 100).toFixed(3).padStart(6)}% ${(ret * 100).toFixed(1).padStart(7)}% ${sh.toFixed(2).padStart(5)} ${(bs.pctPositive * 100).toFixed(0).padStart(3)}% ${(bs.p5 * 100).toFixed(1).padStart(6)}% ${(pctProf * 100).toFixed(0).padStart(3)}% ${(minWin * 100).toFixed(1).padStart(6)}%`,
        );
      }
    },
  );
});
