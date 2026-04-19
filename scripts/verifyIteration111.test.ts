/**
 * Iter 111: Does the "3-red-bars → long in HTF uptrend" edge generalize
 * across majors? If yes: portfolio frequency = 5-10× BTC-alone frequency.
 *
 * Test best 3 iter110 configs on BTC/ETH/SOL/LINK/AVAX/BNB/XRP:
 *   A) nB=3 htf=48 tp1.0/8.0 stop1.2 hold36 (best Sharpe 7.05 on BTC)
 *   B) nB=3 htf=48 tp0.8/4.0 stop1.0 hold24 (highest tpd/bsPos=87%)
 *   C) nB=3 htf=48 tp1.0/5.0 stop1.2 hold24 (bsPos=100% on BTC)
 *
 * For each asset × cfg: full 1000d, per-asset metrics.
 * Then portfolio aggregate across all assets for each cfg.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

interface Cfg {
  name: string;
  nBarsDown: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number;
  htfLen: number;
}

const CFGS: Cfg[] = [
  {
    name: "A tp1.0/8.0 s1.2 h36",
    nBarsDown: 3,
    tp1Pct: 0.01,
    tp2Pct: 0.08,
    stopPct: 0.012,
    holdBars: 36,
    htfLen: 48,
  },
  {
    name: "B tp0.8/4.0 s1.0 h24",
    nBarsDown: 3,
    tp1Pct: 0.008,
    tp2Pct: 0.04,
    stopPct: 0.01,
    holdBars: 24,
    htfLen: 48,
  },
  {
    name: "C tp1.0/5.0 s1.2 h24",
    nBarsDown: 3,
    tp1Pct: 0.01,
    tp2Pct: 0.05,
    stopPct: 0.012,
    holdBars: 24,
    htfLen: 48,
  },
  {
    name: "D tp1.2/6.0 s1.5 h24",
    nBarsDown: 3,
    tp1Pct: 0.012,
    tp2Pct: 0.06,
    stopPct: 0.015,
    holdBars: 24,
    htfLen: 48,
  },
];

const ASSETS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "BNBUSDT",
  "XRPUSDT",
];

function smaLast(v: number[], n: number): number {
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

interface Trade {
  pnl: number;
  sym: string;
  openBar: number;
}

function run(candles: Candle[], cfg: Cfg, sym: string): Trade[] {
  const trades: Trade[] = [];
  const closes = candles.map((c) => c.close);
  const start = Math.max(cfg.htfLen, cfg.nBarsDown + 1);
  for (let i = start; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const sma = smaLast(closes.slice(i - cfg.htfLen, i), cfg.htfLen);
    if (cur.close <= sma) continue;
    let allRed = true;
    for (let k = 0; k < cfg.nBarsDown; k++) {
      if (candles[i - k].close >= candles[i - k - 1].close) {
        allRed = false;
        break;
      }
    }
    if (!allRed) continue;
    if (new Date(cur.openTime).getUTCHours() === 0) continue;
    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp1L = entry * (1 + cfg.tp1Pct);
    const tp2L = entry * (1 + cfg.tp2Pct);
    let sL = entry * (1 - cfg.stopPct);
    const mx = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
    let tp1Hit = false;
    let tp1Bar = -1;
    let l2P = candles[mx].close;
    let l2B = mx;
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      const sH = bar.low <= sL;
      const t1 = bar.high >= tp1L;
      const t2 = bar.high >= tp2L;
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
        const s2 = bar.low <= sL;
        const t22 = bar.high >= tp2L;
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
      direction: "long",
      holdingHours: l2B - (i + 1),
      config: MAKER_COSTS,
    });
    const leg2 = l2c.netPnlPct;
    let leg1: number;
    if (tp1Hit) {
      const l1c = applyCosts({
        entry,
        exit: tp1L,
        direction: "long",
        holdingHours: tp1Bar - (i + 1),
        config: MAKER_COSTS,
      });
      leg1 = l1c.netPnlPct;
    } else {
      leg1 = leg2;
    }
    trades.push({ pnl: 0.5 * leg1 + 0.5 * leg2, sym, openBar: i });
    i = l2B;
  }
  return trades;
}

function sharpeOf(pnls: number[]): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(365 * 24);
}

describe("iter 111 — dip-buy edge portfolio generalization", () => {
  it(
    "does BTC dip-buy edge work on ETH/SOL/etc too?",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 111: dip-buy edge portfolio test ===");
      const data: Record<string, Candle[]> = {};
      for (const s of ASSETS) {
        try {
          data[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: "1h",
            targetCount: 24000,
          });
          const d = data[s].length / 24;
          console.log(`${s}: ${data[s].length} bars = ${d.toFixed(0)}d`);
        } catch {
          console.log(`${s}: FETCH FAIL`);
        }
      }
      const avail = ASSETS.filter((s) => data[s]);

      for (const cfg of CFGS) {
        console.log(`\n════ ${cfg.name} ════`);
        let portTrades: Trade[] = [];
        let totalDays = 0;
        for (const sym of avail) {
          const days = data[sym].length / 24;
          totalDays = Math.max(totalDays, days);
          const t = run(data[sym], cfg, sym);
          portTrades = portTrades.concat(t);
          const w = t.filter((x) => x.pnl > 0).length;
          const ret = t.reduce((a, x) => a * (1 + x.pnl), 1) - 1;
          const sh = sharpeOf(t.map((x) => x.pnl));
          const tpd = t.length / days;
          console.log(
            `${sym.padEnd(10)} n=${t.length.toString().padStart(4)} tpd=${tpd.toFixed(2)} WR=${((t.length > 0 ? w / t.length : 0) * 100).toFixed(1).padStart(5)}% ret=${(ret * 100).toFixed(1).padStart(6)}% Shp=${sh.toFixed(2).padStart(6)}`,
          );
        }
        // Portfolio aggregate (equal-weight, each trade same $ risk)
        portTrades.sort((a, b) => a.openBar - b.openBar);
        const pnls = portTrades.map((t) => t.pnl);
        const portW = pnls.filter((p) => p > 0).length;
        const portRet = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const portSh = sharpeOf(pnls);
        const portTpd = portTrades.length / totalDays;
        console.log(
          `PORTFOLIO  n=${portTrades.length.toString().padStart(4)} tpd=${portTpd.toFixed(2)} WR=${((portW / Math.max(1, portTrades.length)) * 100).toFixed(1).padStart(5)}% ret=${(portRet * 100).toFixed(1).padStart(6)}% Shp=${portSh.toFixed(2).padStart(6)}`,
        );
      }
    },
  );
});
