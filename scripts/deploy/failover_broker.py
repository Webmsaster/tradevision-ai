#!/usr/bin/env python3
"""2026-05-17 Hot-Standby Failover Broker — SKELETON.
State machine: ACTIVE | STANDBY | LOCKED | EXHAUSTED per FTMO_ACCOUNT_ID.
Promotes STANDBY → ACTIVE when ACTIVE hits 4% daily-DD (pre-trip threshold).

2026-05-23 Wave1 audit fix (KRIT):
  - Atomic write via tmp+fsync+rename (was raw write_text → torn-write on
    power-loss corrupted entire state).
  - File-lock around load+mutate+save (was RMW without lock → two concurrent
    invocations both saw same STANDBY pool, both promoted different candidates
    → MULTIPLE ACTIVE accounts, defeating failover's whole purpose).
"""
import argparse, json, os, sys, tempfile
from pathlib import Path

# Re-use the project's existing file_lock primitive from tools/process_lock.py.
_TOOLS = Path(__file__).resolve().parents[2] / "tools"
if str(_TOOLS) not in sys.path:
    sys.path.insert(0, str(_TOOLS))
from process_lock import file_lock  # type: ignore  # noqa: E402


def _atomic_write_json(path: Path, data) -> None:
    """tmp+fsync+rename — torn-write safe on power-loss."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
        # parent-dir fsync so rename is durable on power-loss
        try:
            dir_fd = os.open(str(path.parent), os.O_DIRECTORY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


class FailoverBroker:
    def __init__(self, state_file):
        self.state_file = Path(state_file)
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.lock_path = self.state_file.with_suffix(self.state_file.suffix + ".lock")
        self.load()

    def load(self):
        if self.state_file.exists():
            try:
                self.state = json.loads(self.state_file.read_text())
            except (json.JSONDecodeError, ValueError):
                # Corrupt state → start fresh; alert operator via stderr.
                print(
                    f"⚠ failover_broker: state file {self.state_file} corrupt — resetting",
                    file=sys.stderr,
                )
                self.state = {"accounts": {}, "active_count": 0}
        else:
            self.state = {"accounts": {}, "active_count": 0}

    def save(self):
        _atomic_write_json(self.state_file, self.state)

    def check_and_promote(self, accounts):
        # Hold file-lock across the entire RMW so concurrent invocations
        # cannot both see "STANDBY available" and both promote it.
        with file_lock(self.lock_path, timeout_sec=10.0):
            # Re-load inside the lock so we see any state writes from a
            # concurrent invocation that completed first.
            self.load()
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


if __name__ == "__main__":
    main()
