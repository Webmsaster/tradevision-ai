/**
 * Iter 158 — 100× leverage daytrade scan.
 *
 * User pushback on iter157: use 100× leverage to bridge the raw-mean gap.
 *
 * Fair re-analysis: iter157's compound-explosion argument assumes
 * COMPOUNDING position sizing. With FIXED-NOTIONAL sizing at 100× leverage,
 * the math becomes:
 *   raw mean 0.25% × 100× = 25% effMean per trade (margin-based)
 *   raw stop 0.3% × 100× = −30% margin per loss (survivable)
 *   raw stop 0.5% × 100× = −50% margin per loss (steep but not liquidation)
 *   raw stop 0.9% × 100× = −90% margin per loss (near-liquidation)
 *   raw stop 1.0% × 100× = LIQUIDATION (100% wipe of margin)
 *
 * So the physical question becomes: does a BTC 1h entry trigger exist with
 *   WR ≥ 70%, raw mean ≥ 0.25%, raw stop ≤ 0.5%, freq ≥ 2/day?
 *
 * This iteration scans a large grid of mean-reversion and breakout triggers
 * with TIGHT tp/stop targets. If any config clears:
 *   • Raw WR ≥ 70%
 *   • Raw mean ≥ 0.25%
 *   • Raw stop ≤ 0.5% (so 100× lev stays below −50% per loss)
 *   • Frequency ≥ 2 per day
 *   • No bankruptcy at 100× leverage on 8.7 years of real data
 *   • bootstrap+ ≥ 90%
 * then we have a valid 3-constraint + 100× solution.
 *
 * Otherwise iter158 proves with real data what iter157 proved mathematically.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

function bootstrap(
  pnls: number[],
  resamples: number,
  blockLen: number,
  seed: number,
): number {
  if (pnls.length < blockLen) return 0;
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
  return rets.filter((r) => r > 0).length / rets.length;
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

type Trigger =
  | { type: "rsi_oversold"; len: number; th: number }
  | { type: "nDown"; n: number }
  | { type: "bbLow"; len: number; k: number }
  | { type: "minDrop"; bars: number; pct: number };

function fires(
  candles: Candle[],
  closes: number[],
  rsi: number[],
  i: number,
  trg: Trigger,
): boolean {
  switch (trg.type) {
    case "rsi_oversold":
      return rsi[i] <= trg.th;
    case "nDown": {
      if (i < trg.n + 1) return false;
      for (let k = 0; k < trg.n; k++) {
        if (closes[i - k] >= closes[i - k - 1]) return false;
      }
      return true;
    }
    case "bbLow": {
      if (i < trg.len) return false;
      const win = closes.slice(i - trg.len, i);
      const m = win.reduce((a, b) => a + b, 0) / win.length;
      const v = win.reduce((a, b) => a + (b - m) * (b - m), 0) / win.length;
      const sd = Math.sqrt(v);
      return candles[i].close <= m - trg.k * sd;
    }
    case "minDrop": {
      if (i < trg.bars + 1) return false;
      const prev = closes[i - trg.bars];
      return prev > 0 && (closes[i] - prev) / prev <= -trg.pct;
    }
  }
}

interface Trade {
  pnl: number;
  exitReason: "tp" | "stop" | "time";
  openIdx: number;
}

function runLong(
  candles: Candle[],
  trg: Trigger,
  tpPct: number,
  stopPct: number,
  hold: number,
  rsiLen = 14,
): Trade[] {
  const closes = candles.map((c) => c.close);
  const rsi = rsiSeries(closes, rsiLen);
  const trades: Trade[] = [];
  let cooldown = -1;
  const start = Math.max(30, rsiLen + 2);
  for (let i = start; i < candles.length - 1; i++) {
    if (i < cooldown) continue;
    if (!fires(candles, closes, rsi, i, trg)) continue;
    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = entry * (1 + tpPct);
    const stop = entry * (1 - stopPct);
    const mx = Math.min(i + 1 + hold, candles.length - 1);
    let exitBar = mx;
    let exitPrice = candles[mx].close;
    let reason: "tp" | "stop" | "time" = "time";
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      if (bar.low <= stop) {
        exitBar = j;
        exitPrice = stop;
        reason = "stop";
        break;
      }
      if (bar.high >= tp) {
        exitBar = j;
        exitPrice = tp;
        reason = "tp";
        break;
      }
    }
    const pnl = applyCosts({
      entry,
      exit: exitPrice,
      direction: "long",
      holdingHours: exitBar - (i + 1),
      config: MAKER_COSTS,
    }).netPnlPct;
    trades.push({ pnl, exitReason: reason, openIdx: i });
    cooldown = exitBar + 1;
  }
  return trades;
}

function applyLeverage(pnls: number[], leverage: number) {
  const effPnls: number[] = [];
  for (const p of pnls) {
    const lev = p * leverage;
    if (lev <= -0.95) effPnls.push(-1.0);
    else effPnls.push(lev);
  }
  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  let bankrupt = false;
  for (const p of effPnls) {
    eq *= 1 + p;
    if (eq <= 0.01) {
      bankrupt = true;
      break;
    }
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  return { effPnls, bankrupt, maxDd, cumRet: bankrupt ? -1 : eq - 1 };
}

function flatNotionalReturn(pnls: number[], leverage: number): number {
  // Additive return assuming fixed position size per trade (no compounding)
  let total = 0;
  for (const p of pnls) {
    const lev = p * leverage;
    total += Math.max(lev, -1.0);
  }
  return total;
}

function meanOf(p: number[]) {
  return p.length === 0 ? 0 : p.reduce((a, b) => a + b, 0) / p.length;
}

describe("iter 158 — 100× leverage daytrade scan", () => {
  it(
    "find BTC 1h entry trigger with raw WR ≥ 70% + raw mean ≥ 0.25% + tight stop",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 158: 100× LEVERAGE DAYTRADE ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });
      const days = c.length / 24;
      console.log(`loaded ${c.length} 1h candles (${days.toFixed(0)} days)`);

      interface ScanRow {
        trgName: string;
        tp: number;
        stop: number;
        hold: number;
        n: number;
        tradesPerDay: number;
        wr: number;
        rawMean: number;
        rawMin: number;
        bsPos: number;
        eff100Mean: number;
        eff100Bankrupt: boolean;
        eff100MaxDd: number;
        flatReturn100: number;
      }
      const results: ScanRow[] = [];

      const triggers: { name: string; trg: Trigger }[] = [
        // RSI oversold variants
        { name: "RSI14≤25", trg: { type: "rsi_oversold", len: 14, th: 25 } },
        { name: "RSI14≤30", trg: { type: "rsi_oversold", len: 14, th: 30 } },
        { name: "RSI7≤25", trg: { type: "rsi_oversold", len: 7, th: 25 } },
        { name: "RSI7≤30", trg: { type: "rsi_oversold", len: 7, th: 30 } },
        { name: "RSI7≤20", trg: { type: "rsi_oversold", len: 7, th: 20 } },
        // n-down streaks
        { name: "3downBars", trg: { type: "nDown", n: 3 } },
        { name: "4downBars", trg: { type: "nDown", n: 4 } },
        { name: "5downBars", trg: { type: "nDown", n: 5 } },
        // BB low
        { name: "BB20 −2σ", trg: { type: "bbLow", len: 20, k: 2 } },
        { name: "BB20 −2.5σ", trg: { type: "bbLow", len: 20, k: 2.5 } },
        { name: "BB40 −2σ", trg: { type: "bbLow", len: 40, k: 2 } },
        // minor drops
        { name: "drop 6b≥1%", trg: { type: "minDrop", bars: 6, pct: 0.01 } },
        { name: "drop 12b≥2%", trg: { type: "minDrop", bars: 12, pct: 0.02 } },
      ];
      const tps = [0.003, 0.005, 0.007, 0.01, 0.015, 0.02];
      const stops = [0.002, 0.003, 0.004, 0.005]; // max 0.5% for 100× safety
      const holds = [2, 4, 8, 12];

      for (const { name, trg } of triggers) {
        for (const tp of tps) {
          for (const stop of stops) {
            for (const hold of holds) {
              const t = runLong(c, trg, tp, stop, hold);
              if (t.length < 50) continue;
              const pnls = t.map((x) => x.pnl);
              const wr = pnls.filter((p) => p > 0).length / pnls.length;
              const rawMean = meanOf(pnls);
              const rawMin = Math.min(...pnls);
              const tradesPerDay = t.length / days;
              const lev100 = applyLeverage(pnls, 100);
              const eff100Mean = meanOf(lev100.effPnls);
              const bs = bootstrap(
                lev100.effPnls,
                100,
                Math.max(3, Math.floor(lev100.effPnls.length / 15)),
                1234,
              );
              const flatReturn100 = flatNotionalReturn(pnls, 100);
              results.push({
                trgName: name,
                tp,
                stop,
                hold,
                n: t.length,
                tradesPerDay,
                wr,
                rawMean,
                rawMin,
                bsPos: bs,
                eff100Mean,
                eff100Bankrupt: lev100.bankrupt,
                eff100MaxDd: lev100.maxDd,
                flatReturn100,
              });
            }
          }
        }
      }
      console.log(`\nTotal configs with n ≥ 50: ${results.length}`);

      // Filter by ALL 3 constraints (+ 100× survivability)
      const passing = results.filter(
        (r) =>
          r.tradesPerDay >= 2 &&
          r.wr >= 0.7 &&
          r.eff100Mean >= 0.25 &&
          !r.eff100Bankrupt &&
          r.bsPos >= 0.9,
      );
      console.log(
        `Configs meeting ALL: 2/day + 70% WR + 25% effMean @100× + alive + bs+ ≥ 90%: **${passing.length}**`,
      );

      if (passing.length > 0) {
        passing.sort((a, b) => b.eff100Mean - a.eff100Mean);
        console.log("\n── Top 15 passing configs ──");
        console.log(
          "trigger          tp    stop  hold    n   /day   WR   rawMean   rawMin   bs+   eff100%   maxDD    flat100Σ",
        );
        for (const r of passing.slice(0, 15)) {
          console.log(
            `${r.trgName.padEnd(16)} ${(r.tp * 100).toFixed(2).padStart(4)}% ${(r.stop * 100).toFixed(2).padStart(4)}%  ${r.hold.toString().padStart(3)}h  ${r.n.toString().padStart(4)} ${r.tradesPerDay.toFixed(2).padStart(4)} ${(r.wr * 100).toFixed(0).padStart(3)}%  ${(r.rawMean * 100).toFixed(3).padStart(6)}% ${(r.rawMin * 100).toFixed(2).padStart(6)}% ${(r.bsPos * 100).toFixed(0).padStart(3)}% ${(r.eff100Mean * 100).toFixed(2).padStart(6)}%  ${(r.eff100MaxDd * 100).toFixed(0).padStart(4)}%  ${(r.flatReturn100 * 100).toFixed(0).padStart(8)}%`,
          );
        }
      } else {
        console.log(
          "\n★ ZERO configs pass all constraints at 100× leverage. Relaxing gates to find nearest-miss ★",
        );
        // Nearest miss: 2/day + WR ≥ 70% + 100×-alive (drop bs+ and effMean requirements)
        const nm1 = results
          .filter(
            (r) => r.tradesPerDay >= 2 && r.wr >= 0.7 && !r.eff100Bankrupt,
          )
          .sort((a, b) => b.eff100Mean - a.eff100Mean)
          .slice(0, 10);
        console.log("\n-- 2/day + WR 70% + alive @100× (best by effMean) --");
        console.log(
          "trigger          tp    stop  hold    n   /day   WR   rawMean   eff100%  maxDD    bs+   flat100Σ",
        );
        for (const r of nm1) {
          console.log(
            `${r.trgName.padEnd(16)} ${(r.tp * 100).toFixed(2).padStart(4)}% ${(r.stop * 100).toFixed(2).padStart(4)}%  ${r.hold.toString().padStart(3)}h  ${r.n.toString().padStart(4)} ${r.tradesPerDay.toFixed(2).padStart(4)} ${(r.wr * 100).toFixed(0).padStart(3)}%  ${(r.rawMean * 100).toFixed(3).padStart(6)}%  ${(r.eff100Mean * 100).toFixed(2).padStart(6)}%  ${(r.eff100MaxDd * 100).toFixed(0).padStart(4)}%  ${(r.bsPos * 100).toFixed(0).padStart(3)}% ${(r.flatReturn100 * 100).toFixed(0).padStart(8)}%`,
          );
        }

        // Nearest miss: high effMean achievable w/ freq ≥ 2/day + alive
        const nm2 = results
          .filter(
            (r) =>
              r.tradesPerDay >= 2 &&
              !r.eff100Bankrupt &&
              r.bsPos >= 0.9 &&
              r.eff100Mean >= 0.1,
          )
          .sort((a, b) => b.eff100Mean - a.eff100Mean)
          .slice(0, 10);
        console.log(
          "\n-- 2/day + effMean ≥ 10% + alive @100× + bs+ ≥ 90% (sacrifice WR) --",
        );
        console.log(
          "trigger          tp    stop  hold    n   /day   WR   rawMean   eff100%  maxDD    bs+   flat100Σ",
        );
        for (const r of nm2) {
          console.log(
            `${r.trgName.padEnd(16)} ${(r.tp * 100).toFixed(2).padStart(4)}% ${(r.stop * 100).toFixed(2).padStart(4)}%  ${r.hold.toString().padStart(3)}h  ${r.n.toString().padStart(4)} ${r.tradesPerDay.toFixed(2).padStart(4)} ${(r.wr * 100).toFixed(0).padStart(3)}%  ${(r.rawMean * 100).toFixed(3).padStart(6)}%  ${(r.eff100Mean * 100).toFixed(2).padStart(6)}%  ${(r.eff100MaxDd * 100).toFixed(0).padStart(4)}%  ${(r.bsPos * 100).toFixed(0).padStart(3)}% ${(r.flatReturn100 * 100).toFixed(0).padStart(8)}%`,
          );
        }
      }

      expect(true).toBe(true);
    },
  );
});
