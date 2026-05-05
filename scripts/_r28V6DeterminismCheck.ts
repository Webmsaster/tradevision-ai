/**
 * R28_V6 Determinism Check
 *
 * Runs the V4-Sim simulator twice on the same window and asserts that
 * `passed`, `finalEquityPct`, `passDay`, and `reason` are byte-identical.
 *
 * Picks 3 fixed windows (deterministic indices, NOT Math.random) so the
 * check itself is reproducible across runs.
 *
 * Usage: node ./node_modules/tsx/dist/cli.mjs scripts/_r28V6DeterminismCheck.ts
 *
 * Exit code:
 *   0  → all 3 windows determined identical results
 *   1  → at least one window produced divergent results
 */
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
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

const cfg: FtmoDaytrade24hConfig =
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
const { aligned, minBars } = loadAligned();
const winBars = cfg.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

// Enumerate window starts (same convention as _r28V6Shard.ts).
const winStarts: number[] = [];
for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  winStarts.push(start);
}
const totalWins = winStarts.length;
console.log(`[determinism] total windows available: ${totalWins}`);

// Pick 3 fixed indices — early, mid, late — deterministic, no Math.random.
const pickIdx = [
  Math.floor(totalWins * 0.1),
  Math.floor(totalWins * 0.5),
  Math.floor(totalWins * 0.9),
];

interface RunOut {
  passed: boolean;
  reason: string;
  passDay: number | null;
  finalEquityPct: number;
}

function runWindow(winIdx: number): RunOut {
  const start = winStarts[winIdx]!;
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned))
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
  const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, "DET_CHECK");
  return {
    passed: r.passed,
    reason: r.reason,
    passDay: r.passDay ?? null,
    finalEquityPct: r.finalEquityPct,
  };
}

let allMatch = true;
for (const winIdx of pickIdx) {
  console.log(`\n[determinism] === window ${winIdx} ===`);
  const a = runWindow(winIdx);
  const b = runWindow(winIdx);
  const match =
    a.passed === b.passed &&
    a.reason === b.reason &&
    a.passDay === b.passDay &&
    // Bit-exact float compare via toString — equivalent to byte-identical
    // for IEEE-754 doubles produced by deterministic arithmetic.
    a.finalEquityPct.toString() === b.finalEquityPct.toString();
  console.log(
    `  run A: passed=${a.passed} reason=${a.reason} passDay=${a.passDay} eq=${a.finalEquityPct}`,
  );
  console.log(
    `  run B: passed=${b.passed} reason=${b.reason} passDay=${b.passDay} eq=${b.finalEquityPct}`,
  );
  console.log(`  MATCH: ${match ? "YES" : "NO  <-- NON-DETERMINISTIC"}`);
  if (!match) allMatch = false;
}

console.log(
  `\n[determinism] RESULT: ${allMatch ? "CONFIRMED — all 3 windows byte-identical" : "BROKEN — divergent runs detected"}`,
);
process.exit(allMatch ? 0 : 1);
