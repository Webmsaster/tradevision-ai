/**
 * Live Volume-Spike Fade signal (per-symbol).
 *
 * Iter 32 — wires the iter31b walk-forward-validated SOL edge into
 * the live signal engine.
 *
 * Signal trigger (on the latest CLOSED 1h candle):
 *   v_z = vol[i] / median(vol[i-N : i])
 *   p_z = |close[i] - close[i-1]| / std(returns[i-N : i])
 *   if v_z > volMult AND p_z > priceZ:
 *     direction = (last bar UP)? SHORT : LONG     (fade mode)
 *     entry  = current close (mark)
 *     stop   = entry × (1 ± stopPct)
 *     exitAt = closeTime + holdBars × 1h
 *
 * Defaults are the iter31b OOS-best for SOL: v3×p2.0 / 4h / 1.0% stop,
 * lookback 48 bars (2 days).
 *
 * Publishes a stable shape so the UI and signal-journal can consume it
 * without symbol-specific branching.
 */
import type { Candle } from "@/utils/indicators";

export interface VolumeSpikeSignalConfig {
  lookback: number;
  volMult: number;
  priceZ: number;
  holdBars: number;
  stopPct: number;
  mode: "fade" | "momentum";
}

/** SOL OOS-best from iter31b walk-forward validation. */
export const SOL_FADE_CONFIG: VolumeSpikeSignalConfig = {
  lookback: 48,
  volMult: 3,
  priceZ: 2.0,
  holdBars: 4,
  stopPct: 0.01,
  mode: "fade",
};

export interface VolumeSpikeSnapshot {
  symbol: string;
  capturedAt: number;
  active: boolean;
  direction?: "long" | "short";
  vZ: number;
  pZ: number;
  threshold: { volMult: number; priceZ: number };
  entry?: number;
  stop?: number;
  exitAt?: number;
  reason: string;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function stdReturns(closes: number[]): number {
  if (closes.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] <= 0) continue;
    r.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (r.length === 0) return 0;
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}

export function evaluateVolumeSpikeSignal(
  symbol: string,
  candles: Candle[],
  cfg: VolumeSpikeSignalConfig = SOL_FADE_CONFIG,
): VolumeSpikeSnapshot {
  const now = Date.now();
  if (candles.length < cfg.lookback + 2) {
    return {
      symbol,
      capturedAt: now,
      active: false,
      vZ: 0,
      pZ: 0,
      threshold: { volMult: cfg.volMult, priceZ: cfg.priceZ },
      reason: `Insufficient history (need ${cfg.lookback + 2}, have ${candles.length})`,
    };
  }

  const i = candles.length - 1;
  const cur = candles[i];
  const prev = candles[i - 1];
  if (prev.close <= 0) {
    return {
      symbol,
      capturedAt: now,
      active: false,
      vZ: 0,
      pZ: 0,
      threshold: { volMult: cfg.volMult, priceZ: cfg.priceZ },
      reason: "Previous close invalid",
    };
  }

  const window = candles.slice(i - cfg.lookback, i);
  const medVol = median(window.map((c) => c.volume));
  const vZ = medVol > 0 ? cur.volume / medVol : 0;
  const sd = stdReturns(window.map((c) => c.close));
  const ret = (cur.close - prev.close) / prev.close;
  const pZ = sd > 0 ? Math.abs(ret) / sd : 0;

  const volPass = vZ >= cfg.volMult;
  const pricePass = pZ >= cfg.priceZ;

  if (!volPass || !pricePass) {
    return {
      symbol,
      capturedAt: now,
      active: false,
      vZ,
      pZ,
      threshold: { volMult: cfg.volMult, priceZ: cfg.priceZ },
      reason: `No spike (vZ=${vZ.toFixed(2)}/${cfg.volMult}, pZ=${pZ.toFixed(2)}/${cfg.priceZ})`,
    };
  }

  const direction: "long" | "short" =
    cfg.mode === "fade"
      ? ret > 0
        ? "short"
        : "long"
      : ret > 0
        ? "long"
        : "short";
  const entry = cur.close;
  const stop =
    direction === "long"
      ? entry * (1 - cfg.stopPct)
      : entry * (1 + cfg.stopPct);
  const exitAt = cur.closeTime + cfg.holdBars * 60 * 60 * 1000;

  return {
    symbol,
    capturedAt: now,
    active: true,
    direction,
    vZ,
    pZ,
    threshold: { volMult: cfg.volMult, priceZ: cfg.priceZ },
    entry,
    stop,
    exitAt,
    reason: `Volume ${vZ.toFixed(1)}× median + price ${pZ.toFixed(1)}σ ${ret > 0 ? "UP" : "DOWN"} → fade ${direction.toUpperCase()}`,
  };
}
