/**
 * Iter 101-103: Multi-year validation on ETH + SOL (1h × 30000 bars).
 *
 * Check if the alt-portfolio "edge" is also overfit to recent regime
 * (like BTC was in iter98-100), or if it holds up over 3.4 years.
 *
 * Tests 2 configs per asset:
 *   A) current HF_DAYTRADING_CONFIG (fade 2.5/1.8 tp0.2/1.2 s4 h24)
 *      translated to 1h (holdBars: 24 → 6)
 *   B) iter94 BTC config equivalent on alt (fade 2.5/1.0 tp0.15/1.8 s3 h6)
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

const CONFIGS: Cfg[] = [
  {
    name: "CURRENT HF cfg: fade 2.5/1.8 tp0.2/1.2 s4 h6",
    lookback: 48,
    volMult: 2.5,
    priceZ: 1.8,
    tp1Pct: 0.002,
    tp2Pct: 0.012,
    stopPct: 0.04,
    holdBars: 6,
    mode: "fade",
  },
  {
    name: "iter94 ALT: fade 2.5/1.0 tp0.15/1.80 s3 h6",
    lookback: 48,
    volMult: 2.5,
    priceZ: 1.0,
    tp1Pct: 0.0015,
    tp2Pct: 0.018,
    stopPct: 0.03,
    holdBars: 6,
    mode: "fade",
  },
];

const ASSETS = ["ETHUSDT", "SOLUSDT", "LINKUSDT", "AVAXUSDT"]; // older alts

function median(a: number[]) {
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
      w.map((c) => c.close),
      Math.min(48, w.length),
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
      holdingHours: l2B - (i + 1),
      config: MAKER_COSTS,
    });
    const leg2 = l2c.netPnlPct;
    let leg1: number;
    if (tp1Hit) {
      const l1c = applyCosts({
        entry,
        exit: tp1L,
        direction,
        holdingHours: tp1Bar - (i + 1),
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

function dateFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

describe("iter 101-103 — alt multi-year validation", () => {
  it("test ETH, SOL, LINK, AVAX on 3.4y", { timeout: 300_000 }, async () => {
    console.log("\n=== ITER 101-103: alt multi-year ===");
    const data: Record<string, Candle[]> = {};
    for (const s of ASSETS) {
      try {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "1h",
          targetCount: 30000,
        });
        const days = data[s].length / 24;
        console.log(
          `${s}: ${data[s].length} bars = ${days.toFixed(0)} days (${(days / 365).toFixed(2)}y) ${dateFromMs(data[s][0].openTime)} → ${dateFromMs(data[s][data[s].length - 1].openTime)}`,
        );
      } catch {
        console.log(`${s}: fetch fail`);
      }
    }

    for (const cfg of CONFIGS) {
      console.log(`\n═══ ${cfg.name} ═══`);
      // Per-asset multi-year
      for (const sym of ASSETS) {
        if (!data[sym]) continue;
        const full = run(data[sym], cfg);
        const fullW = full.filter((t) => t.pnl > 0).length;
        const fullRet = full.reduce((a, t) => a * (1 + t.pnl), 1) - 1;
        const barsPerWindow = Math.floor(data[sym].length / 8);
        interface Rec {
          wr: number;
          ret: number;
          n: number;
        }
        const recs: Rec[] = [];
        for (let w = 0; w < 8; w++) {
          const slice = data[sym].slice(
            w * barsPerWindow,
            (w + 1) * barsPerWindow,
          );
          if (slice.length < 100) continue;
          const r = run(slice, cfg);
          const wr =
            r.length > 0 ? r.filter((t) => t.pnl > 0).length / r.length : 0;
          const ret = r.reduce((a, t) => a * (1 + t.pnl), 1) - 1;
          recs.push({ wr, ret, n: r.length });
        }
        const wrs = recs
          .filter((r) => r.n > 0)
          .map((r) => r.wr)
          .sort();
        const medWR = wrs[Math.floor(wrs.length / 2)] ?? 0;
        const minWR = wrs[0] ?? 0;
        const pctProf = recs.filter((r) => r.ret > 0).length / recs.length;
        const minRet = recs.length ? Math.min(...recs.map((r) => r.ret)) : 0;
        console.log(
          `${sym.padEnd(10)} full n=${full.length.toString().padStart(4)} WR=${((fullW / Math.max(1, full.length)) * 100).toFixed(1).padStart(5)}% ret=${(fullRet * 100).toFixed(1).padStart(6)}%   per-win medWR=${(medWR * 100).toFixed(1).padStart(5)}% minWR=${(minWR * 100).toFixed(1).padStart(5)}% pctProf=${(pctProf * 100).toFixed(0).padStart(3)}% minRet=${(minRet * 100).toFixed(1).padStart(6)}%`,
        );
      }
    }
  });
});
