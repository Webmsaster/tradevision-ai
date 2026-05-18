"""Signal-Tracker Mode for Pre-Challenge Warm-up.

Runs the same poll loop as ftmo_executor but WITHOUT MT5 connection.
Purpose: build up signal-history.jsonl for 24h+ BEFORE user purchases
the FTMO challenge, so the start-gate has a real cluster signal at T0.

Usage:
    # Run for 24-48h before purchasing challenge
    FTMO_MOCK=1 FTMO_TF=2h-trend-v5-amber-max-passlock \\
        python3 tools/signal_tracker_mode.py

Behavior:
    - Polls pending-signals.json every 30s (same as executor)
    - Logs every incoming signal to signal-history.jsonl
    - Does NOT execute trades, does NOT connect MT5
    - Skip pause/account/equity state writes
    - Can run in parallel with Node signal generator

When user purchases challenge:
    - Stop this tracker
    - Start real ftmo_executor.py — signal-history already populated
    - Gate-check will use accumulated 24h+ history
"""
import os
import sys
import time
from pathlib import Path

# Ensure FTMO_MOCK is set to bypass MT5 import
os.environ.setdefault("FTMO_MOCK", "1")

_TOOLS_DIR = Path(__file__).resolve().parent
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

# Import after sys.path setup
import ftmo_executor as exe  # noqa: E402


def poll_once() -> int:
    """Poll pending-signals.json, log new signals to history, return count."""
    if not exe.PENDING_PATH.exists():
        return 0
    try:
        data = exe.read_json(exe.PENDING_PATH, {"signals": []})
    except Exception as e:
        print(f"[tracker] read pending failed: {e}", file=sys.stderr)
        return 0
    signals = data.get("signals", [])
    if not signals:
        return 0
    # Log to history (idempotent via dedup inside _log_signals_to_history)
    exe._log_signals_to_history(signals)
    return len(signals)


def main():
    interval_s = int(os.environ.get("SIGNAL_TRACKER_INTERVAL", "30"))
    print(f"[tracker] Signal-Tracker Mode started.")
    print(f"  STATE_DIR={exe.STATE_DIR}")
    print(f"  SIGNAL_HISTORY_PATH={exe.SIGNAL_HISTORY_PATH}")
    print(f"  Poll interval: {interval_s}s")
    print(f"  Ctrl-C to stop. Run for 24-48h before purchasing challenge.")
    print()
    total = 0
    iter_count = 0
    start_ts = time.time()
    try:
        while True:
            n = poll_once()
            total += n
            iter_count += 1
            if iter_count % 60 == 0 or n > 0:
                # Every 30min OR when signal arrives: status
                cluster = exe.compute_live_cluster()
                hours_running = (time.time() - start_ts) / 3600
                print(f"[tracker] running {hours_running:.1f}h, "
                      f"total signals={total}, live cluster: "
                      f"breadth={cluster['breadth']}/{exe.START_GATE_MIN_BREADTH} "
                      f"majors={cluster['majors']}/{exe.START_GATE_MIN_MAJORS} "
                      f"qualified={cluster['qualified']} "
                      f"history_24h={cluster['history_count']}")
            time.sleep(interval_s)
    except KeyboardInterrupt:
        print(f"\n[tracker] Stopped. Ran {(time.time()-start_ts)/3600:.1f}h, "
              f"logged {total} signals total.")
        cluster = exe.compute_live_cluster()
        print(f"[tracker] Final live cluster: {cluster}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
