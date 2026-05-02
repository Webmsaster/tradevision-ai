/**
 * Volume-Spike Fade strategy.
 *
 * Iter 31 hypothesis: extreme 1h volume spikes (>K× rolling median) accompanied
 * by an outsized price move (>P× rolling close-to-close std) indicate panic
 * liquidations / news shock. Liquidity overshoot mean-reverts within
 * 4-12 hours.
 *
 * Signal:
 *   v_z = volume[i] / median(volume[i-N : i])
 *   p_z = |close[i] - close[i-1]| / std(returns[i-N : i])
 *   If v_z > volMult AND p_z > priceZ:
 *     enter FADE direction at next bar open (long if last bar was DOWN, short if UP)
 *     hold for H bars or stop-out
 *
 * Costs applied via standard cost model.
 */
import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";

export interface VolumeSpikeFadeConfig {
  lookback: number; // window for median volume + return std (e.g. 48 = 2 days)
  volMult: number; // 5.0 = volume must exceed 5× rolling median
  priceZ: number; // 2.5 = price move must exceed 2.5σ
  holdBars: number; // 6
  stopPct: number; // 0.012
  costs?: CostConfig;
  longOnly?: boolean;
  shortOnly?: boolean;
  /**
   * "fade"     → trade against the spike (up-spike → short, down-spike → long).
   *               Works on retail-heavy assets where spikes = panic/liquidation.
   * "momentum" → trade with the spike (up-spike → long, down-spike → short).
   *               Works on institution-heavy assets where spikes = real news flow.
   */
  mode?: "fade" | "momentum";
}

export const DEFAULT_VS_FADE: VolumeSpikeFadeConfig = {
  lookback: 48,
  volMult: 5,
  priceZ: 2.5,
  holdBars: 6,
  stopPct: 0.012,
};

export interface VolumeFadeTrade {
  entryTime: number;
  exitTime: number;
  direction: "long" | "short";
  entry: number;
  exit: number;
  triggerVZ: number;
  triggerPZ: number;
  netPnlPct: number;
  exitReason: "time" | "stop";
}

export interface VolumeFadeReport {
  trades: VolumeFadeTrade[];
  signalsFired: number;
  netReturnPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[m - 1]! + sorted[m]!) / 2
    : sorted[m];
}

function stdReturns(closes: number[]): number {
  if (closes.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const r = (closes[i]! - closes[i - 1]!) / closes[i - 1]!;
    rets.push(r);
  }
  const m = rets.reduce((s, v) => s + v, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - m) * (x - m), 0) / rets.length;
  return Math.sqrt(v);
}

export function runVolumeSpikeFade(
  candles: Candle[],
  cfg: VolumeSpikeFadeConfig = DEFAULT_VS_FADE,
): VolumeFadeReport {
  const costs = cfg.costs ?? DEFAULT_COSTS;
  const trades: VolumeFadeTrade[] = [];
  let signalsFired = 0;

  for (let i = cfg.lookback; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (prev!.close <= 0) continue;
    const window = candles.slice(i - cfg.lookback, i);
    const medVol = median(window.map((c) => c.volume));
    if (medVol <= 0) continue;
    const vZ = cur!.volume / medVol;
    if (vZ < cfg.volMult) continue;

    const sd = stdReturns(window.map((c) => c.close));
    if (sd <= 0) continue;
    const ret = (cur!.close - prev!.close) / prev!.close;
    const pZ = Math.abs(ret) / sd;
    if (pZ < cfg.priceZ) continue;
    signalsFired++;

    const mode = cfg.mode ?? "fade";
    const direction: "long" | "short" =
      mode === "fade"
        ? ret > 0
          ? "short"
          : "long"
        : ret > 0
          ? "long"
          : "short";
    if (cfg.longOnly && direction === "short") continue;
    if (cfg.shortOnly && direction === "long") continue;

    const entryBar = candles[i + 1];
    if (!entryBar) break;
    const entry = entryBar.open;
    const stopLevel =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);

    let exitIdx = i + 1 + cfg.holdBars;
    if (exitIdx >= candles.length) exitIdx = candles.length - 1;
    let exitReason: VolumeFadeTrade["exitReason"] = "time";
    let exitPrice = candles[exitIdx]!.close;

    for (let j = i + 2; j <= exitIdx; j++) {
      const bar = candles[j];
      if (direction === "long" && bar!.low <= stopLevel) {
        exitIdx = j;
        exitPrice = stopLevel;
        exitReason = "stop";
        break;
      }
      if (direction === "short" && bar!.high >= stopLevel) {
        exitIdx = j;
        exitPrice = stopLevel;
        exitReason = "stop";
        break;
      }
    }

    const cost = applyCosts({
      entry,
      exit: exitPrice,
      direction,
      holdingHours: exitIdx - (i + 1),
      config: costs,
    });
    trades.push({
      entryTime: entryBar.openTime,
      exitTime: candles[exitIdx]!.openTime,
      direction,
      entry,
      exit: exitPrice,
      triggerVZ: vZ,
      triggerPZ: pZ,
      netPnlPct: cost.netPnlPct,
      exitReason,
    });
    i = exitIdx;
  }

  const returns = trades.map((t) => t.netPnlPct);
  const netRet = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const winRate = returns.length > 0 ? wins / returns.length : 0;
  const grossW = returns.filter((r) => r > 0).reduce((s, vv) => s + vv, 0);
  const grossL = Math.abs(
    returns.filter((r) => r < 0).reduce((s, vv) => s + vv, 0),
  );
  const pf = grossL > 0 ? grossW / grossL : Infinity;
  const m = returns.reduce((s, vv) => s + vv, 0) / Math.max(1, returns.length);
  const v =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const sd = Math.sqrt(v);
  const periodDays =
    trades.length > 0
      ? (trades[trades.length - 1]!.exitTime - trades[0]!.entryTime) / 86400000
      : 30;
  const perYear = periodDays > 0 ? (trades.length / periodDays) * 365 : 0;
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(perYear) : 0;

  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1]! * (1 + r));
  let peak = 1,
    maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trades,
    signalsFired,
    netReturnPct: netRet,
    winRate,
    profitFactor: pf === Infinity ? 999 : pf,
    sharpe,
    maxDrawdownPct: maxDd,
  };
}
