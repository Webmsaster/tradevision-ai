#!/usr/bin/env python3
"""2026-05-17 Stress-Scenario synthetic windows for tail-risk validation."""
import json, math, random
from pathlib import Path
def make_crash(n_bars=200, start=100.0, crash_pct=0.30, crash_bar=100):
    """Generate synthetic crash scenario: gradual rise then sharp drop."""
    bars = []
    for i in range(n_bars):
        if i < crash_bar:
            price = start * (1 + 0.001 * i)  # 0.1% drift up
        elif i == crash_bar:
            price = start * (1 + 0.001 * crash_bar) * (1 - crash_pct)  # crash
        else:
            price = start * (1 + 0.001 * crash_bar) * (1 - crash_pct) * (1 + 0.0005 * (i - crash_bar))
        bars.append({"open_time": i * 1800_000, "close_time": (i+1)*1800_000,
                     "open": price*(1-0.001), "high": price*(1+0.002), "low": price*(1-0.002),
                     "close": price, "volume": 1000.0})
    return bars

def make_chop(n_bars=200, start=100.0, vol=0.005):
    bars = []
    p = start; random.seed(42)
    for i in range(n_bars):
        p *= (1 + random.gauss(0, vol))
        bars.append({"open_time": i*1800_000, "close_time": (i+1)*1800_000,
                     "open": p*0.999, "high": p*1.002, "low": p*0.998, "close": p, "volume": 500.0})
    return bars

out = Path("scripts/cache_stress"); out.mkdir(parents=True, exist_ok=True)
crash = make_crash(); chop = make_chop()
(out/"CRASH_30m.json").write_text(json.dumps(crash))
(out/"CHOP_30m.json").write_text(json.dumps(chop))
print(f"✅ Stress scenarios: {len(crash)} crash bars, {len(chop)} chop bars → {out}/")
