/**
 * Iter 160 — 15m bars + 100× leverage scan for 2-3/day + 70% WR + 25% mean.
 *
 * iter158-159 showed on 1h BTC bars zero configs meet freq ≥ 2/day because
 * oscillator triggers (RSI, BB, nDown) fire too rarely. On 15m bars the
 * same triggers fire 4× more often → 2/day becomes reachable.
 *
 * This iter loads BTC 15m data (~8.7 years worth, ~300k candles) and scans
 * loose triggers with TIGHT tp/stop targets designed for 100× leverage.
 *
 * Also reports at each leverage level so user can see the trade-off between
 * leverage and survivability.
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
  | { type: "rsi_os"; len: number; th: number }
  | { type: "nDown"; n: number }
  | { type: "bbLow"; len: number; k: number };

function fires(
  candles: Candle[],
  closes: number[],
  rsi: number[],
  i: number,
  trg: Trigger,
): boolean {
  switch (trg.type) {
    case "rsi_os":
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
  }
}

interface Trade {
  pnl: number;
  exitReason: "tp" | "stop" | "time";
  holdBars: number;
}

function runLong(
  candles: Candle[],
  trg: Trigger,
  tpPct: number,
  stopPct: number,
  holdBars: number,
  barsPerHour: number,
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
    const mx = Math.min(i + 1 + holdBars, candles.length - 1);
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
      holdingHours: (exitBar - (i + 1)) / barsPerHour,
      config: MAKER_COSTS,
    }).netPnlPct;
    trades.push({ pnl, exitReason: reason, holdBars: exitBar - (i + 1) });
    cooldown = exitBar + 1;
  }
  return trades;
}

function compound(pnls: number[], leverage: number) {
  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  let bankrupt = false;
  for (const p of pnls) {
    const lev = Math.max(p * leverage, -1.0);
    eq *= 1 + lev;
    if (eq <= 0.01) {
      bankrupt = true;
      break;
    }
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  return { cumRet: bankrupt ? -1 : eq - 1, maxDd, bankrupt };
}

function meanOf(p: number[]) {
  return p.length === 0 ? 0 : p.reduce((a, b) => a + b, 0) / p.length;
}

describe("iter 160 — 15m × 100× leverage scan", () => {
  it(
    "find 15m daytrade configs reaching 2/day + 70% WR + 25% eff @100×",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 160: 15m + 100× ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "15m",
        targetCount: 100_000, // ~1042 days
        maxPages: 200,
      });
      const days = c.length / 96; // 96 15m bars per day
      const barsPerHour = 4;
      console.log(`loaded ${c.length} 15m candles (${days.toFixed(0)} days)`);

      interface Row {
        trg: string;
        tp: number;
        stop: number;
        hold: number;
        n: number;
        perDay: number;
        wr: number;
        rawMean: number;
        rawMin: number;
        bsPos: number;
        l10: ReturnType<typeof compound>;
        l25: ReturnType<typeof compound>;
        l50: ReturnType<typeof compound>;
        l100: ReturnType<typeof compound>;
      }
      const results: Row[] = [];

      const triggers: { name: string; trg: Trigger }[] = [
        { name: "RSI14≤25", trg: { type: "rsi_os", len: 14, th: 25 } },
        { name: "RSI14≤30", trg: { type: "rsi_os", len: 14, th: 30 } },
        { name: "RSI14≤35", trg: { type: "rsi_os", len: 14, th: 35 } },
        { name: "RSI14≤40", trg: { type: "rsi_os", len: 14, th: 40 } },
        { name: "RSI7≤25", trg: { type: "rsi_os", len: 7, th: 25 } },
        { name: "RSI7≤30", trg: { type: "rsi_os", len: 7, th: 30 } },
        { name: "RSI7≤35", trg: { type: "rsi_os", len: 7, th: 35 } },
        { name: "3down", trg: { type: "nDown", n: 3 } },
        { name: "4down", trg: { type: "nDown", n: 4 } },
        { name: "BB20 −2σ", trg: { type: "bbLow", len: 20, k: 2 } },
        { name: "BB20 −1.5σ", trg: { type: "bbLow", len: 20, k: 1.5 } },
        { name: "BB40 −2σ", trg: { type: "bbLow", len: 40, k: 2 } },
      ];
      const tps = [0.002, 0.003, 0.004, 0.005, 0.007, 0.01];
      const stops = [0.002, 0.003, 0.004, 0.005, 0.007];
      // hold in 15m bars: 4=1h, 8=2h, 16=4h, 32=8h
      const holds = [4, 8, 16, 32];

      for (const { name, trg } of triggers) {
        for (const tp of tps) {
          for (const stop of stops) {
            for (const hold of holds) {
              const t = runLong(c, trg, tp, stop, hold, barsPerHour);
              if (t.length < 100) continue;
              const pnls = t.map((x) => x.pnl);
              const wr = pnls.filter((p) => p > 0).length / pnls.length;
              const m = meanOf(pnls);
              const min = Math.min(...pnls);
              const perDay = t.length / days;
              const l10 = compound(pnls, 10);
              const l25 = compound(pnls, 25);
              const l50 = compound(pnls, 50);
              const l100 = compound(pnls, 100);
              const bs = bootstrap(
                pnls,
                100,
                Math.max(3, Math.floor(pnls.length / 15)),
                1234,
              );
              results.push({
                trg: name,
                tp,
                stop,
                hold,
                n: t.length,
                perDay,
                wr,
                rawMean: m,
                rawMin: min,
                bsPos: bs,
                l10,
                l25,
                l50,
                l100,
              });
            }
          }
        }
      }
      console.log(`Scanned ${results.length} configs with n ≥ 100`);

      // Distribution overview
      const byFreq = [...results].sort((a, b) => b.perDay - a.perDay);
      console.log(
        `Max perDay seen: ${byFreq[0]?.perDay.toFixed(2)} (${byFreq[0]?.trg} tp=${((byFreq[0]?.tp || 0) * 100).toFixed(2)}% s=${((byFreq[0]?.stop || 0) * 100).toFixed(2)}% h=${byFreq[0]?.hold})`,
      );
      const freq2plus = results.filter((r) => r.perDay >= 2);
      const freq1plus = results.filter((r) => r.perDay >= 1);
      console.log(
        `Configs ≥ 1/day: ${freq1plus.length}, ≥ 2/day: ${freq2plus.length}`,
      );
      const wr70 = results.filter((r) => r.wr >= 0.7);
      console.log(`Configs WR ≥ 70%: ${wr70.length}`);
      const both = results.filter((r) => r.perDay >= 2 && r.wr >= 0.7);
      console.log(`Configs ≥ 2/day AND WR ≥ 70%: ${both.length}`);

      // Main filter: all 3 constraints + 100× alive
      const triple100 = results.filter(
        (r) =>
          r.perDay >= 2 &&
          r.wr >= 0.7 &&
          !r.l100.bankrupt &&
          r.rawMean >= 0.0025,
      );
      console.log(
        `\n★ TRIPLE @100× (≥2/day + ≥70% WR + ≥0.25% rawMean + alive): ${triple100.length} ★`,
      );
      if (triple100.length > 0) {
        triple100.sort((a, b) => b.rawMean - a.rawMean);
        console.log(
          "trg          tp    stop  h(15m)   n   /day   WR   rawMean   min   bs+   cum100%   DD100",
        );
        for (const r of triple100.slice(0, 15)) {
          console.log(
            `${r.trg.padEnd(11)} ${(r.tp * 100).toFixed(2).padStart(4)}% ${(r.stop * 100).toFixed(2).padStart(4)}% ${r.hold.toString().padStart(4)}b  ${r.n.toString().padStart(5)} ${r.perDay.toFixed(2).padStart(4)} ${(r.wr * 100).toFixed(0).padStart(3)}%  ${(r.rawMean * 100).toFixed(3).padStart(6)}% ${(r.rawMin * 100).toFixed(2).padStart(5)}% ${(r.bsPos * 100).toFixed(0).padStart(3)}% ${(r.l100.cumRet * 100).toExponential(2).padStart(9)}  ${(r.l100.maxDd * 100).toFixed(0).padStart(4)}%`,
          );
        }
      }

      // Weaker "triple" with lower leverage surviving
      console.log(
        `\n-- Same triple at lower leverage (find min leverage that survives) --`,
      );
      const triple10 = results.filter(
        (r) =>
          r.perDay >= 2 &&
          r.wr >= 0.7 &&
          !r.l10.bankrupt &&
          r.rawMean >= 0.0025,
      );
      const triple25 = results.filter(
        (r) =>
          r.perDay >= 2 &&
          r.wr >= 0.7 &&
          !r.l25.bankrupt &&
          r.rawMean >= 0.0025,
      );
      const triple50 = results.filter(
        (r) =>
          r.perDay >= 2 &&
          r.wr >= 0.7 &&
          !r.l50.bankrupt &&
          r.rawMean >= 0.0025,
      );
      console.log(
        `@10× alive: ${triple10.length}, @25× alive: ${triple25.length}, @50× alive: ${triple50.length}, @100× alive: ${triple100.length}`,
      );

      if (triple50.length > 0) {
        const best = triple50.slice().sort((a, b) => b.rawMean - a.rawMean)[0];
        console.log(
          `Best triple @50×: ${best.trg} tp=${(best.tp * 100).toFixed(2)}% s=${(best.stop * 100).toFixed(2)}% h=${best.hold}b → n=${best.n} ${best.perDay.toFixed(2)}/d WR=${(best.wr * 100).toFixed(0)}% rawMean=${(best.rawMean * 100).toFixed(3)}% effMean@50×=${(best.rawMean * 50 * 100).toFixed(1)}% cum50=${(best.l50.cumRet * 100).toFixed(0)}% DD=${(best.l50.maxDd * 100).toFixed(0)}%`,
        );
      }

      expect(true).toBe(true);
    },
  );
});
