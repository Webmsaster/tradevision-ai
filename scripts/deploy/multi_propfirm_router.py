#!/usr/bin/env python3
"""2026-05-17 Multi-Prop-Firm Routing — SKELETON.
Routes signals to compatible prop-firm accounts based on firm-rules."""
FIRMS = {
    "FTMO_2Step":    {"dl": 5.0, "tl": 10.0, "p1_target": 10.0, "p2_target": 5.0, "min_days": 4},
    "FundedNext":    {"dl": 5.0, "tl": 10.0, "p1_target": 8.0,  "p2_target": 5.0, "min_days": 5, "dd_type": "floating"},
    "MyForexFunds":  {"dl": 5.0, "tl": 12.0, "p1_target": 8.0,  "p2_target": 5.0, "min_days": 3, "dd_type": "trailing"},
    "The5ers_HG":    {"dl": 4.0, "tl": 6.0,  "p1_target": 6.0,  "p2_target": 0,   "min_days": 6},
}
def route_signal(signal, firms):
    """Filter compatible firms for given signal."""
    compatible = []
    for fname, rules in firms.items():
        if signal.get("expected_stop_pct", 0) >= rules["dl"]: continue  # stop too wide for DL
        compatible.append(fname)
    return compatible
def main():
    sig = {"symbol": "BTCUSDT", "direction": "long", "expected_stop_pct": 3.0}
    routes = route_signal(sig, FIRMS)
    print(f"Signal: {sig}")
    print(f"Compatible firms: {routes}")
    print(f"Total firms in pool: {len(FIRMS)}")
if __name__ == "__main__": main()
