/**
 * Step-2 Grid Aggregator — combines 8 grid-shard JSONLs and ranks all
 * 32 (tp_mult × dpt × target) combos by joint pass-rate.
 *
 * Usage: npx tsx scripts/_step2GridAggregate.ts
 */
import { readFileSync, readdirSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";

interface Row {
  win_idx: number;
  tp_mult?: number;
  dpt?: number;
  target?: number;
  step1_passed: boolean;
  step2_passed?: boolean;
  step2_eq?: number;
  step2_reason?: string;
  joint_pass?: boolean;
}

const rows: Row[] = [];
for (const f of readdirSync(CACHE_DIR)) {
  if (!/^step2_grid_shard_\d+\.jsonl$/.test(f)) continue;
  const raw = readFileSync(`${CACHE_DIR}/${f}`, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
}
console.log(`[grid-aggregate] loaded ${rows.length} rows`);

// Step-1 windows = unique win_idx where step1_passed=true.
const step1Total = new Set(rows.map((r) => r.win_idx)).size;
const step1Passed = new Set(
  rows.filter((r) => r.step1_passed).map((r) => r.win_idx),
).size;

interface PerCombo {
  total: number;
  joint_pass: number;
  step2_eqs: number[];
  fail_reasons: Record<string, number>;
}
const perCombo = new Map<string, PerCombo>();
function key(tp: number, dpt: number, t: number): string {
  return `${tp.toFixed(2)}|${dpt.toFixed(3)}|${t.toFixed(2)}`;
}
for (const r of rows) {
  if (!r.step1_passed) continue;
  if (r.tp_mult == null || r.dpt == null || r.target == null) continue;
  const k = key(r.tp_mult, r.dpt, r.target);
  if (!perCombo.has(k)) {
    perCombo.set(k, {
      total: 0,
      joint_pass: 0,
      step2_eqs: [],
      fail_reasons: {},
    });
  }
  const m = perCombo.get(k)!;
  m.total++;
  if (r.joint_pass) m.joint_pass++;
  if (r.step2_eq != null) m.step2_eqs.push(r.step2_eq);
  if (r.step2_reason && !r.joint_pass) {
    m.fail_reasons[r.step2_reason] = (m.fail_reasons[r.step2_reason] ?? 0) + 1;
  }
}

interface RankedCombo {
  tp_mult: number;
  dpt: number;
  target: number;
  step1_total: number;
  step2_total: number;
  step2_pass: number;
  step2_pass_rate: number;
  joint_pass_rate: number; // step2_pass / step1_total
  median_eq: number;
  top_fail: string | null;
}
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const ranked: RankedCombo[] = [];
for (const [k, v] of perCombo.entries()) {
  const [tp, dpt, t] = k.split("|").map(Number);
  const topFail = Object.entries(v.fail_reasons).sort((a, b) => b[1] - a[1])[0];
  ranked.push({
    tp_mult: tp!,
    dpt: dpt!,
    target: t!,
    step1_total: step1Total,
    step2_total: v.total,
    step2_pass: v.joint_pass,
    step2_pass_rate: v.total ? v.joint_pass / v.total : 0,
    joint_pass_rate: step1Total ? v.joint_pass / step1Total : 0,
    median_eq: median(v.step2_eqs),
    top_fail: topFail ? `${topFail[0]} (${topFail[1]})` : null,
  });
}
ranked.sort((a, b) => b.joint_pass_rate - a.joint_pass_rate);

console.log(
  `\nStep-1 windows: ${step1Passed}/${step1Total} = ${((step1Passed / Math.max(1, step1Total)) * 100).toFixed(2)}%`,
);
console.log(
  `\n=== Round 65 Grid Sweep — ranked by joint pass-rate (top 20) ===\n`,
);
console.log(
  `${"rank".padEnd(5)} ${"tp_mult".padEnd(8)} ${"dpt".padEnd(8)} ${"target".padEnd(7)} ${"S2 cond".padEnd(15)} ${"JOINT".padEnd(15)} ${"med eq".padEnd(10)} top fail`,
);
console.log("-".repeat(95));
ranked.slice(0, 20).forEach((r, i) => {
  console.log(
    `${(i + 1).toString().padEnd(5)} ${r.tp_mult.toFixed(2).padEnd(8)} ${r.dpt.toFixed(3).padEnd(8)} ${r.target.toFixed(2).padEnd(7)} ${`${(r.step2_pass_rate * 100).toFixed(2)}%`.padEnd(15)} ${`${(r.joint_pass_rate * 100).toFixed(2)}%`.padEnd(15)} ${(r.median_eq * 100).toFixed(2).padEnd(10)} ${r.top_fail ?? "—"}`,
  );
});

// Documented baseline (R28_V6_STEP2): 77.86% conditional, profit_target=0.05.
const baseline = 0.7786;
const top = ranked[0]!;
console.log(
  `\n🏆 Round 65 Grid-Champion: tp_mult=${top.tp_mult} dpt=${top.dpt} target=${top.target}`,
);
console.log(
  `   Step-2 conditional: ${(top.step2_pass_rate * 100).toFixed(2)}% vs baseline 77.86% — `,
  top.step2_pass_rate >= baseline ? "✅ improvement" : "❌ no improvement",
);
console.log(`   Joint pass-rate: ${(top.joint_pass_rate * 100).toFixed(2)}%`);
console.log(
  `   Multi-account math (3-Strategy): ${((1 - Math.pow(1 - top.joint_pass_rate, 3)) * 100).toFixed(2)}% min-1-pass`,
);
