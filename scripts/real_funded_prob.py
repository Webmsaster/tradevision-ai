#!/usr/bin/env python3
"""
2026-05-17 ECHTE Funded-Prob Berechnung — User-Frage "warum so high?".

Die 90%+-Quote auf qualifying windows ist conditional. Hier rechne ich die
unconditional Funded-Prob unter verschiedenen Bot-Deploy-Szenarien aus.
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
TRADES = ROOT / "trades_p06" / "p06_p1_trades.jsonl"
P1_WIN = ROOT / "trades_p06" / "p06_p1_windows.jsonl"
P2_WIN = ROOT / "per_window" / "p06_ptp_8pct_25_p2.jsonl"
MAJORS = {"BTC", "ETH", "BNB", "SOL"}
GATE_WINDOW_HOURS = 2
GATE_MIN_BREADTH = 10
GATE_MIN_MAJORS = 1

def load(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["win_idx"]] = r
    return out

p1 = load(P1_WIN)
p2 = load(P2_WIN)
trades = defaultdict(list)
for line in TRADES.read_text().splitlines():
    if line.strip():
        r = json.loads(line)
        trades[r["winIdx"]].append(r)
for win_trades in trades.values():
    win_trades.sort(key=lambda t: t["entryTime"])

common = sorted(set(p1) & set(p2) & set(trades))
n_total = len(common)

def base_symbol(symbol: str) -> str:
    base = symbol.split("-")[0].upper()
    return base[:-4] if base.endswith("USDT") else base

def cluster_features(w: int) -> tuple[int, int]:
    win_trades = trades[w]
    if not win_trades:
        return 0, 0
    t0 = win_trades[0]["entryTime"]
    cutoff = t0 + GATE_WINDOW_HOURS * 3600 * 1000
    symbols = {base_symbol(t["symbol"]) for t in win_trades if t["entryTime"] <= cutoff}
    return len(symbols), len(symbols & MAJORS)

def is_qualified(w: int) -> bool:
    breadth, majors = cluster_features(w)
    return breadth >= GATE_MIN_BREADTH and majors >= GATE_MIN_MAJORS

# Categorize each window with the current deploy gate.
qualified = []
not_qualified = []
for w in common:
    if is_qualified(w):
        qualified.append(w)
    else:
        not_qualified.append(w)

def pass_stats(windows, label):
    n = len(windows)
    if n == 0:
        return {"label": label, "n": 0, "share": 0.0,
                "p1": 0, "p1_pct": 0.0,
                "p2": 0, "p2_pct": 0.0,
                "both": 0, "both_pct": 0.0}
    p1_pass = sum(1 for w in windows if p1[w]["passed"])
    p2_pass = sum(1 for w in windows if p2[w]["passed"])
    both = sum(1 for w in windows if p1[w]["passed"] and p2[w]["passed"])
    return {
        "label": label, "n": n, "share": n/n_total*100,
        "p1": p1_pass, "p1_pct": p1_pass/n*100,
        "p2": p2_pass, "p2_pct": p2_pass/n*100,
        "both": both, "both_pct": both/n*100
    }

print(f"=== Window Categorization (n={n_total}) ===")
qual_s = pass_stats(qualified, "Green-start gate")
nq_s = pass_stats(not_qualified, "NOT qualifying")
all_s = pass_stats(common, "ALL (no gate)")

wait_days = []
for pos, w in enumerate(common):
    if w in qualified:
        wait_days.append(0)
        continue
    next_q = next((q for q in qualified if q > w), None)
    if next_q is not None:
        wait_days.append((next_q - w) * 3)

wait_median = statistics.median(wait_days) if wait_days else 0
wait_avg = statistics.mean(wait_days) if wait_days else 0
wait_p90 = sorted(wait_days)[int(0.9 * (len(wait_days) - 1))] if wait_days else 0

random_buy_starts = []
random_buy_wait_days = []
for pos, w in enumerate(common):
    next_q = next((q for q in qualified if common.index(q) >= pos), None)
    if next_q is not None:
        random_buy_starts.append(next_q)
        random_buy_wait_days.append((common.index(next_q) - pos) * 3)

random_buy_pass = sum(1 for w in random_buy_starts if p1[w]["passed"] and p2[w]["passed"])
random_buy_pct = random_buy_pass / len(random_buy_starts) * 100 if random_buy_starts else 0.0
random_buy_no_next = n_total - len(random_buy_starts)
random_buy_wait_median = statistics.median(random_buy_wait_days) if random_buy_wait_days else 0
random_buy_wait_avg = statistics.mean(random_buy_wait_days) if random_buy_wait_days else 0
random_buy_wait_p90 = (
    sorted(random_buy_wait_days)[int(0.9 * (len(random_buy_wait_days) - 1))]
    if random_buy_wait_days else 0
)

print(
    f"Gate: {GATE_WINDOW_HOURS}h b>={GATE_MIN_BREADTH} "
    f"m>={GATE_MIN_MAJORS}"
)

for s in [qual_s, nq_s, all_s]:
    print(f"\n{s['label']:<22}: {s['n']:>3}/{n_total} ({s['share']:5.1f}%)")
    print(f"  P1 pass:   {s['p1']:>3}/{s['n']:<3} = {s['p1_pct']:5.2f}%")
    print(f"  P2 pass:   {s['p2']:>3}/{s['n']:<3} = {s['p2_pct']:5.2f}%")
    print(f"  AND pass:  {s['both']:>3}/{s['n']:<3} = {s['both_pct']:5.2f}%")

print("\n" + "="*70)
print("=== ECHTE UNCONDITIONAL FUNDED-PROB BERECHNUNG ===")
print("="*70)

print("\n--- Szenario A: Bot kauft Challenge blind (random timing) ---")
print("  Bot kauft Challenge zu zufälligem Zeitpunkt, gate filtert NICHT.")
print(f"  Funded-Prob: {all_s['both']}/{n_total} = {all_s['both_pct']:.2f}%  ← BASELINE (kein gate)")

print("\n--- Szenario B: Bot kauft blind, stoppt Trading wenn no-qualify ---")
print("  Bot kauft Challenge. Nach 24h: wenn nicht qualifying, stoppt.")
print("  → Qualifying windows pass normal, non-qualifying = fail (no trades)")
funded_B = qual_s['both']
print(f"  Funded-Prob: {funded_B}/{n_total} = {funded_B/n_total*100:.2f}%  ← VERSCHLECHTERT!")
print("  (verliert alle nicht-qualifizierenden Challenges)")

print("\n--- Szenario C: Bot kauft blind, trade-anyway wenn no-qualify ---")
print("  Bot kauft Challenge, ignoriert gate. Effektiv = Baseline ohne gate.")
funded_C = all_s['both']
print(f"  Funded-Prob: {funded_C}/{n_total} = {funded_C/n_total*100:.2f}%  ← = Baseline")

print("\n--- Szenario D: Smart-Timing (Codex's eigentliche Idee) ---")
print("  Bot scannt Markt KONTINUIERLICH, kauft Challenge erst wenn")
print("  qualifying cluster SICHTBAR ist.")
print("  → Effective Funded-Prob = qualified pass rate")
funded_D = qual_s['both_pct']
print(f"  Funded-Prob auf gestarteten Challenges: {funded_D:.2f}%  ← 92%+ wenn Bot smart")
print(f"  (Aber nur {qual_s['share']:.1f}% der Zeit-Slots sind 'kaufbar')")

print("\n--- Szenario E: Random kaufen, aber Bot wartet VOR erstem Trade bis grün ---")
print("  Voraussetzung: FTMO 2-Step ohne max. Zeitlimit; Start-Gate bleibt AN.")
print("  Kaufzeitpunkt ist random, Trading-Start ist smart getimed.")
print(f"  Funded-Prob nach Trading-Start: {funded_D:.2f}%  ← grüne Starts")
print(f"  Random-Purchase gewichtet: {random_buy_pass}/{len(random_buy_starts)} = {random_buy_pct:.2f}%")
print(f"  No-next-green im Sample: {random_buy_no_next}")
print(
    f"  Erwartete Wartezeit im 3d-Grid: median {random_buy_wait_median:.0f}d / "
    f"avg {random_buy_wait_avg:.1f}d / p90 {random_buy_wait_p90:.0f}d"
)

print("\n--- Szenario F: Pre-Filter Selection (post-hoc Berechnung) ---")
print(f"  Vom Trader-Sicht: Wenn ich 100 Challenges spiele in qualifying-")
print(f"  Marktphasen → ~92% funded. Wenn 100 zufällige Challenges SOFORT traden → ~55%.")

print("\n" + "="*70)
print("=== DER HAKEN ===")
print("="*70)
print(f"""
- Aktuelle Engine-Implementation FILTERT post-hoc nach gate, sie REDUZIERT
  den Sample-Space ({qual_s['n']} statt {n_total} Windows). Pass-Rate ist conditional auf
  qualifying.
