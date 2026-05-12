#!/bin/bash
# R29 Hunt — autonomous multi-phase pass-rate hunt to 65% bug-free.
# Phases:
#   1  — sweep all existing configs at step=14
#   1b — parameter grid on V5_TITANIUM_PASSLOCK
#   2  — cross-step audit (3/7/14/21/28) on top 3 candidates
#   3  — walk-forward 4-quartile audit on candidates ≥58% step=7
# Bug-hunt threshold: any candidate ≥65% on step=7 with <8pp quartile spread
# triggers Phase 4 (deep-audit).
set -euo pipefail
cd "$(dirname "$0")/.."

# Require gawk (3-arg match()). Bail early on POSIX-only awk to avoid silent
# parse failure that previously produced empty TOP_CONFIGS lists.
if ! awk 'BEGIN{ if (match("a", /a/, _)) exit 0; exit 1 }' 2>/dev/null; then
  echo "ERROR: gawk required (3-arg match). Install gawk." >&2
  exit 2
fi

# Verify Rust sweep binary exists before kicking off long-running phases.
if [ ! -x ./engine-rust/target/release/ftmo-sweep ]; then
  echo "ERROR: ./engine-rust/target/release/ftmo-sweep missing or not executable." >&2
  echo "Build it via: cargo build --release --manifest-path engine-rust/Cargo.toml" >&2
  exit 3
fi

MASTER_LOG="/tmp/hunt_master_$$.log"
MASTER_LOG_FINAL=/tmp/hunt_master.log
: > "$MASTER_LOG"
trap 'cp -f "$MASTER_LOG" "$MASTER_LOG_FINAL" 2>/dev/null || true; rm -f "$MASTER_LOG.partial"' EXIT INT TERM

phase() {
  echo "" | tee -a "$MASTER_LOG"
  echo "############ $1 @ $(date +%T) ############" | tee -a "$MASTER_LOG"
}

# Phase 1 — was previously never invoked by the orchestrator, so /tmp/hunt_phase1.log
# stayed empty and TOP_CONFIGS came out blank. Always run if log absent.
if [ ! -s /tmp/hunt_phase1.log ]; then
  phase "PHASE 1 — config sweep"
  bash scripts/_huntPhase1.sh 2>&1 | tail -25 | tee -a "$MASTER_LOG"
fi

# Phase 1b runs independently, can be skipped if it's already done
if [ ! -s /tmp/hunt_phase1b.log ]; then
  phase "PHASE 1b — parameter grid"
  bash scripts/_huntPhase1b.sh 2>&1 | tail -25 | tee -a "$MASTER_LOG"
fi

# Combine Phase 1 + 1b results, pick top candidates ≥56% to forward to Phase 2
phase "PHASE 1+1b RANKING"
{
  grep -B1 "passed=" /tmp/hunt_phase1.log 2>/dev/null || true
  grep -B1 "passed=" /tmp/hunt_phase1b.log 2>/dev/null || true
} | paste -d'|' - - | awk -F'|' '{
  match($1, /=== ([^ ]+) /, lab);
  match($2, /\(([0-9.]+)%\)/, pct);
  if (lab[1] != "" && pct[1] != "") print pct[1] "  " lab[1];
}' | sort -rn | tee /tmp/hunt_ranked.txt | head -15 | tee -a "$MASTER_LOG"

# Pick candidates: any TEMPLATE config (not parameter override) ≥ 56%.
# Parameter overrides need re-validation through env-flagged sweeps.
TOP_CONFIGS=$(grep -B1 "passed=" /tmp/hunt_phase1.log 2>/dev/null | paste -d'|' - - | awk -F'|' '{
  match($1, /=== ([^ ]+) /, lab);
  match($2, /\(([0-9.]+)%\)/, pct);
  if (lab[1] != "" && pct[1] + 0 >= 56) print pct[1] " " lab[1];
}' | sort -rn | awk '{print $2}' | head -3)

if [ -z "$TOP_CONFIGS" ]; then
  echo "No Phase 1 candidates ≥56% found — aborting before Phase 2." | tee -a "$MASTER_LOG"
  exit 0
fi

# Validate each TOP_CONFIGS entry — reject any name with whitespace/special chars
# (newline-separated; word-splitting intentional below).
while IFS= read -r cfg; do
  [ -z "$cfg" ] && continue
  [[ "$cfg" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ERROR: bad cfg name from Phase 1 rank: '$cfg'" >&2; exit 1; }
done <<< "$TOP_CONFIGS"

phase "PHASE 2 — cross-step on top configs: $TOP_CONFIGS"
# shellcheck disable=SC2086  # intentional word-split of newline-separated configs
bash scripts/_huntPhase2.sh $TOP_CONFIGS 2>&1 | tail -50 | tee -a "$MASTER_LOG"

# Phase 3 walk-forward on whichever survived Phase 2 with ≥58% step=7.
# Phase 2 emits label "=== cfg @ step=N ===" then "<bars/trades>" then "passed=".
# Previously `grep -B1 "@ step=7"` returned only the label — no pct field — and
# SURVIVORS was empty. Use -A2 to grab the passed= line, then pair them.
phase "PHASE 3 — walk-forward audit"
SURVIVORS=$(grep -A2 "@ step=7 ===" /tmp/hunt_phase2.log 2>/dev/null \
  | grep -E "=== |passed=" \
  | paste -d'|' - - | awk -F'|' '{
      match($1, /=== ([^ ]+) @/, lab);
      match($2, /\(([0-9.]+)%\)/, pct);
      if (lab[1] != "" && pct[1] + 0 >= 58) print lab[1];
    }' | sort -u)
echo "Survivors: $SURVIVORS" | tee -a "$MASTER_LOG"
for cfg in $SURVIVORS; do
  # Validate survivor name before feeding to subshell scripts
  [[ "$cfg" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ERROR: bad survivor cfg name: '$cfg'" >&2; exit 1; }
  bash scripts/_huntPhase3.sh "$cfg" 2>&1 | tail -15 | tee -a "$MASTER_LOG"
done

phase "ORCHESTRATOR DONE"
echo "Logs: /tmp/hunt_phase{1,1b,2,3}.log + /tmp/hunt_master.log" | tee -a "$MASTER_LOG"
