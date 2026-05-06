/**
 * Daily-Loss-Attack Aggregator — combines 8 shard JSONLs and ranks
 * all 20 (trail × pdt) configs by pass-rate.
 */
import { readFileSync, readdirSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";

interface Row {
  win_idx: number;
  trail: number;
  pdt: string;
  passed: boolean;
  eq: number;
  reason: string;
}

const rows: Row[] = [];
for (const f of readdirSync(CACHE_DIR)) {
  if (!/^daily_loss_attack_shard_\d+\.jsonl$/.test(f)) continue;
  const raw = readFileSync(`${CACHE_DIR}/${f}`, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
}
console.log(`[dl-attack-aggregate] loaded ${rows.length} rows`);

interface Combo {
  trail: number;
  pdt: string;
  total: number;
  pass: number;
  reasons: Record<string, number>;
  eqs: number[];
}
const map = new Map<string, Combo>();
for (const r of rows) {
  const k = `${r.trail.toFixed(3)}|${r.pdt}`;
  if (!map.has(k))
    map.set(k, {
      trail: r.trail,
      pdt: r.pdt,
      total: 0,
      pass: 0,
      reasons: {},
      eqs: [],
    });
  const c = map.get(k)!;
  c.total++;
  if (r.passed) c.pass++;
  c.reasons[r.reason] = (c.reasons[r.reason] ?? 0) + 1;
  c.eqs.push(r.eq);
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const ranked = [...map.values()]
  .map((c) => ({
    ...c,
    pass_rate: c.pass / Math.max(1, c.total),
    median_eq: median(c.eqs),
    daily_loss_count: c.reasons["daily_loss"] ?? 0,
  }))
  .sort((a, b) => b.pass_rate - a.pass_rate);

console.log(`\n=== Round 66 Daily-Loss-Attack — ranked by pass-rate ===\n`);
console.log(
  `${"rank".padEnd(5)} ${"trail".padEnd(8)} ${"pdt".padEnd(12)} ${"PASS".padEnd(15)} ${"med eq".padEnd(10)} ${"daily_loss"}`,
);
console.log("-".repeat(80));
ranked.forEach((c, i) => {
  console.log(
    `${(i + 1).toString().padEnd(5)} ${c.trail.toFixed(3).padEnd(8)} ${c.pdt.padEnd(12)} ${`${c.pass}/${c.total}=${(c.pass_rate * 100).toFixed(2)}%`.padEnd(15)} ${(c.median_eq * 100).toFixed(2).padEnd(10)} ${c.daily_loss_count}`,
  );
});

const champ = ranked[0]!;
const baseline = ranked.find((c) => c.trail === 0.012 && c.pdt === "none");
console.log(
  `\n🏆 Round 66 DL-Attack Champion: trail=${champ.trail} pdt=${champ.pdt}`,
);
console.log(`   Pass-Rate: ${(champ.pass_rate * 100).toFixed(2)}%`);
if (baseline) {
  const delta = (champ.pass_rate - baseline.pass_rate) * 100;
  console.log(
    `   vs R28_V6_PASSLOCK baseline (trail=0.012/none): ${(baseline.pass_rate * 100).toFixed(2)}% → ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}pp ${delta > 0 ? "✅" : "❌"}`,
  );
}
console.log(
  `   Daily-loss fails reduced: ${baseline ? baseline.daily_loss_count - champ.daily_loss_count : 0}`,
);
