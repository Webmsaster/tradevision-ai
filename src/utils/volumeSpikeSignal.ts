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

export interface LockedEdge {
  symbol: string;
  cfg: VolumeSpikeSignalConfig;
  /** Bootstrap median Sharpe across 10 chronological + block-bootstrap splits (iter34). */
  medianOosSharpe: number;
  /** Worst Sharpe across the same 10 splits (iter34). */
  minOosSharpe: number;
  /** % of bootstrap splits that finished profitable (iter34). */
  pctProfitable: number;
  /** Recommended portfolio weight (inverse-vol from iter41 — best Sharpe 4.17). */
  recommendedWeight: number;
}

/**
 * Iter 34 production-locked edges. Each passed:
 *   median Sharpe ≥ 1.0 AND min Sharpe ≥ 0.0 AND ≥80% of splits profitable
 * across 10 walk-forward / block-bootstrap windows.
 */
export const LOCKED_EDGES: LockedEdge[] = [
  {
    symbol: "AVAXUSDT",
    cfg: {
      lookback: 48,
      volMult: 5,
      priceZ: 2.5,
      holdBars: 6,
      stopPct: 0.012,
      mode: "momentum",
    },
    medianOosSharpe: 2.92,
    minOosSharpe: 0.42,
    pctProfitable: 1.0,
    recommendedWeight: 0.161,
  },
  {
    symbol: "SUIUSDT",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      holdBars: 6,
      stopPct: 0.012,
      mode: "momentum",
    },
    medianOosSharpe: 2.83,
    minOosSharpe: 1.12,
    pctProfitable: 1.0,
    recommendedWeight: 0.093,
  },
  {
    symbol: "SOLUSDT",
    cfg: { ...SOL_FADE_CONFIG },
    medianOosSharpe: 2.35,
    minOosSharpe: 0.08,
    pctProfitable: 0.9,
    recommendedWeight: 0.176,
  },
  {
    symbol: "AVAXUSDT_FADE",
    cfg: {
      lookback: 48,
      volMult: 5,
      priceZ: 2.0,
      holdBars: 4,
      stopPct: 0.01,
      mode: "fade",
    },
    medianOosSharpe: 2.27,
    minOosSharpe: 0.44,
    pctProfitable: 1.0,
    recommendedWeight: 0.205,
  },
  {
    symbol: "APTUSDT",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      holdBars: 4,
      stopPct: 0.01,
      mode: "momentum",
    },
    medianOosSharpe: 1.99,
    minOosSharpe: 1.38,
    pctProfitable: 1.0,
    recommendedWeight: 0.107,
  },
  {
    symbol: "INJUSDT",
    cfg: {
      lookback: 48,
      volMult: 4,
      priceZ: 2.0,
      holdBars: 6,
      stopPct: 0.012,
      mode: "momentum",
    },
    medianOosSharpe: 1.75,
    minOosSharpe: 1.05,
    pctProfitable: 1.0,
    recommendedWeight: 0.105,
  },
  {
    symbol: "NEARUSDT",
    cfg: {
      lookback: 48,
      volMult: 3,
      priceZ: 2.0,
      holdBars: 4,
      stopPct: 0.01,
      mode: "fade",
    },
    medianOosSharpe: 1.05,
    minOosSharpe: 0.06,
    pctProfitable: 0.9,
    recommendedWeight: 0.152,
  },
];

/**
 * Resolve a "real" Binance symbol from a LOCKED_EDGES key. We sometimes use
 * synthetic suffixes like "AVAXUSDT_FADE" to register two strategies on the
 * same coin (different parameter sets / modes). The fetch always uses the
 * stripped symbol.
 */
export function lockedEdgeBinanceSymbol(key: string): string {
  return key.replace(/_FADE$|_MOM$/, "");
}

