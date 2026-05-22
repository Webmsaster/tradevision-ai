# Session Handoff - 2026-05-22

## What was done

Branch `feature/r28-deploy` (continuation after the 2026-05-21 bug-round). Focus this session: **verify the bug-fixes, get honest numbers, then hunt for improvements.**

1. **PTP-fix verification (HANDOFF step 2):** Rebuilt `ftmo-sweep` with the `exit.rs` PTP-cost fix (was stale). A/B vs pre-fix binary on the AMBER_MAX_PASSLOCK champion → **pass-rate-NEUTRAL** (52.35% both; equity higher in 43/1022 windows but 0 pass/fail flips). Fix is correct, just doesn't move aggregate pass-rate.
2. **Full E2E run (HANDOFF step 3):** 23 failures → fixed to **60/60 green, 0 skip**. Found **1 real app bug** (`import/page.tsx` sample-trade UUIDs missing `sample-` prefix → "Sample data loaded" indicator never showed) + 3 stale-test classes + un-fixme'd 2 widget tests (false-alarm, was a test-timing race). TS unit 1257 ✓, tsc 0 ✓.
3. **Pushed + PR (HANDOFF step 1):** branch pushed to origin; PR #71 (→ main) retitled + status comment.
4. **Honest pass-rate measurements (fresh, bug-free engine):** single-account combined-funded (P1∧P2 **true sequential**) = **33.1%** (the same-window proxy's 50.3% was misleading — P2|P1=96.5% was a same-window artifact; real sequential P2|P1=63%). Cluster-gate gives **0 uplift** (the 91.8% `qualified_at_start` is lookahead). 2-stack AMBER+RUBIN only 39.5% (corr +0.48, not orthogonal).
5. **Funded-phase + profit economics:** continuous funded trading busts **99%** over 90-180d (edge is front-loaded, ~4-day cluster). Burst-withdrawal model (+5% take-profit → bank → repeat) → full pipeline net **~$6,550/mo (6.55%) on $100k** (backtest).
6. **8-agent improvement hunt** — found 2 real wins + 5 confirmed dead-ends (see Next steps / memory).

## Current state

- **All test suites green:** Rust workspace ✓, TS unit 1257 ✓, E2E 60/60 ✓, tsc 0. Python pytest unchanged (not touched this session).
- **Branch fully pushed**, PR #71 open (NOT merged — user's merge call, 157 commits / 487 files vs main).
- **2 verified improvements found:**
  1. **Funded profit-take +8% instead of +5%** → full-pipeline net **~$10,800/mo (10.8%) on $100k backtest** (+65% vs +5%). ⚠️ IN-SAMPLE — needs walk-forward before live.
  2. **Orthogonal 3-stack AMBER + BIDIR + MR = 47.4% combined-funded** (vs 33% single / 39.5% old correlated). Decorrelation via different SIGNAL CLASSES (trend-long / long-short / mean-revert), corr ≈ 0.

## Next steps (priority-ordered)

1. **Walk-forward-validate the +8% funded target** (split in-sample/out-of-sample). The $10.8k/mo is a single in-sample number; the +8% reach may be regime-specific. This is the #1 thing to confirm before trusting the new profit figure.
2. **Decide on PR #71 merge** to main (user's call).
3. If deploying: follow `tools/PASSLOCK_DEPLOY_RUNBOOK.md` — run `signal_tracker_mode.py` warmup, deploy the 3 orthogonal strategies as separate MT5 accounts, set funded take-profit to +8%, withdraw + pause after each bank (NEVER trade funded continuously → 99% bust).
4. Optional engine TODO: add a window-start-timestamp field to sweep JSONL so cross-config stacks with different window grids (TITANIUM etc.) can be date-joined honestly.

## Open issues / blockers

- **No blockers.** Honest deploy reality (bug-free, fresh): single-account ~33% funded / ~4-6%/mo at +5% or ~7-8%/mo live at +8%; orthogonal 3-stack 47% funded-prob. **Far below the old memory headlines (75-90%)** — those were lookahead/proxy/grid-misalignment artifacts, all corrected this session.
- **+8% funded target is in-sample** — do not trust the $10.8k/mo until walk-forward.
- **Pre-existing WIP NOT from this session** (left untouched, were M/?? before): `.env.ftmo.*.example`, `scripts/ftmo_timing_supervisor.py`, `scripts/macro_regime_audit.py`, `scripts/real_funded_prob.py`, `tools/ecosystem.config.js`, `tools/promote_to_step2.sh`, `tools/signal_tracker_mode.py`, various `scripts/_hunt2026_05_19/20_*.sh`, `state/*`.

## Key files changed (this session, committed)

- `src/app/import/page.tsx` — sample-trade UUID `sample-` prefix fix (real app bug).
- `e2e/helpers.ts` — `canonicalPair()` helper; `createTestTrade` returns canonical pair.
- `e2e/trade-crud.spec.ts`, `e2e/trade-form.spec.ts` — canonical-pair assertions + exact Delete button.
- `e2e/multi-account.spec.ts` — account-remove by exact aria-label (AccountSwitcher collision fix).
- `e2e/settings.spec.ts` — un-fixme'd 2 widget tests, auto-retrying assertions.
- Analysis sweep scripts (committed): `scripts/_ptp_fix_ab_`, `_combined_p1p2_`, `_combined_clustergate_`, `_stack3_funded_`, `_funded_phase_`, `_funded_burst_2026_05_22.sh`.
- `scripts/_hunt_p1_knobs_/_parallel_2026_05_22.sh` — P1-knob hunt (agent-created).

## Resume

- Full detail: memory `project_session_2026_05_21_50agent_bug_round.md` (all 2026-05-22 addenda).
- Branch: `feature/r28-deploy`. PR #71. Hunt data in `scripts/cache_bakeoff/hunt_*` (gitignored).
