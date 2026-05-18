#!/usr/bin/env python3
"""
2026-05-18 User-Anfrage: 'tages cluster und news' — Calendar Patterns testen.
Validate ob day-of-week, hour, weekend, oder news-events prädiktiv für
qualifying/pass-rate sind.
"""
import json
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
MAJORS = {"BTC-TREND", "ETH-TREND", "BNB-TREND", "SOL-TREND"}

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
    cutoff = s[0]["entryTime"] + 24*3600*1000
    syms, majs = set(), set()
    for t in s:
        if t["entryTime"] > cutoff: break
        syms.add(t["symbol"])
        for p in MAJORS:
            if t["symbol"].startswith(p[:-6]+"-") or t["symbol"] == p:
                majs.add(p); break
    return len(syms) >= 4 and len(majs) >= 3

common = sorted(set(p1) & set(p2) & set(trades.keys()))
n = len(common)
print(f"Total windows: {n}\n")

# Per-window calendar features
def features(win_trades):
    s = sorted(win_trades, key=lambda t: t["entryTime"])
    if not s: return None
    first_t = s[0]["entryTime"] / 1000
    dt = datetime.fromtimestamp(first_t, tz=timezone.utc)
    return {
        "dow": dt.weekday(),  # 0=Mon, 6=Sun
        "hour": dt.hour,
        "is_weekend_starting": dt.weekday() >= 5,
        "is_friday_evening": dt.weekday() == 4 and dt.hour >= 16,
        "month": dt.month,
        "is_us_open_hours": 13 <= dt.hour <= 21,  # 9am-5pm ET in UTC
        "is_asia_open_hours": 0 <= dt.hour <= 8,
    }

# Per-feature: qualifying-rate AND pass-rate
print("=== Day-of-Week Patterns ===")
print(f"{'DoW':<8} {'N':<6} {'Qual%':<8} {'Pass%':<8} {'AND%':<8}")
dow_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
for d in range(7):
    sub = [w for w in common if features(trades[w])["dow"] == d]
    if not sub: continue
    q_count = sum(1 for w in sub if qualifying(trades[w]))
    p_count = sum(1 for w in sub if p1[w]["passed"])
    and_count = sum(1 for w in sub if p1[w]["passed"] and p2[w]["passed"])
    print(f"  {dow_names[d]:<6} {len(sub):<6} {q_count/len(sub)*100:5.1f}%  "
          f"{p_count/len(sub)*100:5.1f}%  {and_count/len(sub)*100:5.1f}%")

print("\n=== Hour-of-Day Patterns (UTC) ===")
print(f"{'Hour':<8} {'N':<6} {'Qual%':<8} {'AND%':<8}")
for h_range in [(0, 6), (6, 12), (12, 18), (18, 24)]:
    sub = [w for w in common if h_range[0] <= features(trades[w])["hour"] < h_range[1]]
    if not sub: continue
    q_count = sum(1 for w in sub if qualifying(trades[w]))
    and_count = sum(1 for w in sub if p1[w]["passed"] and p2[w]["passed"])
    print(f"  {h_range[0]:02d}-{h_range[1]:02d}h  {len(sub):<6} "
          f"{q_count/len(sub)*100:5.1f}%  {and_count/len(sub)*100:5.1f}%")

print("\n=== Weekend-Starting vs Weekday-Starting ===")
weekday_subset = [w for w in common if not features(trades[w])["is_weekend_starting"]]
weekend_subset = [w for w in common if features(trades[w])["is_weekend_starting"]]
for label, sub in [("Weekday", weekday_subset), ("Weekend", weekend_subset)]:
    if not sub: continue
    q = sum(1 for w in sub if qualifying(trades[w]))
    a = sum(1 for w in sub if p1[w]["passed"] and p2[w]["passed"])
    print(f"  {label:<10} {len(sub):<5} Qual%={q/len(sub)*100:5.1f}  AND%={a/len(sub)*100:5.1f}")

print("\n=== Month Patterns ===")
print(f"{'Month':<8} {'N':<6} {'Qual%':<8} {'AND%':<8}")
for m in range(1, 13):
    sub = [w for w in common if features(trades[w])["month"] == m]
    if not sub: continue
    q = sum(1 for w in sub if qualifying(trades[w]))
    a = sum(1 for w in sub if p1[w]["passed"] and p2[w]["passed"])
    print(f"  {m:>3}    {len(sub):<6} {q/len(sub)*100:5.1f}%  {a/len(sub)*100:5.1f}%")

# Big-event days (rough: known crypto news 2024-2026)
print("\n=== Crypto Event Day Proximity ===")
# Known major events (BTC halving Apr 2024, ETF approvals Jan 2024, FOMC dates)
events = [
    ("BTC ETF approval", "2024-01-10"),
    ("BTC halving", "2024-04-20"),
    ("FOMC Mar 2024", "2024-03-20"),
    ("FOMC Jun 2024", "2024-06-12"),
    ("FOMC Sep 2024", "2024-09-18"),
    ("FOMC Dec 2024", "2024-12-18"),
    ("US Election", "2024-11-05"),
]
event_ts = []
for label, date_str in events:
    ts = datetime.fromisoformat(date_str).replace(tzinfo=timezone.utc).timestamp() * 1000
    event_ts.append((label, ts))

for proximity_days in [1, 3, 7, 14]:
    near_event = []
    far_event = []
    for w in common:
        first_t = sorted(trades[w], key=lambda t: t["entryTime"])[0]["entryTime"]
        is_near = any(abs(first_t - et) <= proximity_days * 86400 * 1000
                      for _, et in event_ts)
        if is_near:
            near_event.append(w)
        else:
            far_event.append(w)
    for label, sub in [(f"≤{proximity_days}d to event", near_event),
                       (f">{proximity_days}d from event", far_event)]:
        if not sub: continue
        q = sum(1 for w in sub if qualifying(trades[w]))
        a = sum(1 for w in sub if p1[w]["passed"] and p2[w]["passed"])
        print(f"  {label:<24} {len(sub):<5} Qual%={q/len(sub)*100:5.1f}  "
              f"AND%={a/len(sub)*100:5.1f}")
    print()
