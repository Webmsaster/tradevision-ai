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
    """Read most-recent equity from <state>/equity-history.jsonl."""
    eqh = state_dir / "equity-history.jsonl"
    if not eqh.exists():
        return None
    try:
        with open(eqh, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            # Read last 4KB
            f.seek(max(0, size - 4096))
            tail = f.read().decode("utf-8", errors="ignore")
        last_line = next(
            (line for line in reversed(tail.splitlines()) if line.strip()), None
        )
        if not last_line:
            return None
        rec = json.loads(last_line)
        return float(rec.get("equity_usd", 0))
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def spawn_executor(tf: str, target: float, max_days: int) -> subprocess.Popen:
    """Spawn ftmo_executor.py subprocess for a single phase."""
    env = os.environ.copy()
    env["FTMO_TF"] = tf
    env["FTMO_PROFIT_TARGET"] = str(target)
    env["FTMO_MAX_DAYS"] = str(max_days)
    env["FTMO_ACCOUNT_ID"] = ACCOUNT_ID
    log("spawn_executor", tf=tf, target=target, max_days=max_days)
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
    if not state_dir.exists():
        log("archive_skip", reason="state_dir_missing", path=str(state_dir))
        return None
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = BACKUP_DIR / f"{ACCOUNT_ID}-{label}-{ts}"
    try:
        shutil.copytree(state_dir, dest)
        log("state_archived", src=str(state_dir), dest=str(dest))
        return dest
    except OSError as e:
        log("archive_failed", error=str(e), level="error")
        return None


def supervise_phase(
    tf: str, target: float, max_days: int, phase_label: str
) -> str:
    """Returns one of: "passed", "failed", "timeout"."""
    state_dir = executor_state_dir(tf)
    target_equity = INITIAL_BALANCE * (1 + target)
    deadline = time.time() + max_days * 86400
    proc = spawn_executor(tf, target, max_days)
    log("phase_started", phase=phase_label, tf=tf, target=target,
        target_equity=target_equity, deadline_iso=datetime.fromtimestamp(deadline, tz=timezone.utc).isoformat())

    while True:
        time.sleep(POLL_SEC)
        rc = proc.poll()
        if rc is not None:
            log("executor_died_unexpectedly", phase=phase_label, returncode=rc, level="error")
            return "failed"

        eq = latest_equity(state_dir)
        if eq is not None:
            log("equity_poll", phase=phase_label, equity_usd=eq, target_equity=target_equity)
            if eq >= target_equity:
                log("phase_target_reached", phase=phase_label, equity_usd=eq, target_equity=target_equity)
                graceful_stop(proc)
                archive_state(state_dir, phase_label)
                return "passed"

        if time.time() >= deadline:
            log("phase_deadline_exceeded", phase=phase_label, level="error")
            graceful_stop(proc)
            archive_state(state_dir, f"{phase_label}-TIMEOUT")
            return "timeout"


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

    # Phase 1
    result_p1 = supervise_phase(tf_p1, P1_TARGET, P1_MAX_DAYS, "P1")
    if result_p1 != "passed":
        log("supervisor_exit", phase_failed="P1", result=result_p1, level="error")
        return 2

    # Phase 2
    result_p2 = supervise_phase(tf_p2, P2_TARGET, P2_MAX_DAYS, "P2")
    if result_p2 != "passed":
        log("supervisor_exit", phase_failed="P2", result=result_p2, level="error")
        return 3

    log("supervisor_funded", message="ACCOUNT FUNDED — both phases passed!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
