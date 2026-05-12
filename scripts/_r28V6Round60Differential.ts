/**
 * Differential analysis: PASSLOCK vs R28_V6 baseline window-by-window.
 *
 * Categories per shared winIdx:
 *   - BOTH_PASS (control)
 *   - PASSLOCK_FLIPS_FAIL_TO_PASS  ← desired: passlock helps
 *   - PASSLOCK_FLIPS_PASS_TO_FAIL  ← bad: passlock hurts (theoretically impossible)
 *   - BOTH_FAIL  (passlock didn't help here)
 *
 * Same for COMBO_PL_IDLT vs PASSLOCK to diagnose where IDLT hurts.
 */
import { readFileSync, existsSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";

interface Result {
  winIdx: number;
  passed: boolean;
  reason: string;
}

function loadVariant(prefix: string, suffix = "_shard_"): Map<number, Result> {
  const m = new Map<number, Result>();
  for (let s = 0; s < 8; s++) {
    const f = `${CACHE_DIR}/${prefix}${suffix}${s}.jsonl`;
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
  // Shared windows only.
  const sharedIdx = [...a.keys()].filter((i) => b.has(i)).sort((x, y) => x - y);
  const cats = {
    bothPass: [] as Result[],
    aOnlyPass: [] as { idx: number; bReason: string }[],
    bOnlyPass: [] as { idx: number; aReason: string }[],
    bothFail: [] as { idx: number; aReason: string; bReason: string }[],
  };
  for (const i of sharedIdx) {
    const ra = a.get(i)!;
    const rb = b.get(i)!;
    if (ra.passed && rb.passed) cats.bothPass.push(ra);
    else if (ra.passed && !rb.passed)
      cats.aOnlyPass.push({ idx: i, bReason: rb.reason });
    else if (!ra.passed && rb.passed)
      cats.bOnlyPass.push({ idx: i, aReason: ra.reason });
    else cats.bothFail.push({ idx: i, aReason: ra.reason, bReason: rb.reason });
  }
  console.log(
    `\n=== ${bLabel} vs ${aLabel} (shared n=${sharedIdx.length}) ===`,
  );
  console.log(`  BOTH_PASS:           ${cats.bothPass.length}`);
  console.log(
    `  ${bLabel.padEnd(15)} ONLY:  ${cats.bOnlyPass.length}  ← ${bLabel} flips fail→pass (desired)`,
  );
  console.log(
    `  ${aLabel.padEnd(15)} ONLY:  ${cats.aOnlyPass.length}  ← ${bLabel} flips pass→fail (bad)`,
  );
  console.log(`  BOTH_FAIL:           ${cats.bothFail.length}`);
  console.log(
    `  Net Δ: +${cats.bOnlyPass.length} -${cats.aOnlyPass.length} = ${cats.bOnlyPass.length - cats.aOnlyPass.length}pp shift`,
  );

  if (cats.aOnlyPass.length > 0) {
    console.log(`  ⚠️  ${aLabel}-only-pass windows (${bLabel} hurts):`);
    cats.aOnlyPass.slice(0, 5).forEach((c) => {
      console.log(`     winIdx=${c.idx}  ${bLabel}-fail-reason: ${c.bReason}`);
    });
  }
  if (cats.bOnlyPass.length > 0) {
    const reasons: Record<string, number> = {};
    cats.bOnlyPass.forEach((c) => {
      reasons[c.aReason] = (reasons[c.aReason] ?? 0) + 1;
    });
    console.log(`  Recovered from these ${aLabel} failure-modes:`);
    Object.entries(reasons)
      .sort(([, a], [, b]) => b - a)
      .forEach(([reason, count]) => {
        console.log(`     ${reason}: ${count}`);
      });
  }
}

const r28v6 = loadVariant("r28v6");
const passlock = loadVariant("r28v6_v60_passlock");
const combo = loadVariant("r28v6_v60_combo_pl_idlt");

console.log(
  `Loaded: R28_V6 baseline n=${r28v6.size}, PASSLOCK n=${passlock.size}, COMBO n=${combo.size}`,
);

diff(r28v6, passlock, "R28_V6", "PASSLOCK");
diff(passlock, combo, "PASSLOCK", "COMBO");
diff(r28v6, combo, "R28_V6", "COMBO");
