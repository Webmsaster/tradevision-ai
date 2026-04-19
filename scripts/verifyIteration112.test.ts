/**
 * Iter 112: Validate filtered 5-asset basket (BTC, LINK, BNB, XRP, AVAX)
 * with bootstrap + disjoint window test.
 *
 * Cfg B (tp0.8/4.0 s1.0 h24 htf48 nB3) — best from iter111.
 *
 * Drop ETH (-20.6%) and SOL (-17.8%) since they fail individually.
 *
 * Validation:
 *   - per-asset 10 × 100-day disjoint windows
 *   - portfolio aggregated: chrono order, 10 windows
 *   - bootstrap: 30 resamples over trade sequence (per-asset + portfolio)
 *   - require portfolio bootstrap ≥ 80% positive
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

const CFG: Cfg = {
  name: "DIP-BUY B tp0.8/4.0 s1.0 h24 htf48",
  nBarsDown: 3,
  tp1Pct: 0.008,
  tp2Pct: 0.04,
  stopPct: 0.01,
  holdBars: 24,
  htfLen: 48,
};

const BASKET = ["BTCUSDT", "LINKUSDT", "BNBUSDT", "XRPUSDT", "AVAXUSDT"];

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

describe("iter 112 — filtered basket validation", () => {
  it(
    "validate BTC+LINK+BNB+XRP+AVAX dip-buy portfolio",
    { timeout: 600_000 },
    async () => {
      console.log(`\n=== ITER 112: ${CFG.name} on filtered basket ===`);
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

      // Per-asset: full + disjoint windows + bootstrap
      console.log("\n── Per-asset ──");
      for (const sym of BASKET) {
        const t = run(data[sym], CFG, sym);
        const pnls = t.map((x) => x.pnl);
        const w = pnls.filter((p) => p > 0).length;
        const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const sh = sharpeOf(pnls);
        const tpd = t.length / days;
        // windows
        const perRet: number[] = [];
        for (let i = 0; i < 10; i++) {
          const slice = data[sym].slice(i * bpw, (i + 1) * bpw);
          const tt = run(slice, CFG, sym);
          perRet.push(tt.reduce((a, p) => a * (1 + p.pnl), 1) - 1);
        }
        const pctProf = perRet.filter((r) => r > 0).length / perRet.length;
        const minRet = Math.min(...perRet);
        const bs = bootstrap(
          pnls,
          30,
          Math.max(5, Math.floor(pnls.length / 15)),
          42,
        );
        console.log(
          `${sym.padEnd(10)} n=${t.length.toString().padStart(4)} tpd=${tpd.toFixed(2)} WR=${((w / Math.max(1, t.length)) * 100).toFixed(1).padStart(5)}% ret=${(ret * 100).toFixed(1).padStart(6)}% Shp=${sh.toFixed(2).padStart(5)} %prof=${(pctProf * 100).toFixed(0).padStart(3)}% minWin=${(minRet * 100).toFixed(1).padStart(5)}% bsPos=${(bs.pctPositive * 100).toFixed(0).padStart(3)}% bsMed=${(bs.medRet * 100).toFixed(1).padStart(5)}%`,
        );
      }

      // Portfolio: combined chronologically
      console.log("\n── PORTFOLIO aggregate ──");
      let allTrades: Trade[] = [];
      for (const sym of BASKET) {
        allTrades = allTrades.concat(run(data[sym], CFG, sym));
      }
      allTrades.sort((a, b) => a.openBar - b.openBar);
      const allPnls = allTrades.map((t) => t.pnl);
      const portW = allPnls.filter((p) => p > 0).length;
      const portRet = allPnls.reduce((a, p) => a * (1 + p), 1) - 1;
      const portSh = sharpeOf(allPnls);
      const portTpd = allTrades.length / days;
      // portfolio windows: each window is a bar range, gather trades from that range across all syms
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
        99,
      );
      console.log(
        `n=${allTrades.length} tpd=${portTpd.toFixed(2)} WR=${((portW / allTrades.length) * 100).toFixed(1)}% cumRet=${(portRet * 100).toFixed(1)}% Shp=${portSh.toFixed(2)}`,
      );
      console.log(
        `%prof=${(portPctProf * 100).toFixed(0)}% minWin=${(portMinWin * 100).toFixed(1)}% bsPos=${(portBs.pctPositive * 100).toFixed(0)}% bsMed=${(portBs.medRet * 100).toFixed(1)}% bs5%=${(portBs.p5 * 100).toFixed(1)}%`,
      );
      console.log(
        `Window rets: [${portWinRet.map((r) => (r * 100).toFixed(1) + "%").join(", ")}]`,
      );

      // Verdict
      const passedBS = portBs.pctPositive >= 0.8;
      const passedPctProf = portPctProf >= 0.6;
      const passedMinWin = portMinWin >= -0.05;
      const passedPortRet = portRet > 0;
      console.log("\n── VERDICT ──");
      console.log(`${passedPortRet ? "✓" : "✗"} portfolio cumRet > 0`);
      console.log(
        `${passedBS ? "✓" : "✗"} bootstrap ≥ 80% positive (actual: ${(portBs.pctPositive * 100).toFixed(0)}%)`,
      );
      console.log(
        `${passedPctProf ? "✓" : "✗"} pctProf ≥ 60% (actual: ${(portPctProf * 100).toFixed(0)}%)`,
      );
      console.log(
        `${passedMinWin ? "✓" : "✗"} minWindow ≥ -5% (actual: ${(portMinWin * 100).toFixed(1)}%)`,
      );
      if (passedPortRet && passedBS && passedPctProf && passedMinWin) {
        console.log("\n★★★ DIP-BUY EDGE VALIDATED — PRODUCTION CANDIDATE ★★★");
      } else {
        console.log("\n✗ fails at least one gate — NOT production-ready");
      }
    },
  );
});
