/**
 * Round 61 Differential analysis: Day-Risk variants vs PASSLOCK baseline.
 *
 * Per shared winIdx:
 *   - BOTH_PASS (no effect)
 *   - DR_FLIPS_FAIL_TO_PASS  ← Day-Risk helps
 *   - DR_FLIPS_PASS_TO_FAIL  ← Day-Risk hurts
 *   - BOTH_FAIL (Day-Risk doesn't help here)
 */
import { readFileSync, existsSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";

interface Result {
  winIdx: number;
  passed: boolean;
  reason: string;
}

function loadVariant(prefix: string): Map<number, Result> {
  const m = new Map<number, Result>();
  for (let s = 0; s < 8; s++) {
    const f = `${CACHE_DIR}/r28v6_v61_${prefix}_shard_${s}.jsonl`;
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        m.set(o.winIdx, {
          winIdx: o.winIdx,
          passed: !!o.passed,
          reason: o.reason ?? "",
        });
      } catch {}
    }
  }
  return m;
}

function diff(
  a: Map<number, Result>,
  b: Map<number, Result>,
  aLabel: string,
  bLabel: string,
) {
  const sharedIdx = [...a.keys()].filter((i) => b.has(i)).sort((x, y) => x - y);
  const cats = {
    bothPass: 0,
    aOnlyPass: [] as { idx: number; bReason: string }[],
    bOnlyPass: [] as { idx: number; aReason: string }[],
    bothFail: 0,
  };
  for (const i of sharedIdx) {
    const ra = a.get(i)!;
    const rb = b.get(i)!;
    if (ra.passed && rb.passed) cats.bothPass++;
    else if (ra.passed && !rb.passed)
      cats.aOnlyPass.push({ idx: i, bReason: rb.reason });
    else if (!ra.passed && rb.passed)
      cats.bOnlyPass.push({ idx: i, aReason: ra.reason });
    else cats.bothFail++;
  }
  console.log(
    `\n=== ${bLabel} vs ${aLabel} (shared n=${sharedIdx.length}) ===`,
  );
  console.log(`  BOTH_PASS:           ${cats.bothPass}`);
  console.log(
    `  ${bLabel.padEnd(15)} ONLY:  ${cats.bOnlyPass.length}  ← ${bLabel} flips fail→pass`,
  );
  console.log(
    `  ${aLabel.padEnd(15)} ONLY:  ${cats.aOnlyPass.length}  ← ${bLabel} flips pass→fail`,
  );
  console.log(`  BOTH_FAIL:           ${cats.bothFail}`);
  const net = cats.bOnlyPass.length - cats.aOnlyPass.length;
  console.log(
    `  Net Δ: +${cats.bOnlyPass.length} -${cats.aOnlyPass.length} = ${net >= 0 ? "+" : ""}${net} windows`,
  );

  if (cats.aOnlyPass.length > 0) {
    console.log(`  ⚠️  ${aLabel}-only-pass windows (${bLabel} hurts):`);
    cats.aOnlyPass.slice(0, 5).forEach((c) => {
      console.log(`     winIdx=${c.idx}  ${bLabel} fail-reason: ${c.bReason}`);
    });
  }
  if (cats.bOnlyPass.length > 0) {
    const reasons: Record<string, number> = {};
    cats.bOnlyPass.forEach((c) => {
      reasons[c.aReason] = (reasons[c.aReason] ?? 0) + 1;
    });
    console.log(`  Recovered failure modes:`);
    Object.entries(reasons)
      .sort(([, a], [, b]) => b - a)
      .forEach(([reason, count]) => console.log(`     ${reason}: ${count}`));
  }
}

const baseline = loadVariant("passlock_baseline");
const dr50 = loadVariant("passlock_dr50");
const dr70 = loadVariant("passlock_dr70");
const dr502d = loadVariant("passlock_dr50_2d");

console.log(
  `Loaded: baseline n=${baseline.size}, dr50 n=${dr50.size}, dr70 n=${dr70.size}, dr50_2d n=${dr502d.size}`,
);

diff(baseline, dr50, "PASSLOCK", "DR50");
diff(baseline, dr70, "PASSLOCK", "DR70");
diff(baseline, dr502d, "PASSLOCK", "DR50_2D");
