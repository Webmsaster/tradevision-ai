/**
 * R28_V7 Volatility-Adaptive TP — sharded V4-Sim re-validation.
 *
 * Hypothesis: R28_V6 ships a uniform tpMult ×0.55 across all 9 assets.
 * Realized 14d-vol differs across assets and across time. Scaling TP
 * to per-asset / per-window vol class may capture more edge — wider
 * TPs in high-vol regimes, tighter in low-vol.
 *
 * Variants (selected via env VARIANT={V0,V1,V2,V3,V4}):
 *   V0: baseline R28_V6 control (no override) — must match 56.62%.
 *   V1: per-window 14d vol-scale.   tp = base × clip(vol_14d / med_14d, 0.5, 2.0)
 *   V2: per-window 30d vol-scale.   tp = base × clip(vol_30d / med_30d, 0.5, 2.0)
 *   V3: 2-stage regime: tp = base × 1.3 if vol > med else base × 0.7
 *   V4: per-asset hardcoded vol-class (BTC=0.50, AAVE=0.65, mid=0.55) × tpPct_base
 *
 * Tp scaling is applied AT WINDOW START on the asset.tpPct (which already
 * embeds R28_V6's ×0.55 factor) — vol is measured over the warmup buffer
 * preceding the window so it never peeks ahead.
 *
 * Args:
 *   process.argv[2] = SHARD_IDX  (0-based)
 *   process.argv[3] = SHARD_COUNT
 *   process.env.VARIANT = "V0" | "V1" | "V2" | "V3" | "V4"
 *
 * Output: scripts/cache_voltp_r28v7/r28v7_<variant>_shard_<idx>.jsonl
 */
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR_DATA = "scripts/cache_bakeoff";
const CACHE_DIR_OUT = "scripts/cache_voltp_r28v7";
const SHARD_IDX = parseInt(process.argv[2] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[3] ?? "1", 10);
const VARIANT = (process.env.VARIANT ?? "V0").toUpperCase();
if (!["V0", "V1", "V2", "V3", "V4"].includes(VARIANT)) {
  throw new Error(`unknown VARIANT=${VARIANT}`);
}
const OUT_FILE = `${CACHE_DIR_OUT}/r28v7_${VARIANT}_shard_${SHARD_IDX}.jsonl`;
writeFileSync(OUT_FILE, ""); // truncate

const SYMBOLS = [
  "AAVEUSDT",
  "ADAUSDT",
  "BCHUSDT",
  "BNBUSDT",
  "BTCUSDT",
  "ETCUSDT",
  "ETHUSDT",
  "LTCUSDT",
  "XRPUSDT",
];

// 30m bars: 14d × 48 = 672, 30d × 48 = 1440
const VOL14_BARS = 14 * 48;
const VOL30_BARS = 30 * 48;

function loadAligned(): { aligned: Record<string, Candle[]>; minBars: number } {
  const data: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    data[s] = JSON.parse(
      readFileSync(`${CACHE_DIR_DATA}/${s}_30m.json`, "utf-8"),
    );
  }
  const sets = SYMBOLS.map((s) => new Set(data[s]!.map((c) => c.openTime)));
  const common = [...sets[0]!]
    .filter((t) => sets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of SYMBOLS)
    aligned[s] = data[s]!.filter((c) => cs.has(c.openTime));
  return {
    aligned,
    minBars: Math.min(...SYMBOLS.map((s) => aligned[s]!.length)),
  };
}

/** Rolling stdev of log-returns over `windowBars` for full series (1 sample per bar). */
function rollingStdLogRet(candles: Candle[], windowBars: number): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(0);
  if (n < 2) return out;
  const logRet = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const prev = candles[i - 1]!.close;
    const cur = candles[i]!.close;
    if (prev > 0 && cur > 0) logRet[i] = Math.log(cur / prev);
  }
  // Rolling stdev (population)
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    sum += logRet[i]!;
    sumSq += logRet[i]! * logRet[i]!;
    count++;
    if (i >= windowBars) {
      const drop = logRet[i - windowBars]!;
      sum -= drop;
      sumSq -= drop * drop;
      count--;
    }
    if (count > 1) {
      const mean = sum / count;
      const variance = Math.max(0, sumSq / count - mean * mean);
      out[i] = Math.sqrt(variance);
    } else {
      out[i] = 0;
    }
  }
  return out;
}

