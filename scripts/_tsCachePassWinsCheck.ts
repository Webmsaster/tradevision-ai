// Re-run ONLY the windows where the stale cache says PASS, and check if
// they still pass under the current engine. This is the focused test for
// the cache-staleness hypothesis.
import { FTMO_DAYTRADE_24H_R28_V6_PASSLOCK } from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, readdirSync } from "node:fs";

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

function loadAligned() {
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

// Load cache → set of PASS-window indices
const cachePass = new Set<number>();
const cacheEq = new Map<number, number>();
for (const fn of readdirSync(CACHE_DIR).filter((f) =>
  f.startsWith("r28v6_v60_passlock_shard_"),
)) {
  const text = readFileSync(`${CACHE_DIR}/${fn}`, "utf-8");
  for (const line of text.trim().split("\n")) {
    const d = JSON.parse(line);
    if (d.passed === true) {
      cachePass.add(d.winIdx);
      cacheEq.set(d.winIdx, d.finalEquityPct);
    }
  }
}
console.log(`Cache claims ${cachePass.size} PASS windows (of 136)`);

const cfg = FTMO_DAYTRADE_24H_R28_V6_PASSLOCK;
const { aligned, minBars } = loadAligned();
const winBars = cfg.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

let stillPass = 0;
let flippedToFail = 0;
let total = 0;
let winIdx = 0;
const t0 = Date.now();
for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  if (cachePass.has(winIdx)) {
    const trimmed: Record<string, Candle[]> = {};
    for (const k of Object.keys(aligned))
      trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
    const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, "PASSCHECK");
    total++;
    const cacheE = (cacheEq.get(winIdx) ?? 0) * 100;
    const todayE = r.finalEquityPct * 100;
    if (r.passed) {
      stillPass++;
      console.log(
        `w${winIdx}: STILL PASS  cache eq=${cacheE.toFixed(2)}%  today eq=${todayE.toFixed(2)}%  Δ=${(todayE - cacheE).toFixed(2)}pp  reason=${r.reason}`,
      );
    } else {
      flippedToFail++;
      console.log(
        `w${winIdx}: FLIPPED FAIL  cache eq=${cacheE.toFixed(2)}%  today eq=${todayE.toFixed(2)}%  Δ=${(todayE - cacheE).toFixed(2)}pp  reason=${r.reason} *** FLIP ***`,
      );
    }
  }
  winIdx++;
}
console.log(`\nDONE in ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(
  `Of ${total} cache-PASS windows: ${stillPass} still pass, ${flippedToFail} flipped to FAIL.`,
);
console.log(
  `Cache claimed 55.88% (76/136). Honest TS rate today (cache-PASS only): ${((76 - flippedToFail) / 136) * 100}.${(((76 - flippedToFail) / 136) * 100).toFixed(2).split(".")[1]}% upper bound`,
);
