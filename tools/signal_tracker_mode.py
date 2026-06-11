"""Signal-Tracker Mode for Pre-Challenge Warm-up.

Runs the same poll loop as ftmo_executor but WITHOUT MT5 connection.
Purpose: build up signal-history.jsonl BEFORE user purchases
the FTMO challenge, so the start-gate has a real cluster signal at T0.

Usage:
    # Run before purchasing challenge
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
    - Gate-check will use accumulated signal history
"""
import os
import sys
import time
from pathlib import Path

# 2026-05-24 Wave2 HIGH FIX: `setdefault` was a silent foot-gun — if the
# operator's shell had `FTMO_MOCK=0` (leftover from a real-MT5 debug
# session), this script kept that "0" and `import ftmo_executor` would
# attempt a real MetaTrader5 connect on Linux/WSL → ImportError or worse, a
# warmup tracker accidentally placing live orders if it ran on the Windows
# VPS. This tracker NEVER trades; force-mock unconditionally.
os.environ["FTMO_MOCK"] = "1"

_TOOLS_DIR = Path(__file__).resolve().parent
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

# Import after sys.path setup
import ftmo_executor as exe  # noqa: E402


def cluster_ready(cluster: dict) -> tuple[bool, float]:
    """Return (ready_to_buy, oldest_history_hours)."""
    oldest = cluster.get("oldest_log_ms")
    age_h = 0.0
    if oldest is not None:
        age_h = (cluster["ts_ms"] - oldest) / 3_600_000
    ready = bool(cluster.get("qualified")) and age_h >= exe.START_GATE_MIN_HISTORY_HOURS
    return ready, age_h


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
    alerts_enabled = os.environ.get("SIGNAL_TRACKER_ALERTS", "1").lower() in (
        "1", "true", "yes"
    )
    print(f"[tracker] Signal-Tracker Mode started.")
    print(f"  STATE_DIR={exe.STATE_DIR}")
    print(f"  SIGNAL_HISTORY_PATH={exe.SIGNAL_HISTORY_PATH}")
    print(f"  Poll interval: {interval_s}s")
    print(f"  Telegram alerts: {'ON' if alerts_enabled else 'OFF'}")
    print(
        "  Gate rule: "
        f"{exe.START_GATE_WINDOW_HOURS:g}h "
        f"breadth>={exe.START_GATE_MIN_BREADTH} "
        f"majors>={exe.START_GATE_MIN_MAJORS} "
        f"min_history>={exe.START_GATE_MIN_HISTORY_HOURS:g}h"
    )
    print(f"  Ctrl-C to stop. Keep running until ready=True before first trade.")
    print()
    total = 0
    iter_count = 0
    start_ts = time.time()
    last_ready = False
    try:
        while True:
            n = poll_once()
            total += n
            iter_count += 1
            cluster = exe.compute_live_cluster()
            ready, history_age_h = cluster_ready(cluster)
            if alerts_enabled and ready and not last_ready:
                exe.tg_send(
                    "🟢 <b>FTMO CLUSTER GREEN — BUY WINDOW</b>\n"
                    "Fast-pass setup is ready.\n"
                    f"breadth={cluster['breadth']}/{exe.START_GATE_MIN_BREADTH} "
                    f"majors={cluster['majors']}/{exe.START_GATE_MIN_MAJORS}\n"
                    f"window={cluster.get('window_hours', exe.START_GATE_WINDOW_HOURS):g}h "
                    f"history={history_age_h:.1f}h signals={cluster['history_count']}\n"
                    "Action: buy/start challenge now, then start executor."
                )
            elif alerts_enabled and last_ready and not ready:
                exe.tg_send(
                    "🔴 <b>FTMO CLUSTER NO LONGER GREEN</b>\n"
                    f"breadth={cluster['breadth']}/{exe.START_GATE_MIN_BREADTH} "
                    f"majors={cluster['majors']}/{exe.START_GATE_MIN_MAJORS}\n"
                    f"window={cluster.get('window_hours', exe.START_GATE_WINDOW_HOURS):g}h "
                    f"history={history_age_h:.1f}h signals={cluster['history_count']}"
                )
            last_ready = ready
            if iter_count % 60 == 0 or n > 0:
                # Every 30min OR when signal arrives: status
                hours_running = (time.time() - start_ts) / 3600
                print(f"[tracker] running {hours_running:.1f}h, "
                      f"total signals={total}, live cluster: "
                      f"breadth={cluster['breadth']}/{exe.START_GATE_MIN_BREADTH} "
                      f"majors={cluster['majors']}/{exe.START_GATE_MIN_MAJORS} "
                      f"qualified={cluster['qualified']} "
                      f"ready={ready} "
                      f"history_age={history_age_h:.1f}h "
                      f"history_{cluster.get('window_hours', exe.START_GATE_WINDOW_HOURS):g}h="
                      f"{cluster['history_count']}")
            time.sleep(interval_s)
    except KeyboardInterrupt:
        print(f"\n[tracker] Stopped. Ran {(time.time()-start_ts)/3600:.1f}h, "
              f"logged {total} signals total.")
        cluster = exe.compute_live_cluster()
        print(f"[tracker] Final live cluster: {cluster}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
