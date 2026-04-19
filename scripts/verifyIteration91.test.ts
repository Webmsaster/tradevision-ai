/**
 * Iter 91: Bootstrap-lock top BTC configs from iter90.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

interface Cfg {
  name: string;
  lookback: number;
  volMult: number;
  priceZ: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number;
  mode: "fade" | "momentum";
}

const CANDIDATES: Cfg[] = [
  {
    name: "A: fade 2.0/1.8 tp0.3/1.5 s2.0 h24 (PF 4.54)",
    lookback: 48,
    volMult: 2.0,
    priceZ: 1.8,
    tp1Pct: 0.003,
    tp2Pct: 0.015,
    stopPct: 0.02,
    holdBars: 24,
    mode: "fade",
  },
  {
    name: "B: fade 2.0/1.8 tp0.15/1.2 s2.0 h24 (PF 7.14, WR 93.9%)",
    lookback: 48,
    volMult: 2.0,
    priceZ: 1.8,
    tp1Pct: 0.0015,
    tp2Pct: 0.012,
    stopPct: 0.02,
    holdBars: 24,
    mode: "fade",
  },
  {
    name: "C: fade 2.0/1.5 tp0.2/1.6 s2.0 h24 (more trades)",
    lookback: 48,
    volMult: 2.0,
    priceZ: 1.5,
    tp1Pct: 0.002,
    tp2Pct: 0.016,
    stopPct: 0.02,
    holdBars: 24,
    mode: "fade",
  },
];

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

function run(candles: Candle[], cfg: Cfg): Trade[] {
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
    const sma48 = smaLast(
      w.slice(-48).map((c) => c.close),
      48,
    );
    const aligned = cur.close > sma48;
    if (direction === "long" && !aligned) continue;
    if (direction === "short" && aligned) continue;
    const p = candles[i - 1];
    const b = candles[i - 2];
    if (!p || !b) continue;
    const sameDir = ret > 0 ? p.close > b.close : p.close < b.close;
    if (!sameDir) continue;
    if (new Date(cur.openTime).getUTCHours() === 0) continue;

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
          sL = entry;
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

describe("iter 91 — bootstrap-lock BTC configs", () => {
  it("14-window on top 3 BTC candidates", { timeout: 600_000 }, async () => {
    console.log("\n=== ITER 91: bootstrap-lock BTC ===");
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount: 10000,
    });
    for (const cfg of CANDIDATES) {
      console.log(`\n── ${cfg.name} ──`);
      const fullR = run(btc, cfg);
      const fullW = fullR.filter((t) => t.pnl > 0).length;
      const fullRet = fullR.reduce((a, r) => a * (1 + r.pnl), 1) - 1;
      console.log(
        `full-hist: n=${fullR.length} WR=${((fullW / fullR.length) * 100).toFixed(1)}% ret=${(fullRet * 100).toFixed(1)}%`,
      );

      interface Rec {
        trades: number;
        wr: number;
        ret: number;
      }
      const recs: Rec[] = [];
      for (const cut of [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]) {
        const slice = btc.slice(Math.floor(btc.length * cut));
        const r = run(slice, cfg);
        if (r.length < 5) continue;
        const wr = r.filter((t) => t.pnl > 0).length / r.length;
        const ret = r.reduce((a, x) => a * (1 + x.pnl), 1) - 1;
        recs.push({ trades: r.length, wr, ret });
      }
      for (let i = 0; i < 5; i++) {
        const boot = blockBootstrap(btc, 96 * 14, 6, 1234 + i * 17);
        const r = run(boot, cfg);
        if (r.length < 5) continue;
        const wr = r.filter((t) => t.pnl > 0).length / r.length;
        const ret = r.reduce((a, x) => a * (1 + x.pnl), 1) - 1;
        recs.push({ trades: r.length, wr, ret });
      }
      const wrs = recs.map((r) => r.wr).sort((a, b) => a - b);
      const medWR = wrs[Math.floor(wrs.length / 2)];
      const minWR = wrs[0];
      const pctProf = recs.filter((r) => r.ret > 0).length / recs.length;
      const avgTr = recs.reduce((s, r) => s + r.trades, 0) / recs.length;
      console.log(
        `bootstrap (n=${recs.length}): medWR=${(medWR * 100).toFixed(1)}% minWR=${(minWR * 100).toFixed(1)}% pctProf=${(pctProf * 100).toFixed(0)}% avgTr=${avgTr.toFixed(1)}`,
      );
      const passes = medWR >= 0.8 && minWR >= 0.65 && pctProf >= 0.8;
      console.log(
        `${passes ? "★ PASSES" : "drops"} (medWR≥80, minWR≥65, pctProf≥80 — lenient since BTC has fewer trades)`,
      );
    }
  });
});
