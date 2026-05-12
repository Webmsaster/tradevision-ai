/**
 * R29 Rust Backbone Validation — drift table for 5 hot configs.
 *
 * Runs Rust ftmo-sweep + TS sharded simulate() on the same window-set
 * for each config, prints a drift table, and exits 0 iff all configs
 * are within ±5pp (the threshold for using Rust as permanent backbone).
 *
 * Usage:
 *   node ./node_modules/tsx/dist/cli.mjs scripts/_r29RustBackboneValidate.ts
 *
 * Wall-clock: ~10-15 min (TS sweeps are the bottleneck).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import * as cfgModule from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";

const CACHE_DIR = "scripts/cache_bakeoff";
const RUST_BIN = "engine-rust/target/release/ftmo-sweep";
const STEP_DAYS = 14;
const WINDOWS = 200;

interface ConfigCase {
  rustSelector: string;
  tsConst: string;
  symbols: string[];
  label: string;
}

const CASES: ConfigCase[] = [
  {
    rustSelector: "2h-trend-v5-r28-v6-passlock",
    tsConst: "FTMO_DAYTRADE_24H_R28_V6_PASSLOCK",
    symbols: [
      "AAVEUSDT",
      "ADAUSDT",
      "BCHUSDT",
      "BNBUSDT",
      "BTCUSDT",
      "ETCUSDT",
      "ETHUSDT",
      "LTCUSDT",
      "XRPUSDT",
    ],
    label: "R28_V6_PASSLOCK (9 assets)",
  },
  {
    rustSelector: "2h-trend-v5-titanium",
    tsConst: "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM",
    symbols: [
      "ETHUSDT",
      "BTCUSDT",
      "BNBUSDT",
      "ADAUSDT",
      "DOGEUSDT",
      "AVAXUSDT",
      "LTCUSDT",
      "BCHUSDT",
      "AAVEUSDT",
      "XRPUSDT",
      "INJUSDT",
      "RUNEUSDT",
      "ETCUSDT",
      "SANDUSDT",
    ],
    label: "V5_TITANIUM (14 assets)",
  },
  {
    rustSelector: "2h-trend-v5-amber",
    tsConst: "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER",
    symbols: [
      "ETHUSDT",
      "BTCUSDT",
      "BNBUSDT",
      "ADAUSDT",
      "DOGEUSDT",
      "AVAXUSDT",
      "LTCUSDT",
      "BCHUSDT",
      "AAVEUSDT",
      "XRPUSDT",
      "INJUSDT",
      "ETCUSDT",
      "SANDUSDT",
    ],
    label: "V5_AMBER (13 assets, drops RUNE)",
  },
  {
    rustSelector: "2h-trend-v5-titanium-passlock",
    tsConst: "FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK",
    symbols: [
      "ETHUSDT",
      "BTCUSDT",
      "BNBUSDT",
      "ADAUSDT",
      "DOGEUSDT",
      "AVAXUSDT",
      "LTCUSDT",
      "BCHUSDT",
      "AAVEUSDT",
      "XRPUSDT",
      "INJUSDT",
      "RUNEUSDT",
      "ETCUSDT",
      "SANDUSDT",
    ],
    label: "TITANIUM_PASSLOCK (14 assets, R10)",
  },
  {
    rustSelector: "r28_v6_passlock_frmed",
    tsConst: "FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_FRMED",
    symbols: [
      "AAVEUSDT",
      "ADAUSDT",
      "BCHUSDT",
      "BNBUSDT",
      "BTCUSDT",
      "ETCUSDT",
      "ETHUSDT",
      "LTCUSDT",
      "XRPUSDT",
    ],
    label: "R28_V6_PASSLOCK_FRMED (funding-filter)",
  },
];

interface SweepResult {
  passed: number;
  total: number;
  pct: number;
  walltime_s: number;
}

function runRust(c: ConfigCase): SweepResult | null {
  const t0 = Date.now();
  const res = spawnSync(
    RUST_BIN,
    [
      "--candles-dir",
      CACHE_DIR,
      "--symbols",
      c.symbols.join(","),
      "--config",
      c.rustSelector,
      "--windows",
      String(WINDOWS),
      "--step-days",
      String(STEP_DAYS),
      "--signals",
      "per-asset",
    ],
    { encoding: "utf-8" },
  );
  if (res.status !== 0) {
    console.error(`Rust ${c.rustSelector} FAILED:`, res.stderr ?? res.stdout);
    return null;
  }
  const m = res.stdout.match(/passed=(\d+)\s*\/\s*(\d+)\s*\(([\d.]+)%\)/);
  if (!m) {
    console.error(`Rust ${c.rustSelector} — could not parse output`);
    return null;
  }
  return {
    passed: parseInt(m[1]!, 10),
    total: parseInt(m[2]!, 10),
    pct: parseFloat(m[3]!),
    walltime_s: (Date.now() - t0) / 1000,
  };
}

function loadAlignedTs(symbols: string[]) {
  const data: Record<string, Candle[]> = {};
  for (const s of symbols) {
    const p = `${CACHE_DIR}/${s}_30m.json`;
    if (!existsSync(p)) {
      throw new Error(`missing candles ${p}`);
    }
    data[s] = JSON.parse(readFileSync(p, "utf-8"));
  }
  const sets = symbols.map((s) => new Set(data[s]!.map((c) => c.openTime)));
  const common = [...sets[0]!]
    .filter((t) => sets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s]!.filter((c) => cs.has(c.openTime));
  const fundingByAsset: Record<string, (number | null)[]> = {};
  for (const s of symbols) {
    const fp = `${CACHE_DIR}/${s}_funding.json`;
    if (existsSync(fp)) {
      const f: { t: number; r: number }[] = JSON.parse(
        readFileSync(fp, "utf-8"),
      );
      const out: (number | null)[] = new Array(aligned[s]!.length);
      let fIdx = 0;
      let cur: number | null = null;
      for (let i = 0; i < aligned[s]!.length; i++) {
        const t = aligned[s]![i]!.openTime;
        while (fIdx < f.length && f[fIdx]!.t <= t) {
          cur = f[fIdx]!.r;
          fIdx++;
        }
        out[i] = cur;
      }
      fundingByAsset[s] = out;
    } else {
      fundingByAsset[s] = new Array(aligned[s]!.length).fill(null);
    }
  }
  return {
    aligned,
    fundingByAsset,
    minBars: Math.min(...symbols.map((s) => aligned[s]!.length)),
  };
}

function runTs(c: ConfigCase): SweepResult | null {
  const cfg = (cfgModule as Record<string, unknown>)[c.tsConst];
  if (!cfg || typeof cfg !== "object") {
    console.error(`TS const ${c.tsConst} not found`);
    return null;
  }
  const t0 = Date.now();
  const { aligned, fundingByAsset, minBars } = loadAlignedTs(c.symbols);
  const ftmoCfg =
    cfg as (typeof cfgModule)["FTMO_DAYTRADE_24H_R28_V6_PASSLOCK"];
  const winBars = ftmoCfg.maxDays * 48;
  const stepBars = STEP_DAYS * 48;
  const WARMUP = 5000;
  let passed = 0;
  let total = 0;
  for (
    let start = WARMUP;
    start + winBars <= minBars && total < WINDOWS;
    start += stepBars
  ) {
    const trimmed: Record<string, Candle[]> = {};
    const trimmedFunding: Record<string, (number | null)[]> = {};
    for (const k of Object.keys(aligned)) {
      trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
      trimmedFunding[k] = fundingByAsset[k]!.slice(
        start - WARMUP,
        start + winBars,
      );
    }
    const r = simulate(
      trimmed,
      ftmoCfg,
      WARMUP,
      WARMUP + winBars,
      c.tsConst,
      trimmedFunding,
    );
    if (r.passed) passed++;
    total++;
  }
  return {
    passed,
    total,
    pct: total > 0 ? (passed / total) * 100 : 0,
    walltime_s: (Date.now() - t0) / 1000,
  };
}

console.log("Rust Backbone Validation — 5 configs × {Rust, TS} drift table");
console.log("=".repeat(80));
const rows: Array<{
  label: string;
  rustPct: number | null;
  rustWall: number | null;
  tsPct: number | null;
  tsWall: number | null;
  drift: number | null;
}> = [];

for (const c of CASES) {
  console.log(`\n>>> ${c.label}`);
  console.log(`    Rust selector: ${c.rustSelector}`);
  const rust = runRust(c);
  if (rust) {
    console.log(
      `    Rust: ${rust.passed}/${rust.total} = ${rust.pct.toFixed(2)}% in ${rust.walltime_s.toFixed(1)}s`,
    );
  }
  const ts = runTs(c);
  if (ts) {
    console.log(
      `    TS:   ${ts.passed}/${ts.total} = ${ts.pct.toFixed(2)}% in ${ts.walltime_s.toFixed(1)}s`,
    );
  }
  const drift = rust && ts ? rust.pct - ts.pct : null;
  rows.push({
    label: c.label,
    rustPct: rust?.pct ?? null,
    rustWall: rust?.walltime_s ?? null,
    tsPct: ts?.pct ?? null,
    tsWall: ts?.walltime_s ?? null,
    drift,
  });
}

console.log("\n" + "=".repeat(80));
console.log("DRIFT SUMMARY");
console.log("=".repeat(80));
console.log(
  "Config".padEnd(38),
  "Rust%".padStart(8),
  "TS%".padStart(8),
  "Δpp".padStart(8),
  "RustS".padStart(7),
  "TSs".padStart(7),
  "Speedup",
);
let allOk = true;
for (const r of rows) {
  const driftStr = r.drift !== null ? r.drift.toFixed(2) : "n/a";
  const okMark = r.drift !== null && Math.abs(r.drift) <= 5 ? "✓" : "✗";
  if (r.drift === null || Math.abs(r.drift) > 5) allOk = false;
  const speedup =
    r.rustWall && r.tsWall ? `${(r.tsWall / r.rustWall).toFixed(0)}×` : "—";
  console.log(
    r.label.padEnd(38),
    (r.rustPct?.toFixed(2) ?? "—").padStart(8),
    (r.tsPct?.toFixed(2) ?? "—").padStart(8),
    `${driftStr}${okMark}`.padStart(8),
    (r.rustWall?.toFixed(1) ?? "—").padStart(7),
    (r.tsWall?.toFixed(1) ?? "—").padStart(7),
    speedup,
  );
}

console.log(
  "\nVerdict:",
  allOk
    ? "✓ ALL within ±5pp — backbone permanent-ready"
    : "✗ Drift > 5pp on at least one config",
);
process.exit(allOk ? 0 : 1);
