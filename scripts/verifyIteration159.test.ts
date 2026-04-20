/**
 * Iter 159 — 100× leverage frontier: what ACTUALLY survives?
 *
 * iter158 showed 0/1248 configs pass 3-constraint + 100× + bs+90%.
 * Nearest-miss tables were also empty, which means:
 *   - Either no config has freq ≥ 2/day AND WR ≥ 70% AND alive @100×
 *   - Or even WR-drop tables produce nothing
 *
 * This iteration loosens all filters to map the true 100× frontier:
 *   A) Best WR achievable at freq ≥ 2/day, alive @100×
 *   B) Best effMean achievable at freq ≥ 2/day, alive @100×
 *   C) Best freq achievable at WR ≥ 70%, alive @100×
 *   D) Minimum leverage at which a 70% WR 2/day config survives
 *
 * Plus: simulate fixed-notional sizing (user's "hunderter hebel" is likely
 * combined with fixed-risk position sizing, not compound). That changes the
 * survivability math meaningfully.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

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
  | { type: "bbLow"; len: number; k: number };

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
  }
}

interface Trade {
  pnl: number;
  exitReason: "tp" | "stop" | "time";
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
    trades.push({ pnl, exitReason: reason });
    cooldown = exitBar + 1;
  }
  return trades;
}

/** Compounded simulation — each trade grows/shrinks equity. Bankrupt at <1%. */
function compoundSim(pnls: number[], leverage: number) {
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

/**
 * Fixed-notional simulation with fixed-fraction-risk sizing.
 * Per trade: risk r% of equity. At 100× leverage, margin = r% of equity,
 * notional = r × 100 × equity. PnL = raw_pnl × notional = raw_pnl × r × 100 × eq.
 * Equity update additive but expressed as fraction.
 */
function fixedRiskSim(pnls: number[], leverage: number, riskFrac: number) {
  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  let bankrupt = false;
  for (const p of pnls) {
    const ret = p * leverage * riskFrac;
    const cappedRet = Math.max(ret, -riskFrac); // margin cap: can't lose more than staked margin
    eq *= 1 + cappedRet;
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

describe("iter 159 — 100× leverage frontier mapping", () => {
  it(
    "map true frontier with loose filters + fixed-risk sizing",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 159: 100× FRONTIER MAP ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });
      const days = c.length / 24;
      console.log(`loaded ${c.length} 1h candles (${days.toFixed(0)} days)`);

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
        compound100: { cumRet: number; maxDd: number; bankrupt: boolean };
        fixed100_2pct: { cumRet: number; maxDd: number; bankrupt: boolean };
        fixed100_1pct: { cumRet: number; maxDd: number; bankrupt: boolean };
      }
      const results: Row[] = [];
      const triggers: { name: string; trg: Trigger }[] = [
        { name: "RSI14≤25", trg: { type: "rsi_oversold", len: 14, th: 25 } },
        { name: "RSI14≤30", trg: { type: "rsi_oversold", len: 14, th: 30 } },
        { name: "RSI14≤35", trg: { type: "rsi_oversold", len: 14, th: 35 } },
        { name: "RSI7≤25", trg: { type: "rsi_oversold", len: 7, th: 25 } },
        { name: "RSI7≤30", trg: { type: "rsi_oversold", len: 7, th: 30 } },
        { name: "RSI7≤35", trg: { type: "rsi_oversold", len: 7, th: 35 } },
        { name: "RSI7≤20", trg: { type: "rsi_oversold", len: 7, th: 20 } },
        { name: "3down", trg: { type: "nDown", n: 3 } },
        { name: "4down", trg: { type: "nDown", n: 4 } },
        { name: "5down", trg: { type: "nDown", n: 5 } },
        { name: "BB20 −2σ", trg: { type: "bbLow", len: 20, k: 2 } },
        { name: "BB20 −1.5σ", trg: { type: "bbLow", len: 20, k: 1.5 } },
      ];
      for (const { name, trg } of triggers) {
        for (const tp of [0.002, 0.003, 0.004, 0.005, 0.007, 0.01]) {
          for (const stop of [0.002, 0.003, 0.004, 0.005, 0.007]) {
            for (const hold of [2, 4, 8]) {
              const t = runLong(c, trg, tp, stop, hold);
              if (t.length < 50) continue;
              const pnls = t.map((x) => x.pnl);
              const wr = pnls.filter((p) => p > 0).length / pnls.length;
              const m = meanOf(pnls);
              const min = Math.min(...pnls);
              const perDay = t.length / days;
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
                compound100: compoundSim(pnls, 100),
                fixed100_2pct: fixedRiskSim(pnls, 100, 0.02),
                fixed100_1pct: fixedRiskSim(pnls, 100, 0.01),
              });
            }
          }
        }
      }
      console.log(`Scanned ${results.length} configs.\n`);

      // Question A: Best WR achievable at freq ≥ 2/day (no leverage-alive filter)
      const aFiltered = results.filter((r) => r.perDay >= 2);
      console.log(
        `-- A: Configs with freq ≥ 2/day: ${aFiltered.length} total --`,
      );
      const topA = aFiltered.sort((a, b) => b.wr - a.wr).slice(0, 5);
      console.log(
        "trg              tp    stop  hold    n   /day   WR   rawMean   compound100  fixed100@1%",
      );
      for (const r of topA) {
        console.log(
          `${r.trg.padEnd(12)} ${(r.tp * 100).toFixed(2).padStart(4)}% ${(r.stop * 100).toFixed(2).padStart(4)}%  ${r.hold.toString().padStart(3)}h  ${r.n.toString().padStart(4)} ${r.perDay.toFixed(2).padStart(4)} ${(r.wr * 100).toFixed(0).padStart(3)}%  ${(r.rawMean * 100).toFixed(3).padStart(6)}%  ${r.compound100.bankrupt ? "BANKRUPT" : (r.compound100.cumRet * 100).toFixed(0).padStart(8) + "%"}  ${r.fixed100_1pct.bankrupt ? "BANKRUPT" : (r.fixed100_1pct.cumRet * 100).toFixed(0).padStart(8) + "%"}`,
        );
      }

      // Question B: Best effMean at freq ≥ 2/day, alive @100× compound
      const bFiltered = results.filter(
        (r) => r.perDay >= 2 && !r.compound100.bankrupt,
      );
      console.log(
        `\n-- B: freq ≥ 2/day + NOT bankrupt @100× compound: ${bFiltered.length} --`,
      );
      const topB = bFiltered
        .sort((a, b) => b.rawMean * 100 - a.rawMean * 100)
        .slice(0, 10);
      console.log(
        "trg              tp    stop  hold    n   /day   WR   rawMean   eff100Σ",
      );
      for (const r of topB) {
        console.log(
          `${r.trg.padEnd(12)} ${(r.tp * 100).toFixed(2).padStart(4)}% ${(r.stop * 100).toFixed(2).padStart(4)}%  ${r.hold.toString().padStart(3)}h  ${r.n.toString().padStart(4)} ${r.perDay.toFixed(2).padStart(4)} ${(r.wr * 100).toFixed(0).padStart(3)}%  ${(r.rawMean * 100).toFixed(3).padStart(6)}%  ${(r.compound100.cumRet * 100).toFixed(0).padStart(8)}%`,
        );
      }

      // Question C: Fixed-risk sizing at 1% — much more survivable
      console.log(
        `\n-- C: freq ≥ 2/day + FIXED-RISK 1% @100× (not bankrupt + cumRet>0) --`,
      );
      const cFiltered = results.filter(
        (r) =>
          r.perDay >= 2 &&
          !r.fixed100_1pct.bankrupt &&
          r.fixed100_1pct.cumRet > 0,
      );
      console.log(`  ${cFiltered.length} configs.`);
      const topC = cFiltered
        .sort((a, b) => b.fixed100_1pct.cumRet - a.fixed100_1pct.cumRet)
        .slice(0, 10);
      console.log(
        "trg              tp    stop  hold    n   /day   WR   rawMean   fixed1%Σ  maxDD",
      );
      for (const r of topC) {
        console.log(
          `${r.trg.padEnd(12)} ${(r.tp * 100).toFixed(2).padStart(4)}% ${(r.stop * 100).toFixed(2).padStart(4)}%  ${r.hold.toString().padStart(3)}h  ${r.n.toString().padStart(4)} ${r.perDay.toFixed(2).padStart(4)} ${(r.wr * 100).toFixed(0).padStart(3)}%  ${(r.rawMean * 100).toFixed(3).padStart(6)}%  ${(r.fixed100_1pct.cumRet * 100).toFixed(0).padStart(8)}%  ${(r.fixed100_1pct.maxDd * 100).toFixed(0).padStart(4)}%`,
        );
      }

      // Question D: what's the absolute best 70%+ WR config at any freq?
      const dFiltered = results.filter((r) => r.wr >= 0.7 && r.n >= 30);
      console.log(
        `\n-- D: Any WR ≥ 70% (regardless of freq): ${dFiltered.length} --`,
      );
      const topD = dFiltered.sort((a, b) => b.perDay - a.perDay).slice(0, 8);
      console.log(
        "trg              tp    stop  hold    n   /day   WR   rawMean   compound100  fixed100@1%",
      );
      for (const r of topD) {
        console.log(
          `${r.trg.padEnd(12)} ${(r.tp * 100).toFixed(2).padStart(4)}% ${(r.stop * 100).toFixed(2).padStart(4)}%  ${r.hold.toString().padStart(3)}h  ${r.n.toString().padStart(4)} ${r.perDay.toFixed(2).padStart(4)} ${(r.wr * 100).toFixed(0).padStart(3)}%  ${(r.rawMean * 100).toFixed(3).padStart(6)}%  ${r.compound100.bankrupt ? "BANKRUPT" : (r.compound100.cumRet * 100).toFixed(0).padStart(8) + "%"}  ${r.fixed100_1pct.bankrupt ? "BANKRUPT" : (r.fixed100_1pct.cumRet * 100).toFixed(0).padStart(8) + "%"}`,
        );
      }

      // Final feasibility: triple pass at 100× fixed-1%
      const tripleFixed = results.filter(
        (r) =>
          r.perDay >= 2 &&
          r.wr >= 0.7 &&
          !r.fixed100_1pct.bankrupt &&
          r.fixed100_1pct.cumRet > 0 &&
          r.rawMean * 100 >= 0.25,
      );
      console.log(
        `\n★ TRIPLE PASS (2/day, 70% WR, ≥25% effMean) @100× fixed-risk-1%: ${tripleFixed.length} configs ★`,
      );
      if (tripleFixed.length > 0) {
        tripleFixed.sort((a, b) => b.rawMean - a.rawMean);
        for (const r of tripleFixed.slice(0, 5)) {
          console.log(
            `  ${r.trg} tp=${(r.tp * 100).toFixed(2)}% s=${(r.stop * 100).toFixed(2)}% h=${r.hold}h → n=${r.n} ${r.perDay.toFixed(2)}/d WR=${(r.wr * 100).toFixed(0)}% rawMean=${(r.rawMean * 100).toFixed(3)}% → @100× compound: ${(r.compound100.cumRet * 100).toFixed(0)}% cumRet`,
          );
        }
      }

      expect(true).toBe(true);
    },
  );
});
