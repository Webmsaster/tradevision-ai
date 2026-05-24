"""
Phase-Switch Supervisor for Phase-Adaptive Stack-4.

Supervises a single FTMO account through Phase 1 (+10% / 30d) and
Phase 2 (+5% / 60d). Auto-switches FTMO_TF (template) at P1-target hit.

Source finding: docs/PHASE_ADAPTIVE_STACK4_DEPLOY_PLAN.md (97.28% OOS).

Env-vars (per account):
    FTMO_ACCOUNT_ID            Account identifier (e.g. "A")
    FTMO_TF_P1                 Template for Phase 1
    FTMO_TF_P2                 Template for Phase 2
    FTMO_INITIAL_BALANCE       Starting balance (default 100000)
    FTMO_P1_TARGET             P1 profit target (default 0.10 = +10%)
    FTMO_P2_TARGET             P2 profit target (default 0.05 = +5%)
    FTMO_P1_MAX_DAYS           P1 deadline (default 30)
    FTMO_P2_MAX_DAYS           P2 deadline (default 60)
    SUPERVISOR_POLL_SEC        Equity poll interval (default 60)
    SUPERVISOR_EXECUTOR_BIN    Path to executor (default tools/ftmo_executor.py)

Behavior:
    Phase 1: spawn executor with FTMO_TF=$FTMO_TF_P1, target=$FTMO_P1_TARGET.
    Poll equity-history.jsonl every SUPERVISOR_POLL_SEC.
    On equity >= initial * (1 + P1_TARGET):
        1. Send SIGTERM to executor (graceful exit).
        2. Wait for clean exit (max 30s, then SIGKILL).
        3. Archive P1 state-dir → state-backups/<ACCT>-P1-<ts>/.
        4. Spawn executor with FTMO_TF=$FTMO_TF_P2, target=$FTMO_P2_TARGET.
    Phase 2: same logic, on P2 pass exit success.
    On P1 or P2 fail (max-days exceeded OR daily-loss tripped): exit code 2.

Logs to: ftmo-state-supervisor-<ACCT>/supervisor.jsonl
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


REPO_ROOT = Path(__file__).resolve().parent.parent

ACCOUNT_ID = os.environ.get("FTMO_ACCOUNT_ID", "default")
TF_P1 = os.environ.get("FTMO_TF_P1")
TF_P2 = os.environ.get("FTMO_TF_P2")
INITIAL_BALANCE = float(os.environ.get("FTMO_INITIAL_BALANCE", "100000"))
P1_TARGET = float(os.environ.get("FTMO_P1_TARGET", "0.10"))
P2_TARGET = float(os.environ.get("FTMO_P2_TARGET", "0.05"))
P1_MAX_DAYS = int(os.environ.get("FTMO_P1_MAX_DAYS", "30"))
P2_MAX_DAYS = int(os.environ.get("FTMO_P2_MAX_DAYS", "60"))
POLL_SEC = int(os.environ.get("SUPERVISOR_POLL_SEC", "60"))
EXECUTOR_BIN = os.environ.get(
    "SUPERVISOR_EXECUTOR_BIN", str(REPO_ROOT / "tools" / "ftmo_executor.py")
)

SUPERVISOR_STATE_DIR = REPO_ROOT / f"ftmo-state-supervisor-{ACCOUNT_ID}"
SUPERVISOR_LOG = SUPERVISOR_STATE_DIR / "supervisor.jsonl"
BACKUP_DIR = REPO_ROOT / "state-backups"


def _validate_env() -> tuple[str, str]:
    missing = [k for k, v in {"FTMO_TF_P1": TF_P1, "FTMO_TF_P2": TF_P2}.items() if not v]
    if missing:
        print(f"FATAL: missing env vars: {missing}", file=sys.stderr)
        sys.exit(1)
    if not (0 < P1_TARGET < 1):
        print(f"FATAL: FTMO_P1_TARGET={P1_TARGET} out of (0, 1)", file=sys.stderr)
        sys.exit(1)
    if not (0 < P2_TARGET < 1):
        print(f"FATAL: FTMO_P2_TARGET={P2_TARGET} out of (0, 1)", file=sys.stderr)
        sys.exit(1)
    # AUDIT FIX KRIT #3: if P1 and P2 use IDENTICAL FTMO_TF, the STATE_DIRs
    # collide → P2 executor inherits P1's pause-state.json (target_hit=True)
    # AND the executor's singleton-lock collides → spawn race-loses. Allow
    # symmetric-only when explicitly opted-in via FTMO_ALLOW_SYMMETRIC_TF=1.
    if TF_P1 == TF_P2 and os.environ.get("FTMO_ALLOW_SYMMETRIC_TF", "0") != "1":
        print(
            f"FATAL: FTMO_TF_P1 == FTMO_TF_P2 ({TF_P1!r}). Symmetric template "
            "switch causes state-dir collision + singleton-lock contention. "
            "Set FTMO_ALLOW_SYMMETRIC_TF=1 to opt-in (also requires distinct "
            "state-dir per phase via supervisor state-migration).",
            file=sys.stderr,
        )
        sys.exit(1)
    return TF_P1, TF_P2  # type: ignore[return-value]  # validated non-None above


def log(event: str, **fields) -> None:
    SUPERVISOR_STATE_DIR.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        "account": ACCOUNT_ID,
        **fields,
    }
    print(json.dumps(entry), flush=True)
    try:
        with open(SUPERVISOR_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def executor_state_dir(tf: str) -> Path:
    return REPO_ROOT / f"ftmo-state-{tf}-{ACCOUNT_ID}"


def latest_equity(state_dir: Path) -> Optional[float]:
    """Read most-recent equity from <state>/equity-history.jsonl.

    AUDIT FIX WARNUNG #7: file rotation by executor (truncate+rewrite at
    20MB) can leave the tail mid-write. We:
      1. Read the last 16KB (larger window than 4KB)
      2. Skip lines that don't parse cleanly
      3. Return the last FULLY-VALID equity reading

    Avoids silent miss-of-target by tolerating one corrupt tail line
    during rotation.
    """
    eqh = state_dir / "equity-history.jsonl"
    if not eqh.exists():
        return None
    try:
        with open(eqh, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 16384))  # KRIT-fix: wider window
            tail = f.read().decode("utf-8", errors="ignore")
        # Iterate lines from end, return first valid one
        for line in reversed(tail.splitlines()):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                rec = json.loads(stripped)
                eq = rec.get("equity_usd")
                if isinstance(eq, (int, float)):
                    return float(eq)
            except (json.JSONDecodeError, ValueError):
                continue
        return None
    except OSError:
        return None


def spawn_executor(tf: str, target: float, max_days: int) -> subprocess.Popen:
    """Spawn ftmo_executor.py subprocess for a single phase.

    AUDIT FIX KRIT #5: executor reads FTMO_START_BALANCE (NOT
    FTMO_INITIAL_BALANCE). Export both for safety.

    AUDIT FIX KRIT #6: FTMO_MAX_DAYS is unused by executor — supervisor
    enforces the deadline. Still export for any future executor use +
    documentation.
    """
    env = os.environ.copy()
    env["FTMO_TF"] = tf
    env["FTMO_PROFIT_TARGET"] = str(target)
    env["FTMO_MAX_DAYS"] = str(max_days)
    env["FTMO_ACCOUNT_ID"] = ACCOUNT_ID
    env["FTMO_START_BALANCE"] = str(INITIAL_BALANCE)  # KRIT #5
    log("spawn_executor", tf=tf, target=target, max_days=max_days,
        start_balance=INITIAL_BALANCE)
    return subprocess.Popen(
        [sys.executable, EXECUTOR_BIN],
        env=env,
        cwd=str(REPO_ROOT),
    )


def graceful_stop(proc: subprocess.Popen, timeout_sec: int = 30) -> None:
    if proc.poll() is not None:
        return  # already exited
    log("sigterm_executor", pid=proc.pid)
    try:
        proc.send_signal(signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=timeout_sec)
        log("executor_exited", pid=proc.pid, returncode=proc.returncode)
    except subprocess.TimeoutExpired:
        log("sigkill_executor", pid=proc.pid, reason="timeout")
        try:
            proc.kill()
            proc.wait(timeout=5)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            pass


def archive_state(state_dir: Path, label: str) -> Optional[Path]:
    """AUDIT FIX KRIT #3: copytree leaves source in place — P2 spawn
    with same TF would inherit stale state. Now: copy then rename source
    to a `.consumed-<ts>` suffix so a subsequent same-TF executor spawn
    starts fresh (executor will mkdir its STATE_DIR).
    """
    if not state_dir.exists():
        log("archive_skip", reason="state_dir_missing", path=str(state_dir))
        return None
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = BACKUP_DIR / f"{ACCOUNT_ID}-{label}-{ts}"
    try:
        shutil.copytree(state_dir, dest)
        log("state_archived", src=str(state_dir), dest=str(dest))
    except OSError as e:
        log("archive_failed", error=str(e), level="error")
        return None
    # KRIT #3: move source out of the way so next executor mkdir's fresh.
    try:
        consumed = state_dir.with_name(state_dir.name + f".consumed-{ts}")
        state_dir.rename(consumed)
        log("state_dir_consumed", src=str(state_dir), consumed=str(consumed))
    except OSError as e:
        # Non-fatal: copy succeeded. But warn loudly.
        log("state_dir_consume_failed", error=str(e), level="warn")
    return dest


def _read_phase_state() -> dict:
    """AUDIT FIX KRIT #4: persistent phase tracking. Read or init."""
    sf = SUPERVISOR_STATE_DIR / "phase.json"
    if not sf.exists():
        return {}
    try:
        return json.loads(sf.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _write_phase_state(state: dict) -> None:
    SUPERVISOR_STATE_DIR.mkdir(parents=True, exist_ok=True)
    sf = SUPERVISOR_STATE_DIR / "phase.json"
    tmp = sf.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(sf)  # atomic on POSIX


def supervise_phase(
    tf: str, target: float, max_days: int, phase_label: str
) -> str:
    """Returns one of: "passed", "failed", "timeout".

    AUDIT FIX KRIT #4: persists phase_started_at to survive supervisor
    restarts. On restart, reuse stored start-time so deadline doesn't reset.

    AUDIT FIX KRIT #1: executor doesn't exit on target hit (only pauses).
    Detect target via equity-poll, not via proc.poll() exit code.
    On unexpected proc death, re-check equity ONCE before declaring failure.
    """
    state = _read_phase_state()
    phase_start_key = f"{phase_label}_started_at_iso"
    if phase_start_key in state:
        # Restart: reuse original start time
        started_at_iso = state[phase_start_key]
        started_at = datetime.fromisoformat(started_at_iso).timestamp()
        log("phase_resumed", phase=phase_label, started_at_iso=started_at_iso)
    else:
        started_at = time.time()
        state[phase_start_key] = datetime.fromtimestamp(
            started_at, tz=timezone.utc
        ).isoformat()
        _write_phase_state(state)

    state_dir = executor_state_dir(tf)
    target_equity = INITIAL_BALANCE * (1 + target)
    deadline = started_at + max_days * 86400
    proc = spawn_executor(tf, target, max_days)
    log("phase_started", phase=phase_label, tf=tf, target=target,
        target_equity=target_equity,
        deadline_iso=datetime.fromtimestamp(deadline, tz=timezone.utc).isoformat())

    while True:
        time.sleep(POLL_SEC)
        rc = proc.poll()
        if rc is not None:
            # AUDIT FIX KRIT #1: re-check equity before declaring failure.
            # Executor may have hit target then exited (broker disconnect /
            # SIGTERM / etc) leaving target_equity reached but unobserved
            # in last poll cycle.
            final_eq = latest_equity(state_dir)
            if final_eq is not None and final_eq >= target_equity:
                log("phase_target_reached_after_proc_exit",
                    phase=phase_label, equity_usd=final_eq,
                    target_equity=target_equity, exit_rc=rc)
                _wait_for_positions_drain(state_dir)
                archive_state(state_dir, phase_label)
                return "passed"
            log("executor_died_unexpectedly",
                phase=phase_label, returncode=rc, final_equity=final_eq,
                level="error")
            return "failed"

        eq = latest_equity(state_dir)
        if eq is not None:
            log("equity_poll", phase=phase_label, equity_usd=eq, target_equity=target_equity)
            if eq >= target_equity:
                log("phase_target_reached", phase=phase_label, equity_usd=eq, target_equity=target_equity)
                # AUDIT FIX KRIT #2: drain positions before SIGTERM + archive.
                # Sequence: signal executor → wait for open-positions empty →
                # then SIGTERM → archive. Prevents P2 spawn with orphan P1 trades.
                _wait_for_positions_drain(state_dir)
                graceful_stop(proc)
                archive_state(state_dir, phase_label)
                return "passed"

        if time.time() >= deadline:
            log("phase_deadline_exceeded", phase=phase_label, level="error")
            _wait_for_positions_drain(state_dir, timeout_sec=30)
            graceful_stop(proc)
            archive_state(state_dir, f"{phase_label}-TIMEOUT")
            return "timeout"


def _wait_for_positions_drain(
    state_dir: Path, timeout_sec: int = 120
) -> bool:
    """AUDIT FIX KRIT #2: wait until executor reports no open positions.

    Reads `open-positions.json` (executor writes this after each trade-
    state poll). Returns True if drained, False if timeout. Either way,
    caller proceeds — but logs the outcome.
    """
    open_pos_file = state_dir / "open-positions.json"
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if not open_pos_file.exists():
            # No file means executor hasn't initialized / already exited
            # → no positions to drain
            return True
        try:
            data = json.loads(open_pos_file.read_text())
        except (OSError, json.JSONDecodeError):
            time.sleep(2)
            continue
        positions = data.get("positions", []) if isinstance(data, dict) else data
        if not positions:
            log("positions_drained", state_dir=str(state_dir))
            return True
        log("positions_drain_waiting", count=len(positions),
            remaining_sec=int(deadline - time.time()))
        time.sleep(5)
    log("positions_drain_timeout", timeout_sec=timeout_sec, level="warn")
    return False


def main() -> int:
    tf_p1, tf_p2 = _validate_env()
    log(
        "supervisor_start",
        tf_p1=tf_p1, tf_p2=tf_p2,
        initial_balance=INITIAL_BALANCE,
        p1_target=P1_TARGET, p2_target=P2_TARGET,
        p1_max_days=P1_MAX_DAYS, p2_max_days=P2_MAX_DAYS,
        poll_sec=POLL_SEC,
    )

    # AUDIT FIX KRIT #4: persistent phase tracking.
    # On restart, read phase.json. If P1 already passed, skip to P2.
    # If P2 already passed, exit success. If FUNDED, refuse to re-trade.
    state = _read_phase_state()
    if state.get("status") == "FUNDED":
        log("supervisor_exit_idempotent", reason="ACCOUNT_ALREADY_FUNDED",
            funded_at=state.get("funded_at_iso"))
        return 0
    if state.get("status") == "FAILED":
        log("supervisor_exit_idempotent", reason="ACCOUNT_ALREADY_FAILED",
            failed_phase=state.get("failed_phase"),
            failed_at=state.get("failed_at_iso"), level="error")
        return 4
    current_phase = state.get("current_phase", "P1")
    log("supervisor_phase_resume", current_phase=current_phase)

    # Phase 1
    if current_phase == "P1":
        result_p1 = supervise_phase(tf_p1, P1_TARGET, P1_MAX_DAYS, "P1")
        if result_p1 != "passed":
            state["status"] = "FAILED"
            state["failed_phase"] = "P1"
            state["failed_at_iso"] = datetime.now(timezone.utc).isoformat()
            state["failed_reason"] = result_p1
            _write_phase_state(state)
            log("supervisor_exit", phase_failed="P1", result=result_p1, level="error")
            return 2
        state["current_phase"] = "P2"
        state["p1_passed_at_iso"] = datetime.now(timezone.utc).isoformat()
        _write_phase_state(state)

    # Phase 2
    result_p2 = supervise_phase(tf_p2, P2_TARGET, P2_MAX_DAYS, "P2")
    if result_p2 != "passed":
        state["status"] = "FAILED"
        state["failed_phase"] = "P2"
        state["failed_at_iso"] = datetime.now(timezone.utc).isoformat()
        state["failed_reason"] = result_p2
        _write_phase_state(state)
        log("supervisor_exit", phase_failed="P2", result=result_p2, level="error")
        return 3
    state["status"] = "FUNDED"
    state["funded_at_iso"] = datetime.now(timezone.utc).isoformat()
    _write_phase_state(state)

    log("supervisor_funded", message="ACCOUNT FUNDED — both phases passed!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