/** Median of finite positive values. */
function median(xs: number[]): number {
  const filtered = xs.filter((x) => Number.isFinite(x) && x > 0);
  if (filtered.length === 0) return 0;
  filtered.sort((a, b) => a - b);
  const mid = Math.floor(filtered.length / 2);
  return filtered.length % 2 === 1
    ? filtered[mid]!
    : (filtered[mid - 1]! + filtered[mid]!) / 2;
}

const baseCfg: FtmoDaytrade24hConfig =
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;

// Map symbol → asset symbol (TREND-suffix). One-to-one.
const SOURCE_TO_ASSET: Record<string, string> = {
  BTCUSDT: "BTC-TREND",
  ETHUSDT: "ETH-TREND",
  BNBUSDT: "BNB-TREND",
  ADAUSDT: "ADA-TREND",
  LTCUSDT: "LTC-TREND",
  BCHUSDT: "BCH-TREND",
  ETCUSDT: "ETC-TREND",
  XRPUSDT: "XRP-TREND",
  AAVEUSDT: "AAVE-TREND",
};

// V4 hardcoded multipliers — applied to each asset's PRE-R28_V6 base tp
// (which is V5_QUARTZ_LITE's per-asset tpPct, before the ×0.55).
// Goal: replace uniform 0.55 with vol-class-aware values.
//   Low-vol (BTC, ETH): tighter TPs → faster passes
//   Mid-vol (BNB, BCH, LTC, ADA, XRP, ETC): default
//   High-vol (AAVE): wider TPs → don't choke on AAVE chop
const V4_MULT_BY_ASSET: Record<string, number> = {
  "BTC-TREND": 0.5,
  "ETH-TREND": 0.5,
  "BNB-TREND": 0.55,
  "BCH-TREND": 0.55,
  "LTC-TREND": 0.55,
  "ADA-TREND": 0.55,
  "XRP-TREND": 0.55,
  "ETC-TREND": 0.55,
  "AAVE-TREND": 0.65,
};

const { aligned, minBars } = loadAligned();
const winBars = baseCfg.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

// Pre-compute vol series per asset on the FULL aligned candle series (using
// only past data when querying — we always read at index `start - 1`).
const vol14BySymbol: Record<string, number[]> = {};
const vol30BySymbol: Record<string, number[]> = {};
for (const s of SYMBOLS) {
  vol14BySymbol[s] = rollingStdLogRet(aligned[s]!, VOL14_BARS);
  vol30BySymbol[s] = rollingStdLogRet(aligned[s]!, VOL30_BARS);
}

// Cross-window medians (per-asset over the full data span, excluding warm-up).
// Used by V1/V2 (per-asset relative scaling) and V3 (regime split).
const med14ByAsset: Record<string, number> = {};
const med30ByAsset: Record<string, number> = {};
for (const s of SYMBOLS) {
  med14ByAsset[SOURCE_TO_ASSET[s]!] = median(vol14BySymbol[s]!.slice(WARMUP));
  med30ByAsset[SOURCE_TO_ASSET[s]!] = median(vol30BySymbol[s]!.slice(WARMUP));
}

console.log(
  `[shard ${SHARD_IDX}/${SHARD_COUNT}] VARIANT=${VARIANT} med14:`,
  Object.entries(med14ByAsset)
    .map(([k, v]) => `${k}=${v.toFixed(5)}`)
    .join(" "),
);

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Build a window-specific config — clones baseCfg and rewrites each
 * asset.tpPct based on the chosen variant + the vol observed at `start`.
 */
