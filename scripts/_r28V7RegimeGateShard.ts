/**
 * Sharded R28_V7 regime-gate revalidation — Round 60 (2026-05-03).
 *
 * Mirrors `_r28V6Shard.ts` but runs the V4-Engine simulate loop with a
 * per-bar regime gate that can BLOCK ENTRIES (exits/PTP/breakEven still
 * run normally). Each shard processes the windows where
 * `windowIdx % SHARD_COUNT === SHARD_IDX` for a single variant.
 *
 * Args:
 *   process.argv[2] = SHARD_IDX   (0..SHARD_COUNT-1)
 *   process.argv[3] = SHARD_COUNT
 *   process.argv[4] = VARIANT_IDX (0=baseline, 1..4=gate variants)
 *
 * Variants:
 *   V0: baseline (no gate) — control vs 56.62% memory entry
 *   V1: skip entries when BTC 2h close < 200-EMA(2h)
 *   V2: skip entries when BTC 50-EMA(2h) < 200-EMA(2h) (death-cross)
 *   V3: skip entries when BTC last-7d return on 2h < -5% (84 bars × 2h)
 *   V4: skip entries unless BOTH BTC and ETH have close > 200-EMA on 2h
 *
 * Output: scripts/cache_bakeoff/r28v7_regime_v<idx>_shard_<idx>.jsonl + stdout
 */
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { pollLive, initialState } from "../src/utils/ftmoLiveEngineV4";
import { atr, ema, type Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const SHARD_IDX = parseInt(process.argv[2] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[3] ?? "1", 10);
const VARIANT_IDX = parseInt(process.argv[4] ?? "0", 10);
const OUT_FILE = `${CACHE_DIR}/r28v7_regime_v${VARIANT_IDX}_shard_${SHARD_IDX}.jsonl`;
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

function loadAligned(): { aligned: Record<string, Candle[]>; minBars: number } {
  const data: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    data[s] = JSON.parse(
      readFileSync(`${CACHE_DIR}/${s}_30m.json`, "utf-8"),
    ) as Candle[];
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

/**
 * Load BTC/ETH 2h closes and pre-compute regime indicators.
 * Returns lookup maps from openTime → indicator values for the LATEST
 * closed 2h bar at-or-before that openTime.
 */
interface RegimeMaps {
  // For each 30m openTime, the indicator value of the latest closed 2h bar.
  btcClose: Map<number, number>;
  btcEma200: Map<number, number | null>;
  btcEma50: Map<number, number | null>;
  btcRet7d: Map<number, number | null>;
  ethClose: Map<number, number>;
  ethEma200: Map<number, number | null>;
}

function loadRegime(): RegimeMaps {
  const btc2h = JSON.parse(
    readFileSync(`${CACHE_DIR}/BTCUSDT_2h.json`, "utf-8"),
  ) as Candle[];
  const eth2h = JSON.parse(
    readFileSync(`${CACHE_DIR}/ETHUSDT_2h.json`, "utf-8"),
  ) as Candle[];

  const btcCloses = btc2h.map((c) => c.close);
  const ethCloses = eth2h.map((c) => c.close);
  const btcEma200Series = ema(btcCloses, 200);
  const btcEma50Series = ema(btcCloses, 50);
  const ethEma200Series = ema(ethCloses, 200);

  // Last-7d return on 2h: 7d * 24h / 2h = 84 bars
  const RET_BARS = 84;
  const btcRet7dSeries: (number | null)[] = btc2h.map((_, i) => {
    if (i < RET_BARS) return null;
    const back = btcCloses[i - RET_BARS]!;
    if (!back) return null;
    return (btcCloses[i]! - back) / back;
  });

  // Build a sorted array of (openTime, idx) for binary lookups.
  // For each 30m bar at time t, the LATEST CLOSED 2h bar is one whose
  // closeTime <= t (i.e. its openTime + 2h <= t). To be conservative
  // (no look-ahead), require openTime + 2h*ms <= 30m_openTime.
  const TWO_H_MS = 2 * 60 * 60 * 1000;
  const btcOpenTimes = btc2h.map((c) => c.openTime);
  const ethOpenTimes = eth2h.map((c) => c.openTime);

  function findLatestClosedIdx(times: number[], at: number): number {
    // Find max i such that times[i] + TWO_H_MS <= at.
    let lo = 0,
      hi = times.length - 1,
      ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! + TWO_H_MS <= at) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  // Build maps only for the 30m timestamps we'll see in our SYMBOLS.
  // (Using a single common set from BTCUSDT_30m as proxy.)
  const btc30m = JSON.parse(
    readFileSync(`${CACHE_DIR}/BTCUSDT_30m.json`, "utf-8"),
  ) as Candle[];

  const btcClose = new Map<number, number>();
  const btcEma200Map = new Map<number, number | null>();
  const btcEma50Map = new Map<number, number | null>();
  const btcRet7dMap = new Map<number, number | null>();
  const ethClose = new Map<number, number>();
  const ethEma200Map = new Map<number, number | null>();

  for (const c of btc30m) {
    const t = c.openTime;
    const bIdx = findLatestClosedIdx(btcOpenTimes, t);
    const eIdx = findLatestClosedIdx(ethOpenTimes, t);
    if (bIdx >= 0) {
      btcClose.set(t, btcCloses[bIdx]!);
      btcEma200Map.set(t, btcEma200Series[bIdx] ?? null);
      btcEma50Map.set(t, btcEma50Series[bIdx] ?? null);
      btcRet7dMap.set(t, btcRet7dSeries[bIdx] ?? null);
    }
    if (eIdx >= 0) {
      ethClose.set(t, ethCloses[eIdx]!);
      ethEma200Map.set(t, ethEma200Series[eIdx] ?? null);
    }
  }

  return {
    btcClose,
    btcEma200: btcEma200Map,
    btcEma50: btcEma50Map,
    btcRet7d: btcRet7dMap,
    ethClose,
    ethEma200: ethEma200Map,
  };
}

/**
 * Per-variant gate: returns true to BLOCK entries at openTime t.
 * Conservative on missing data — if indicator is null (warmup), DO NOT
 * block (allow baseline behavior).
 */
function makeGate(variant: number, r: RegimeMaps): (t: number) => boolean {
  if (variant === 0) return () => false;

  if (variant === 1) {
    // BTC 2h close < EMA200(2h)
    return (t) => {
      const c = r.btcClose.get(t);
      const e = r.btcEma200.get(t);
      if (c == null || e == null) return false;
      return c < e;
    };
  }

  if (variant === 2) {
    // BTC EMA50(2h) < EMA200(2h) — death-cross regime
    return (t) => {
      const f = r.btcEma50.get(t);
      const s = r.btcEma200.get(t);
      if (f == null || s == null) return false;
      return f < s;
    };
  }

  if (variant === 3) {
    // BTC 7d return < -5%
    return (t) => {
      const v = r.btcRet7d.get(t);
      if (v == null) return false;
      return v < -0.05;
    };
  }

  if (variant === 4) {
    // Require BOTH BTC and ETH close > EMA200(2h).
    // Block when EITHER is below.
    return (t) => {
      const bc = r.btcClose.get(t);
      const be = r.btcEma200.get(t);
      const ec = r.ethClose.get(t);
      const ee = r.ethEma200.get(t);
      if (bc == null || be == null || ec == null || ee == null) return false;
      return bc < be || ec < ee;
    };
  }

  throw new Error(`Unknown variant ${variant}`);
}

interface SimResult {
  passed: boolean;
  reason: "profit_target" | "daily_loss" | "total_loss" | "time" | "give_back";
  passDay?: number;
  finalEquityPct: number;
  blocked: number; // count of bars where gate blocked entries
  totalBars: number;
}

/**
 * Drop-in replacement for `simulate()` that swaps `cfg.assets = []` on
 * bars where the gate fires (blocks all entries while still letting
 * exits/breakeven/PTP run inside pollLive).
 */
function simulateWithGate(
  alignedCandles: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  startBar: number,
  endBar: number,
  cfgLabel: string,
  gate: (t: number) => boolean,
): SimResult {
  const state = initialState(cfgLabel);
  // Mirror simulate(): pre-compute ATR for chandelier exit on each asset.
  const atrSeriesByAsset: Record<string, (number | null)[]> = {};
  if (cfg.chandelierExit) {
    for (const asset of cfg.assets) {
      const sourceKey = asset.sourceSymbol ?? asset.symbol;
      const cs = alignedCandles[sourceKey];
      if (cs) atrSeriesByAsset[sourceKey] = atr(cs, cfg.chandelierExit.period);
    }
  }

  // Build a "gated" cfg with empty assets — used on blocked bars.
  // Empty assets disables ALL new entries inside pollLive's entry loop
  // while leaving exits/PTP/breakEven untouched (those iterate
  // state.openPositions, not cfg.assets).
  const cfgGated: FtmoDaytrade24hConfig = { ...cfg, assets: [] };

  let blocked = 0;
  let totalBars = 0;

  for (let i = startBar; i < endBar; i++) {
    if (state.stoppedReason) break;
    const sliceByAsset: Record<string, Candle[]> = {};
    for (const k of Object.keys(alignedCandles)) {
      sliceByAsset[k] = alignedCandles[k]!.slice(0, i + 1);
    }
    const slicedAtr: Record<string, (number | null)[]> = {};
    if (cfg.chandelierExit) {
      for (const k of Object.keys(atrSeriesByAsset)) {
        slicedAtr[k] = atrSeriesByAsset[k]!.slice(0, i + 1);
      }
    }
    // Reference time = openTime of the latest aligned bar (matches
    // pollLive's lastBar.openTime). All assets are aligned 1:1 by
    // upstream loadAligned() — pick any.
    const anyKey = Object.keys(sliceByAsset)[0]!;
    const lastBar = sliceByAsset[anyKey]![sliceByAsset[anyKey]!.length - 1]!;
    const block = gate(lastBar.openTime);

    totalBars++;
    if (block) blocked++;

    const useCfg = block ? cfgGated : cfg;
    const r = pollLive(state, sliceByAsset, useCfg, slicedAtr);
    if (r.challengeEnded) {
      if (r.passed) {
        return {
          passed: true,
          reason: "profit_target",
          passDay: Math.max(
            (state.firstTargetHitDay ?? state.day) + 1,
            cfg.minTradingDays,
          ),
          finalEquityPct: state.equity - 1,
          blocked,
          totalBars,
        };
      }
      return {
        passed: false,
        reason:
          r.failReason && r.failReason !== "feed_lost" ? r.failReason : "time",
        finalEquityPct: state.equity - 1,
        blocked,
        totalBars,
      };
    }
  }

  // End-of-window check (mirror simulate() logic).
  const targetHit =
    state.firstTargetHitDay !== null &&
    state.tradingDays.length >= cfg.minTradingDays;
  const finalEquityFloor = 1 + cfg.profitTarget * 0.5;
  const giveBackTooFar =
    targetHit &&
    Number.isFinite(state.equity) &&
    state.equity < finalEquityFloor;
  const passed = targetHit && !giveBackTooFar;
  return {
    passed,
    reason: passed ? "profit_target" : giveBackTooFar ? "give_back" : "time",
    passDay: passed
      ? Math.max((state.firstTargetHitDay ?? state.day) + 1, cfg.minTradingDays)
      : undefined,
    finalEquityPct: state.equity - 1,
    blocked,
    totalBars,
  };
}

const cfg: FtmoDaytrade24hConfig =
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
console.log(
  `[shard ${SHARD_IDX}/${SHARD_COUNT} V${VARIANT_IDX}] loading data...`,
);
const { aligned, minBars } = loadAligned();
const regime = loadRegime();
console.log(
  `[shard ${SHARD_IDX}/${SHARD_COUNT} V${VARIANT_IDX}] data loaded. minBars=${minBars} btcClose-keys=${regime.btcClose.size}`,
);
const gate = makeGate(VARIANT_IDX, regime);

const winBars = cfg.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

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
  const r = simulateWithGate(
    trimmed,
    cfg,
    WARMUP,
    WARMUP + winBars,
    `R28_V7_REGIME_V${VARIANT_IDX}`,
    gate,
  );
  const out = {
    winIdx,
    variant: VARIANT_IDX,
    passed: r.passed,
    reason: r.reason,
    passDay: r.passDay ?? null,
    finalEquityPct: r.finalEquityPct,
    blocked: r.blocked,
    totalBars: r.totalBars,
    blockPct: r.totalBars > 0 ? r.blocked / r.totalBars : 0,
  };
  appendFileSync(OUT_FILE, JSON.stringify(out) + "\n");
  console.log(
    `[shard ${SHARD_IDX}/${SHARD_COUNT} V${VARIANT_IDX}] win=${winIdx} passed=${r.passed} reason=${r.reason} eq=${r.finalEquityPct.toFixed(4)} block=${(out.blockPct * 100).toFixed(1)}% t+${Math.round((Date.now() - t0) / 1000)}s`,
  );
  winIdx++;
}
console.log(
  `[shard ${SHARD_IDX}/${SHARD_COUNT} V${VARIANT_IDX}] DONE in ${Math.round((Date.now() - t0) / 1000)}s`,
);
