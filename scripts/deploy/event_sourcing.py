#!/usr/bin/env python3
"""2026-05-17 Event-Sourcing Live State — append-only log + replay-rebuild.
Replaces mutable snapshots with immutable event log."""
import argparse, json, time
from pathlib import Path
class EventStore:
    def __init__(self, log_file): self.log_file = Path(log_file); self.log_file.parent.mkdir(parents=True, exist_ok=True)
    def append(self, event_type, **payload):
        event = {"ts_ms": int(time.time()*1000), "type": event_type, **payload}
        with open(self.log_file, "a") as f: f.write(json.dumps(event) + "\n")
        return event
    def replay(self):
        state = {"equity": 10000.0, "positions": {}, "phase": "P1", "day": 0}
        if not self.log_file.exists(): return state
        for line in self.log_file.read_text().splitlines():
            if not line.strip(): continue
            evt = json.loads(line)
            t = evt["type"]
            if t == "fill":
                state["positions"][evt["symbol"]] = {"side": evt["side"], "price": evt["price"]}
            elif t == "close":
                pos = state["positions"].pop(evt["symbol"], None)
                if pos: state["equity"] += evt.get("pnl", 0)
            elif t == "phase_pass":
                state["phase"] = evt["new_phase"]
        return state
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default="state/events.jsonl")
    ap.add_argument("--demo", action="store_true")
    args = ap.parse_args()
    store = EventStore(args.log)
    if args.demo:
        store.append("fill", symbol="BTCUSDT", side="long", price=50000.0)
        store.append("close", symbol="BTCUSDT", pnl=120.50)
        store.append("phase_pass", new_phase="P2")
    state = store.replay()
    print(f"Replayed state: {state}")
if __name__ == "__main__": main()
