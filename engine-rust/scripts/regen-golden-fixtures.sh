#!/usr/bin/env bash
# Regenerate the TS-dumped golden fixtures from cached candles. Run from
# the repo root. Each window takes a few seconds; the full sweep dumps
# 5 fixtures totalling ~80MB into engine-rust/ftmo-engine-core/tests/golden/.
#
# These fixtures are .gitignored — regenerate after pulling main, or
# whenever the TS V4-Sim or detector logic changes.

set -euo pipefail
cd "$(dirname "$0")/../.."

WINDOWS="${WINDOWS:-0 1 2 3 4}"
CONFIG="${CONFIG:-R28_V6_PASSLOCK}"

for w in $WINDOWS; do
  out="engine-rust/ftmo-engine-core/tests/golden/r28v6_w${w}.json"
  echo "==> dumping window $w → $out"
  node ./node_modules/tsx/dist/cli.mjs scripts/dumpRustGoldenFixture.ts \
    --config "$CONFIG" --window "$w" --out "$out"
done

echo
echo "✅ regenerated $(echo $WINDOWS | wc -w) fixtures"
echo "Run drift summary: cargo test --manifest-path engine-rust/Cargo.toml --test drift_summary -- --nocapture"
