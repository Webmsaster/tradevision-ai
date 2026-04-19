/**
 * Iter 108: Diagnostic landscape dump.
 *
 * After iter105+106+107 produced 0 configs under strict multi-period filters,
 * question: is there ANY hidden signal, or is noise across the board?
 *
 * This iter ranks the BTC grid by 3 separate criteria:
 *   1. Full-history Sharpe (no multi-period check)
 *   2. Full-history cumulative return
 *   3. Full-history WR
 *
 * Only soft filter: n ≥ 200. Reveals the ceiling.
 * Using combined volume-spike + RSI confluence (new).
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

interface Cfg {
  lookback: number;
  volMult: number;
  priceZ: number;
  rsiLen: number;
  rsiEnabled: boolean;
  rsiBuyMax: number; // for longs: RSI must be ≤ this
  rsiSellMin: number; // for shorts: RSI must be ≥ this
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number;
  mode: "fade" | "momentum";
  htfTrendEnabled: boolean;
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
function rsi(closes: number[], len: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < len + 1) return out;
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

interface Trade {
  pnl: number;
}

function run(candles: Candle[], cfg: Cfg): Trade[] {
  const trades: Trade[] = [];
  const closes = candles.map((c) => c.close);
  const rsiArr = cfg.rsiEnabled ? rsi(closes, cfg.rsiLen) : [];
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
    if (cfg.rsiEnabled) {
      const r = rsiArr[i];
      if (!Number.isFinite(r)) continue;
      if (direction === "long" && r > cfg.rsiBuyMax) continue;
      if (direction === "short" && r < cfg.rsiSellMin) continue;
    }
    if (cfg.htfTrendEnabled) {
      const sma48 = smaLast(
        w.map((c) => c.close),
        Math.min(48, w.length),
      );
      const aligned = cur.close > sma48;
      if (direction === "long" && !aligned) continue;
      if (direction === "short" && aligned) continue;
    }
    const p = candles[i - 1];
    const b = candles[i - 2];
    if (!p || !b) continue;
    if (cfg.mode === "momentum") {
      const pb = direction === "long" ? p.close < b.close : p.close > b.close;
      if (!pb) continue;
    } else {
      const sameDir = ret > 0 ? p.close > b.close : p.close < b.close;
      if (!sameDir) continue;
    }
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

function sharpeOf(pnls: number[]): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(365 * 24);
}

describe("iter 108 — BTC diagnostic landscape (no strict filters)", () => {
  it(
    "dump BTC ceiling by Sharpe, cumRet, WR separately",
    { timeout: 1_800_000 },
    async () => {
      console.log("\n=== ITER 108: BTC landscape diagnostic ===");
      const btc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 24000,
      });
      const days = btc.length / 24;
      console.log(`BTC: ${btc.length} bars = ${days.toFixed(0)} days`);

      // Combined vol+RSI grid — including both modes
      const grid: Cfg[] = [];
      for (const mode of ["fade", "momentum"] as const) {
        for (const vm of [1.5, 2.0, 2.5]) {
          for (const pZ of [1.0, 1.5, 2.0]) {
            for (const rsiOn of [false, true]) {
              const rsiBuyVariants = rsiOn ? [30, 40, 50] : [0];
              const rsiSellVariants = rsiOn ? [50, 60, 70] : [100];
              for (const rsiB of rsiBuyVariants) {
                for (const rsiS of rsiSellVariants) {
                  for (const tp1 of [0.002, 0.003]) {
                    for (const tp2Mult of [3, 6]) {
                      for (const stop of [0.02, 0.03, 0.04]) {
                        for (const hold of [6, 12, 24]) {
                          for (const htfTrend of [false, true]) {
                            grid.push({
                              lookback: 48,
                              volMult: vm,
                              priceZ: pZ,
                              rsiLen: 14,
                              rsiEnabled: rsiOn,
                              rsiBuyMax: rsiB,
                              rsiSellMin: rsiS,
                              tp1Pct: tp1,
                              tp2Pct: tp1 * tp2Mult,
                              stopPct: stop,
                              holdBars: hold,
                              mode,
                              htfTrendEnabled: htfTrend,
                            });
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      console.log(`Grid: ${grid.length} configs`);

      interface Row {
        cfg: Cfg;
        n: number;
        wr: number;
        ret: number;
        sharpe: number;
        tpd: number;
      }
      const results: Row[] = [];
      for (const cfg of grid) {
        const trades = run(btc, cfg);
        if (trades.length < 200) continue;
        const pnls = trades.map((t) => t.pnl);
        const w = pnls.filter((p) => p > 0).length;
        const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const sh = sharpeOf(pnls);
        results.push({
          cfg,
          n: trades.length,
          wr: w / trades.length,
          ret,
          sharpe: sh,
          tpd: trades.length / days,
        });
      }
      console.log(`\n${results.length} configs with n≥200`);

      const printTable = (title: string, rows: Row[]) => {
        console.log(`\n── ${title} ──`);
        console.log(
          "mode".padEnd(10) +
            "vm".padStart(5) +
            "pZ".padStart(5) +
            "rsi".padStart(10) +
            "tp1/tp2".padStart(14) +
            "stop".padStart(6) +
            "h".padStart(4) +
            "htf".padStart(4) +
            "n".padStart(6) +
            "tpd".padStart(6) +
            "WR%".padStart(7) +
            "ret%".padStart(10) +
            "Shp".padStart(7),
        );
        for (const r of rows) {
          const c = r.cfg;
          const rsiStr = c.rsiEnabled
            ? `${c.rsiBuyMax}/${c.rsiSellMin}`
            : "off";
          console.log(
            c.mode.padEnd(10) +
              c.volMult.toFixed(1).padStart(5) +
              c.priceZ.toFixed(1).padStart(5) +
              rsiStr.padStart(10) +
              `${(c.tp1Pct * 100).toFixed(2)}/${(c.tp2Pct * 100).toFixed(2)}`.padStart(
                14,
              ) +
              (c.stopPct * 100).toFixed(1).padStart(6) +
              c.holdBars.toString().padStart(4) +
              (c.htfTrendEnabled ? "Y" : "N").padStart(4) +
              r.n.toString().padStart(6) +
              r.tpd.toFixed(2).padStart(6) +
              (r.wr * 100).toFixed(1).padStart(7) +
              (r.ret * 100).toFixed(2).padStart(10) +
              r.sharpe.toFixed(2).padStart(7),
          );
        }
      };

      const byRet = [...results].sort((a, b) => b.ret - a.ret);
      const bySharpe = [...results].sort((a, b) => b.sharpe - a.sharpe);
      const byWR = [...results]
        .filter((r) => r.ret > 0)
        .sort((a, b) => b.wr - a.wr);

      printTable("TOP 15 by cumRet (full 1000d)", byRet.slice(0, 15));
      printTable("TOP 15 by Sharpe (full 1000d)", bySharpe.slice(0, 15));
      printTable("TOP 15 by WR (among ret>0)", byWR.slice(0, 15));
      printTable("BOTTOM 5 by cumRet", byRet.slice(-5));
    },
  );
});
