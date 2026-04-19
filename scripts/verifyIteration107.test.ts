/**
 * Iter 107: After iter105+106 ruled out volume-spike (21000+ configs zero
 * survivors over 1000d), try ORTHOGONAL trigger: RSI(14) mean-reversion.
 *
 * Premise: volume-spike faded into noise post-2023. RSI-extreme may still
 * work as entry, especially with trend alignment.
 *
 * Relaxed survival criteria (realistic daytrading):
 *   - ≥ 0.3 trades/day
 *   - cumRet > 0 over 1000d
 *   - WR ≥ 55% (not 75 — accept lower WR if Sharpe ≥ 1)
 *   - Sharpe ≥ 1.0 over trades
 *   - ≥ 60% of 10 × 100-day windows profitable
 *   - min window ret ≥ -3%
 *
 * Grid: RSI_buy [20,25,30,35], RSI_sell [65,70,75,80],
 * tp1 [0.0015,0.002,0.003,0.005], tp2mult [3,6],
 * stop [0.015,0.02,0.03], hold [6,12,24], htfTrend [true,false],
 * require penultimate-bar pullback [true,false]
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

interface Cfg {
  rsiLen: number;
  rsiBuy: number;
  rsiSell: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number;
  htfTrendEnabled: boolean;
  requirePullback: boolean;
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

function smaLast(v: number[], n: number): number {
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

interface Trade {
  pnl: number;
}

function run(candles: Candle[], cfg: Cfg): Trade[] {
  const trades: Trade[] = [];
  const closes = candles.map((c) => c.close);
  const rsiArr = rsi(closes, cfg.rsiLen);
  const start = Math.max(cfg.rsiLen + 2, 48);
  for (let i = start; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const r = rsiArr[i];
    if (!Number.isFinite(r)) continue;
    let direction: "long" | "short" | null = null;
    if (r <= cfg.rsiBuy) direction = "long";
    else if (r >= cfg.rsiSell) direction = "short";
    if (!direction) continue;
    if (cfg.htfTrendEnabled) {
      const sma48 = smaLast(closes.slice(i - 48, i), 48);
      const aligned = cur.close > sma48;
      // counter-trend relative to HTF: only take longs in uptrend, shorts in downtrend
      if (direction === "long" && !aligned) continue;
      if (direction === "short" && aligned) continue;
    }
    if (cfg.requirePullback) {
      const p = candles[i - 1];
      const b = candles[i - 2];
      if (!p || !b) continue;
      const pb = direction === "long" ? p.close < b.close : p.close > b.close;
      if (!pb) continue;
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

describe("iter 107 — BTC RSI mean-reversion 1000-day search", () => {
  it(
    "find BTC RSI configs with WR≥55, Sharpe≥1 over 1000d",
    { timeout: 1_800_000 },
    async () => {
      console.log("\n=== ITER 107: BTC RSI mean-reversion search ===");
      const btc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 24000,
      });
      const days = btc.length / 24;
      const barsPerWindow = Math.floor(btc.length / 10);
      console.log(`BTC: ${btc.length} bars = ${days.toFixed(0)} days`);

      const grid: Cfg[] = [];
      for (const rsiBuy of [20, 25, 30, 35]) {
        for (const rsiSell of [65, 70, 75, 80]) {
          for (const tp1 of [0.0015, 0.002, 0.003, 0.005]) {
            for (const tp2Mult of [3, 6]) {
              for (const stop of [0.015, 0.02, 0.03]) {
                for (const hold of [6, 12, 24]) {
                  for (const htfTrend of [true, false]) {
                    for (const pullback of [true, false]) {
                      grid.push({
                        rsiLen: 14,
                        rsiBuy,
                        rsiSell,
                        tp1Pct: tp1,
                        tp2Pct: tp1 * tp2Mult,
                        stopPct: stop,
                        holdBars: hold,
                        htfTrendEnabled: htfTrend,
                        requirePullback: pullback,
                      });
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
        tpd: number;
        sharpe: number;
        pctProf: number;
        minRet: number;
        medWR: number;
      }
      const results: Row[] = [];
      let checked = 0;
      for (const cfg of grid) {
        checked++;
        const trades = run(btc, cfg);
        const n = trades.length;
        if (n < 100) continue;
        const w = trades.filter((t) => t.pnl > 0).length;
        const wr = w / n;
        const pnls = trades.map((t) => t.pnl);
        const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const tpd = n / days;
        if (wr < 0.55 || ret <= 0 || tpd < 0.3) continue;
        const sh = sharpeOf(pnls);
        if (sh < 1.0) continue;
        const perWR: number[] = [];
        const perRet: number[] = [];
        for (let win = 0; win < 10; win++) {
          const startI = win * barsPerWindow;
          const slice = btc.slice(startI, startI + barsPerWindow);
          const t = run(slice, cfg);
          if (t.length > 0)
            perWR.push(t.filter((x) => x.pnl > 0).length / t.length);
          perRet.push(t.reduce((a, x) => a * (1 + x.pnl), 1) - 1);
        }
        const pctProf = perRet.filter((r) => r > 0).length / perRet.length;
        if (pctProf < 0.6) continue;
        const minRet = Math.min(...perRet);
        if (minRet < -0.03) continue;
        const sortedWR = [...perWR].sort();
        const medWR = sortedWR[Math.floor(sortedWR.length / 2)] ?? 0;
        results.push({
          cfg,
          n,
          wr,
          ret,
          tpd,
          sharpe: sh,
          pctProf,
          minRet,
          medWR,
        });
      }
      console.log(`\nChecked ${checked}/${grid.length}`);
      console.log(
        `${results.length} BTC RSI configs pass (WR≥55, Sharpe≥1, pctProf≥60, minRet≥-3%, tpd≥0.3)`,
      );
      if (results.length === 0) {
        console.log(
          "\n✗ NO BTC RSI config survives either.\n" +
            "  Combined with iter105+106: no systematic HF edge exists\n" +
            "  on BTC 1h over 2.7y with any simple trigger (vol-spike, RSI).",
        );
        return;
      }
      console.log(
        "\n── Top 30 by (Sharpe × sqrt(tpd) × pctProf) ──\n" +
          "rsiB".padStart(5) +
          "rsiS".padStart(5) +
          "tp1/tp2".padStart(14) +
          "stop".padStart(6) +
          "h".padStart(4) +
          "htf".padStart(4) +
          "pb".padStart(4) +
          "n".padStart(6) +
          "tpd".padStart(6) +
          "WR%".padStart(7) +
          "ret%".padStart(9) +
          "Shp".padStart(6) +
          "medWR".padStart(7) +
          "%prof".padStart(7) +
          "minRet".padStart(8),
      );
      const sorted = results.sort(
        (a, b) =>
          b.sharpe * Math.sqrt(b.tpd) * b.pctProf -
          a.sharpe * Math.sqrt(a.tpd) * a.pctProf,
      );
      for (const r of sorted.slice(0, 30)) {
        const c = r.cfg;
        console.log(
          c.rsiBuy.toString().padStart(5) +
            c.rsiSell.toString().padStart(5) +
            `${(c.tp1Pct * 100).toFixed(2)}/${(c.tp2Pct * 100).toFixed(2)}`.padStart(
              14,
            ) +
            (c.stopPct * 100).toFixed(1).padStart(6) +
            c.holdBars.toString().padStart(4) +
            (c.htfTrendEnabled ? "Y" : "N").padStart(4) +
            (c.requirePullback ? "Y" : "N").padStart(4) +
            r.n.toString().padStart(6) +
            r.tpd.toFixed(2).padStart(6) +
            (r.wr * 100).toFixed(1).padStart(7) +
            (r.ret * 100).toFixed(1).padStart(9) +
            r.sharpe.toFixed(2).padStart(6) +
            (r.medWR * 100).toFixed(1).padStart(7) +
            (r.pctProf * 100).toFixed(0).padStart(7) +
            (r.minRet * 100).toFixed(1).padStart(8),
        );
      }
    },
  );
});
