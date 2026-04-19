/**
 * Iter 104: Can a trend-strength regime filter rescue the HF edge
 * on alts multi-year? Test portfolio aggregate of 4 alts with 5 filter
 * strengths. If no variant shows positive portfolio ret over 3.4y:
 * honestly conclude HF system is regime-bound.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const ASSETS = ["ETHUSDT", "SOLUSDT", "LINKUSDT", "AVAXUSDT"];

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
  trendLookback: number;
  maxAbsSlopeBps: number;
}

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
function trendBps(closes: number[]): number {
  const n = closes.length;
  const meanP = closes.reduce((s, v) => s + v, 0) / n;
  const meanX = (n - 1) / 2;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (closes[i] - meanP);
    den += (i - meanX) * (i - meanX);
  }
  return (num / den / meanP) * 10000;
}

interface Trade {
  pnl: number;
}

function run(candles: Candle[], cfg: Cfg): Trade[] {
  const trades: Trade[] = [];
  const start = Math.max(cfg.lookback, cfg.trendLookback);
  for (let i = start; i < candles.length - cfg.holdBars - 1; i++) {
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
    if (cfg.maxAbsSlopeBps > 0) {
      const tClose = candles
        .slice(i - cfg.trendLookback, i)
        .map((c) => c.close);
      const strength = Math.abs(trendBps(tClose));
      if (strength > cfg.maxAbsSlopeBps) continue;
    }
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

const BASE = {
  lookback: 48,
  volMult: 2.5,
  priceZ: 1.8,
  tp1Pct: 0.002,
  tp2Pct: 0.012,
  stopPct: 0.04,
  holdBars: 6,
  mode: "fade" as const,
};

const CFGS: Cfg[] = [
  { ...BASE, name: "NO FILTER", trendLookback: 0, maxAbsSlopeBps: 0 },
  {
    ...BASE,
    name: "VERY STRONG |slope|<3bps",
    trendLookback: 240,
    maxAbsSlopeBps: 3,
  },
  {
    ...BASE,
    name: "STRONG |slope|<5bps",
    trendLookback: 240,
    maxAbsSlopeBps: 5,
  },
  {
    ...BASE,
    name: "MEDIUM |slope|<10bps",
    trendLookback: 240,
    maxAbsSlopeBps: 10,
  },
  {
    ...BASE,
    name: "WIDE |slope|<20bps",
    trendLookback: 240,
    maxAbsSlopeBps: 20,
  },
];

describe("iter 104 — trend-regime gate on portfolio multi-year", () => {
  it(
    "check if any filter rescues the alt-edge",
    { timeout: 300_000 },
    async () => {
      console.log("\n=== ITER 104: regime gate portfolio test ===");
      const data: Record<string, Candle[]> = {};
      for (const s of ASSETS) {
        try {
          data[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: "1h",
            targetCount: 30000,
          });
        } catch {
          // skip
        }
      }
      const avail = ASSETS.filter((s) => data[s]);

      for (const cfg of CFGS) {
        console.log(`\n── ${cfg.name} ──`);
        let totalN = 0,
          totalW = 0,
          totalLog = 0;
        const perAsset: Record<string, { n: number; wr: number; ret: number }> =
          {};
        for (const s of avail) {
          const t = run(data[s], cfg);
          const w = t.filter((x) => x.pnl > 0).length;
          const ret = t.reduce((a, x) => a * (1 + x.pnl), 1) - 1;
          perAsset[s] = {
            n: t.length,
            wr: t.length > 0 ? w / t.length : 0,
            ret,
          };
          totalN += t.length;
          totalW += w;
          for (const x of t) totalLog += Math.log(1 + x.pnl);
        }
        const portfolioWR = totalN > 0 ? totalW / totalN : 0;
        const portfolioRet = Math.exp(totalLog) - 1;
        console.log(
          `portfolio: n=${totalN} WR=${(portfolioWR * 100).toFixed(1)}% cumRet=${(portfolioRet * 100).toFixed(1)}%`,
        );
        for (const s of avail) {
          const a = perAsset[s];
          console.log(
            `  ${s.padEnd(10)} n=${a.n.toString().padStart(4)} WR=${(a.wr * 100).toFixed(1).padStart(5)}% ret=${(a.ret * 100).toFixed(1).padStart(6)}%`,
          );
        }
      }
    },
  );
});
