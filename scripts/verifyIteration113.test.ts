/**
 * Iter 113: Add BTC-macro regime gate to portfolio.
 *
 * Premise: in iter112, portfolio losing windows were -21% to -23%. Cause:
 * alt-coin entries during BTC bear regime. Fix: only trade entries when
 * BTC itself is in HTF uptrend (macro-aligned).
 *
 * Also drop AVAX (worst asset from iter112).
 *
 * Tests 2 variants:
 *   V1: 4 assets (BTC+LINK+BNB+XRP), BTC-macro gate ON
 *   V2: same 4 assets, BTC-macro gate OFF (baseline)
 *
 * Pass gate: portfolio pctProf≥60, minWin≥-8%, bsPos≥85%.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

interface Cfg {
  nBarsDown: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number;
  htfLen: number;
  btcMacroHtf: number; // if >0, require BTC close > SMA(btcMacroHtf)
}

const BASE: Omit<Cfg, "btcMacroHtf"> = {
  nBarsDown: 3,
  tp1Pct: 0.008,
  tp2Pct: 0.04,
  stopPct: 0.01,
  holdBars: 24,
  htfLen: 48,
};

const BASKET = ["BTCUSDT", "LINKUSDT", "BNBUSDT", "XRPUSDT"];

function smaLast(v: number[], n: number): number {
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

interface Trade {
  pnl: number;
  sym: string;
  openBar: number;
}

function run(
  candles: Candle[],
  cfg: Cfg,
  sym: string,
  btcCandles: Candle[],
): Trade[] {
  const trades: Trade[] = [];
  const closes = candles.map((c) => c.close);
  const btcCloses = btcCandles.map((c) => c.close);
  const start = Math.max(cfg.htfLen, cfg.btcMacroHtf, cfg.nBarsDown + 1);
  for (let i = start; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const sma = smaLast(closes.slice(i - cfg.htfLen, i), cfg.htfLen);
    if (cur.close <= sma) continue;

    if (cfg.btcMacroHtf > 0) {
      const btcI = Math.min(i, btcCandles.length - 1);
      const btcCur = btcCandles[btcI].close;
      const btcSma = smaLast(
        btcCloses.slice(btcI - cfg.btcMacroHtf, btcI),
        cfg.btcMacroHtf,
      );
      if (btcCur <= btcSma) continue;
    }

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

function bootstrap(
  pnls: number[],
  resamples: number,
  blockLen: number,
  seed: number,
): { pctPositive: number; medRet: number; p5: number } {
  if (pnls.length < blockLen) return { pctPositive: 0, medRet: 0, p5: 0 };
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
    medRet: sorted[Math.floor(sorted.length / 2)],
    p5: sorted[Math.floor(sorted.length * 0.05)],
  };
}

describe("iter 113 — BTC-macro regime gate on portfolio", () => {
  it(
    "test BTC-macro gate saves portfolio from alt bear drawdowns",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 113: BTC-macro regime gate ===");
      const data: Record<string, Candle[]> = {};
      for (const s of BASKET) {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "1h",
          targetCount: 24000,
        });
      }
      const days = data[BASKET[0]].length / 24;
      const bpw = Math.floor(data[BASKET[0]].length / 10);
      const btc = data["BTCUSDT"];

      for (const variant of [
        { name: "V1 btcMacro OFF (baseline 4-asset)", btcMacroHtf: 0 },
        { name: "V2 btcMacro 96h (4 days)", btcMacroHtf: 96 },
        { name: "V3 btcMacro 168h (7 days)", btcMacroHtf: 168 },
        { name: "V4 btcMacro 336h (14 days)", btcMacroHtf: 336 },
      ]) {
        const cfg: Cfg = { ...BASE, btcMacroHtf: variant.btcMacroHtf };
        console.log(`\n════ ${variant.name} ════`);
        let allTrades: Trade[] = [];
        for (const sym of BASKET) {
          const t = run(data[sym], cfg, sym, btc);
          allTrades = allTrades.concat(t);
          const pnls = t.map((x) => x.pnl);
          const w = pnls.filter((p) => p > 0).length;
          const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
          const sh = sharpeOf(pnls);
          const tpd = t.length / days;
          console.log(
            `  ${sym.padEnd(10)} n=${t.length.toString().padStart(4)} tpd=${tpd.toFixed(2)} WR=${((w / Math.max(1, t.length)) * 100).toFixed(1).padStart(5)}% ret=${(ret * 100).toFixed(1).padStart(6)}% Shp=${sh.toFixed(2).padStart(5)}`,
          );
        }
        allTrades.sort((a, b) => a.openBar - b.openBar);
        const allPnls = allTrades.map((t) => t.pnl);
        const portW = allPnls.filter((p) => p > 0).length;
        const portRet = allPnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const portSh = sharpeOf(allPnls);
        const portTpd = allTrades.length / days;
        const portWinRet: number[] = [];
        for (let w = 0; w < 10; w++) {
          const lo = w * bpw;
          const hi = (w + 1) * bpw;
          const winTrades = allTrades.filter(
            (t) => t.openBar >= lo && t.openBar < hi,
          );
          const r = winTrades.reduce((a, t) => a * (1 + t.pnl), 1) - 1;
          portWinRet.push(r);
        }
        const portPctProf =
          portWinRet.filter((r) => r > 0).length / portWinRet.length;
        const portMinWin = Math.min(...portWinRet);
        const portBs = bootstrap(
          allPnls,
          30,
          Math.max(10, Math.floor(allPnls.length / 15)),
          99 + variant.btcMacroHtf,
        );
        console.log(
          `  PORT n=${allTrades.length} tpd=${portTpd.toFixed(2)} WR=${((portW / allTrades.length) * 100).toFixed(1)}% cumRet=${(portRet * 100).toFixed(1)}% Shp=${portSh.toFixed(2)}`,
        );
        console.log(
          `       %prof=${(portPctProf * 100).toFixed(0)}% minWin=${(portMinWin * 100).toFixed(1)}% bsPos=${(portBs.pctPositive * 100).toFixed(0)}% bsMed=${(portBs.medRet * 100).toFixed(1)}% bs5%=${(portBs.p5 * 100).toFixed(1)}%`,
        );
        console.log(
          `       windows: [${portWinRet.map((r) => (r * 100).toFixed(1) + "%").join(", ")}]`,
        );
      }
    },
  );
});
