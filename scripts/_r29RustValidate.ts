/**
 * _r29RustValidate.ts — TS-vs-Rust per-window drift validator for the
 * R28_V6_PASSLOCK champion.
 *
 * Goal: pin-point per-window where the Rust port diverges from the TS
 * `simulate()` reference. Currently PASSLOCK Rust ≈ 0% pass-rate vs TS
 * 44.85% (the recent PT08 variant) — we need to know whether all Rust
 * windows fail with the same `reason` (= a single bug to hunt) or drift
 * is scattered across reasons (= multiple bugs).
 *
 * Pipeline per window:
 *   1. Load aligned 30m candles for the 9 R28_V6 assets, slice
 *      `[start, start + maxDays*48]` (NO warmup pre-roll passed to Rust;
 *      both engines initialise `challengeStartTs` from the first bar of
 *      the slice → day-counters match).
 *   2. Run TS `simulate()` on a `warmup + winBars` slice with
 *      startBar=warmup (engine convention from `_r29Round7Shard.ts`).
 *   3. Write the warmup+winBars slice to a temp candles dir, invoke
 *      `engine-rust/target/release/ftmo-sweep --candles-dir <tmp>
 *       --symbols ... --windows 1 --config 2h-trend-v5-r28-v6-passlock`,
 *      parse the resulting JSONL.
 *   4. Diff (passed | reason | finalEquityPct | trades).
 *
 * Output: a markdown table on stdout + summary "pass-rate gap = X pp,
 * mean equity diff = Y%".
 *
 * Usage:
 *   node ./node_modules/tsx/dist/cli.mjs scripts/_r29RustValidate.ts
 *   node ./node_modules/tsx/dist/cli.mjs scripts/_r29RustValidate.ts --skip-rust
 *   node ./node_modules/tsx/dist/cli.mjs scripts/_r29RustValidate.ts --windows 0,16,64
 *
 * Defaults: windows = 0,8,16,64,72  (mix of pass / daily_loss / total_loss
 * / clean-pass / edge-late-pass — drawn from
 * `scripts/cache_bakeoff/r28v6_v60_passlock_shard_0.jsonl`).
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { FTMO_DAYTRADE_24H_R28_V6_PASSLOCK } from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";

const CACHE_DIR = "scripts/cache_bakeoff";
const TMP_DIR = "scripts/cache_bakeoff/_rust_validate_tmp";
const RUST_BIN = "engine-rust/target/release/ftmo-sweep";
const RUST_SELECTOR = "2h-trend-v5-r28-v6-passlock";
const WARMUP = 5000;
const STEP_DAYS = 14;

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

interface Args {
  windows: number[];
  skipRust: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    windows: [0, 8, 16, 64, 72],
    skipRust: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--windows") {
      a.windows = argv[++i]!.split(",").map((s) => parseInt(s, 10));
    } else if (arg === "--skip-rust") {
      a.skipRust = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: _r29RustValidate.ts [--windows 0,8,16,...] [--skip-rust]",
      );
      process.exit(0);
    }
  }
  return a;
}

function loadAligned(): {
  aligned: Record<string, Candle[]>;
  minBars: number;
} {
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
  for (const s of SYMBOLS) {
    aligned[s] = data[s]!.filter((c) => cs.has(c.openTime));
  }
  return {
    aligned,
    minBars: Math.min(...SYMBOLS.map((s) => aligned[s]!.length)),
  };
}

interface TSResult {
  passed: boolean;
  reason: string;
  finalEquityPct: number;
  trades: number;
  passDay: number | null;
}

function runTS(
  trimmed: Record<string, Candle[]>,
  startBar: number,
  endBar: number,
): TSResult {
  const cfg = FTMO_DAYTRADE_24H_R28_V6_PASSLOCK;
  const r = simulate(trimmed, cfg, startBar, endBar, "R28_V6_PASSLOCK");
  return {
    passed: r.passed,
    reason: r.reason,
    finalEquityPct: r.finalEquityPct,
    trades: r.trades.length,
    passDay: r.passDay ?? null,
  };
}

interface RustResult {
  passed: boolean;
  reason: string;
  finalEquityPct: number;
  trades: number;
  errored?: string;
}

/**
 * Slice candles to the challenge window only (no pre-warmup) and dump to
 * a fresh tmp dir, then invoke ftmo-sweep with --windows 1 → it consumes
 * the entire dump as a single window (TS startBar=0..endBar=winBars).
 *
 * NOTE: TS simulate gets warmup+winBars and skips warmup bars; that means
 * TS engine sees ATR/RSI history pre-warmed BEFORE challenge bars. Rust
 * engine here gets only winBars total → first ~14 bars have ATR=None.
 * This is one known systematic drift source; the harness reports it but
 * does not try to suppress it.
 */