export interface VolumeSpikeSnapshot {
  /** Either a real Binance symbol (e.g. "SOLUSDT") or a synthetic locked-edge
   *  key (e.g. "AVAXUSDT_FADE"). UI should display via `displayLabel`. */
  symbol: string;
  /** UI label (e.g. "AVAX (fade)"). */
  displayLabel: string;
  mode: "fade" | "momentum";
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
  /** Lifetime stats from iter34 bootstrap (only set when called via LOCKED_EDGES). */
  edgeMeta?: {
    medianOosSharpe: number;
    minOosSharpe: number;
    pctProfitable: number;
    /** Recommended portfolio weight (inverse-vol — iter41). */
    recommendedWeight: number;
  };
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m];
}

function stdReturns(closes: number[]): number {
  if (closes.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1]! <= 0) continue;
    r.push((closes[i]! - closes[i - 1]!) / closes[i - 1]!);
  }
  if (r.length === 0) return 0;
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}

function buildLabel(symbol: string, mode: "fade" | "momentum"): string {
  const base = lockedEdgeBinanceSymbol(symbol).replace(/USDT$/, "");
  return `${base} (${mode})`;
}

export interface EvaluateOptions {
  cfg?: VolumeSpikeSignalConfig;
  edgeMeta?: VolumeSpikeSnapshot["edgeMeta"];
  /** Override displayLabel (defaults to "<base> (<mode>)"). */
  displayLabel?: string;
}

export function evaluateVolumeSpikeSignal(
  symbol: string,
  candles: Candle[],
  optionsOrCfg: EvaluateOptions | VolumeSpikeSignalConfig = SOL_FADE_CONFIG,
): VolumeSpikeSnapshot {
  // Allow legacy 3-arg call with raw cfg.
  const opts: EvaluateOptions =
    "cfg" in optionsOrCfg ||
    "edgeMeta" in optionsOrCfg ||
    "displayLabel" in optionsOrCfg
      ? (optionsOrCfg as EvaluateOptions)
      : { cfg: optionsOrCfg as VolumeSpikeSignalConfig };
  const cfg = opts.cfg ?? SOL_FADE_CONFIG;
  const displayLabel = opts.displayLabel ?? buildLabel(symbol, cfg.mode);
  const edgeMeta = opts.edgeMeta;
  const now = Date.now();
  const base = {
    symbol,
    displayLabel,
    mode: cfg.mode,
    capturedAt: now,
    threshold: { volMult: cfg.volMult, priceZ: cfg.priceZ },
    edgeMeta,
  };
  if (candles.length < cfg.lookback + 2) {
    return {
      ...base,
      active: false,
      vZ: 0,
      pZ: 0,
      reason: `Insufficient history (need ${cfg.lookback + 2}, have ${candles.length})`,
    };
  }

  const i = candles.length - 1;
  const cur = candles[i];
  const prev = candles[i - 1];
  if (prev!.close <= 0) {
    return {
      ...base,
      active: false,
      vZ: 0,
      pZ: 0,
      reason: "Previous close invalid",
    };
  }

  const window = candles.slice(i - cfg.lookback, i);
  const medVol = median(window.map((c) => c.volume));
  const vZ = medVol > 0 ? cur!.volume / medVol : 0;
  const sd = stdReturns(window.map((c) => c.close));
  const ret = (cur!.close - prev!.close) / prev!.close;
  const pZ = sd > 0 ? Math.abs(ret) / sd : 0;

  const volPass = vZ >= cfg.volMult;
  const pricePass = pZ >= cfg.priceZ;

  if (!volPass || !pricePass) {
    return {
      ...base,
      active: false,
      vZ,
      pZ,
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
  const entry = cur!.close;
  const stop =
    direction === "long"
      ? entry * (1 - cfg.stopPct)
      : entry * (1 + cfg.stopPct);
  const exitAt = cur!.closeTime + cfg.holdBars * 60 * 60 * 1000;

  return {
    ...base,
    active: true,
    direction,
    vZ,
    pZ,
    entry,
    stop,
    exitAt,
    reason: `Volume ${vZ.toFixed(1)}× median + price ${pZ.toFixed(1)}σ ${ret > 0 ? "UP" : "DOWN"} → ${cfg.mode} ${direction.toUpperCase()}`,
  };
}
