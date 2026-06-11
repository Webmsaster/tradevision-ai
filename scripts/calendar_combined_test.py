#!/usr/bin/env python3
"""
2026-05-18 Calendar + Breadth-Gate kombiniert.
Finding: Fri/Mon/Wed AND% sind 56-68% vs Tue/Thu 40-50%.
Test ob calendar-filter ALONE oder PLUS breadth-gate >=90% bringt.
"""
import json
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
MAJORS = {"BTC-TREND", "ETH-TREND", "BNB-TREND", "SOL-TREND"}
GATE_WINDOW_HOURS = 2
GATE_MIN_BREADTH = 10
GATE_MIN_MAJORS = 1

def load(p):
    out = {}
    for line in Path(p).read_text().splitlines():
        if line.strip(): r=json.loads(line); out[r["win_idx"]] = r
    return out

p1 = load(ROOT / "trades_p06" / "p06_p1_windows.jsonl")
p2 = load(ROOT / "per_window" / "p06_ptp_8pct_25_p2.jsonl")
trades = defaultdict(list)
for line in (ROOT / "trades_p06" / "p06_p1_trades.jsonl").read_text().splitlines():
    if line.strip(): r=json.loads(line); trades[r["winIdx"]].append(r)

def qualifying(tl):
    if not tl: return False
    s = sorted(tl, key=lambda t: t["entryTime"])
    cutoff = s[0]["entryTime"] + GATE_WINDOW_HOURS*3600*1000
    syms, majs = set(), set()
    for t in s:
        if t["entryTime"] > cutoff: break
        syms.add(t["symbol"])
        for p in MAJORS:
            if t["symbol"].startswith(p[:-6]+"-") or t["symbol"] == p:
                majs.add(p); break
    return len(syms) >= GATE_MIN_BREADTH and len(majs) >= GATE_MIN_MAJORS

def dow(win_trades):
    if not win_trades: return None
    s = sorted(win_trades, key=lambda t: t["entryTime"])
    return datetime.fromtimestamp(s[0]["entryTime"]/1000, tz=timezone.utc).weekday()

def month(win_trades):
    if not win_trades: return None
    s = sorted(win_trades, key=lambda t: t["entryTime"])
    return datetime.fromtimestamp(s[0]["entryTime"]/1000, tz=timezone.utc).month

common = sorted(set(p1) & set(p2) & set(trades.keys()))
n = len(common)

# Build features per window
print("=== Calendar Gate Variants ===\n")
print(f"Baseline (no filter): n={n}, AND={sum(1 for w in common if p1[w]['passed'] and p2[w]['passed'])/n*100:.2f}%\n")

# Single-axis filters
strong_dows = [0, 2, 4]  # Mon Wed Fri
strong_months = [2, 9, 10, 11, 12]  # Feb, Sep, Oct, Nov, Dec

def evaluate(label, pred):
    sub = [w for w in common if pred(w)]
    if not sub: return
    a = sum(1 for w in sub if p1[w]["passed"] and p2[w]["passed"])
    q = sum(1 for w in sub if qualifying(trades[w]))
    print(f"  {label:<45} n={len(sub):<4}  AND={a/len(sub)*100:5.2f}%  "
          f"Qual={q/len(sub)*100:5.1f}%  (retention {len(sub)/n*100:.1f}%)")

# Without breadth-gate, only calendar:
print("--- Calendar ONLY (no breadth-gate) ---")
evaluate("Fri only", lambda w: dow(trades[w]) == 4)
evaluate("Mon|Wed|Fri", lambda w: dow(trades[w]) in {0, 2, 4})
evaluate("Mon|Wed|Fri|Sun", lambda w: dow(trades[w]) in {0, 2, 4, 6})
evaluate("Strong months (Feb,Sep-Dec)", lambda w: month(trades[w]) in strong_months)
evaluate("Strong DoW + Strong month", lambda w: dow(trades[w]) in {0,2,4} and month(trades[w]) in strong_months)

# Combined with breadth-gate:
print("\n--- Calendar + Breadth-Gate ---")
evaluate("Breadth-Gate ONLY (baseline)", lambda w: qualifying(trades[w]))
evaluate("Fri AND breadth-gate", lambda w: dow(trades[w]) == 4 and qualifying(trades[w]))
evaluate("Mon|Wed|Fri AND breadth-gate", lambda w: dow(trades[w]) in {0,2,4} and qualifying(trades[w]))
evaluate("Strong DoW AND breadth", lambda w: dow(trades[w]) in {0,2,4,6} and qualifying(trades[w]))
evaluate("StrongDoW AND StrongMonth AND breadth", lambda w: dow(trades[w]) in {0,2,4} and month(trades[w]) in strong_months and qualifying(trades[w]))

# OR variants: calendar OR breadth-gate (gives more buys, lower pass-rate)
print("\n--- Calendar OR Breadth-Gate (more buys, less precision) ---")
evaluate("Fri OR breadth-gate", lambda w: dow(trades[w]) == 4 or qualifying(trades[w]))
evaluate("Mon|Wed|Fri OR breadth-gate", lambda w: dow(trades[w]) in {0,2,4} or qualifying(trades[w]))

# Combined: Fri OR (Mon|Wed AND breadth)?
print("\n--- Complex compounds ---")
evaluate("Fri (any) OR (Mon|Wed AND breadth)",
         lambda w: dow(trades[w]) == 4 or (dow(trades[w]) in {0,2} and qualifying(trades[w])))
evaluate("Mon|Wed|Fri (any) OR (Sun AND breadth)",
         lambda w: dow(trades[w]) in {0,2,4} or (dow(trades[w]) == 6 and qualifying(trades[w])))

# Goal: find combo that ≥85% AND with ≥30% retention
print("\n=== Search for ≥90% AND with reasonable retention ===")
best = []
for dow_set in [{4}, {0,2,4}, {0,2,4,6}, {0,2,4,5,6}]:
    for month_set in [None, set(strong_months), {9,10,11,12}, {12,1,2}]:
        for use_breadth in [True, False]:
            def pred(w, ds=dow_set, ms=month_set, ub=use_breadth):
                if dow(trades[w]) not in ds: return False
                if ms is not None and month(trades[w]) not in ms: return False
                if ub and not qualifying(trades[w]): return False
                return True
            sub = [w for w in common if pred(w)]
            if not sub or len(sub) < 50: continue
            a = sum(1 for w in sub if p1[w]["passed"] and p2[w]["passed"])
            rate = a / len(sub) * 100
            retention = len(sub) / n * 100
            label = f"DoW={sorted(dow_set)} Mo={'all' if month_set is None else sorted(month_set)} Br={'Y' if use_breadth else 'N'}"
            best.append((rate, retention, len(sub), label))

best.sort(reverse=True)
print(f"\nTop combinations (≥50 windows):")
print(f"{'AND%':<8} {'Ret%':<8} {'N':<6} Filter")
for rate, ret, n_, label in best[:10]:
    print(f"  {rate:5.2f}%  {ret:5.1f}%  {n_:<5} {label}")
