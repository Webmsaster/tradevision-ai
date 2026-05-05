/**
 * Round 61 multi-variant shard — tests 4 R28_V6_PASSLOCK + Day-Risk variants.
 * Compares Day-Risk variants against PASSLOCK baseline (which is itself the
 * Round 60 champion). Resume-mode supported (skip already-done windows).
 *
 * Variants:
 *   - passlock         (baseline — already validated 64.77% in Round 60)
 *   - passlock_dr50    (PASSLOCK + day-risk 0.5× day 0-2)
 *   - passlock_dr70    (PASSLOCK + day-risk 0.7× day 0-2)
 *   - passlock_dr50_2d (PASSLOCK + day-risk 0.5× day 0-1)
 */
import {
  FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
  FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_DAYRISK_50,
  FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_DAYRISK_70,
  FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_DAYRISK_50_2D,
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
  { name: "passlock_baseline", cfg: FTMO_DAYTRADE_24H_R28_V6_PASSLOCK },
  { name: "passlock_dr50", cfg: FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_DAYRISK_50 },
  { name: "passlock_dr70", cfg: FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_DAYRISK_70 },
  {
    name: "passlock_dr50_2d",
    cfg: FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_DAYRISK_50_2D,
  },
];

const outFiles: Record<string, string> = {};
const doneWinIdxByVariant: Record<string, Set<number>> = {};
for (const v of VARIANTS) {
  const f = `${CACHE_DIR}/r28v6_v61_${v.name}_shard_${SHARD_IDX}.jsonl`;
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
      `[r61 shard ${SHARD_IDX}] resume: ${v.name} has ${doneWinIdxByVariant[v.name]!.size} windows already done`,
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
      `R61_${v.name.toUpperCase()}`,
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
    `[r61 shard ${SHARD_IDX}/${SHARD_COUNT}] win=${winIdx} done t+${Math.round((Date.now() - t0) / 1000)}s`,
  );
  winIdx++;
}
console.log(
  `[r61 shard ${SHARD_IDX}/${SHARD_COUNT}] DONE in ${Math.round((Date.now() - t0) / 1000)}s`,
);
