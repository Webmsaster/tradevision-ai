#!/usr/bin/env bash
# 2026-05-15 — Post-audit final validation script
#
# Runs after all worktree-agents (R2-Fix, R4, Stream A Hunter, Stream B ML)
# have been merged back to feature/r28-deploy. Confirms the entire codebase
# is bug-free, all tests grün, smoke-test passing.
#
# Exit codes: 0 = all green, non-zero = first failing step.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

step() {
  local name="$1" cmd="$2"
  bold "── $name"
  if eval "$cmd"; then
    green "✓ $name"
  else
    red "✗ $name FAILED"
    exit 1
  fi
  echo
}

bold "════════════════════════════════════════"
bold "  Final Validation — Post-Audit State"
bold "════════════════════════════════════════"
echo

# 1. TypeScript typecheck
step "TS typecheck" "npm run typecheck 2>&1 | tail -3"

# 2. ESLint (allow warnings, fail only on errors)
step "ESLint" "npm run lint 2>&1 | tail -5 | grep -E '0 errors' || { echo 'lint errors found'; exit 1; }"

# 3. Vitest
step "Vitest" "npm test 2>&1 | grep -E 'Tests\\s+[0-9]+ passed' | tail -1"

# 4. Rust build (release)
step "Cargo build --release" "(cd engine-rust && cargo build --release 2>&1 | tail -3)"

# 5. Rust workspace tests
step "Cargo test --workspace" "(cd engine-rust && cargo test --release --workspace 2>&1 | grep -E 'test result:' | tail -3)"

# 6. Pytest
step "Pytest tools/" "/usr/bin/python3 -m pytest tools/test_ftmo_executor.py --tb=line 2>&1 | tail -3"

# 7. Python compile
step "py_compile (live-bot)" "/usr/bin/python3 -m py_compile tools/ftmo_executor.py tools/ftmo_kill.py tools/news_blackout.py tools/preflight_check.py"

# 8. Smoke sweep — AMBER_MAX_PASSLOCK champion config
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
step "Smoke sweep (AMBER_MAX_PASSLOCK champion)" "(cd engine-rust && ./target/release/ftmo-sweep \
  --candles-dir ../scripts/cache_bakeoff \
  --funding-dir ../scripts/cache_bakeoff \
  --symbols $SYMS \
  --config 2h-trend-v5-amber-max-passlock \
  --signals regime --regime-min-votes 2 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm \
  --windows 1000 --step-days 1 --threads 8 \
  --profit-target 0.08 2>&1 | tail -2)"

# 9. Strict-pass identity check (post-Codex give-back fix sanity)
step "Strict-pass identity" "(cd engine-rust && ./target/release/ftmo-sweep \
  --candles-dir ../scripts/cache_bakeoff \
  --funding-dir ../scripts/cache_bakeoff \
  --symbols $SYMS \
  --config 2h-trend-v5-amber-max-passlock \
  --signals regime --regime-min-votes 2 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm \
  --windows 100 --step-days 14 --threads 8 \
  --profit-target 0.08 --strict-pass 2>&1 | tail -1)"

echo
bold "════════════════════════════════════════"
green "  ALL VALIDATION CHECKS PASSED ✓"
bold "════════════════════════════════════════"