function buildWindowCfg(start: number): FtmoDaytrade24hConfig {
  // Vol read-index: use start - 1 to ensure no look-ahead into the window.
  const idx = Math.max(0, start - 1);
  const newAssets = baseCfg.assets.map((a) => {
    // baseTp is the R28_V6 tightened value (already includes ×0.55 from R28_V4 base).
    const baseTp = a.tpPct ?? 0.05;
    const sourceKey = a.sourceSymbol ?? a.symbol;
    // Some assets carry "-TREND" suffix; map back to source symbol for vol lookup.
    let symbolKey: string | undefined;
    if (vol14BySymbol[sourceKey]) {
      symbolKey = sourceKey;
    } else {
      // sourceSymbol might already be the trade symbol (e.g. BTCUSDT).
      const found = Object.entries(SOURCE_TO_ASSET).find(
        ([, asset]) => asset === a.symbol,
      );
      if (found) symbolKey = found[0];
    }
    if (!symbolKey || !vol14BySymbol[symbolKey]) {
      return { ...a }; // fallback: keep base
    }
    let newTp = baseTp;
    if (VARIANT === "V0") {
      newTp = baseTp;
    } else if (VARIANT === "V1") {
      const v = vol14BySymbol[symbolKey]![idx]!;
      const med = med14ByAsset[a.symbol] ?? 0;
      const ratio = med > 0 && v > 0 ? clamp(v / med, 0.5, 2.0) : 1.0;
      newTp = baseTp * ratio;
    } else if (VARIANT === "V2") {
      const v = vol30BySymbol[symbolKey]![idx]!;
      const med = med30ByAsset[a.symbol] ?? 0;
      const ratio = med > 0 && v > 0 ? clamp(v / med, 0.5, 2.0) : 1.0;
      newTp = baseTp * ratio;
    } else if (VARIANT === "V3") {
      const v = vol14BySymbol[symbolKey]![idx]!;
      const med = med14ByAsset[a.symbol] ?? 0;
      const factor = med > 0 && v > med ? 1.3 : 0.7;
      newTp = baseTp * factor;
    } else if (VARIANT === "V4") {
      // Replace R28_V6's uniform 0.55 with per-asset class.
      // baseTp = base_unmult × 0.55 → undo and re-apply class mult.
      const unmult = baseTp / 0.55;
      const classMult = V4_MULT_BY_ASSET[a.symbol] ?? 0.55;
      newTp = unmult * classMult;
    }
    return { ...a, tpPct: newTp };
  });
  return { ...baseCfg, assets: newAssets };
}

let winIdx = 0;
const t0 = Date.now();
for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  if (winIdx % SHARD_COUNT !== SHARD_IDX) {
    winIdx++;
    continue;
  }
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned))
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
  const wcfg = buildWindowCfg(start);
  const r = simulate(
    trimmed,
    wcfg,
    WARMUP,
    WARMUP + winBars,
    `R28_V7_${VARIANT}`,
  );
  // Capture per-asset tpPct snapshot for diagnostics (first window only).
  const tpSnap =
    winIdx % 16 === 0
      ? wcfg.assets.reduce<Record<string, number>>((acc, a) => {
          acc[a.symbol] = +(a.tpPct ?? 0).toFixed(5);
          return acc;
        }, {})
      : undefined;
  const out = {
    variant: VARIANT,
    winIdx,
    passed: r.passed,
    reason: r.reason,
    passDay: r.passDay ?? null,
    finalEquityPct: r.finalEquityPct,
    ...(tpSnap ? { tpSnap } : {}),
  };
  appendFileSync(OUT_FILE, JSON.stringify(out) + "\n");
  console.log(
    `[shard ${SHARD_IDX}/${SHARD_COUNT}] ${VARIANT} win=${winIdx} passed=${r.passed} reason=${r.reason} eq=${r.finalEquityPct.toFixed(4)} t+${Math.round((Date.now() - t0) / 1000)}s`,
  );
  winIdx++;
}
console.log(
  `[shard ${SHARD_IDX}/${SHARD_COUNT}] ${VARIANT} DONE in ${Math.round((Date.now() - t0) / 1000)}s`,
);