function runRust(
  trimmed: Record<string, Candle[]>,
  warmupBars: number,
  winIdx: number,
): RustResult {
  if (!existsSync(RUST_BIN)) {
    return {
      passed: false,
      reason: "rust_bin_missing",
      finalEquityPct: 0,
      trades: 0,
      errored: `${RUST_BIN} not found — run cargo build --release in engine-rust/ first`,
    };
  }
  // Per-call sub-dir to avoid races if validate runs in parallel.
  const subDir = `${TMP_DIR}/win_${winIdx}`;
  rmSync(subDir, { recursive: true, force: true });
  mkdirSync(subDir, { recursive: true });

  // Slice off the warmup prefix → write the challenge-only candle window.
  for (const sym of SYMBOLS) {
    const challengeOnly = trimmed[sym]!.slice(warmupBars);
    writeFileSync(`${subDir}/${sym}_30m.json`, JSON.stringify(challengeOnly));
  }

  const outPath = `${subDir}/rust_result.jsonl`;
  const args = [
    "--candles-dir",
    subDir,
    "--symbols",
    SYMBOLS.join(","),
    "--config",
    RUST_SELECTOR,
    "--windows",
    "1",
    "--threads",
    "1",
    "--out",
    outPath,
  ];
  const proc = spawnSync(path.resolve(RUST_BIN), args, {
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (proc.status !== 0) {
    return {
      passed: false,
      reason: "rust_exit_nonzero",
      finalEquityPct: 0,
      trades: 0,
      errored: `exit=${proc.status}; stderr=${(proc.stderr ?? "").slice(0, 500)}`,
    };
  }
  if (!existsSync(outPath)) {
    return {
      passed: false,
      reason: "rust_no_output",
      finalEquityPct: 0,
      trades: 0,
      errored: `no JSONL produced; stdout=${(proc.stdout ?? "").slice(0, 500)}`,
    };
  }
  const lines = readFileSync(outPath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return {
      passed: false,
      reason: "rust_empty_jsonl",
      finalEquityPct: 0,
      trades: 0,
      errored: `stdout=${(proc.stdout ?? "").slice(0, 500)}`,
    };
  }
  const row = JSON.parse(lines[0]!) as {
    passed: boolean;
    fail_reason: string | null;
    final_equity_pct: number;
    trades: number;
  };
  return {
    passed: row.passed,
    reason: row.passed ? "profit_target" : (row.fail_reason ?? "time"),
    finalEquityPct: row.final_equity_pct,
    trades: row.trades,
  };
}

function fmtPct(x: number): string {
  return (x * 100).toFixed(2) + "%";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[_r29RustValidate] config=R28_V6_PASSLOCK windows=${args.windows.join(",")} skipRust=${args.skipRust}`,
  );

  const { aligned, minBars } = loadAligned();
  const cfg = FTMO_DAYTRADE_24H_R28_V6_PASSLOCK;
  const winBars = cfg.maxDays * 48;
  const stepBars = STEP_DAYS * 48;

  console.log(
    `loaded ${SYMBOLS.length} symbols × ${minBars} bars; winBars=${winBars} (${cfg.maxDays}d), warmup=${WARMUP}, step=${STEP_DAYS}d`,
  );

  type Row = {
    win: number;
    ts: TSResult;
    rust: RustResult | null;
    eqDelta: number;
    flipped: boolean;
  };
  const rows: Row[] = [];

  for (const winIdx of args.windows) {
    const start = WARMUP + winIdx * stepBars;
    if (start + winBars > minBars) {
      console.warn(
        `SKIP w${winIdx}: out of bounds (start=${start}, minBars=${minBars})`,
      );
      continue;
    }
    const trimmed: Record<string, Candle[]> = {};
    for (const k of Object.keys(aligned)) {
      trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
    }
    const t0 = Date.now();
    const ts = runTS(trimmed, WARMUP, WARMUP + winBars);
    const tsMs = Date.now() - t0;

    let rust: RustResult | null = null;
    let rustMs = 0;
    if (!args.skipRust) {
      const r0 = Date.now();
      rust = runRust(trimmed, WARMUP, winIdx);
      rustMs = Date.now() - r0;
    }

    const eqDelta = rust ? rust.finalEquityPct - ts.finalEquityPct : 0;
    const flipped = rust ? rust.passed !== ts.passed : false;
    rows.push({ win: winIdx, ts, rust, eqDelta, flipped });

    console.log(
      `w${winIdx}: TS ${ts.passed ? "PASS" : "FAIL"} (${ts.reason}, eq=${fmtPct(ts.finalEquityPct)}, trades=${ts.trades}, ${tsMs}ms)` +
        (rust
          ? ` | Rust ${rust.passed ? "PASS" : "FAIL"} (${rust.reason}, eq=${fmtPct(rust.finalEquityPct)}, trades=${rust.trades}, ${rustMs}ms)${rust.errored ? " ERR=" + rust.errored : ""}` +
            (flipped ? "  *** FLIP ***" : "")
          : ""),
    );
  }

  // Markdown diff table
  console.log("\n## Per-window diff\n");
  console.log(
    "| Win | TS pass | TS reason | TS eq | TS trades | Rust pass | Rust reason | Rust eq | Rust trades | Δeq | Flip |",
  );
  console.log(
    "| --- | ------- | --------- | ----- | --------- | --------- | ----------- | ------- | ----------- | --- | ---- |",
  );
  for (const r of rows) {
    const rustStr = r.rust
      ? `| ${r.rust.passed ? "✓" : "✗"} | ${r.rust.reason} | ${fmtPct(r.rust.finalEquityPct)} | ${r.rust.trades} | ${fmtPct(r.eqDelta)} | ${r.flipped ? "YES" : "no"} |`
      : "| (skipped) | — | — | — | — | — |";
    console.log(
      `| ${r.win} | ${r.ts.passed ? "✓" : "✗"} | ${r.ts.reason} | ${fmtPct(r.ts.finalEquityPct)} | ${r.ts.trades} ${rustStr}`,
    );
  }

  // Summary
  const tsPass = rows.filter((r) => r.ts.passed).length;
  const rustPass = rows.filter((r) => r.rust?.passed).length;
  const tsRate = (tsPass / rows.length) * 100;
  const rustRate = (rustPass / rows.length) * 100;
  const meanEqTs =
    rows.reduce((s, r) => s + r.ts.finalEquityPct, 0) / rows.length;
  const meanEqRust = rows.some((r) => r.rust)
    ? rows.reduce((s, r) => s + (r.rust?.finalEquityPct ?? 0), 0) / rows.length
    : 0;
  const flipCount = rows.filter((r) => r.flipped).length;

  console.log("\n## Summary\n");
  console.log(
    `- TS:   ${tsPass}/${rows.length} pass (${tsRate.toFixed(2)}%) | mean eq ${fmtPct(meanEqTs)}`,
  );
  if (!args.skipRust) {
    console.log(
      `- Rust: ${rustPass}/${rows.length} pass (${rustRate.toFixed(2)}%) | mean eq ${fmtPct(meanEqRust)}`,
    );
    console.log(
      `- pass-rate gap = ${(tsRate - rustRate).toFixed(2)} pp | mean eq diff = ${fmtPct(meanEqRust - meanEqTs)} | flips = ${flipCount}/${rows.length}`,
    );
    // Failure-reason histogram for Rust (helps spot single-bug pattern).
    const reasonCount: Record<string, number> = {};
    for (const r of rows) {
      if (!r.rust) continue;
      const k = r.rust.passed ? "(pass)" : r.rust.reason;
      reasonCount[k] = (reasonCount[k] ?? 0) + 1;
    }
    console.log("- Rust reason histogram:");
    for (const [k, v] of Object.entries(reasonCount)) {
      console.log(`    ${k}: ${v}`);
    }
  }

  // Cleanup tmp dirs (per-window subdirs).
  if (!args.skipRust) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

main();
