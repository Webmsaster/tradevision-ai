#!/usr/bin/env python3
"""
2026-05-17 CRITICAL BUG HUNT #1: Does the supervisor's EMA-cross proxy
actually match the REAL "qualifying" cluster from the engine?

OPTIMIZED VERSION: precompute EMA-series once per asset, then sliding check.
"""
import json
from pathlib import Path
from collections import defaultdict

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
MAJORS_TREND = {"BTC-TREND", "ETH-TREND", "BNB-TREND", "SOL-TREND"}
MAJORS_SHORT = {"BTC", "ETH", "BNB", "SOL"}

ASSETS = ["AAVE", "ADA", "ALGO", "ARB", "ATOM", "AVAX", "BCH", "BNB", "BTC",
          "DOT", "ETC", "ETH", "LINK", "LTC", "NEAR", "SOL", "TRX", "UNI", "XRP"]

EMA_FAST = 9
EMA_SLOW = 21
LOOKBACK_BARS = 48  # = 24h on 30m

print("[load] 19 asset candle indexes + precompute EMA series...")
asset_data = {}  # sym -> {"times": list, "closes": list, "ema_fast": list, "ema_slow": list}
for sym in ASSETS:
    path = f"scripts/cache_bakeoff/{sym}USDT_30m.json"
    if not Path(path).exists():
        continue
    data = sorted(json.load(open(path)), key=lambda c: c["openTime"])
    times = [c["openTime"] for c in data]
    closes = [c["close"] for c in data]

    # Compute EMA series in O(n)
    af = 2 / (EMA_FAST + 1)
    as_ = 2 / (EMA_SLOW + 1)
    ema_fast = []
    ema_slow = []
    for i, c in enumerate(closes):
        if i < EMA_FAST - 1:
            ema_fast.append(None)
        elif i == EMA_FAST - 1:
            ema_fast.append(sum(closes[:EMA_FAST]) / EMA_FAST)
        else:
            ema_fast.append(af * c + (1 - af) * ema_fast[-1])
        if i < EMA_SLOW - 1:
            ema_slow.append(None)
        elif i == EMA_SLOW - 1:
            ema_slow.append(sum(closes[:EMA_SLOW]) / EMA_SLOW)
        else:
            ema_slow.append(as_ * c + (1 - as_) * ema_slow[-1])

    asset_data[sym] = {
        "times": times,
        "closes": closes,
        "ema_fast": ema_fast,
        "ema_slow": ema_slow,
    }
    print(f"  {sym}: {len(times)} bars")

print("[load] backtest data...")
p1 = {}
p2 = {}
for line in (ROOT / "trades_p06" / "p06_p1_windows.jsonl").read_text().splitlines():
    if line.strip(): r=json.loads(line); p1[r["win_idx"]] = r
for line in (ROOT / "per_window" / "p06_ptp_8pct_25_p2.jsonl").read_text().splitlines():
    if line.strip(): r=json.loads(line); p2[r["win_idx"]] = r
trades = defaultdict(list)
for line in (ROOT / "trades_p06" / "p06_p1_trades.jsonl").read_text().splitlines():
    if line.strip(): r=json.loads(line); trades[r["winIdx"]].append(r)

def real_qualifying(win_trades):
    if not win_trades: return False
    s = sorted(win_trades, key=lambda t: t["entryTime"])
    cutoff = s[0]["entryTime"] + 24 * 3600 * 1000
    syms, majs = set(), set()
    for t in s:
        if t["entryTime"] > cutoff: break
        syms.add(t["symbol"])
        for p in MAJORS_TREND:
            if t["symbol"].startswith(p[:-6] + "-") or t["symbol"] == p:
                majs.add(p); break
    return len(syms) >= 4 and len(majs) >= 3

def find_idx_before(times, target_ms):
    """Largest index i where times[i] < target_ms."""
    lo, hi = 0, len(times)
    while lo < hi:
        mid = (lo + hi) // 2
        if times[mid] < target_ms:
            lo = mid + 1
        else:
            hi = mid
    return lo - 1  # last valid before

