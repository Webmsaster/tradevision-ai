/**
 * Spot-check: re-run PASSLOCK on winIdx=0 and winIdx=8 with NEW PTP=0.005.
 * Compare with cached results (which were produced with PTP=0.012).
 *
 * Goal: detect whether the PTP fix (Round 60 audit, 2026-05-04) changes
 * pass-rate dramatically. If <2pp swing per window in equity / pass-flag
 * is preserved, PASSLOCK 63.24% claim stands. Otherwise full re-sweep needed.
 *
 * Usage: node ./node_modules/.bin/tsx scripts/_r28V6Round60PtpSpotCheck.ts
 */
import { FTMO_DAYTRADE_24H_R28_V6_PASSLOCK } from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";

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
    data[s] = JSON.parse(readFileSync(`${CACHE_DIR}/${s}_30m.json`, "utf-8"));
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

const cfg = FTMO_DAYTRADE_24H_R28_V6_PASSLOCK;
console.log(
  `[spot-check] PTP triggerPct = ${cfg.partialTakeProfit?.triggerPct} (expected 0.005 post-fix)`,
);
console.log(
  `[spot-check] PTP closeFraction = ${cfg.partialTakeProfit?.closeFraction}`,
);
console.log(
  `[spot-check] closeAllOnTargetReached = ${cfg.closeAllOnTargetReached}`,
);

const { aligned, minBars } = loadAligned();
const winBars = cfg.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

interface CachedResult {
  winIdx: number;
  passed: boolean;
  reason: string;
  finalEquityPct: number;
}
const cached = new Map<number, CachedResult>();
for (let s = 0; s < 8; s++) {
  const lines = readFileSync(
    `${CACHE_DIR}/r28v6_v60_passlock_shard_${s}.jsonl`,
    "utf-8",
  )
    .trim()
    .split("\n");
  for (const line of lines) {
    const o = JSON.parse(line);
    cached.set(o.winIdx, o);
  }
}

const targetWindows = [0, 8, 16, 40]; // 2 pass + 2 fail in cache
console.log(
  `\n=== Comparing live PTP=0.005 vs cached PTP=0.012 results (${targetWindows.length} windows) ===\n`,
);

let winIdx = 0;
const t0 = Date.now();
for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  if (!targetWindows.includes(winIdx)) {
    winIdx++;
    continue;
  }
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned))
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);

  const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, `SPOT_${winIdx}`);
  const c = cached.get(winIdx)!;
  const eqDelta = (r.finalEquityPct - c.finalEquityPct) * 100; // pp
  const passFlip = r.passed !== c.passed;
  console.log(
    `winIdx=${winIdx.toString().padStart(3)}` +
      `  cached: pass=${c.passed ? "Y" : "N"} eq=${(c.finalEquityPct * 100).toFixed(2)}% (${c.reason})` +
      `  | live: pass=${r.passed ? "Y" : "N"} eq=${(r.finalEquityPct * 100).toFixed(2)}% (${r.reason})` +
      `  | Δeq=${eqDelta >= 0 ? "+" : ""}${eqDelta.toFixed(2)}pp${passFlip ? "  ⚠️ FLIP" : ""}`,
  );
  winIdx++;
}
console.log(`\n[spot-check] DONE in ${Math.round((Date.now() - t0) / 1000)}s`);
