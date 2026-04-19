/**
 * Iter 57: Bootstrap-lock the top 5 iter56 HF daytrading candidates.
 *
 * iter56 full-history: 398 configs passed WR≥70 + ret>0 + ≥10/wk.
 * Top by score:
 *   #1 fade vm2.5/pZ1.8 tp1=0.30/tp2=1.2 stop=3.0 hold=24 → WR 91.8%, +58.6%, 17.2/wk
 *   #2 fade vm2.5/pZ1.8 tp1=0.30/tp2=1.2 stop=3.0 hold=32 → WR 92.6%, +55.0%, 17.2/wk
 *   #3 fade vm2.5/pZ1.6 tp1=0.30/tp2=1.2 stop=3.0 hold=16 → WR 88.3%, +54.4%, 21.2/wk
 *   #4 fade vm2.0/pZ1.8 tp1=0.30/tp2=1.2 stop=3.0 hold=32 → WR 90.5%, +50.5%, 23.4/wk
 *   #5 fade vm2.0/pZ1.6 tp1=0.20/tp2=1.2 stop=3.0 hold=32 → WR 92.6%, +45.2%, 29.2/wk
 *
 * All top configs share wide stop=3.0 — high WR via rare-but-big-loss. Must
 * verify on bootstrap that the rare loss doesn't compound across regimes.
 *
 * Lock: portfolio minWR ≥ 70% AND pctProf ≥ 80% across 15 windows
 * (10 chrono + 5 block bootstrap).
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import { applyCosts } from "../src/utils/costModel";
import type { Candle } from "../src/utils/indicators";

const ASSETS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "AVAXUSDT",
  "SUIUSDT",
  "APTUSDT",
  "INJUSDT",
  "NEARUSDT",
  "OPUSDT",
  "LINKUSDT",
];

interface Cfg {
  label: string;
  volMult: number;
  priceZ: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number;
  mode: "fade" | "momentum";
  lookback: number;
  htfTrend: boolean;
  microPullback: boolean;
  useBreakeven: boolean;
}

const CANDIDATES: Cfg[] = [
  {
    label: "#1 fade 2.5/1.8 tp0.3/1.2 s3 h24",
    volMult: 2.5,
    priceZ: 1.8,
    tp1Pct: 0.003,
    tp2Pct: 0.012,
    stopPct: 0.03,
    holdBars: 24,
    mode: "fade",
    lookback: 48,
    htfTrend: true,
    microPullback: true,
    useBreakeven: true,
  },
  {
    label: "#2 fade 2.5/1.8 tp0.3/1.2 s3 h32",
    volMult: 2.5,
    priceZ: 1.8,
    tp1Pct: 0.003,
    tp2Pct: 0.012,
    stopPct: 0.03,
    holdBars: 32,
    mode: "fade",
    lookback: 48,
    htfTrend: true,
    microPullback: true,
    useBreakeven: true,
  },
  {
    label: "#3 fade 2.5/1.6 tp0.3/1.2 s3 h16",
    volMult: 2.5,
    priceZ: 1.6,
    tp1Pct: 0.003,
    tp2Pct: 0.012,
    stopPct: 0.03,
    holdBars: 16,
    mode: "fade",
    lookback: 48,
    htfTrend: true,
    microPullback: true,
    useBreakeven: true,
  },
  {
    label: "#4 fade 2.0/1.8 tp0.3/1.2 s3 h32",
    volMult: 2.0,
    priceZ: 1.8,
    tp1Pct: 0.003,
    tp2Pct: 0.012,
    stopPct: 0.03,
    holdBars: 32,
    mode: "fade",
    lookback: 48,
    htfTrend: true,
    microPullback: true,
    useBreakeven: true,
  },
  {
    label: "#5 fade 2.0/1.6 tp0.2/1.2 s3 h32",
    volMult: 2.0,
    priceZ: 1.6,
    tp1Pct: 0.002,
    tp2Pct: 0.012,
    stopPct: 0.03,
    holdBars: 32,
    mode: "fade",
    lookback: 48,
    htfTrend: true,
    microPullback: true,
    useBreakeven: true,
  },
];

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function stdReturns(c: number[]): number {
  if (c.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < c.length; i++) {
    if (c[i - 1] <= 0) continue;
    r.push((c[i] - c[i - 1]) / c[i - 1]);
  }
  if (r.length === 0) return 0;
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}
function sma(vals: number[]): number {
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

interface Trade {
  pnl: number;
}

function runCfg(candles: Candle[], cfg: Cfg): Trade[] {
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
    if (cfg.htfTrend) {
      const s48 = sma(w.slice(-48).map((c) => c.close));
      const al = cur.close > s48;
      if (direction === "long" && !al) continue;
      if (direction === "short" && al) continue;
    }
    if (cfg.microPullback) {
      const p = candles[i - 1];
      const b = candles[i - 2];
      if (!p || !b) continue;
      if (cfg.mode === "momentum") {
        const pb = direction === "long" ? p.close < b.close : p.close > b.close;
        if (!pb) continue;
      } else {
        const sd2 = ret > 0 ? p.close > b.close : p.close < b.close;
        if (!sd2) continue;
      }
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
    let t1Hit = false;
    let t1Bar = -1;
    let l2P = candles[mx].close;
    let l2B = mx;
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      const sH = direction === "long" ? bar.low <= sL : bar.high >= sL;
      const t1R = direction === "long" ? bar.high >= tp1L : bar.low <= tp1L;
      const t2R = direction === "long" ? bar.high >= tp2L : bar.low <= tp2L;
      if (!t1Hit) {
        if (t1R && sH) {
          l2B = j;
          l2P = sL;
          break;
        }
        if (sH) {
          l2B = j;
          l2P = sL;
          break;
        }
        if (t1R) {
          t1Hit = true;
          t1Bar = j;
          if (cfg.useBreakeven) sL = entry;
          if (t2R) {
            l2B = j;
            l2P = tp2L;
            break;
          }
          continue;
        }
      } else {
        const sH2 = direction === "long" ? bar.low <= sL : bar.high >= sL;
        const t22 = direction === "long" ? bar.high >= tp2L : bar.low <= tp2L;
        if (t22 && sH2) {
          l2B = j;
          l2P = sL;
          break;
        }
        if (t22) {
          l2B = j;
          l2P = tp2L;
          break;
        }
        if (sH2) {
          l2B = j;
          l2P = sL;
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
    if (t1Hit) {
      const l1c = applyCosts({
        entry,
        exit: tp1L,
        direction,
        holdingHours: (t1Bar - (i + 1)) * 0.25,
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

function chronoSlices(candles: Candle[]) {
  const cuts = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
  return cuts.map((r) => candles.slice(Math.floor(candles.length * r)));
}

function blockBootstrap(
  candles: Candle[],
  blockBars: number,
  n: number,
  seed: number,
): Candle[] {
  const blocks: Candle[][] = [];
  for (let i = 0; i + blockBars <= candles.length; i += blockBars) {
    blocks.push(candles.slice(i, i + blockBars));
  }
  let s = seed;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const picked: Candle[] = [];
  const want = Math.min(n, blocks.length);
  const used = new Set<number>();
  while (picked.length < want * blockBars) {
    const idx = Math.floor(rand() * blocks.length);
    if (used.has(idx)) continue;
    used.add(idx);
    picked.push(...blocks[idx]);
  }
  let t = candles[0]?.openTime ?? 0;
  return picked.map((c) => {
    const out = { ...c, openTime: t, closeTime: t + 15 * 60 * 1000 - 1 };
    t += 15 * 60 * 1000;
    return out;
  });
}

function pct(a: number[], q: number): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length * q)];
}

describe("iteration 57 — bootstrap-lock top iter56 HF configs", () => {
  it(
    "10-chrono + 5-bootstrap per config, portfolio aggregate",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 57: BOOTSTRAP LOCK OF HF DAYTRADING ===");
      const data: Record<string, Candle[]> = {};
      for (const s of ASSETS) {
        try {
          data[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: "15m",
            targetCount: 10000,
          });
        } catch {
          continue;
        }
      }
      const avail = ASSETS.filter((s) => data[s] && data[s].length >= 2000);
      console.log(`${avail.length} assets available`);

      for (const cfg of CANDIDATES) {
        // For each window, compute portfolio-level WR/ret
        interface WinRec {
          label: string;
          trades: number;
          wr: number;
          ret: number;
        }
        const windows: Array<{
          label: string;
          perSym: Record<string, Candle[]>;
        }> = [];

        // 10 chrono
        const cronSlices = chronoSlices(data[avail[0]]);
        for (let wi = 0; wi < cronSlices.length; wi++) {
          const perSym: Record<string, Candle[]> = {};
          const cutFrac =
            (data[avail[0]].length - cronSlices[wi].length) /
            data[avail[0]].length;
          for (const s of avail) {
            const cut = Math.floor(data[s].length * cutFrac);
            perSym[s] = data[s].slice(cut);
          }
          windows.push({ label: `chrono${wi}`, perSym });
        }
        // 5 bootstrap
        for (let i = 0; i < 5; i++) {
          const perSym: Record<string, Candle[]> = {};
          for (const s of avail) {
            perSym[s] = blockBootstrap(
              data[s],
              96 * 14, // 14-day blocks
              6, // 84 days total
              1234 + i * 17,
            );
          }
          windows.push({ label: `boot${i}`, perSym });
        }

        const recs: WinRec[] = [];
        for (const w of windows) {
          let n = 0;
          let wins = 0;
          let sumLog = 0;
          for (const s of avail) {
            const trs = runCfg(w.perSym[s], cfg);
            n += trs.length;
            wins += trs.filter((t) => t.pnl > 0).length;
            for (const t of trs) sumLog += Math.log(1 + t.pnl);
          }
          const wr = n > 0 ? wins / n : 0;
          const ret = Math.exp(sumLog) - 1;
          recs.push({ label: w.label, trades: n, wr, ret });
        }
        const wrs = recs.map((r) => r.wr);
        const rets = recs.map((r) => r.ret);
        const ns = recs.map((r) => r.trades);
        const medWR = pct(wrs, 0.5);
        const minWR = Math.min(...wrs);
        const pctProf = rets.filter((x) => x > 0).length / rets.length;
        const medRet = pct(rets, 0.5);
        const minRet = Math.min(...rets);
        const avgTrades = ns.reduce((s, v) => s + v, 0) / ns.length;
        const passed = medWR >= 0.7 && minWR >= 0.7 && pctProf >= 0.8;

        console.log(`\n== ${cfg.label} ==`);
        console.log(
          "win".padEnd(12) +
            "trades".padStart(8) +
            "WR%".padStart(7) +
            "ret%".padStart(9),
        );
        for (const r of recs) {
          console.log(
            r.label.padEnd(12) +
              r.trades.toString().padStart(8) +
              (r.wr * 100).toFixed(1).padStart(7) +
              (r.ret * 100).toFixed(1).padStart(9),
          );
        }
        console.log(
          `  Summary: avgTrades=${avgTrades.toFixed(1)}  medWR=${(medWR * 100).toFixed(1)}%  minWR=${(minWR * 100).toFixed(1)}%  pctProf=${(pctProf * 100).toFixed(0)}%  medRet=${(medRet * 100).toFixed(1)}%  minRet=${(minRet * 100).toFixed(1)}%`,
        );
        console.log(
          `  Lock (medWR≥70 AND minWR≥70 AND pctProf≥80): ${passed ? "★ PASS" : "drop"}`,
        );
      }
    },
  );
});