def proxy_active(sym, window_start_ms):
    """Did EMA-9 cross above EMA-21 in the last 48 bars ending BEFORE window_start?"""
    d = asset_data.get(sym)
    if d is None: return False
    end_idx = find_idx_before(d["times"], window_start_ms)
    if end_idx < EMA_SLOW + LOOKBACK_BARS:
        return False
    start_idx = end_idx - LOOKBACK_BARS
    prev_diff = None
    for i in range(start_idx, end_idx + 1):
        ef = d["ema_fast"][i]
        es = d["ema_slow"][i]
        if ef is None or es is None:
            continue
        diff = ef - es
        if prev_diff is not None and prev_diff <= 0 and diff > 0:
            return True
        prev_diff = diff
    return False

def proxy_qualifying(window_start_ms):
    syms = set()
    majs = set()
    for sym in ASSETS:
        if proxy_active(sym, window_start_ms):
            syms.add(sym)
            if sym in MAJORS_SHORT:
                majs.add(sym)
    return len(syms) >= 4 and len(majs) >= 3

print("\n[validate] proxy vs real qualifying per window...")
common = sorted(set(p1) & set(p2) & set(trades.keys()))
print(f"Total windows: {len(common)}")

real_yes_proxy_yes = 0
real_yes_proxy_no = 0
real_no_proxy_yes = 0
real_no_proxy_no = 0
proxy_buy_pass = 0
proxy_buy_total = 0
proxy_skip_pass = 0
proxy_skip_total = 0

for w in common:
    tl = trades[w]
    if not tl: continue
    real_q = real_qualifying(tl)
    first_entry = min(t["entryTime"] for t in tl)
    proxy_q = proxy_qualifying(first_entry)

    if real_q and proxy_q: real_yes_proxy_yes += 1
    elif real_q and not proxy_q: real_yes_proxy_no += 1
    elif not real_q and proxy_q: real_no_proxy_yes += 1
    else: real_no_proxy_no += 1

    passed_both = p1[w]["passed"] and p2[w]["passed"]
    if proxy_q:
        proxy_buy_total += 1
        if passed_both: proxy_buy_pass += 1
    else:
        proxy_skip_total += 1
        if passed_both: proxy_skip_pass += 1

total = real_yes_proxy_yes + real_yes_proxy_no + real_no_proxy_yes + real_no_proxy_no
print(f"\n=== Confusion Matrix ===")
print(f"                    Proxy=YES    Proxy=NO")
print(f"Real=QUALIFYING      {real_yes_proxy_yes:>6}      {real_yes_proxy_no:>6}")
print(f"Real=NOT-QUALIFY     {real_no_proxy_yes:>6}      {real_no_proxy_no:>6}")
acc = (real_yes_proxy_yes + real_no_proxy_no) / total * 100
prec = real_yes_proxy_yes / max(real_yes_proxy_yes + real_no_proxy_yes, 1) * 100
rec = real_yes_proxy_yes / max(real_yes_proxy_yes + real_yes_proxy_no, 1) * 100
print(f"\nAccuracy: {acc:.1f}%")
print(f"Precision (proxy-BUY → real qualifying): {prec:.1f}%")
print(f"Recall (real qualifying → proxy-BUY): {rec:.1f}%")

print(f"\n=== ACTUAL PASS-RATE IF FOLLOWING PROXY ===")
print(f"Proxy says BUY:  {proxy_buy_total} windows, "
      f"{proxy_buy_pass} passed = "
      f"{proxy_buy_pass/max(proxy_buy_total,1)*100:.2f}% AND")
print(f"Proxy says SKIP: {proxy_skip_total} windows, "
      f"{proxy_skip_pass} passed = "
      f"{proxy_skip_pass/max(proxy_skip_total,1)*100:.2f}% AND")
base = sum(1 for w in common if p1[w]["passed"] and p2[w]["passed"])
print(f"Baseline:        {base}/{len(common)} = {base/len(common)*100:.2f}% AND")

print()
if proxy_buy_total > 0:
    proxy_pass_rate = proxy_buy_pass / proxy_buy_total * 100
    if proxy_pass_rate >= 90:
        print(f"✅ Proxy delivers {proxy_pass_rate:.1f}% — meets 90% target")
    elif proxy_pass_rate >= 80:
        print(f"⚠️  Proxy delivers {proxy_pass_rate:.1f}% — NOT 92% as claimed")
    else:
        print(f"❌ CRITICAL BUG: Proxy only {proxy_pass_rate:.1f}% — supervisor BROKEN")
