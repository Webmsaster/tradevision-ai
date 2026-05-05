/**
 * Round 60 multi-variant shard — tests 7 R28_V6 variants in parallel per
 * window. Each shard processes its own window-subset (winIdx % SHARD_COUNT
 * === SHARD_IDX) and runs all 7 variants on each of its windows. Output is
 * one jsonl-file per variant.
 *
 * Args:
 *   process.argv[2] = SHARD_IDX (0-based)
 *   process.argv[3] = SHARD_COUNT
 *
 * Variants tested:
 *   - passlock      — closeAllOnTargetReached:true (Tier C7 ⭐)
 *   - corrcap2      — correlationFilter maxOpenSameDirection=2 (Tier B4 strong)
 *   - corrcap3      — maxOpenSameDirection=3 (Tier B4 mild)
 *   - lscool48      — lossStreakCooldown afterLosses=3 cooldownBars=48 (Tier B5)
 *   - lscool96      — lossStreakCooldown afterLosses=3 cooldownBars=96 (Tier B5 aggressive)
 *   - todcutoff18   — allowedHoursUtc up to 18 (Tier B6 strict)
 *   - todcutoff20   — allowedHoursUtc up to 20 (Tier B6 mild)
 */
import {
  FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
  FTMO_DAYTRADE_24H_R28_V6_CORRCAP2,
  FTMO_DAYTRADE_24H_R28_V6_CORRCAP3,
  FTMO_DAYTRADE_24H_R28_V6_LSCOOL,
  FTMO_DAYTRADE_24H_R28_V6_LSCOOL96,
  FTMO_DAYTRADE_24H_R28_V6_TODCUTOFF18,
  FTMO_DAYTRADE_24H_R28_V6_TODCUTOFF20,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const SHARD_IDX = parseInt(process.argv[2] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[3] ?? "1", 10);
const RESUME = process.argv.includes("--resume");

const VARIANTS: { name: string; cfg: FtmoDaytrade24hConfig }[] = [
  { name: "passlock", cfg: FTMO_DAYTRADE_24H_R28_V6_PASSLOCK },
  { name: "corrcap2", cfg: FTMO_DAYTRADE_24H_R28_V6_CORRCAP2 },
  { name: "corrcap3", cfg: FTMO_DAYTRADE_24H_R28_V6_CORRCAP3 },
  { name: "lscool48", cfg: FTMO_DAYTRADE_24H_R28_V6_LSCOOL },
  { name: "lscool96", cfg: FTMO_DAYTRADE_24H_R28_V6_LSCOOL96 },
  { name: "todcutoff18", cfg: FTMO_DAYTRADE_24H_R28_V6_TODCUTOFF18 },
  { name: "todcutoff20", cfg: FTMO_DAYTRADE_24H_R28_V6_TODCUTOFF20 },
];

// Output files (truncate on fresh start; preserve on --resume).
const outFiles: Record<string, string> = {};
const doneWinIdxByVariant: Record<string, Set<number>> = {};
for (const v of VARIANTS) {
  const f = `${CACHE_DIR}/r28v6_v60_${v.name}_shard_${SHARD_IDX}.jsonl`;
  outFiles[v.name] = f;
  doneWinIdxByVariant[v.name] = new Set<number>();
  if (RESUME && existsSync(f)) {
    const lines = readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (typeof obj.winIdx === "number")
          doneWinIdxByVariant[v.name]!.add(obj.winIdx);
      } catch {}
    }
    console.log(
      `[shard ${SHARD_IDX}] resume: ${v.name} has ${doneWinIdxByVariant[v.name]!.size} windows already done`,
    );
  } else {
    writeFileSync(f, "");
  }
}

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

const { aligned, minBars } = loadAligned();
const winBars = VARIANTS[0]!.cfg.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

let winIdx = 0;
const t0 = Date.now();
for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  if (winIdx % SHARD_COUNT !== SHARD_IDX) {
    winIdx++;
    continue;
  }
  // Resume: skip variants where this winIdx is already in jsonl.
  const variantsToRun = VARIANTS.filter(
    (v) => !doneWinIdxByVariant[v.name]!.has(winIdx),
  );
  if (variantsToRun.length === 0) {
    winIdx++;
    continue;
  }
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned))
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);

  for (const v of variantsToRun) {
    const r = simulate(
      trimmed,
      v.cfg,
      WARMUP,
      WARMUP + winBars,
      `R60_${v.name.toUpperCase()}`,
    );
    const out = {
      winIdx,
      passed: r.passed,
      reason: r.reason,
      passDay: r.passDay ?? null,
      finalEquityPct: r.finalEquityPct,
    };
    appendFileSync(outFiles[v.name]!, JSON.stringify(out) + "\n");
  }
  console.log(
    `[shard ${SHARD_IDX}/${SHARD_COUNT}] win=${winIdx} done t+${Math.round((Date.now() - t0) / 1000)}s`,
  );
  winIdx++;
}
console.log(
  `[shard ${SHARD_IDX}/${SHARD_COUNT}] DONE in ${Math.round((Date.now() - t0) / 1000)}s`,
);
