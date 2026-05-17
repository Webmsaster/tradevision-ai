#!/usr/bin/env python3
"""2026-05-17 Hot-Standby Failover Broker — SKELETON.
State machine: ACTIVE | STANDBY | LOCKED | EXHAUSTED per FTMO_ACCOUNT_ID.
Promotes STANDBY → ACTIVE when ACTIVE hits 4% daily-DD (pre-trip threshold)."""
import argparse, json
from pathlib import Path
class FailoverBroker:
    def __init__(self, state_file):
        self.state_file = Path(state_file); self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.load()
    def load(self):
        if self.state_file.exists(): self.state = json.loads(self.state_file.read_text())
        else: self.state = {"accounts": {}, "active_count": 0}
    def save(self): self.state_file.write_text(json.dumps(self.state, indent=2))
    def check_and_promote(self, accounts):
        for acc_id, dd_pct in accounts.items():
            cur = self.state["accounts"].get(acc_id, {"status": "ACTIVE"})
            if cur["status"] == "ACTIVE" and dd_pct >= 4.0:
                cur["status"] = "EXHAUSTED"
                cur["exhausted_at_dd"] = dd_pct
                print(f"  ⚠ {acc_id} EXHAUSTED at DD={dd_pct:.2f}% — promoting STANDBY")
                # find next STANDBY → ACTIVE
                for cand_id, cand in self.state["accounts"].items():
                    if cand.get("status") == "STANDBY":
                        cand["status"] = "ACTIVE"
                        print(f"  ✅ {cand_id} promoted to ACTIVE")
                        break
            self.state["accounts"][acc_id] = cur
        self.save()
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", default="state/failover_broker.json")
    args = ap.parse_args()
    broker = FailoverBroker(args.state)
    # Demo input
    broker.check_and_promote({"acc_A": 1.2, "acc_B": 0.5, "acc_C": 4.5})
    print(f"State: {broker.state}")
if __name__ == "__main__": main()