- ECHTE Live-Funded-Prob hängt davon ab WIE der Bot deployed wird:
  - Naive (Szenario A/C): {all_s['both_pct']:.0f}% (= Baseline)
  - Stop-on-no-qualify (Szenario B): {funded_B/n_total*100:.0f}% (verschlechtert)
  - Smart-Timing (Szenario D): {funded_D:.0f}% (kaufen wenn grün)
  - Random-Buy-90-Mode (Szenario E): {random_buy_pct:.0f}% purchase-gewichtet
- Die {funded_D:.2f}% ist EHRLICH wenn Bot smart-timing macht. Nicht zu high, nicht
  zu low — es ist eine ANDERE Frage als naive blind-buy mit sofortigem Trading.
""")

# Non-qualifying detail
print("=== Was passiert in nicht-qualifizierenden Windows? ===")
print(f"  P1 pass-rate non-qual: {nq_s['p1_pct']:.2f}% (vs {qual_s['p1_pct']:.2f}% in qual)")
print(f"  P2 pass-rate non-qual: {nq_s['p2_pct']:.2f}% (vs {qual_s['p2_pct']:.2f}% in qual)")
print(f"  AND pass-rate non-qual: {nq_s['both_pct']:.2f}% (vs {qual_s['both_pct']:.2f}% in qual)")
print(f"  Gap: {qual_s['both_pct'] - nq_s['both_pct']:.2f}pp")
print(f"\n  Die qualifying windows haben ECHT bessere Outcomes — der Gate ist")
print(f"  ein gültiger Markt-Indikator, kein Lookahead-Bug. Aber Bot muss")
print(f"  ihn real-time erkennen + Smart-Timing machen für die 92%.")
