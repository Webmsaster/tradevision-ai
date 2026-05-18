#!/usr/bin/env python3
"""
2026-05-18 FTMO Timing-Supervisor v2 — bug-fixed version.

v1 used an EMA-9/21 cross PROXY which delivered only 54.8% pass-rate
(equivalent to baseline, NOT 92%). Bug confirmed against 324-window
backtest: precision=42.6%, supervisor was misleading.

v2 uses the REAL Rust voter engine via ftmo-sweep with windows>=N filtered
by --start-after-ts. The qualified_at_start flag from WindowResult is the
authoritative buy signal — same flag used to compute the 92.42% backtest
pass-rate.

Pipeline:
  1. cache_updater.py: fetch latest 30m bars for all 19 assets
  2. ftmo-sweep --windows N --start-after-ts (NOW - 32d): get LATEST window
  3. Parse qualified= from stdout + per-window jsonl
  4. Write state/timing-gate.json
  5. Telegram BUY_ALLOWED on qualifying-state transition

Run modes:
  python3 scripts/ftmo_timing_supervisor_v2.py            # one-shot
  python3 scripts/ftmo_timing_supervisor_v2.py --skip-cache  # skip cache update
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from datetime import datetime, timezone

PROJ_ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = PROJ_ROOT / "state"
GATE_FILE = STATE_DIR / "timing-gate.json"
HIST_FILE = STATE_DIR / "timing-history.jsonl"
TMP_OUT = Path("/tmp/timing_supervisor_p1.jsonl")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")

SYMBOLS = "AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"

SWEEP_BIN = PROJ_ROOT / "engine-rust" / "target" / "release" / "ftmo-sweep"

def atomic_write(path: Path, content: str) -> None:
    """Atomic write: tmp file + fsync + rename + parent-dir-fsync.

    2026-05-18 Bug-Audit (HOCH): the previous version reopened the file
    after write_text to call fsync — `rb+` on a closed-then-reopened FD
    doesn't durably flush. Use a single open() for write+fsync, and
    fsync the parent directory so the rename itself is durable.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)
    # POSIX: fsync parent dir to durably commit the rename. Best-effort on
    # systems that don't support dir-fsync.
    try:
        dirfd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    except (OSError, AttributeError):
        pass


def update_cache():
    print("[1/3] Updating candle cache from Binance...")
    r = subprocess.run(
        ["python3", "scripts/cache_updater.py"],
        cwd=str(PROJ_ROOT), capture_output=True, text=True, timeout=300
    )
    # 2026-05-18 Bug-Audit (HOCH): cache_updater exit 1 = fetch fail, exit 2
    # = stale cache (>2h old). Both must surface to Telegram so the operator
    # knows the gate state is untrustworthy and can re-trigger manually.
    if r.returncode != 0:
        last_lines = "\n".join(r.stderr.splitlines()[-5:])
        print(f"  [cache-err exit={r.returncode}] {last_lines}", file=sys.stderr)
        emit_telegram(
            f"⚠️ FTMO cache_updater failed (exit {r.returncode}):\n"
            f"{last_lines}\n\n"
            f"Gate state will be stale until next cron tick."
        )
        return False
    for line in r.stdout.splitlines()[-3:]:
        print(f"  {line}")
    return True

