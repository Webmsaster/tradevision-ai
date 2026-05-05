/**
 * Round 60 Vol-Adaptive tpMult shard — tests 4 VolTp variants per window.
 * Mirror of _r28V6Round60Shard.ts but isolated to avoid colliding with the
 * already-running primary multi-variant sweep.
 */
import {
  FTMO_DAYTRADE_24H_R28_V6_VOLTP_AGGR,
  FTMO_DAYTRADE_24H_R28_V6_VOLTP_MILD,
  FTMO_DAYTRADE_24H_R28_V6_VOLTP_INV,
  FTMO_DAYTRADE_24H_R28_V6_VOLTP_LOW,
  FTMO_DAYTRADE_24H_R28_V6_IDLT_25,
  FTMO_DAYTRADE_24H_R28_V6_IDLT_30,
  FTMO_DAYTRADE_24H_R28_V6_IDLT_35,
  FTMO_DAYTRADE_24H_R28_V6_COMBO_PL_IDLT,
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
  { name: "voltp_aggr", cfg: FTMO_DAYTRADE_24H_R28_V6_VOLTP_AGGR },
  { name: "voltp_mild", cfg: FTMO_DAYTRADE_24H_R28_V6_VOLTP_MILD },
  { name: "voltp_inv", cfg: FTMO_DAYTRADE_24H_R28_V6_VOLTP_INV },
  { name: "voltp_low", cfg: FTMO_DAYTRADE_24H_R28_V6_VOLTP_LOW },
  { name: "idlt_25", cfg: FTMO_DAYTRADE_24H_R28_V6_IDLT_25 },
  { name: "idlt_30", cfg: FTMO_DAYTRADE_24H_R28_V6_IDLT_30 },
  { name: "idlt_35", cfg: FTMO_DAYTRADE_24H_R28_V6_IDLT_35 },
  { name: "combo_pl_idlt", cfg: FTMO_DAYTRADE_24H_R28_V6_COMBO_PL_IDLT },
];

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
      `[voltp shard ${SHARD_IDX}] resume: ${v.name} has ${doneWinIdxByVariant[v.name]!.size} windows already done`,
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
    `[voltp shard ${SHARD_IDX}/${SHARD_COUNT}] win=${winIdx} done t+${Math.round((Date.now() - t0) / 1000)}s`,
  );
  winIdx++;
}
console.log(
  `[voltp shard ${SHARD_IDX}/${SHARD_COUNT}] DONE in ${Math.round((Date.now() - t0) / 1000)}s`,
);
