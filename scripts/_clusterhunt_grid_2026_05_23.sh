#!/bin/bash
# 2026-05-23 CLUSTER-GATE GRID SWEEP — lookahead-safe true-sequential combined-funded.
#
# Background: Live default is breadth=4 / majors=3 ("b4m3"). Audit 2026-05-22 showed
# 0pp uplift on TRUE-SEQUENTIAL combined-funded vs ungated (both ~33.1% on AMBER_MAX_PASSLOCK).
# The old cluster_audit/grid_*.jsonl files used qualified_at_start which is LOOKAHEAD
# (forward-window). This sweep uses --cluster-only-mode (trailing 24h) which mirrors
# the live executor's check_cluster_entry_block — the only honest gate.
#
# Grid: 5 breadth x 4 majors = 20 cells. Sweep P1 + P2 per cell, then TRUE-SEQUENTIAL
# combined funded via P1 final_day -> P2 win start. Aim: any cell with combined > ~36%
# beats current orthogonal-stack member by 3pp+.
#
# Runtime estimate: per cell P1 (30d max) ~5min + P2 (60d max) ~10min = ~15min/cell
# at --threads 8 single-process. 20 cells SERIAL = ~5h; with --threads 4 + 2 parallel
# cells = ~2.5h. Recommend serial overnight (no thrash). Memory ~3 GB per sweep.
#
# DO NOT START CONCURRENT — only one binary at a time. Run with `bash scripts/_clusterhunt_grid_2026_05_23.sh` in tmux.

set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/clusterhunt_2026_05_23
mkdir -p "$OUT"

SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

# Common args identical to _combined_clustergate_2026_05_22.sh EXCEPT the GATE
COMMON_PRE="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMBOLS \
  --windows 9999 --step-days 1 --threads 8 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --config 2h-trend-v5-amber-max-passlock \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  --strict-pass"

BREADTHS=(3 4 5 6 8)
MAJORS=(1 2 3 4)

SUMMARY="$OUT/_summary.tsv"
echo -e "cell\twindows\tP1_pct\tP2_marg_pct\tP2_given_P1_pct\tCombined_pct" > "$SUMMARY"

for B in "${BREADTHS[@]}"; do
  for M in "${MAJORS[@]}"; do
    CELL="b${B}m${M}"
    GATE="--cluster-only-mode --min-initial-signal-breadth $B --min-initial-majors $M \
      --initial-window-hours 24 --majors-list BTC,ETH,BNB,SOL"

    P1OUT="$OUT/${CELL}_p1.jsonl"
    P2OUT="$OUT/${CELL}_p2.jsonl"

    echo "[$(date +%H:%M:%S)] === $CELL (breadth=$B majors=$M) ==="
    if [[ -f "$P1OUT" && -f "$P2OUT" ]]; then
      echo "  cached, skipping sweep"
    else
      echo "  P1 ..."
      $SWEEP $COMMON_PRE $GATE --profit-target 0.10 --max-days 30 --out "$P1OUT" 2>&1 | tail -1
      echo "  P2 ..."
      $SWEEP $COMMON_PRE $GATE --profit-target 0.05 --max-days 60 --out "$P2OUT" 2>&1 | tail -1
    fi

    python3 - "$P1OUT" "$P2OUT" "$CELL" "$SUMMARY" <<'EOF'
import json,sys
p1f,p2f,cell,summ=sys.argv[1:5]
p1={}; p2={}
for l in open(p1f):
    o=json.loads(l); p1[o["win_idx"]]=(bool(o["passed"]), o["final_day"])
for l in open(p2f):
    o=json.loads(l); p2[o["win_idx"]]=bool(o["passed"])
ks=sorted(set(p1)&set(p2))
n=len(ks)
if n==0:
    print(f"  {cell}: NO OVERLAP")
    sys.exit(0)
p1p=sum(1 for k in ks if p1[k][0])
p2pm=sum(1 for k in ks if p2[k])
# true sequential
ne=0; pp=0; sf=0
for i in sorted(p1):
    passed,D=p1[i]; j=i+D
    if j not in p2: continue
    ne+=1
    if passed:
        pp+=1
        if p2[j]: sf+=1
p1pct=100*p1p/n
p2mpct=100*p2pm/n
condpct=(100*sf/pp) if pp else 0.0
combpct=(100*sf/ne) if ne else 0.0
print(f"  {cell}: P1={p1pct:.2f}% P2m={p2mpct:.2f}% P2|P1={condpct:.2f}% COMBINED={combpct:.2f}%")
with open(summ,'a') as f:
    f.write(f"{cell}\t{n}\t{p1pct:.2f}\t{p2mpct:.2f}\t{condpct:.2f}\t{combpct:.2f}\n")
EOF

  done
done

echo ""
echo "=== GRID COMPLETE — sorted by combined-funded ==="
{ head -1 "$SUMMARY"; tail -n +2 "$SUMMARY" | sort -t$'\t' -k6 -gr; }