def run_sweep():
    print("[2/3] Running ftmo-sweep for latest qualifying check...")
    # 2026-05-18 Bug-Audit (KRITISCH): delete stale TMP_OUT before run.
    # If a previous crash left an old jsonl behind and the new sweep fails
    # early, parse_latest_window would read STALE data from the previous run.
    TMP_OUT.unlink(missing_ok=True)
    # 2026-05-18 Smoke-test: --start-after-ts filter collapsed engine to 0
    # windows ("ZERO survived planning"). Engine's `--windows N --step-days K`
    # already picks the N most-recent windows that fit the cache; explicit
    # ts-filter not needed. 20 windows × 3d = 60d recency horizon.
    cmd = [
        str(SWEEP_BIN),
        "--candles-dir", "scripts/cache_bakeoff",
        "--funding-dir", "scripts/cache_bakeoff",
        "--symbols", SYMBOLS,
        "--windows", "20", "--step-days", "3", "--threads", "8",
        "--profit-target", "0.10", "--max-days", "30",
        "--signals", "regime", "--regime-min-votes", "2",
        "--regime-poc-z", "--regime-bb-z-mr", "--regime-use-supertrend",
        "--regime-use-hmm", "--regime-use-ad-line",
        "--cross-asset-sym", "BTCUSDT",
        "--cross-asset-fast", "9", "--cross-asset-slow", "21",
        "--config", "2h-trend-v5-amber-max-passlock",
        "--override-tp-mult", "1.14",
        "--kelly-sizing", "--kelly-fraction", "0.5",
        "--kelly-window", "60", "--kelly-min-trades", "20",
        "--ptp-levels", "0.08:0.25",
        "--min-initial-signal-breadth", "4",
        "--min-initial-majors", "3",
        "--out", str(TMP_OUT),
    ]
    r = subprocess.run(cmd, cwd=str(PROJ_ROOT), capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        print(f"  [sweep-err] {r.stderr[:500]}", file=sys.stderr)
        return None
    return r.stdout

def parse_sweep_output(stdout):
    """Parse 'qualified=X/Y' line from sweep stdout."""
    # Lines we expect:
    #   "passed=X / Y (Z%)"
    #   "qualified=A / Y (B%) — passed_of_qualified=..."
    qualified_count = 0
    qualified_total = 0
    passed_of_qualified = None
    for line in stdout.splitlines():
        m = re.search(r"qualified=(\d+)\s*/\s*(\d+)", line)
        if m:
            qualified_count = int(m.group(1))
            qualified_total = int(m.group(2))
        m2 = re.search(r"passed_of_qualified=(\d+)\s*/\s*\d+\s*\(([0-9.]+)%\)", line)
        if m2:
            passed_of_qualified = float(m2.group(2))
    return qualified_count, qualified_total, passed_of_qualified

def parse_latest_window(out_path):
    """Read per-window jsonl + return the window with the HIGHEST win_idx.

    2026-05-18 Bug-Audit (KRIT): sweep.rs uses Arc<Mutex<BufWriter>> with
    threaded fan-out — JSONL line order reflects COMPLETION-order, not
    window-order. The last line may be the first window that finished, not
    the most recent in time. Sort explicitly by win_idx (which is
    monotonic in time-order from the engine's `windows` loop).
    """
    if not out_path.exists():
        return None
    lines = out_path.read_text().splitlines()
    if not lines:
        return None
    rows = []
    for line in lines:
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    if not rows:
        return None
    rows.sort(key=lambda r: r.get("win_idx", 0))
    return rows[-1]

def emit_telegram(msg):
    """Send a Telegram message in plain text (no Markdown parsing).

    2026-05-18 Bug-Audit (MITTEL): MarkdownV1 was deprecated and would 400
    on legitimate underscores/asterisks in symbol names. Drop parse_mode.
    """
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = json.dumps({
        "chat_id": TELEGRAM_CHAT_ID,
        "text": msg,
        # No parse_mode → plain text, no escape required.
    }).encode("utf-8")
    try:
        urllib.request.urlopen(
            urllib.request.Request(url, data=payload,
                                   headers={"Content-Type": "application/json"}),
            timeout=10
        ).read()
    except Exception as e:
        print(f"  [telegram-err] {e}", file=sys.stderr)

def main():
    skip_cache = "--skip-cache" in sys.argv

    STATE_DIR.mkdir(parents=True, exist_ok=True)

    if not skip_cache:
        if not update_cache():
            print("❌ Cache update failed — abort.")
            return 1
    else:
        print("[1/3] Skipping cache update (per --skip-cache)")

    sweep_out = run_sweep()
    if sweep_out is None:
        print("❌ Sweep failed — abort.")
        return 1
    # Print sweep lines for visibility
    for line in sweep_out.splitlines()[-3:]:
        print(f"  {line}")

    qcount, qtotal, pass_pct = parse_sweep_output(sweep_out)
    latest = parse_latest_window(TMP_OUT)

    if latest is None:
        print("[3/3] No window data — state unknown.")
        return 1

    # 2026-05-18 Bug-Audit (KRIT): need >= 3 windows for a stable qualified
    # rate. With qtotal=1 the gate flips on a single window's noise (n=1
    # qualified_count means either 0% or 100%). Refuse to write the gate
    # below that threshold and alert operator.
    if qtotal < 3:
        msg = (f"⚠️ Engine returned only {qtotal} window(s) — refusing to update "
               f"gate (need ≥3 for stable signal). Check cache freshness + "
               f"--start-after-ts unit-mismatch.")
        print(f"❌ {msg}")
        emit_telegram(msg)
        return 1

    qualified = latest.get("qualified_at_start", False)
    breadth = latest.get("first_cluster_size", 0)
    majors = latest.get("first_cluster_majors", 0)

    now_iso = datetime.now(timezone.utc).isoformat()
    state = {
        "ts": int(time.time() * 1000),
        "ts_iso": now_iso,
        "qualified": qualified,
        "breadth": breadth,
        "majors": majors,
        "engine_qualified_count": qcount,
        "engine_qualified_total": qtotal,
        "engine_pass_of_qualified_pct": pass_pct,
        "min_breadth": 4,
        "min_majors": 3,
        "source": "ftmo-sweep --windows 20 --step-days 3 (60d recency horizon)",
        "validation": "v2: real Rust engine with V02 voters (NOT EMA proxy)",
    }

    print(f"\n[3/3] Engine result:")
    print(f"  qualified_at_start: {qualified}")
    print(f"  breadth: {breadth}/{state['min_breadth']}")
    print(f"  majors: {majors}/{state['min_majors']}")
    if pass_pct is not None:
        print(f"  Pass-of-qualified rate (forward window): {pass_pct:.2f}%")

    # Load prev state for transition detection
    prev = None
    if GATE_FILE.exists():
        try:
            prev = json.loads(GATE_FILE.read_text())
        except Exception:
            prev = None

    # 2026-05-18 Bug-Audit (KRITISCH): atomic write — bot polls this file
    # concurrently. Without tmp+rename, the reader can hit an empty/partial
    # JSON during writer truncate-and-write, crash, and end up with corrupt
    # gate state.
    atomic_write(GATE_FILE, json.dumps(state, indent=2))
    # History is append-only — line-write with flush is fine, but rotate
    # if file > 10MB (memory R67-r9 lesson).
    if HIST_FILE.exists() and HIST_FILE.stat().st_size > 10 * 1024 * 1024:
        lines = HIST_FILE.read_text().splitlines()
        atomic_write(HIST_FILE, "\n".join(lines[-5000:]) + "\n")
    with HIST_FILE.open("a") as f:
        f.write(json.dumps(state) + "\n")

    # Transition detection
    prev_qualified = prev.get("qualified", False) if prev else False
    if qualified and not prev_qualified:
        msg = (f"🎯 *FTMO BUY ALLOWED* ({now_iso})\n\n"
               f"Engine V02-voters QUALIFIED for current setup:\n"
               f"  Breadth: {breadth} >= {state['min_breadth']}\n"
               f"  Majors: {majors} >= {state['min_majors']}\n\n"
               f"Smart-Timing-Gate (real engine, NOT proxy) qualifying.\n"
               f"Expected pass-rate: ~92% (memory phase33 backtest).\n"
               f"Buy challenge now.")
        print(f"\n{msg}")
        emit_telegram(msg)
    elif not qualified and prev_qualified:
        msg = (f"⏸ FTMO gate DEACTIVATED ({now_iso})\n"
               f"Breadth {breadth}/{state['min_breadth']}, "
               f"majors {majors}/{state['min_majors']}")
        print(f"\n{msg}")
        emit_telegram(msg)
    else:
        print(f"\n  No state change (qualified={qualified}, prev={prev_qualified})")

    return 0

if __name__ == "__main__":
    sys.exit(main())
