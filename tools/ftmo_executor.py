"""
FTMO MT5 Executor — polls signals, places orders, manages positions.

Features:
- Places market orders with correct lot size computed from risk%
- Sets SL/TP at broker
- Enforces FTMO rules (daily loss, total loss) before each entry
- Writes account.json back so Node service has live equity
- Manages hold-time expiry (closes positions after maxHoldHours)
- **Daily reset** at UTC 00:00 — saves equityAtDayStart
- **Auto-reconnect** on MT5 disconnect — retries indefinitely
- **Mock mode** via FTMO_MOCK=1 — uses tools/mock_mt5.py for Linux/Mac testing
- **Telegram alerts** via TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars

Run real:
    pip install MetaTrader5
    python tools/ftmo_executor.py

Run mock (no MT5 needed, simulates on Binance prices):
    FTMO_MOCK=1 python tools/ftmo_executor.py
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Resolve tools/ dir so we can import mock_mt5 when needed
_TOOLS_DIR = Path(__file__).resolve().parent
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

MOCK_MODE = os.environ.get("FTMO_MOCK", "").lower() in ("1", "true", "yes")

if MOCK_MODE:
    print("[executor] MOCK MODE — using tools/mock_mt5.py (no real MT5)")
    import mock_mt5 as mt5  # type: ignore
else:
    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError:
        print("ERROR: MetaTrader5 library not found. Install with: pip install MetaTrader5")
        print("       OR run in mock mode: FTMO_MOCK=1 python tools/ftmo_executor.py")
        sys.exit(1)

from telegram_notify import tg_send, html_escape  # type: ignore


# =============================================================================
# Config — via env vars
# =============================================================================
_FTMO_TF = os.environ.get("FTMO_TF", "1h")
STATE_DIR = Path(
    os.environ.get("FTMO_STATE_DIR", f"./ftmo-state-{_FTMO_TF}")
)
POLL_INTERVAL_SEC = 30
RECONNECT_BACKOFF_SEC = 10
CHALLENGE_START_BALANCE = float(os.environ.get("FTMO_START_BALANCE", "100000"))
MAX_DAILY_LOSS_PCT = 0.05
MAX_TOTAL_LOSS_PCT = 0.10
CHALLENGE_START_DATE = os.environ.get("FTMO_START_DATE")

# iter236+: Profit target & pause-after-target behavior
# FIX 2026-04-27: FTMO Step 1 = 8% target (not 10%). Step 2 = 5% / 60d.
# Default to Step 1 conditions. Override via FTMO_PROFIT_TARGET env var if doing Step 2.
PROFIT_TARGET_PCT = float(os.environ.get("FTMO_PROFIT_TARGET", "0.08"))  # FTMO Step 1 = 8%
MIN_TRADING_DAYS = int(os.environ.get("FTMO_MIN_TRADING_DAYS", "4"))      # FTMO 2-Step (Step 1 & 2) requires 4 trading days minimum
PAUSE_AT_TARGET = os.environ.get("FTMO_PAUSE_AT_TARGET", "1").lower() in ("1", "true", "yes")
# Round 28: dailyPeakTrailingStop. When intraday equity drops trailDistance
# below today's peak, block new entries (Anti-DL pattern). R28 default = 0.012.
# Set FTMO_DPT_TRAIL=0 to disable. Engine config V5_QUARTZ_LITE_R28 uses 0.012.
DPT_TRAIL_DISTANCE = float(os.environ.get("FTMO_DPT_TRAIL", "0.012"))
DPT_ENABLED = DPT_TRAIL_DISTANCE > 0
# Ping trade asset (tiny no-risk trade to clock minTradingDays after target hit)
PING_SYMBOL_BINANCE = os.environ.get("FTMO_PING_SYMBOL", "ETHUSDT")
PING_LOT_SIZE = float(os.environ.get("FTMO_PING_LOT", "0.01"))  # tiny lot

# Hard-cap on risk_frac sent by signal source. Refuses orders above this.
# FTMO daily-loss = 5%, total-loss = 10%. Capping per-trade at 5% means at
# worst a single bad fill costs 5% — still inside DL after one stop-out.
# A hot signal can still arrive at 200% (legacy backtest formula) — this
# is the executor's last line of defence against the "no money" cascade.
# Phase 12 (CRITICAL Auth Bug 4): default 0.07 contradicted the doc above
# ("5% means at worst single fill costs 5%") and could blow the FTMO -5%
# DL on a single stop-out. Lowered to 0.05 to match the comment.
RISK_FRAC_HARD_CAP = float(os.environ.get("FTMO_RISK_HARD_CAP", "0.05"))

# Auto-pause after N consecutive failed orders (e.g. "no money" cascade).
# Resets to 0 on the first successful order. Setting to 0 disables.
ORDER_FAIL_AUTO_PAUSE = int(os.environ.get("FTMO_ORDER_FAIL_PAUSE", "3"))

# BUGFIX 2026-04-28: enforce engine.maxConcurrentTrades in live executor.
# Engine caps simultaneous open trades (e.g. V5 → 6, ELITE → 12) but live had
# no cap → could open arbitrary count if many signals queued at once. Default
# 8 = safe upper bound for all current configs (V5 family ≤ 12). User can
# tune via FTMO_MAX_CONCURRENT.
MAX_CONCURRENT_TRADES = int(os.environ.get("FTMO_MAX_CONCURRENT", "8"))

# Dry-run mode: log planned orders but never call mt5.order_send.
DRY_RUN = os.environ.get("FTMO_DRY_RUN", "").lower() in ("1", "true", "yes")

# Circuit breaker — pause trading after N consecutive losses
CB_LOSS_STREAK = int(os.environ.get("FTMO_CB_LOSS_STREAK", "3"))
# Daily DD warning threshold (alert only, not pause)
CB_DAILY_DD_WARN_PCT = float(os.environ.get("FTMO_CB_DAILY_DD_WARN", "0.03"))
# Equity history sample interval
EQUITY_HISTORY_INTERVAL_SEC = 300  # 5 minutes

# Rate-limit duplicate loop-error Telegram alerts (avoid spam during restart loops).
# Maps error message prefix → last sent timestamp.
_loop_error_last_sent: dict[str, float] = {}
# FTMO Consistency Rule — warn when largest single trade approaches 45% of total profit
CONSISTENCY_WARN_RATIO = float(os.environ.get("FTMO_CONSISTENCY_WARN_RATIO", "0.35"))
CONSISTENCY_HARD_RATIO = float(os.environ.get("FTMO_CONSISTENCY_HARD_RATIO", "0.42"))

SYMBOL_MAP = {
    "ETHUSDT": os.environ.get("FTMO_ETH_SYMBOL", "ETHUSD"),
    "BTCUSDT": os.environ.get("FTMO_BTC_SYMBOL", "BTCUSD"),
    "SOLUSDT": os.environ.get("FTMO_SOL_SYMBOL", "SOLUSD"),
    "BCHUSDT": os.environ.get("FTMO_BCH_SYMBOL", "BCHUSD"),
    "LTCUSDT": os.environ.get("FTMO_LTC_SYMBOL", "LTCUSD"),
    "LINKUSDT": os.environ.get("FTMO_LINK_SYMBOL", "LNKUSD"),
    "BNBUSDT": os.environ.get("FTMO_BNB_SYMBOL", "BNBUSD"),
    "ADAUSDT": os.environ.get("FTMO_ADA_SYMBOL", "ADAUSD"),
    "DOGEUSDT": os.environ.get("FTMO_DOGE_SYMBOL", "DOGEUSD"),
    "AVAXUSDT": os.environ.get("FTMO_AVAX_SYMBOL", "AVAUSD"),
    # Round 23: V5_QUARTZ_LITE 9-asset pool needs ETC, XRP, AAVE
    "ETCUSDT": os.environ.get("FTMO_ETC_SYMBOL", "ETCUSD"),
    "XRPUSDT": os.environ.get("FTMO_XRP_SYMBOL", "XRPUSD"),
    # FTMO-spezifisch: AAVUSD (ohne E) — nicht AAVEUSD wie bei Binance.
    "AAVEUSDT": os.environ.get("FTMO_AAVE_SYMBOL", "AAVUSD"),
}

PENDING_PATH = STATE_DIR / "pending-signals.json"
EXECUTED_PATH = STATE_DIR / "executed-signals.json"
ACCOUNT_PATH = STATE_DIR / "account.json"
OPEN_POS_PATH = STATE_DIR / "open-positions.json"
PAUSE_STATE_PATH = STATE_DIR / "pause-state.json"  # iter236+ pause-after-target tracking
EXECUTOR_LOG_PATH = STATE_DIR / "executor-log.jsonl"
DAILY_STATE_PATH = STATE_DIR / "daily-reset.json"
DAY_PEAK_PATH = STATE_DIR / "day-peak.json"  # R28: dailyPeakTrailingStop state
CONTROLS_PATH = STATE_DIR / "bot-controls.json"
EQUITY_HISTORY_PATH = STATE_DIR / "equity-history.jsonl"
NEWS_PATH = STATE_DIR / "news-events.json"
# BUGFIX 2026-04-28 (Round 13 Bug 1): write-ahead log for order idempotency.
# Each pending order gets a marker file with a deterministic ID before
# mt5.order_send is called. On boot, markers without confirmed MT5 orders
# are re-queued; markers with confirmed MT5 orders are removed.
PENDING_ORDERS_DIR = STATE_DIR / "pending-orders"

# News auto-close: flatten positions N minutes before high-impact events
NEWS_CLOSE_MINUTES_BEFORE = int(os.environ.get("FTMO_NEWS_CLOSE_MINUTES", "30"))


# BUGFIX 2026-04-28 (Round 31): validate config sanity at startup. Prevents
# nonsense env values (FTMO_RISK_HARD_CAP=70 = 7000% would otherwise pass).
def _validate_config() -> None:
    errs = []
    if not 0.001 <= RISK_FRAC_HARD_CAP <= 0.5:
        errs.append(f"FTMO_RISK_HARD_CAP={RISK_FRAC_HARD_CAP} out of [0.001, 0.5]")
    if not 0.01 <= PROFIT_TARGET_PCT <= 0.20:
        errs.append(f"FTMO_PROFIT_TARGET={PROFIT_TARGET_PCT} out of [0.01, 0.20]")
    if not 1 <= MIN_TRADING_DAYS <= 30:
        errs.append(f"FTMO_MIN_TRADING_DAYS={MIN_TRADING_DAYS} out of [1, 30]")
    if not 1000 <= CHALLENGE_START_BALANCE <= 5_000_000:
        errs.append(f"FTMO_START_BALANCE={CHALLENGE_START_BALANCE} out of [1000, 5M]")
    if not 1 <= NEWS_CLOSE_MINUTES_BEFORE <= 240:
        errs.append(f"FTMO_NEWS_CLOSE_MINUTES={NEWS_CLOSE_MINUTES_BEFORE} out of [1, 240]")
    if errs:
        msg = "Invalid config — refusing to start:\n" + "\n".join("  - " + e for e in errs)
        print(f"[executor] FATAL: {msg}", file=sys.stderr)
        sys.exit(1)


_validate_config()


# =============================================================================
# IO helpers
# =============================================================================
def _rotate_jsonl_if_needed(path: Path, max_mb: int = 50) -> None:
    """BUGFIX 2026-04-28 (Round 12): rotate jsonl files at 50MB to prevent
    unbounded disk fill on long-running bots."""
    try:
        if path.exists() and path.stat().st_size > max_mb * 1024 * 1024:
            archive = path.with_suffix(f".{datetime.now(timezone.utc).strftime('%Y%m%d')}.jsonl")
            path.rename(archive)
    except Exception:
        pass  # don't crash on rotation issues


def log_event(event: str, level: str = "info", **kwargs: Any) -> None:
    """BUGFIX 2026-04-28 (Round 30): added severity level. Default 'info' for
    backwards compat; pass level='warn' or 'error' for parseable filtering."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    _rotate_jsonl_if_needed(EXECUTOR_LOG_PATH)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "event": event,
        **kwargs,
    }
    with open(EXECUTOR_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
    print(f"[executor] [{level}] {event}: {kwargs}")


def read_json(path: Path, fallback: Any) -> Any:
    try:
        if not path.exists():
            return fallback
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        print(f"[executor] failed to read {path}: {e}")
        return fallback


def write_json(path: Path, obj: Any) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    # BUGFIX 2026-04-28: PID-suffixed tmp prevents cross-process race
    # (Node telegramBot and Python both write bot-controls.json).
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    tmp.replace(path)


# BUGFIX 2026-04-28 (Round 36 Bug 5/7): cross-process exclusive lock for
# bot-controls.json read-modify-write. Without this, Node telegramBot's
# R-M-W (e.g. /pause) could race with Python's R-M-W (orderFailStreak++),
# losing one update. Concrete failure: user sends /pause during an
# order-failure burst; Python's stale read writes back paused=False → bot
# keeps firing failed orders.
#
# Mechanism: O_CREAT|O_EXCL sentinel file ("bot-controls.lock"). Cross-
# platform AND interoperable with the Node setControls helper which uses
# the exact same primitive (fs.openSync(path, "wx")). Falls back to
# force-acquire if the lock is older than 2s (assume crashed holder).
import contextlib

CONTROLS_LOCK_TIMEOUT_SEC = 2.0

@contextlib.contextmanager
def _file_lock(lock_path: Path):
    """Exclusive lock on lock_path via O_CREAT|O_EXCL sentinel."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    start = time.time()
    fd: Optional[int] = None
    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, str(os.getpid()).encode())
            except Exception:
                pass
            break
        except FileExistsError:
            # Force-take if the lock is stale (crashed holder).
            if time.time() - start > CONTROLS_LOCK_TIMEOUT_SEC:
                try:
                    lock_path.unlink(missing_ok=True)
                except Exception:
                    pass
            time.sleep(0.005)
    try:
        yield
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except Exception:
                pass
        try:
            lock_path.unlink(missing_ok=True)
        except Exception:
            pass


def update_controls(updater) -> dict:
    """Atomic read-modify-write on bot-controls.json under cross-process lock.
    `updater` receives a dict and mutates it in-place (or returns a new dict).
    Returns the post-update dict.
    """
    lock_path = STATE_DIR / "bot-controls.lock"
    with _file_lock(lock_path):
        controls = read_json(CONTROLS_PATH, {})
        result = updater(controls)
        if isinstance(result, dict):
            controls = result
        write_json(CONTROLS_PATH, controls)
        return controls


# =============================================================================
# MT5 connection — with reconnect
# =============================================================================
def mt5_init_with_retry() -> bool:
    """Try to initialize. On success returns True. Caller handles retry.

    Honors MT5_PATH env var so multiple parallel MT5 installations can be
    targeted (e.g. one terminal per FTMO account on the same VPS).
    """
    mt5_path = os.environ.get("MT5_PATH", "").strip()
    ok = mt5.initialize(path=mt5_path) if mt5_path else mt5.initialize()  # type: ignore[call-arg]
    if ok:
        info = mt5.account_info()
        if info is not None:
            log_event("mt5_connected", login=info.login, server=info.server, balance=info.balance, equity=info.equity, path=mt5_path or "default")
            return True
    err = mt5.last_error() if hasattr(mt5, "last_error") else ("?", "?")
    log_event("mt5_init_failed", error=str(err), path=mt5_path or "default")
    return False


def mt5_ensure_connected() -> bool:
    """Check if MT5 is still connected. If not, try to reconnect. Blocks until success."""
    info = mt5.account_info()
    if info is not None:
        return True
    log_event("mt5_disconnected", action="attempting_reconnect")
    tg_send(f"⚠️ <b>MT5 Disconnected</b>\nExecutor attempting reconnect every {RECONNECT_BACKOFF_SEC}s…")
    # BUGFIX 2026-04-28: was infinite loop with no escalation. Now exits after
    # MAX_RECONNECT_ATTEMPTS so PM2/systemd can fully restart the process.
    MAX_RECONNECT_ATTEMPTS = 60  # ~5 min at 5s backoff
    attempt = 0
    while True:
        attempt += 1
        try:
            mt5.shutdown()
        except Exception:
            pass
        time.sleep(RECONNECT_BACKOFF_SEC)
        if mt5_init_with_retry():
            log_event("mt5_reconnected", attempt=attempt)
            tg_send(f"✅ <b>MT5 Reconnected</b> after {attempt} attempt(s)")
            return True
        if attempt == 3 or attempt == 10 or attempt % 30 == 0:
            log_event("mt5_still_disconnected", attempt=attempt)
            tg_send(f"🔴 <b>MT5 still down</b> — attempt #{attempt}, backoff {RECONNECT_BACKOFF_SEC}s")
        if attempt >= MAX_RECONNECT_ATTEMPTS:
            log_event("mt5_reconnect_giving_up", attempt=attempt)
            tg_send(f"💀 <b>MT5 reconnect FAILED</b> after {attempt} attempts — exiting (PM2 will restart)")
            sys.exit(1)


def mt5_get_equity() -> dict:
    info = mt5.account_info()
    if info is None:
        return {"equity": None, "balance": None, "margin": None, "free_margin": None}
    return {
        "equity": float(info.equity),
        "balance": float(info.balance),
        "margin": float(info.margin),
        "free_margin": float(info.margin_free),
    }


# =============================================================================
# FTMO rules + daily reset
# =============================================================================
def check_ftmo_rules(current_equity: float, day_start_equity: float) -> Optional[str]:
    """Block-new-entries gate — runs each pending-signal cycle.

    Bug-Audit Phase 3 (Python Bug 1+2): widened buffers so we stop QUEUING
    new orders well before the actual FTMO -5% / -10% caps. Emergency-close
    of OPEN positions is handled separately in sync_account_state with a
    larger buffer (see DL_EMERGENCY_BUFFER / TL_EMERGENCY_BUFFER).
    """
    daily_pct = (current_equity - day_start_equity) / day_start_equity
    # 0.005 → 0.010 (block at -4.0% instead of -4.5%): crypto can move 0.5%
    # in a 30-second poll window, that buffer was too tight to prevent breach.
    if daily_pct <= -MAX_DAILY_LOSS_PCT + 0.010:
        return f"daily_loss: {daily_pct:.2%} near -{MAX_DAILY_LOSS_PCT:.0%} cap"
    total_pct = (current_equity - CHALLENGE_START_BALANCE) / CHALLENGE_START_BALANCE
    if total_pct <= -MAX_TOTAL_LOSS_PCT + 0.015:
        return f"total_loss: {total_pct:.2%} near -{MAX_TOTAL_LOSS_PCT:.0%} cap"
    return None


# Bug-Audit Phase 3: emergency-close thresholds.
# DL: close all open positions when intraday drawdown reaches -2.5% to leave
#     SL slippage room before the actual -5% breach.
# TL: close all open positions at -7.5% to prevent the -10% all-time breach
#     (was completely missing — only DL had emergency close).
DL_EMERGENCY_BUFFER = 0.025  # close positions at -(MAX_DAILY_LOSS_PCT - 0.025) = -2.5%
TL_EMERGENCY_BUFFER = 0.025  # close positions at -(MAX_TOTAL_LOSS_PCT - 0.025) = -7.5%


def get_day_peak_state() -> dict:
    """
    R28: dailyPeakTrailingStop persistent state.
    Returns {date: "YYYY-MM-DD", peak_equity_usd: float, last_check_ts: iso}.
    Date is Prague timezone to align with FTMO daily-reset boundary.
    """
    return read_json(DAY_PEAK_PATH, {"date": None, "peak_equity_usd": 0.0})


def update_day_peak(current_equity_usd: float) -> float:
    """
    R28: Update intraday peak equity. Resets at Prague midnight (matching
    FTMO daily-loss anchor). Returns the current day-peak.

    Mirrors engine line 5045-5048: dayPeak ratchets only upward within a day.
    """
    try:
        from zoneinfo import ZoneInfo
        prague_tz = ZoneInfo("Europe/Prague")
    except ImportError:
        from datetime import timedelta
        prague_tz = timezone(timedelta(hours=1))
    today_prague = datetime.now(prague_tz).strftime("%Y-%m-%d")
    state = get_day_peak_state()
    if state.get("date") != today_prague:
        # New day: snapshot current equity as new peak baseline.
        state = {"date": today_prague, "peak_equity_usd": float(current_equity_usd)}
        write_json(DAY_PEAK_PATH, state)
        log_event("day_peak_reset", date=today_prague, peak=current_equity_usd)
        return float(current_equity_usd)
    prev_peak = float(state.get("peak_equity_usd") or current_equity_usd)
    if current_equity_usd > prev_peak:
        state["peak_equity_usd"] = float(current_equity_usd)
        state["last_check_ts"] = datetime.now(timezone.utc).isoformat()
        write_json(DAY_PEAK_PATH, state)
        return float(current_equity_usd)
    return prev_peak


def check_daily_peak_trail_block(current_equity_usd: float) -> Optional[str]:
    """
    R28: Anti-DL gate. If intraday equity has dropped trailDistance below
    today's realized peak, block new entries (lock in gains, don't give back).

    Mirrors engine line 4810-4816. Returns blocker reason or None.
    """
    if not DPT_ENABLED:
        return None
    peak = update_day_peak(current_equity_usd)
    if peak <= 0:
        return None
    drop = (peak - current_equity_usd) / peak
    if drop >= DPT_TRAIL_DISTANCE:
        return f"day_peak_trail: drop {drop:.2%} >= {DPT_TRAIL_DISTANCE:.2%} from intraday peak ${peak:,.2f}"
    return None


# Round 35: peakDrawdownThrottle persistent state for R28_V2/V3/V4 sizing.
# Engine ftmoDaytrade24h.ts:4983-4988 scales risk by `factor` when equity
# is `fromPeak` below all-time challenge peak. Without persistent state,
# Python forgets the peak across restarts and the backtest's +12pp lift
# becomes a Live-mode illusion (V13_LIVEFIRST_30M doc warns about this).
CHALLENGE_PEAK_PATH = STATE_DIR / "challenge-peak.json"


def get_challenge_peak_state() -> dict:
    """
    Returns {peak_equity_usd: float, last_update_ts: iso, started_at: iso}.
    Resets only when CHALLENGE_START_DATE changes (new challenge).
    """
    return read_json(
        CHALLENGE_PEAK_PATH,
        {"peak_equity_usd": 0.0, "last_update_ts": None, "started_at": None},
    )


def update_challenge_peak(current_equity_usd: float) -> float:
    """
    Round 35: Update all-time challenge-peak equity. Persists across PM2
    restarts via challenge-peak.json. Resets only when CHALLENGE_START_DATE
    changes (new challenge → old peak no longer valid) or when the file
    has not yet been seeded for this challenge.

    Mirrors engine line 5055: `peak = max(peak, equity)`, but persistent.
    Returns the current challenge-peak.
    """
    raw = read_json(CHALLENGE_PEAK_PATH, None)
    needs_seed = (
        raw is None
        or raw.get("started_at") != CHALLENGE_START_DATE
        or float(raw.get("peak_equity_usd") or 0.0) <= 0
    )
    if needs_seed:
        seeded = {
            "peak_equity_usd": float(current_equity_usd),
            "last_update_ts": datetime.now(timezone.utc).isoformat(),
            "started_at": CHALLENGE_START_DATE,
        }
        write_json(CHALLENGE_PEAK_PATH, seeded)
        log_event(
            "challenge_peak_seeded",
            started_at=CHALLENGE_START_DATE,
            peak=current_equity_usd,
        )
        return float(current_equity_usd)

    prev_peak = float(raw["peak_equity_usd"])
    if current_equity_usd > prev_peak:
        raw["peak_equity_usd"] = float(current_equity_usd)
        raw["last_update_ts"] = datetime.now(timezone.utc).isoformat()
        write_json(CHALLENGE_PEAK_PATH, raw)
        return float(current_equity_usd)
    return prev_peak


def get_challenge_day() -> int:
    if not CHALLENGE_START_DATE:
        return 0
    try:
        start = datetime.fromisoformat(CHALLENGE_START_DATE).replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        return max(0, (now - start).days)
    except Exception:
        return 0


def handle_daily_reset(current_equity_usd: float) -> float:
    """
    Return the equity-at-day-start (in USD). At CE(S)T 00:00 each calendar day
    (FTMO server timezone = Europe/Prague), snapshots the current equity as
    the new day-start baseline. Persists to daily-reset.json.

    BUGFIX 2026-04-28: Was using UTC, but FTMO daily-loss anchor is at
    midnight Prague (00:00 CET = 23:00 UTC winter, 22:00 UTC summer).
    Off-by-1-2h led to spurious DL boundary detection at the timezone edge.
    """
    try:
        from zoneinfo import ZoneInfo
        prague_tz = ZoneInfo("Europe/Prague")
    except ImportError:
        # Python <3.9 fallback — use fixed CET offset
        from datetime import timedelta
        prague_tz = timezone(timedelta(hours=1))  # CET, ignores DST
    today_prague = datetime.now(prague_tz).strftime("%Y-%m-%d")
    state = read_json(DAILY_STATE_PATH, {})
    last_date = state.get("date")

    if last_date != today_prague:
        # New Prague day — snapshot current equity
        new_state = {
            "date": today_prague,
            "equity_at_day_start_usd": current_equity_usd,
            "snapped_at": datetime.now(timezone.utc).isoformat(),
            "tz": "Europe/Prague",
        }
        write_json(DAILY_STATE_PATH, new_state)
        if last_date is not None:
            prev_start = state.get("equity_at_day_start_usd", current_equity_usd)
            prev_pnl = current_equity_usd - prev_start
            prev_pct = prev_pnl / prev_start if prev_start else 0
            log_event("daily_reset", prev_date=last_date, new_date=today_prague, prev_day_pnl=prev_pnl)
            tg_send(_build_daily_summary(today_prague, last_date, prev_pct, prev_pnl, current_equity_usd))
        else:
            log_event("daily_state_first_write", date=today_prague, equity=current_equity_usd)
        return current_equity_usd
    # BUGFIX 2026-04-28 (Round 23 H4): if state matches today but the equity
    # field is missing or non-numeric, log + alert. Returning current_equity
    # silently would mask any intra-day drawdown that already happened —
    # post-drawdown, the equity_at_day_start must NOT slide upward.
    raw = state.get("equity_at_day_start_usd")
    if not isinstance(raw, (int, float)) or raw <= 0:
        log_event(
            "daily_state_corrupt",
            date=last_date,
            raw_equity_at_day_start=raw,
            current_equity=current_equity_usd,
            recovery="using_current_equity_as_fallback_BUT_DL_MAY_BE_UNDERSTATED",
        )
        tg_send(
            "⚠️ <b>Daily-state corrupt</b>\n"
            f"<code>equity_at_day_start_usd</code> missing/invalid for {last_date}.\n"
            f"Falling back to current equity ${current_equity_usd:,.2f}. "
            "Daily-loss check may be understated until next Prague midnight."
        )
        return float(current_equity_usd)
    return float(raw)


def _build_daily_summary(today_utc: str, last_date: str, prev_pct: float, prev_pnl: float, current_equity_usd: float) -> str:
    """Build a rich daily-summary Telegram message with stats + ASCII chart."""
    equity_pct = (current_equity_usd - CHALLENGE_START_BALANCE) / CHALLENGE_START_BALANCE
    target_progress = max(0.0, equity_pct / PROFIT_TARGET_PCT)
    dl_used = abs(min(0.0, (current_equity_usd - CHALLENGE_START_BALANCE) / CHALLENGE_START_BALANCE)) / 0.05
    tl_floor_usd = CHALLENGE_START_BALANCE * 0.90
    tl_remaining = (current_equity_usd - tl_floor_usd) / CHALLENGE_START_BALANCE

    # Yesterday's trade stats from MT5 history
    win_rate, avg_trade, best, worst, n_trades = _get_yesterday_trade_stats(last_date)

    # ASCII bar for equity progress
    bar_len = 20
    filled = max(0, min(bar_len, int(target_progress * bar_len)))
    bar = "█" * filled + "░" * (bar_len - filled)
    pct_str = f"{equity_pct * 100:+.2f}%"

    # Days-to-pass estimate (based on yesterday's velocity)
    velocity = prev_pct  # fraction per day
    days_to_pass_str = ""
    if velocity > 0 and equity_pct < PROFIT_TARGET_PCT:
        remaining = PROFIT_TARGET_PCT - equity_pct
        days_est = remaining / velocity
        days_to_pass_str = f"\n📈 At yesterday's velocity: ~{days_est:.1f}d to target"

    msg = (
        f"📅 <b>Daily Reset {today_utc}</b>\n\n"
        f"<b>Yesterday ({last_date}):</b> <b>{prev_pct:+.2%}</b> (${prev_pnl:+,.2f})\n"
    )
    if n_trades > 0:
        msg += (
            f"  Trades: {n_trades}  WR: {win_rate*100:.0f}%  Avg: ${avg_trade:+,.2f}\n"
            f"  Best: ${best:+,.2f}  Worst: ${worst:+,.2f}\n"
        )
    else:
        msg += f"  No closed trades yesterday\n"
    msg += (
        f"\n<b>Target Progress: {pct_str} / +{PROFIT_TARGET_PCT*100:.0f}%</b>\n"
        f"<code>{bar}</code> {target_progress*100:.0f}%\n"
        f"\n<b>Risk Used:</b>\n"
        f"  DL: {dl_used*100:.0f}% of -5% cap\n"
        f"  TL buffer: {tl_remaining*100:+.2f}% to -10% cap\n"
        f"\nToday starts: <b>${current_equity_usd:,.2f}</b>"
        f"{days_to_pass_str}"
    )
    return msg


def _get_yesterday_trade_stats(date_str: str) -> tuple[float, float, float, float, int]:
    """
    Returns (win_rate, avg_trade_usd, best_usd, worst_usd, n_trades) for the
    given UTC date. Pulls from MT5 history. Returns (0,0,0,0,0) if no data.
    """
    try:
        # date_str is "YYYY-MM-DD"
        y, m, d = (int(x) for x in date_str.split("-"))
        day_start = datetime(y, m, d, 0, 0, 0, tzinfo=timezone.utc)
        day_end = datetime(y, m, d, 23, 59, 59, tzinfo=timezone.utc)
        deals = mt5.history_deals_get(day_start, day_end) or []
        closes = [d for d in deals if getattr(d, "magic", 0) == 231 and getattr(d, "entry", 0) == mt5.DEAL_ENTRY_OUT]
        if not closes:
            return (0.0, 0.0, 0.0, 0.0, 0)
        profits = [d.profit for d in closes]
        wins = sum(1 for p in profits if p > 0)
        return (
            wins / len(profits),
            sum(profits) / len(profits),
            max(profits),
            min(profits),
            len(profits),
        )
    except Exception:
        return (0.0, 0.0, 0.0, 0.0, 0)


# =============================================================================
# Symbol resolver (FTMO naming differs from Binance — try variants & cache)
# =============================================================================
_SYMBOL_CACHE: dict[str, Optional[str]] = {}


def _resolve_broker_symbol(binance_symbol: str) -> Optional[str]:
    """
    Resolve a Binance ticker (e.g. AAVEUSDT) to the broker's actual symbol name.
    Caches results so we only hit MT5's symbol_info once per ticker.

    Order of attempts:
      1. SYMBOL_MAP override (env var FTMO_<X>_SYMBOL)
      2. Binance "*USDT" → "*USD" naive convention
      3. Drop trailing "E" before USD (Binance "AAVE" → broker "AAV")
      4. Bracketed variants: "X/USD", "X.USD", "X-USD", "X_USD"
      5. With ".x" / ".c" / ".raw" suffixes (some brokers stack these)
    """
    if binance_symbol in _SYMBOL_CACHE:
        return _SYMBOL_CACHE[binance_symbol]

    candidates: list[str] = []

    # 1) explicit map override
    mapped = SYMBOL_MAP.get(binance_symbol)
    if mapped:
        candidates.append(mapped)

    # 2) Binance "*USDT" → "*USD"
    if binance_symbol.endswith("USDT"):
        base = binance_symbol[:-4]
        candidates.append(base + "USD")

        # 3) drop trailing E (AAVE → AAV)
        if base.endswith("E") and len(base) > 2:
            candidates.append(base[:-1] + "USD")

        # 4) separator variants
        for sep in ("/", ".", "-", "_"):
            candidates.append(f"{base}{sep}USD")

        # 5) suffix variants
        for suffix in (".x", ".c", ".raw", ".pro"):
            candidates.append(base + "USD" + suffix)

    # de-dup while preserving order
    seen: set[str] = set()
    unique = [c for c in candidates if not (c in seen or seen.add(c))]

    for candidate in unique:
        try:
            info = mt5.symbol_info(candidate)
            if info is not None:
                _SYMBOL_CACHE[binance_symbol] = candidate
                if mapped is None or candidate != mapped:
                    log_event(
                        "symbol_map_resolved",
                        binance=binance_symbol,
                        broker=candidate,
                        level="info",
                    )
                return candidate
        except Exception:
            continue

    _SYMBOL_CACHE[binance_symbol] = None
    log_event(
        "symbol_unresolved",
        binance=binance_symbol,
        tried=unique,
        level="warn",
    )
    return None


# =============================================================================
# Orders
# =============================================================================
@dataclass
class OrderResult:
    ok: bool
    ticket: Optional[int]
    error: Optional[str]
    lot: Optional[float]
    entry_price: Optional[float]


def compute_lot_size(symbol_info: Any, risk_frac: float, stop_pct: float, account_equity: float, direction: str = "long") -> float:
    """
    Compute lot size for a target risk. Always rounds DOWN (floor) to never
    exceed the requested risk. Returns 0.0 if the requested risk is below
    the broker's volume_min — caller must skip the trade rather than
    silently inflate risk by trading at volume_min.
    """
    risk_usd = account_equity * risk_frac
    tick_size = symbol_info.trade_tick_size or symbol_info.point
    tick_value = symbol_info.trade_tick_value or 1.0
    # BUGFIX 2026-04-28: use direction-aware fill price (ask for long, bid for short)
    # Wide spreads otherwise undersize the stop-distance and oversize the lot.
    if direction == "short":
        current_price = symbol_info.bid if symbol_info.bid else 0
    else:
        current_price = symbol_info.ask if symbol_info.ask else 0
    if tick_size <= 0 or tick_value <= 0 or current_price <= 0:
        return 0.0
    stop_distance_price = current_price * stop_pct
    loss_per_lot = (stop_distance_price / tick_size) * tick_value
    if loss_per_lot <= 0:
        return 0.0
    lot_raw = risk_usd / loss_per_lot
    step = symbol_info.volume_step or 0.01
    # Floor (round DOWN) to never exceed requested risk.
    # BUGFIX 2026-04-28 (Round 36 Bug 9): round to 8 decimals BEFORE floor.
    # Without this, FP residue (lot_raw/step = 6.9999999998 instead of 7)
    # made math.floor() drop a step → ~14% under-sizing of risk.
    lot = math.floor(round(lot_raw / step, 8)) * step
    vol_min = symbol_info.volume_min or 0.01
    if lot < vol_min:
        # Requested risk is too small for broker minimum — refuse rather
        # than silently inflate to volume_min (would breach FTMO sizing).
        return 0.0
    if symbol_info.volume_max:
        lot = min(lot, symbol_info.volume_max)
    return float(lot)


def place_market_order(
    binance_symbol: str,
    direction: str,
    risk_frac: float,
    stop_pct: float,
    tp_pct: float,
    account_equity: float,
    comment: str,
) -> OrderResult:
    """
    Place a LONG or SHORT market order.
    direction="short": sell at bid, SL above, TP below.
    direction="long": buy at ask, SL below, TP above.
    """
    ftmo_symbol = _resolve_broker_symbol(binance_symbol)
    if not ftmo_symbol:
        return OrderResult(False, None, f"unknown symbol {binance_symbol}", None, None)
    if not mt5.symbol_select(ftmo_symbol, True):
        return OrderResult(False, None, f"symbol_select failed for {ftmo_symbol}", None, None)
    info = mt5.symbol_info(ftmo_symbol)
    if info is None or info.bid == 0 or info.ask == 0:
        return OrderResult(False, None, f"symbol_info not ready for {ftmo_symbol}", None, None)

    # Hard-cap risk_frac before sizing — defends against legacy 200% formula.
    if risk_frac > RISK_FRAC_HARD_CAP:
        print(
            f"[executor] WARN: incoming risk_frac={risk_frac:.4f} exceeds hard cap "
            f"{RISK_FRAC_HARD_CAP:.4f} — clamping for {ftmo_symbol}"
        )
        risk_frac = RISK_FRAC_HARD_CAP

    lot = compute_lot_size(info, risk_frac, stop_pct, account_equity, direction)
    if lot <= 0:
        # BUGFIX 2026-04-28: Was silent. Now logs symbol-info dump so user can
        # diagnose why lot=0 (typically broker volume_min too high or tick_size=0).
        diag = (
            f"lot=0 for {ftmo_symbol}: vol_min={getattr(info, 'volume_min', '?')} "
            f"vol_step={getattr(info, 'volume_step', '?')} tick_value={getattr(info, 'trade_tick_value', '?')} "
            f"tick_size={getattr(info, 'trade_tick_size', '?')} point={getattr(info, 'point', '?')} "
            f"contract={getattr(info, 'trade_contract_size', '?')} risk={risk_frac:.4f} stop={stop_pct:.4f}"
        )
        log_event("lot_zero", asset=binance_symbol, ftmo_symbol=ftmo_symbol, diag=diag)
        tg_send(f"⚠️ <b>Lot=0 skip</b>\n{ftmo_symbol}\n<code>{html_escape(diag)}</code>")
        return OrderResult(False, None, "lot computation returned 0", None, None)

    if direction == "short":
        entry_price = info.bid
        stop_price = entry_price * (1 + stop_pct)
        tp_price = entry_price * (1 - tp_pct)
        order_type = mt5.ORDER_TYPE_SELL
    elif direction == "long":
        entry_price = info.ask
        stop_price = entry_price * (1 - stop_pct)
        tp_price = entry_price * (1 + tp_pct)
        order_type = mt5.ORDER_TYPE_BUY
    else:
        return OrderResult(False, None, f"unknown direction {direction}", lot, None)

    # Margin pre-check — ask MT5 to validate the order. If margin would
    # exceed free_margin, halve the lot until it fits or hit volume_min.
    # This stops the "retcode=10019 No money" cascade dead.
    lot = _fit_lot_to_margin(ftmo_symbol, order_type, lot, entry_price, stop_price, tp_price, info)
    if lot <= 0:
        return OrderResult(False, None, "no lot size fits free margin", None, entry_price)

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": ftmo_symbol,
        "volume": lot,
        "type": order_type,
        "price": entry_price,
        "sl": stop_price,
        "tp": tp_price,
        "deviation": 20,
        "magic": 231,
        "comment": comment[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(request)
    if result is None:
        return OrderResult(False, None, "order_send returned None", lot, entry_price)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return OrderResult(False, None, f"retcode={result.retcode} {getattr(result, 'comment', '')}", lot, entry_price)
    return OrderResult(True, result.order, None, lot, result.price)


def _fit_lot_to_margin(
    ftmo_symbol: str,
    order_type: int,
    lot: float,
    entry_price: float,
    stop_price: float,
    tp_price: float,
    info: Any,
) -> float:
    """
    Run mt5.order_check() and halve lot until margin fits, or return 0.0.

    Mock-mode skips the check (mock has no order_check implementation).
    """
    if MOCK_MODE:
        return lot

    check_fn = getattr(mt5, "order_check", None)
    if check_fn is None:
        return lot  # very old MT5 build — fall through and let order_send fail

    vol_min = info.volume_min or 0.01
    step = info.volume_step or 0.01
    cur_lot = lot
    for _ in range(8):  # at most 8 halvings before giving up
        req = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": ftmo_symbol,
            "volume": cur_lot,
            "type": order_type,
            "price": entry_price,
            "sl": stop_price,
            "tp": tp_price,
            "deviation": 20,
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        check = check_fn(req)
        if check is None:
            return cur_lot  # API hiccup — let order_send try
        if check.retcode == 0 or check.retcode == mt5.TRADE_RETCODE_DONE:
            return cur_lot
        # 10019 = "No money", 10014 = "Invalid volume", 10016 = "Invalid stops"
        if check.retcode != 10019:
            return cur_lot  # not a margin issue — let order_send surface it
        new_lot = max(vol_min, math.floor((cur_lot / 2) / step) * step)
        if new_lot >= cur_lot:
            return 0.0  # already at min, still no money
        print(
            f"[executor] margin tight on {ftmo_symbol}: lot {cur_lot:.4f} → {new_lot:.4f}"
        )
        cur_lot = new_lot
    return 0.0


# Backward compat alias
def place_short_market(
    binance_symbol: str, risk_frac: float, stop_pct: float, tp_pct: float,
    account_equity: float, comment: str,
) -> OrderResult:
    return place_market_order(binance_symbol, "short", risk_frac, stop_pct, tp_pct, account_equity, comment)


def close_position(ticket: int) -> bool:
    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        return True
    pos = positions[0]
    info = mt5.symbol_info(pos.symbol)
    if info is None:
        return False
    price = info.ask if pos.type == mt5.POSITION_TYPE_SELL else info.bid
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": pos.symbol,
        "volume": pos.volume,
        "type": mt5.ORDER_TYPE_BUY if pos.type == mt5.POSITION_TYPE_SELL else mt5.ORDER_TYPE_SELL,
        "position": ticket,
        "price": price,
        "deviation": 20,
        "magic": 231,
        "comment": "iter231 close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(request)
    ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
    if ok and result is not None:
        log_event("closed", ticket=ticket, close_price=result.price)
    else:
        log_event("close_failed", ticket=ticket, retcode=getattr(result, "retcode", None))
    return ok


# =============================================================================
# Main loop
# =============================================================================
# =============================================================================
# iter236+ Pause-After-Target logic
# =============================================================================
def get_pause_state() -> dict:
    """Returns {target_hit: bool, target_hit_date: str, ping_dates: list[str], passed: bool}"""
    return read_json(PAUSE_STATE_PATH, {
        "target_hit": False,
        "target_hit_date": None,
        "ping_dates": [],
        "passed": False,
    })


def write_pause_state(state: dict) -> None:
    # BUGFIX 2026-04-28: was non-atomic. Now uses atomic write helper.
    write_json(PAUSE_STATE_PATH, state)


def check_target_and_pause(current_equity: float) -> bool:
    """
    Returns True if pause is active (target hit, waiting for minTradingDays).
    On first detection of target hit: send Telegram, set state.
    """
    if not PAUSE_AT_TARGET:
        return False
    state = get_pause_state()
    if state["passed"]:
        return True  # already passed, keep skipping
    target_equity = CHALLENGE_START_BALANCE * (1 + PROFIT_TARGET_PCT)
    if current_equity >= target_equity and not state["target_hit"]:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        state["target_hit"] = True
        state["target_hit_date"] = today
        write_pause_state(state)
        log_event("target_hit", equity=current_equity, target=target_equity)
        tg_send(
            f"🎯 <b>+{PROFIT_TARGET_PCT*100:.0f}% TARGET HIT!</b>\n"
            f"Equity: <b>${current_equity:,.2f}</b> (start ${CHALLENGE_START_BALANCE:,.0f})\n"
            f"🛑 <b>BOT PAUSED</b> — no more risk trades.\n"
            f"⏳ Waiting for {MIN_TRADING_DAYS} trading-day minimum.\n"
            f"Daily ping trades will be placed to clock the rule."
        )
    return state["target_hit"]


def maybe_place_ping_trade() -> None:
    """If in pause + ping not placed today, place tiny long+close to count trading day."""
    state = get_pause_state()
    if not state["target_hit"] or state["passed"]:
        return
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if today in state["ping_dates"]:
        return  # already pinged today

    if MOCK_MODE:
        log_event("ping_trade_mock", date=today)
        state["ping_dates"].append(today)
    else:
        sym = SYMBOL_MAP.get(PING_SYMBOL_BINANCE, "ETHUSD")
        try:
            info = mt5.symbol_info(sym)
            if info is None:
                log_event("ping_trade_failed", reason=f"symbol {sym} not found")
                return
            tick = mt5.symbol_info_tick(sym)
            if tick is None:
                log_event("ping_trade_failed", reason="no tick data")
                return
            request_buy = {
                "action": mt5.TRADE_ACTION_DEAL, "symbol": sym, "volume": PING_LOT_SIZE,
                "type": mt5.ORDER_TYPE_BUY, "price": tick.ask,
                "deviation": 20, "magic": 232, "comment": "iter236-ping",
            }
            result = mt5.order_send(request_buy)
            if result is None or getattr(result, "retcode", None) != mt5.TRADE_RETCODE_DONE:
                log_event("ping_trade_failed", retcode=getattr(result, "retcode", None))
                return
            # Close immediately
            positions = mt5.positions_get(symbol=sym) or []
            for pos in positions:
                if getattr(pos, "magic", 0) == 232:
                    tick2 = mt5.symbol_info_tick(sym)
                    if tick2 is None:
                        continue
                    close_request = {
                        "action": mt5.TRADE_ACTION_DEAL, "symbol": sym, "volume": pos.volume,
                        "type": mt5.ORDER_TYPE_SELL, "position": pos.ticket,
                        "price": tick2.bid, "deviation": 20, "magic": 232,
                        "comment": "iter236-ping-close",
                    }
                    mt5.order_send(close_request)
            log_event("ping_trade_placed", date=today, symbol=sym, lot=PING_LOT_SIZE)
            state["ping_dates"].append(today)
        except Exception as e:
            log_event("ping_trade_exception", error=str(e))
            return
    write_pause_state(state)

    # Check if challenge passed
    if len(state["ping_dates"]) + 1 >= MIN_TRADING_DAYS:  # +1 for the target-hit day
        if not state["passed"]:
            state["passed"] = True
            write_pause_state(state)
            tg_send(
                f"🏆 <b>CHALLENGE PASSED!</b> 🎉\n"
                f"Target hit: {state['target_hit_date']}\n"
                f"Total trading days: {len(state['ping_dates']) + 1}\n"
                f"Bot will continue placing ping trades until you reset state."
            )
            log_event("challenge_passed", trading_days=len(state["ping_dates"]) + 1)


def process_pending_signals() -> None:
    # Phase 33 (Audit Bug 1 — CRITICAL): acquire pending-signals.lock so we
    # serialize against the Node service's R-M-W. Phase 19 added the lock
    # on the Node side but not here — Python was racing the Node writer,
    # leaving the cross-process race only HALF closed.
    pending_lock = STATE_DIR / "pending-signals.lock"
    with _file_lock(pending_lock):
        data = read_json(PENDING_PATH, {"signals": []})
        pending = data.get("signals", [])
        if not pending:
            return
        executed = read_json(EXECUTED_PATH, {"executions": []})
        open_positions = read_json(OPEN_POS_PATH, {"positions": []})

    acct = mt5_get_equity()
    account_equity = acct["equity"] or CHALLENGE_START_BALANCE
    day_start_usd = handle_daily_reset(account_equity)

    # iter236+: if target reached, skip all new signal trades. The pause logic
    # writes state and Telegram-alerts on first detection. Ping trades are
    # placed separately in main_loop via maybe_place_ping_trade().
    if check_target_and_pause(account_equity):
        log_event("signals_skipped_post_target", count=len(pending))
        # Mark all pending as "skipped_post_target" so they don't re-trigger
        executed = read_json(EXECUTED_PATH, {"executions": []})
        for sig in pending:
            executed["executions"].append({
                "signal": sig, "result": "skipped_post_target",
                "ts": datetime.now(timezone.utc).isoformat(),
            })
        # BUGFIX 2026-04-28: atomic writes (was non-atomic, corrupt-on-crash risk).
        write_json(EXECUTED_PATH, executed)
        # Clear pending queue
        write_json(PENDING_PATH, {"signals": []})
        return

    remaining: list[dict] = []
    # BUGFIX 2026-04-28: signal staleness check — drop signals older than 5min
    # to prevent trading on stale data after crash/restart/long pause.
    MAX_SIGNAL_AGE_MS = 5 * 60_000
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    # MCT counter — tracks orders placed during THIS batch run so back-to-back
    # signals can't bypass the cap before MT5's positions_get sees them.
    in_batch_placed = 0
    for sig in pending:
        # BUGFIX 2026-04-28 (Round 24): validate required fields up-front to
        # prevent KeyError crashes from malformed signals (schema drift, manual
        # JSON edits, corruption). Skip + log signal if any required field missing.
        required_fields = ["assetSymbol", "riskFrac", "stopPct", "tpPct", "stopPrice", "tpPrice", "maxHoldUntil", "entryPrice"]
        missing = [f for f in required_fields if f not in sig]
        if missing:
            log_event("signal_invalid_schema", missing=missing, sig_keys=list(sig.keys()))
            tg_send(f"⚠️ <b>Invalid signal schema</b>\nMissing: {html_escape(','.join(missing))}")
            executed["executions"].append({"signal": sig, "result": "invalid_schema", "missing": missing, "ts": datetime.now(timezone.utc).isoformat()})
            continue
        sig_ts = sig.get("signalBarClose") or sig.get("ts_ms")
        if sig_ts and (now_ms - sig_ts) > MAX_SIGNAL_AGE_MS:
            age_min = (now_ms - sig_ts) / 60000
            log_event("signal_stale_drop", asset=sig["assetSymbol"], age_min=round(age_min, 1))
            tg_send(f"⏰ <b>Signal stale, dropped</b>\n{sig['assetSymbol']}\nage={age_min:.1f}min")
            executed["executions"].append({
                "signal": sig, "result": "stale_drop", "age_min": round(age_min, 1),
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue
        blocker = check_ftmo_rules(account_equity, day_start_usd)
        if blocker:
            log_event("rule_block", asset=sig["assetSymbol"], reason=blocker)
            tg_send(f"🛑 <b>FTMO Rule Block</b>\nAsset: {sig['assetSymbol']}\nReason: {html_escape(blocker)}")
            executed["executions"].append({
                "signal": sig, "result": "blocked", "reason": blocker,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue

        # R28: dailyPeakTrailingStop — Anti-DL gate. Block new entries when
        # intraday equity drops trailDistance below today's peak. This is the
        # key feature that pushes V5_QUARTZ_LITE_R28 to 71.28% engine-honest
        # pass-rate (vs 68.87% baseline). Mirrors engine line 4810-4816.
        dpt_block = check_daily_peak_trail_block(account_equity)
        if dpt_block:
            log_event("dpt_block", asset=sig["assetSymbol"], reason=dpt_block)
            tg_send(f"🛡️ <b>Day-Peak Trail Block</b>\n{sig['assetSymbol']}\n{html_escape(dpt_block)}")
            executed["executions"].append({
                "signal": sig, "result": "dpt_blocked", "reason": dpt_block,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue

        # BUGFIX 2026-04-28: enforce maxConcurrentTrades parity with engine.
        # Bug-Audit Phase 3 (Python Bug 11): mt5.positions_get(magic=) is NOT
        # a documented filter — on new MT5 builds raises TypeError, on old
        # builds silently ignores → returns ALL positions including manual
        # trades from other bots. Filter by magic manually.
        all_positions = mt5.positions_get() or []
        live_positions = [p for p in all_positions if getattr(p, "magic", 0) == 231]
        open_count = len(live_positions) + in_batch_placed
        if open_count >= MAX_CONCURRENT_TRADES:
            log_event("mct_block", asset=sig["assetSymbol"], open=open_count, cap=MAX_CONCURRENT_TRADES)
            tg_send(f"🛑 <b>MCT Cap Reached</b>\n{sig['assetSymbol']} skipped\nOpen: {open_count}/{MAX_CONCURRENT_TRADES}")
            executed["executions"].append({
                "signal": sig, "result": "mct_blocked",
                "open_count": open_count, "cap": MAX_CONCURRENT_TRADES,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue

        direction = sig.get("direction", "short")
        regime = sig.get("regime", "BEAR_CHOP")
        tag = "iter213-bull" if regime == "BULL" else "iter231"

        if DRY_RUN:
            log_event("dry_run_order", asset=sig["assetSymbol"], risk=sig["riskFrac"], stop=sig["stopPct"])
            tg_send(
                f"🧪 <b>DRY RUN — would place order</b>\n"
                f"{sig['assetSymbol']} {direction.upper()}\n"
                f"Risk: {sig['riskFrac']*100:.3f}% · Stop: {sig['stopPct']*100:.2f}%\n"
                f"Entry≈${sig.get('entryPrice', 0):.4f}"
            )
            executed["executions"].append({
                "signal": sig, "result": "dry_run",
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue

        # BUGFIX 2026-04-28 (Round 13 Bug 1): write-ahead log for order idempotency.
        # If executor crashes between mt5.order_send and write_json(EXECUTED_PATH),
        # the marker file lets us detect duplicates on boot.
        order_marker = _write_pending_order_marker(sig)
        # BUGFIX 2026-04-28 (Round 36 Bug 3): embed marker ID in comment so
        # reconcile can match exactly instead of substring-matching the
        # asset symbol (which false-positives against unrelated prior trades).
        # BUGFIX 2026-04-28 (Round 38): marker_id MUST come FIRST. MT5 truncates
        # comment to 31 chars; long tag+asset names (e.g. "iter231 AVAX-TREND
        # <16hex>" = 35 chars) chopped the marker tail and the next reconcile
        # missed the match → re-queued an already-placed signal → DOUBLE order.
        # Use first 8 chars of marker (32 bits, collision-safe per session).
        marker_id = _signal_marker_id(sig)
        marker_short = marker_id[:8]
        # Total length: 8 (marker) + 1 + ~22 = ≤31; remaining truncation safely
        # affects the asset/tag suffix only, not the marker prefix.
        result = place_market_order(
            binance_symbol=sig["sourceSymbol"],
            direction=direction,
            risk_frac=sig["riskFrac"],
            stop_pct=sig["stopPct"],
            tp_pct=sig["tpPct"],
            account_equity=account_equity,
            comment=f"{marker_short} {tag} {sig['assetSymbol']}",
        )
        # Marker stays until executed-signals is written successfully (cleanup at end).
        if result.ok:
            _clear_pending_order_marker(order_marker)
            _reset_order_fail_counter()
            in_batch_placed += 1
            log_event("order_placed", asset=sig["assetSymbol"], ticket=result.ticket, lot=result.lot, entry=result.entry_price)
            tg_send(
                f"✅ <b>ORDER PLACED</b>\n"
                f"{sig['assetSymbol']} {direction.upper()}\n"
                f"Ticket: <code>{result.ticket}</code>\n"
                f"Lot: {result.lot} @ ${result.entry_price:.4f}\n"
                f"Risk: {sig['riskFrac']*100:.3f}% of equity"
            )
            open_positions["positions"].append({
                "ticket": result.ticket,
                "signalAsset": sig["assetSymbol"],
                "sourceSymbol": sig["sourceSymbol"],
                "direction": direction,
                "lot": result.lot,
                "entry_price": result.entry_price,
                "stop_price": sig["stopPrice"],
                "tp_price": sig["tpPrice"],
                # BUGFIX 2026-04-29 (Agent 4 Bug 8): preserve original stopPct
                # — `stop_price` is mutated by break-even/chandelier; time-exit
                # min-gain check needs the IMMUTABLE original.
                "original_stop_pct": sig.get("stopPct"),
                # BUGFIX 2026-04-29 (Agent 4 Bug 5/6): track peak price seen
                # since open for wick-touch PTP semantics (mirror engine's
                # bar.high/low check). max for long, min for short.
                "peak_price_seen": result.entry_price,
                "max_hold_until": sig["maxHoldUntil"],
                "opened_at": datetime.now(timezone.utc).isoformat(),
                # Trailing-stop state. None = trailing not configured.
                # Activated=False until price reaches entry × (1 + activatePct) [long]
                # or entry × (1 - activatePct) [short]. Once activated, SL trails by trailPct.
                "trailing_stop": sig.get("trailingStop"),
                "trailing_activated": False,
                # Round 11 — engine-feature live mirrors. All None = no-op.
                # PTP: one-shot scale-out at trigger.
                "partial_tp": sig.get("partialTakeProfit"),
                "partial_tp_done": False,
                # PTP-Levels: multi-stage scale-out, one-shot per level.
                "partial_tp_levels": sig.get("partialTakeProfitLevels"),
                "partial_tp_levels_done": (
                    [False] * len(sig["partialTakeProfitLevels"])
                    if sig.get("partialTakeProfitLevels") else []
                ),
                # Chandelier: ATR trailing (price units, not pct).
                "chandelier": sig.get("chandelierExit"),
                "chandelier_armed": False,
                "chandelier_best_close": None,
                # Break-even: one-shot SL→entry on profit ≥ threshold.
                "break_even": sig.get("breakEvenAtProfit"),
                "break_even_done": False,
                # Time-exit: close at market if no minGainR within maxBars.
                "time_exit": sig.get("timeExit"),
                "time_exit_reached_min_gain": False,
            })
            executed["executions"].append({
                "signal": sig, "result": "placed", "ticket": result.ticket,
                "actual_entry": result.entry_price, "lot": result.lot,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
        else:
            _bump_order_fail_counter(result.error or "unknown")
            log_event("order_failed", asset=sig["assetSymbol"], error=result.error)
            tg_send(f"❌ <b>ORDER FAILED</b>\n{sig['assetSymbol']}\nError: {html_escape(result.error or 'unknown')}")
            # BUGFIX 2026-04-28: retry transient errors instead of silently dropping.
            err_str = (result.error or "").lower()
            retryable_keywords = ["timeout", "no money", "requote", "off quotes", "trade disabled", "10027"]
            is_retryable = any(k in err_str for k in retryable_keywords)
            retry_count = sig.get("_retryCount", 0)
            if is_retryable and retry_count < 5:
                # Re-queue with retry counter
                retried_sig = {**sig, "_retryCount": retry_count + 1}
                remaining.append(retried_sig)
                log_event("retrying_signal", asset=sig["assetSymbol"], retry=retry_count + 1)
            executed["executions"].append({
                "signal": sig, "result": "failed", "error": result.error,
                "retried": is_retryable and retry_count < 5,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            # If auto-pause kicked in, stop processing more pending signals
            if is_paused():
                remaining.extend(pending[pending.index(sig) + 1:])
                break

    # BUGFIX 2026-04-28: re-read PENDING_PATH before write to merge signals
    # that arrived during this iteration (signal-service may have written new
    # signals while executor was placing orders → would silently overwrite).
    try:
        latest_pending = read_json(PENDING_PATH, {"signals": []})
        latest_signals = latest_pending.get("signals", [])
        # Find signals not in our original 'pending' list (= newly arrived)
        # BUGFIX 2026-04-28: dedup-key fixed — was using "ts" (None for all signals)
        # → key collapsed to (None, asset) → late merge re-queued duplicates.
        # Now uses signalBarClose (the schema actually used by Node).
        original_keys = {(s.get("signalBarClose"), s.get("assetSymbol")) for s in pending}
        new_signals = [s for s in latest_signals if (s.get("signalBarClose"), s.get("assetSymbol")) not in original_keys]
        if new_signals:
            log_event("merged_late_signals", count=len(new_signals))
            remaining.extend(new_signals)
    except Exception as e:
        log_event("merge_check_failed", error=str(e))
    # BUGFIX 2026-04-28 (Round 12): cap executed-signals.json at 500 entries
    # to prevent unbounded growth + JSON-parse stalls.
    if len(executed.get("executions", [])) > 500:
        executed["executions"] = executed["executions"][-500:]
    write_json(PENDING_PATH, {"signals": remaining})
    write_json(EXECUTED_PATH, executed)
    write_json(OPEN_POS_PATH, open_positions)


def _modify_position_sl(ticket: int, new_sl: float) -> bool:
    """Modify SL of an open position via MT5 SLTP request."""
    live = mt5.positions_get(ticket=ticket)
    if not live:
        return False
    pos = live[0]
    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": pos.symbol,
        "position": ticket,
        "sl": float(new_sl),
        "tp": float(pos.tp),
        "magic": 231,
    }
    result = mt5.order_send(request)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        log_event("sl_modify_failed", ticket=ticket, retcode=getattr(result, "retcode", None), error=getattr(result, "comment", ""))
        return False
    return True


def _apply_trailing_stop(pos: dict) -> dict:
    """
    Update SL based on trailing-stop config.
    Returns the (possibly mutated) position dict.

    Logic:
      Long: once price >= entry × (1 + activatePct), trail SL = max(current_sl, price × (1 - trailPct))
      Short: once price <= entry × (1 - activatePct), trail SL = min(current_sl, price × (1 + trailPct))
    """
    trail_cfg = pos.get("trailing_stop")
    if not trail_cfg:
        return pos
    activate_pct = float(trail_cfg.get("activatePct", 0))
    trail_pct = float(trail_cfg.get("trailPct", 0))
    if activate_pct <= 0 or trail_pct <= 0:
        return pos

    live = mt5.positions_get(ticket=pos["ticket"])
    if not live:
        return pos
    p = live[0]
    direction = pos.get("direction", "long")
    entry = float(pos.get("entry_price", p.price_open))
    current_price = float(p.price_current)
    current_sl = float(p.sl) if p.sl else None

    activated = pos.get("trailing_activated", False)

    if direction == "long":
        if not activated:
            if current_price >= entry * (1 + activate_pct):
                pos["trailing_activated"] = True
                activated = True
                log_event("trailing_activated", ticket=pos["ticket"], price=current_price, entry=entry)
        if activated:
            new_sl = current_price * (1 - trail_pct)
            # Only ratchet up — never lower SL
            if current_sl is None or new_sl > current_sl:
                if _modify_position_sl(pos["ticket"], new_sl):
                    log_event("trailing_sl_updated", ticket=pos["ticket"], old_sl=current_sl, new_sl=new_sl, price=current_price)
                    pos["stop_price"] = new_sl
            else:
                # BUGFIX 2026-04-28: log skip so user can verify trail is active but not ratcheting.
                log_event("trailing_skip", ticket=pos["ticket"], current_sl=current_sl, candidate_sl=new_sl, price=current_price, dir="long")
    elif direction == "short":
        if not activated:
            if current_price <= entry * (1 - activate_pct):
                pos["trailing_activated"] = True
                activated = True
                log_event("trailing_activated", ticket=pos["ticket"], price=current_price, entry=entry)
        if activated:
            new_sl = current_price * (1 + trail_pct)
            # Only ratchet down for shorts — never raise SL
            if current_sl is None or new_sl < current_sl:
                if _modify_position_sl(pos["ticket"], new_sl):
                    log_event("trailing_sl_updated", ticket=pos["ticket"], old_sl=current_sl, new_sl=new_sl, price=current_price)
                    pos["stop_price"] = new_sl
            else:
                log_event("trailing_skip", ticket=pos["ticket"], current_sl=current_sl, candidate_sl=new_sl, price=current_price, dir="short")
    return pos


def _close_partial_lot(ticket: int, close_lot: float, reason: str) -> bool:
    """
    Close `close_lot` of an open position via opposite-direction market order.
    Used by partialTakeProfit and partialTakeProfitLevels. Floors to broker
    volume_step. Returns True on success.
    """
    live = mt5.positions_get(ticket=ticket)
    if not live:
        return False
    pos = live[0]
    info = mt5.symbol_info(pos.symbol)
    if info is None:
        return False
    step = info.volume_step or 0.01
    vol_min = info.volume_min or 0.01
    # Floor partial-close lot down to step grid; refuse if below min
    close_lot = math.floor(close_lot / step) * step
    if close_lot < vol_min or close_lot >= pos.volume:
        return False  # too small or would close everything
    price = info.ask if pos.type == mt5.POSITION_TYPE_SELL else info.bid
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": pos.symbol,
        "volume": float(close_lot),
        "type": mt5.ORDER_TYPE_BUY if pos.type == mt5.POSITION_TYPE_SELL else mt5.ORDER_TYPE_SELL,
        "position": ticket,
        "price": price,
        "deviation": 20,
        "magic": 231,
        "comment": f"r11 {reason}"[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(request)
    ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
    if ok and result is not None:
        log_event("partial_close", ticket=ticket, lot=close_lot, reason=reason, price=result.price)
    else:
        log_event("partial_close_failed", ticket=ticket, lot=close_lot, retcode=getattr(result, "retcode", None))
    return ok


def _unrealized_pct(pos: dict, current_price: float) -> float:
    """Direction-aware unrealized P&L as fraction of entry."""
    entry = float(pos.get("entry_price", 0))
    if entry <= 0:
        return 0.0
    if pos.get("direction") == "long":
        return (current_price - entry) / entry
    return (entry - current_price) / entry


def _apply_partial_tp(pos: dict) -> dict:
    """One-shot partial TP: close `closeFraction` of lot when unrealized P&L
    crosses `triggerPct`. Mirrors engine src/utils/ftmoDaytrade24h.ts:3996-4007.
    """
    cfg = pos.get("partial_tp")
    if not cfg or pos.get("partial_tp_done"):
        return pos
    live = mt5.positions_get(ticket=pos["ticket"])
    if not live:
        return pos
    p = live[0]
    current_price = float(p.price_current)
    # BUGFIX 2026-04-29 (Agent 4 Bug 5 parity): engine fires PTP when bar.high
    # (long) or bar.low (short) reaches triggerPrice — i.e., a wick TOUCH
    # within the bar. Live needs to mirror that, otherwise PTP misses if the
    # wick reverts before next poll. Track peak_price_seen per-position.
    direction = pos.get("direction", "long")
    if direction == "long":
        peak = max(pos.get("peak_price_seen") or current_price, current_price)
    else:
        peak = min(pos.get("peak_price_seen") or current_price, current_price)
    pos["peak_price_seen"] = peak
    # Compute unrealized using PEAK (not just current) so wick-touched PTP fires.
    entry = float(pos.get("entry_price", p.price_open))
    unrealized = (peak - entry) / entry if direction == "long" else (entry - peak) / entry
    trigger = float(cfg.get("triggerPct", 0))
    frac = float(cfg.get("closeFraction", 0))
    if unrealized < trigger or frac <= 0:
        return pos
    close_lot = float(p.volume) * frac
    # BUGFIX 2026-04-29 (Agent 4 R10 #11): if close_lot < vol_min, PTP can never
    # fire. Mark done to avoid retry-storm (used to retry every poll forever).
    info = mt5.symbol_info(pos.get("sourceSymbol", p.symbol))
    vol_min_check = info.volume_min if info else 0.01
    if close_lot < vol_min_check:
        pos["partial_tp_done"] = True
        log_event("ptp_skipped_tiny_lot",
                  ticket=pos["ticket"], close_lot=close_lot, vol_min=vol_min_check)
        return pos
    if _close_partial_lot(pos["ticket"], close_lot, "ptp"):
        pos["partial_tp_done"] = True
        log_event("partial_tp_fired", ticket=pos["ticket"],
                  trigger=trigger, fraction=frac, unrealized=unrealized,
                  closed_lot=close_lot)
        # BUGFIX 2026-04-29 (Bug A parity): after PTP fires, auto-move SL to
        # entry on remainder leg. Engine does this since 2026-04-29 — without
        # the parity fix, live realizes losses on remainder while engine
        # assumes break-even minimum. Direction: live underperforms backtest.
        current_sl = float(p.sl) if p.sl else None
        should_move = (
            direction == "long" and (current_sl is None or current_sl < entry)
        ) or (
            direction == "short" and (current_sl is None or current_sl > entry)
        )
        if should_move and _modify_position_sl(pos["ticket"], entry):
            pos["stop_price"] = entry
            pos["break_even_done"] = True
            log_event("ptp_sl_to_entry", ticket=pos["ticket"], new_sl=entry)
        tg_send(
            f"🎯 <b>Partial TP fired</b>\n"
            f"{pos['signalAsset']} ticket <code>{pos['ticket']}</code>\n"
            f"Closed {frac*100:.0f}% @ +{unrealized*100:.2f}%"
            f"{' (SL→entry)' if should_move else ''}"
        )
    return pos


def _apply_partial_tp_levels(pos: dict) -> dict:
    """Multi-stage partial TP: each level fires once, in order, on its trigger.
    Mirrors engine src/utils/ftmoDaytrade24h.ts:4008-4021.
    """
    levels = pos.get("partial_tp_levels")
    if not levels:
        return pos
    done = pos.get("partial_tp_levels_done") or [False] * len(levels)
    if all(done):
        return pos
    live = mt5.positions_get(ticket=pos["ticket"])
    if not live:
        return pos
    p = live[0]
    current_price = float(p.price_current)
    # BUGFIX 2026-04-29 (Agent 4 Bug 6 parity): mirror engine's wick-touch
    # semantics by using peak_price_seen since open (max for long, min short).
    direction = pos.get("direction", "long")
    if direction == "long":
        peak = max(pos.get("peak_price_seen") or current_price, current_price)
    else:
        peak = min(pos.get("peak_price_seen") or current_price, current_price)
    pos["peak_price_seen"] = peak
    entry_price = float(pos.get("entry_price", p.price_open))
    unrealized = (
        (peak - entry_price) / entry_price
        if direction == "long"
        else (entry_price - peak) / entry_price
    )
    for idx, lv in enumerate(levels):
        if done[idx]:
            continue
        trigger = float(lv.get("triggerPct", 0))
        frac = float(lv.get("closeFraction", 0))
        if unrealized < trigger or frac <= 0:
            continue
        close_lot = float(p.volume) * frac
        if _close_partial_lot(pos["ticket"], close_lot, f"ptpL{idx}"):
            done[idx] = True
            log_event("partial_tp_level_fired", ticket=pos["ticket"],
                      tier=idx, trigger=trigger, fraction=frac,
                      unrealized=unrealized, closed_lot=close_lot)
    pos["partial_tp_levels_done"] = done
    return pos


def _apply_chandelier_stop(pos: dict) -> dict:
    """ATR-based trailing stop: highest_close − K × ATR (long) or
    lowest_close + K × ATR (short). Arms only after price moves
    minMoveR × stopPct in favorable direction. Only ratchets, never widens.
    Mirrors engine src/utils/ftmoDaytrade24h.ts:4044-4077.

    NB: ATR is fixed at signal-time (atrAtEntry). The engine recomputes ATR
    each bar; live executor uses the snapshot to avoid pulling a fresh OHLC
    feed. For 30m–4h timeframes this is a safe approximation (bot is meant
    to ratchet on price extremes, not chase real-time volatility shifts).
    """
    cfg = pos.get("chandelier")
    if not cfg:
        return pos
    atr_at_entry = float(cfg.get("atrAtEntry", 0))
    mult = float(cfg.get("mult", 0))
    min_move_r = float(cfg.get("minMoveR", 0.5))
    stop_pct = float(cfg.get("stopPct", 0))
    if atr_at_entry <= 0 or mult <= 0:
        return pos
    live = mt5.positions_get(ticket=pos["ticket"])
    if not live:
        return pos
    p = live[0]
    direction = pos.get("direction", "long")
    current_price = float(p.price_current)
    current_close = current_price  # tick-level close approximation
    current_sl = float(p.sl) if p.sl else None

    unrealized = _unrealized_pct(pos, current_price)
    min_move_abs = min_move_r * stop_pct
    if unrealized < min_move_abs and not pos.get("chandelier_armed"):
        return pos

    pos["chandelier_armed"] = True
    best = pos.get("chandelier_best_close")
    if direction == "long":
        if best is None or current_close > best:
            best = current_close
        new_sl = best - mult * atr_at_entry
    else:
        if best is None or current_close < best:
            best = current_close
        new_sl = best + mult * atr_at_entry
    pos["chandelier_best_close"] = best

    # Ratchet only — never loosen
    if direction == "long":
        if current_sl is not None and new_sl <= current_sl:
            return pos
    else:
        if current_sl is not None and new_sl >= current_sl:
            return pos

    if _modify_position_sl(pos["ticket"], new_sl):
        log_event("chandelier_sl_updated", ticket=pos["ticket"],
                  old_sl=current_sl, new_sl=new_sl, best=best, atr=atr_at_entry,
                  unrealized=unrealized, dir=direction)
        pos["stop_price"] = new_sl
    return pos


def _apply_break_even(pos: dict) -> dict:
    """Move SL to entry once unrealized P&L crosses `threshold`. One-shot.
    Mirrors engine src/utils/ftmoDaytrade24h.ts:3986-3995.
    """
    cfg = pos.get("break_even")
    if not cfg or pos.get("break_even_done"):
        return pos
    threshold = float(cfg.get("threshold", 0))
    if threshold <= 0:
        return pos
    live = mt5.positions_get(ticket=pos["ticket"])
    if not live:
        return pos
    p = live[0]
    unrealized = _unrealized_pct(pos, float(p.price_current))
    if unrealized < threshold:
        return pos
    entry = float(pos.get("entry_price", p.price_open))
    current_sl = float(p.sl) if p.sl else None
    direction = pos.get("direction", "long")
    # Only move SL if it's currently worse than entry (long: below; short: above)
    if direction == "long":
        if current_sl is not None and current_sl >= entry:
            pos["break_even_done"] = True
            return pos
    else:
        if current_sl is not None and current_sl <= entry:
            pos["break_even_done"] = True
            return pos
    if _modify_position_sl(pos["ticket"], entry):
        pos["break_even_done"] = True
        pos["stop_price"] = entry
        log_event("break_even_moved", ticket=pos["ticket"],
                  old_sl=current_sl, new_sl=entry, unrealized=unrealized)
        tg_send(
            f"🔒 <b>Break-Even SL</b>\n"
            f"{pos['signalAsset']} ticket <code>{pos['ticket']}</code>\n"
            f"SL → entry @ +{unrealized*100:.2f}%"
        )
    return pos


def _apply_time_exit(pos: dict, now_ms: int) -> bool:
    """Close at market if `maxBarsWithoutGain` bars have elapsed without
    unrealized P&L ever reaching `minGainR × stopPct`. Returns True if closed.
    Mirrors engine src/utils/ftmoDaytrade24h.ts:4081-4094.
    """
    cfg = pos.get("time_exit")
    if not cfg:
        return False
    max_bars = int(cfg.get("maxBarsWithoutGain", 0))
    min_gain_r = float(cfg.get("minGainR", 0))
    bar_ms = int(cfg.get("barDurationMs", 0))
    if max_bars <= 0 or bar_ms <= 0:
        return False

    live = mt5.positions_get(ticket=pos["ticket"])
    if not live:
        return False
    p = live[0]

    try:
        opened_iso = pos.get("opened_at")
        if not opened_iso:
            return False
        opened_ms = int(datetime.fromisoformat(opened_iso.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return False

    # BUGFIX 2026-04-29 (Agent 4 Bug 7 parity): use bar-aligned bars_held.
    # Round opened_ms UP to the next bar close (engine starts counting from
    # ebIdx, the first CLOSED bar after entry). Wall-clock / bar_ms gave
    # off-by-one toward earlier exit on live.
    bar_aligned_open = ((opened_ms + bar_ms - 1) // bar_ms) * bar_ms
    bars_held = max(0, (now_ms - bar_aligned_open) // bar_ms)

    entry = float(pos.get("entry_price", 0))
    if entry <= 0:
        return False
    # BUGFIX 2026-04-29 (Agent 4 Bug 8 parity): anchor min-gain to ORIGINAL
    # stopPct stored at order placement, not the mutated `stop_price` (which
    # break-even/chandelier may have moved to entry → eff_stop ≈ 0 → time-
    # exit never fires after BE). Fall back to current stop_price for legacy
    # positions written before this field was tracked.
    orig_stop_pct = pos.get("original_stop_pct")
    if orig_stop_pct is None:
        stop_price = float(pos.get("stop_price", 0))
        if stop_price <= 0:
            return False
        orig_stop_pct = abs(stop_price - entry) / entry  # legacy fallback
    min_gain_abs = min_gain_r * float(orig_stop_pct)
    unrealized = _unrealized_pct(pos, float(p.price_current))
    if unrealized >= min_gain_abs:
        pos["time_exit_reached_min_gain"] = True

    if bars_held >= max_bars and not pos.get("time_exit_reached_min_gain"):
        log_event("time_exit_close", ticket=pos["ticket"],
                  bars_held=int(bars_held), unrealized=unrealized,
                  min_gain_abs=min_gain_abs)
        if close_position(pos["ticket"]):
            tg_send(
                f"⏳ <b>Time-exit close</b>\n"
                f"{pos['signalAsset']} ticket <code>{pos['ticket']}</code>\n"
                f"Held {int(bars_held)} bars, no min-gain reached."
            )
        return True
    return False


def _signal_marker_id(sig: dict) -> str:
    """Deterministic ID for write-ahead log: same signal → same ID."""
    import hashlib
    key = f"{sig.get('assetSymbol','')}|{sig.get('signalBarClose','')}|{sig.get('direction','')}"
    return hashlib.sha1(key.encode()).hexdigest()[:16]


def _write_pending_order_marker(sig: dict) -> Path:
    """BUGFIX 2026-04-28 (Round 13 Bug 1): write-ahead log marker before
    mt5.order_send. Lets us detect duplicate-trade risk on crash recovery."""
    PENDING_ORDERS_DIR.mkdir(parents=True, exist_ok=True)
    mid = _signal_marker_id(sig)
    marker = PENDING_ORDERS_DIR / f"{mid}.json"
    write_json(marker, {
        "id": mid,
        "signal": sig,
        "ts": datetime.now(timezone.utc).isoformat(),
    })
    return marker


def _clear_pending_order_marker(marker: Path) -> None:
    """Called after order placement is recorded in executed-signals.json."""
    try:
        marker.unlink(missing_ok=True)
    except Exception:
        pass


def reconcile_pending_order_markers() -> None:
    """BUGFIX 2026-04-28 (Round 13 Bug 1): on boot, check pending-orders/
    markers against MT5 actual positions. If MT5 has the order → mark
    cleaned-up. If not → re-queue signal back to pending-signals.json."""
    if not PENDING_ORDERS_DIR.exists():
        return
    markers = list(PENDING_ORDERS_DIR.glob("*.json"))
    if not markers:
        return
    log_event("order_marker_reconcile_start", count=len(markers))
    # Get MT5 positions to check for matching comments
    # Bug-Audit Phase 3 (Python Bug 11): magic= is NOT a documented MT5 API
    # parameter — filter manually so we don't accidentally see manual trades
    # or other bots' positions.
    try:
        all_positions = mt5.positions_get() or []
        positions = [p for p in all_positions if getattr(p, "magic", 0) == 231]
        comments = {p.comment for p in positions}
    except Exception:
        comments = set()
    # BUGFIX 2026-04-28 (Round 36 Bug 3): also check recent history (closed orders
    # within last 60 minutes) — a successful order_send may have completed and
    # already SL/TP'd before the reconcile runs. Without this we'd re-queue
    # signals that already filled-and-exited → duplicate trade on next pickup.
    try:
        recent_deals = mt5.history_deals_get(
            datetime.fromtimestamp(time.time() - 60 * 60),
            datetime.now(),
        ) or []
        for d in recent_deals:
            if getattr(d, "magic", 0) == 231:
                comments.add(getattr(d, "comment", ""))
    except Exception:
        pass
    requeued = []
    cleaned = 0
    for marker in markers:
        try:
            data = read_json(marker, {})
            sig = data.get("signal", {})
            mid = data.get("id") or _signal_marker_id(sig)
            # BUGFIX 2026-04-28 (Round 36 Bug 3): exact marker-ID match. Was
            # substring `asset in comment`, which false-matched any prior
            # trade containing the same asset string.
            # BUGFIX 2026-04-28 (Round 38): comments are MT5-truncated to 31
            # chars; place_market_order writes the first 8 chars of the marker
            # at the START of the comment, so we match on that prefix.
            # Bug-Audit Phase 3 (Python Bug 7): substring match (`mid_short in
            # c`) collided with random hex sequences in unrelated comments
            # (~birthday-paradox at 8 hex chars over weeks of trades). Using
            # startswith anchors to bar-by-bar prefix structure → no spurious
            # "already placed" hits, no false re-queue / double-order.
            mid_short = mid[:8]
            placed = any(c.startswith(mid_short) for c in comments)
            if placed:
                marker.unlink(missing_ok=True)
                cleaned += 1
            else:
                # Re-queue signal to pending-signals.json
                requeued.append(sig)
                marker.unlink(missing_ok=True)
        except Exception as e:
            log_event("marker_reconcile_failed", marker=str(marker), error=str(e), level="warn")
    if requeued:
        existing = read_json(PENDING_PATH, {"signals": []})
        existing["signals"] = existing.get("signals", []) + requeued
        write_json(PENDING_PATH, existing)
        log_event("orphan_signals_requeued", count=len(requeued))
        tg_send(f"🔄 <b>Recovery</b>\nRe-queued {len(requeued)} orphan signal(s) from previous crash")
    log_event("order_marker_reconcile_done", cleaned=cleaned, requeued=len(requeued))


def _emergency_close_all_positions(reason: str) -> None:
    """BUGFIX 2026-04-28 (Round 23 C2): force-close all open positions when
    daily-loss approaches breach. Was previously only blocking new signals
    while existing positions could still drag equity past -5%.

    BUGFIX 2026-04-28 (Round 36 Bug 1): keep tickets whose close FAILED in
    OPEN_POS_PATH so the next loop retries — wiping unconditionally meant
    a single requote/timeout left an orphan position at MT5 with no
    further trail/time-exit/close attempt → equity could still breach.
    """
    open_positions = read_json(OPEN_POS_PATH, {"positions": []})
    closed = 0
    failed_positions: list[dict] = []
    for pos in open_positions.get("positions", []):
        if close_position(pos["ticket"]):
            closed += 1
        else:
            failed_positions.append(pos)
    if closed > 0:
        log_event("emergency_close", reason=reason, closed=closed, failed=len(failed_positions))
        tg_send(f"🚨 <b>Emergency Close {closed} positions</b>\nReason: {html_escape(reason)}")
    if failed_positions:
        log_event("emergency_close_partial", reason=reason, failed=len(failed_positions),
                  tickets=[p["ticket"] for p in failed_positions])
        tg_send(
            f"⚠️ <b>Emergency Close PARTIAL</b>\n"
            f"Failed to close {len(failed_positions)} position(s): "
            f"<code>{', '.join(str(p['ticket']) for p in failed_positions)}</code>\n"
            f"Will retry on next loop. Reason: {html_escape(reason)}"
        )
    # Only retain still-failed tickets so manage_open_positions can retry.
    write_json(OPEN_POS_PATH, {"positions": failed_positions})


def manage_open_positions() -> None:
    open_positions = read_json(OPEN_POS_PATH, {"positions": []})
    now_ms = int(time.time() * 1000)
    still_open: list[dict] = []
    for pos in open_positions.get("positions", []):
        live = mt5.positions_get(ticket=pos["ticket"])
        if not live:
            log_event("position_gone", ticket=pos["ticket"], reason="closed by SL/TP or manually")
            tg_send(f"📉 <b>Position Closed (SL/TP)</b>\n{pos['signalAsset']} ticket <code>{pos['ticket']}</code>")
            continue
        if now_ms >= pos.get("max_hold_until", 0):
            log_event("hold_expired", ticket=pos["ticket"])
            if close_position(pos["ticket"]):
                tg_send(f"⏱ <b>Hold Expired — Closed</b>\n{pos['signalAsset']} ticket <code>{pos['ticket']}</code>")
            continue
        # Round 11: time-exit short-circuits before any other management.
        if _apply_time_exit(pos, now_ms):
            continue
        # Round 11: break-even runs first so its SL is in place before
        # chandelier/trailing try to ratchet further.
        pos = _apply_break_even(pos)
        # Apply trailing-stop updates if configured
        pos = _apply_trailing_stop(pos)
        # Round 11: chandelier ATR trail (ratchets only)
        pos = _apply_chandelier_stop(pos)
        # Round 11: partial TPs fire last so SL adjustments above use full lot
        pos = _apply_partial_tp(pos)
        pos = _apply_partial_tp_levels(pos)
        still_open.append(pos)
    write_json(OPEN_POS_PATH, {"positions": still_open})


def sync_account_state() -> None:
    acct = mt5_get_equity()
    if acct["equity"] is None:
        return
    equity_frac = acct["equity"] / CHALLENGE_START_BALANCE
    day_start_usd = handle_daily_reset(acct["equity"])
    # Bug-Audit Phase 3 (Python Bug 1+2): emergency close on BOTH daily AND
    # total loss with wider buffers. Crypto can move 0.5%+ in a 30s poll
    # window — old -4.5% threshold left no slippage room before -5% breach.
    # TL had no emergency-close at all — only blocked new entries → static
    # bleed-down to -10% was unprotected.
    dl_emergency_threshold = -(MAX_DAILY_LOSS_PCT - DL_EMERGENCY_BUFFER)  # -2.5%
    tl_emergency_threshold = -(MAX_TOTAL_LOSS_PCT - TL_EMERGENCY_BUFFER)  # -7.5%
    if day_start_usd > 0:
        daily_pct = (acct["equity"] - day_start_usd) / day_start_usd
        if daily_pct <= dl_emergency_threshold:
            _emergency_close_all_positions(f"daily_loss_imminent: {daily_pct:.2%}")
    total_pct = (acct["equity"] - CHALLENGE_START_BALANCE) / CHALLENGE_START_BALANCE
    if total_pct <= tl_emergency_threshold:
        _emergency_close_all_positions(f"total_loss_imminent: {total_pct:.2%}")

    deals = mt5.history_deals_get(datetime.fromtimestamp(time.time() - 30 * 86400), datetime.now())
    recent_pnls: list[float] = []
    if deals:
        closes = [d for d in deals if d.magic == 231 and d.entry == mt5.DEAL_ENTRY_OUT]
        closes.sort(key=lambda d: d.time)
        for d in closes[-20:]:
            recent_pnls.append(d.profit / CHALLENGE_START_BALANCE)

    # Round 35: persist all-time challenge peak so V231 can compute
    # peakDrawdownThrottle (R28_V2/V3/V4 sizing) deterministically.
    challenge_peak_usd = update_challenge_peak(acct["equity"])
    challenge_peak_frac = challenge_peak_usd / CHALLENGE_START_BALANCE

    state = {
        "equity": equity_frac,
        "day": get_challenge_day(),
        "recentPnls": recent_pnls,
        "equityAtDayStart": day_start_usd / CHALLENGE_START_BALANCE,
        "challengePeak": challenge_peak_frac,
        "raw_equity_usd": acct["equity"],
        "raw_balance_usd": acct["balance"],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(ACCOUNT_PATH, state)


def handle_kill_request() -> bool:
    """Check bot-controls.json for killRequested. If set, close all positions
    and reset the flag. Returns True if kill was processed.

    BUGFIX 2026-04-28 (Round 36 Bug 5/7): R-M-W via update_controls under
    file lock. Was: read → loop → write — Telegram bot's concurrent
    write between read and write was lost.
    """
    controls = read_json(CONTROLS_PATH, {})
    if not controls.get("killRequested"):
        return False
    log_event("kill_requested", from_controls=True)
    tg_send("🛑 <b>Kill-request received</b> — closing all bot positions...")
    positions = mt5.positions_get()
    closed = 0
    for pos in positions or []:
        if pos.magic == 231:
            if close_position(pos.ticket):
                closed += 1
    def _apply(c: dict) -> dict:
        c["killRequested"] = False
        c["paused"] = True
        return c
    update_controls(_apply)
    tg_send(f"🛑 <b>Kill complete</b> — {closed} position(s) closed. Bot is PAUSED. Send /resume to re-enable.")
    log_event("kill_complete", closed=closed)
    return True


def is_paused() -> bool:
    controls = read_json(CONTROLS_PATH, {})
    return bool(controls.get("paused"))


def _bump_order_fail_counter(error: str) -> None:
    """Increment consecutive-failure counter; auto-pause on threshold."""
    if ORDER_FAIL_AUTO_PAUSE <= 0:
        return
    auto_paused = {"set": False, "streak": 0}

    def _apply(c: dict) -> dict:
        streak = int(c.get("orderFailStreak", 0)) + 1
        c["orderFailStreak"] = streak
        c["lastOrderFailError"] = (error or "")[:200]
        auto_paused["streak"] = streak
        if streak >= ORDER_FAIL_AUTO_PAUSE and not c.get("paused"):
            c["paused"] = True
            c["lastCommand"] = {
                "ts": datetime.now(timezone.utc).isoformat(),
                "cmd": "/auto-pause",
                "reason": f"{streak} consecutive order failures",
            }
            auto_paused["set"] = True
        return c

    update_controls(_apply)
    if auto_paused["set"]:
        tg_send(
            f"🛑 <b>BOT AUTO-PAUSED</b>\n"
            f"{auto_paused['streak']} consecutive order failures.\n"
            f"Last error: <code>{html_escape((error or 'unknown')[:120])}</code>\n"
            f"Use /resume after fixing the cause."
        )


def _reset_order_fail_counter() -> None:
    """Reset consecutive-failure counter after a successful order."""
    if ORDER_FAIL_AUTO_PAUSE <= 0:
        return

    def _apply(c: dict) -> dict:
        if int(c.get("orderFailStreak", 0)) > 0:
            c["orderFailStreak"] = 0
        return c

    update_controls(_apply)


_last_equity_snapshot = [0.0]  # wrapped in list for closure mutation
_last_cb_check_streak = [0]
_last_dd_warn_sent = [""]  # date of last dd warn sent, to avoid spam


def sample_equity_history(current_equity_usd: float) -> None:
    """Append equity snapshot to equity-history.jsonl every EQUITY_HISTORY_INTERVAL_SEC."""
    now = time.time()
    if now - _last_equity_snapshot[0] < EQUITY_HISTORY_INTERVAL_SEC:
        return
    _last_equity_snapshot[0] = now
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "equity_usd": current_equity_usd,
        "equity_pct": (current_equity_usd - CHALLENGE_START_BALANCE) / CHALLENGE_START_BALANCE,
    }
    with open(EQUITY_HISTORY_PATH, "a") as f:
        f.write(json.dumps(entry) + "\n")


def check_circuit_breaker() -> Optional[str]:
    """
    Check recent closed trades (last 20 in 30d window) for consecutive losses.
    Returns a block-reason string if the CB trips, else None.
    Also sends daily-DD warning via Telegram once per day if threshold exceeded.
    """
    deals = mt5.history_deals_get(datetime.fromtimestamp(time.time() - 30 * 86400), datetime.now())
    if not deals:
        return None

    closes = [d for d in deals if d.magic == 231 and d.entry == mt5.DEAL_ENTRY_OUT]
    closes.sort(key=lambda d: d.time)

    # Count consecutive losses from most recent
    streak = 0
    for d in reversed(closes[-CB_LOSS_STREAK * 2:]):
        if d.profit < 0:
            streak += 1
        else:
            break

    if streak > _last_cb_check_streak[0]:
        # Streak grew
        if streak >= CB_LOSS_STREAK:
            # Trip the breaker: set paused flag (under file lock so a
            # concurrent /resume from Telegram doesn't get clobbered).
            tripped = {"set": False}

            def _apply(c: dict) -> dict:
                if not c.get("paused"):
                    c["paused"] = True
                    c["lastCommand"] = {
                        "from": "circuit-breaker",
                        "cmd": "/pause",
                        "ts": datetime.now(timezone.utc).isoformat(),
                    }
                    tripped["set"] = True
                return c

            update_controls(_apply)
            if tripped["set"]:
                log_event("circuit_breaker_tripped", streak=streak)
                tg_send(
                    f"🚨 <b>CIRCUIT BREAKER TRIPPED</b>\n"
                    f"{streak} consecutive losses detected.\n"
                    f"Bot auto-PAUSED. Review and send /resume when ready.",
                )
                _last_cb_check_streak[0] = streak
                return f"circuit_breaker: {streak} consecutive losses"
    _last_cb_check_streak[0] = streak
    return None


_last_consistency_warn = [""]  # date of last warning per ticket-category


_news_closes_announced: set[int] = set()  # timestamps already warned about


def check_news_auto_close() -> None:
    """
    Read news-events.json (written by Node service). If any high-impact
    event is within NEWS_CLOSE_MINUTES_BEFORE minutes, close all bot
    positions and pause new entries briefly.
    """
    data = read_json(NEWS_PATH, {"events": []})
    events = data.get("events", [])
    if not events:
        return

    now_ms = int(time.time() * 1000)
    threshold_ms = NEWS_CLOSE_MINUTES_BEFORE * 60 * 1000
    incoming = [
        e for e in events
        if 0 <= (int(e.get("timestamp", 0)) - now_ms) <= threshold_ms
        and e.get("impact") == "High"
    ]
    if not incoming:
        return

    # Close all bot positions
    positions = mt5.positions_get() or []
    bot_positions = [p for p in positions if p.magic == 231]
    if bot_positions:
        # BUGFIX 2026-04-28: evict timestamps older than 7 days to prevent
        # unbounded set growth in long-running bot.
        cutoff_ms = now_ms - 7 * 24 * 3600 * 1000
        _news_closes_announced.difference_update(
            t for t in list(_news_closes_announced) if t < cutoff_ms
        )
        for e in incoming:
            if e["timestamp"] in _news_closes_announced:
                continue
            _news_closes_announced.add(e["timestamp"])
            mins_to = max(0, (e["timestamp"] - now_ms) // 60000)
            log_event(
                "news_auto_close_trigger",
                title=e.get("title", "?"),
                currency=e.get("currency", "?"),
                minutes_to=mins_to,
                closing=len(bot_positions),
            )
            tg_send(
                f"📰 <b>News Auto-Close</b>\n"
                f"Event: <b>{html_escape(e.get('title', '?'))}</b> ({e.get('currency', '?')})\n"
                f"In {mins_to} min — flattening {len(bot_positions)} position(s) now.",
            )
        for pos in bot_positions:
            close_position(pos.ticket)


def check_consistency_rule() -> None:
    """
    FTMO Consistency Rule: no single trade may account for > 45% of total profit
    (varies: 30-50% depending on plan; FTMO Standard = 45%).
    We warn at 35% and alert hard at 42%.

    Scans last 60d of closed deals with magic=231, identifies largest winner,
    compares to total profit. If ratio exceeds warn threshold, sends Telegram.
    """
    deals = mt5.history_deals_get(datetime.fromtimestamp(time.time() - 60 * 86400), datetime.now())
    if not deals:
        return
    closes = [d for d in deals if d.magic == 231 and d.entry == mt5.DEAL_ENTRY_OUT]
    wins = [d for d in closes if d.profit > 0]
    if not wins:
        return

    total_profit = sum(d.profit for d in closes)
    if total_profit <= 0:
        return  # No net profit yet, rule not applicable

    largest = max(wins, key=lambda d: d.profit)
    ratio = largest.profit / total_profit

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    warn_key = f"{today}-{'HARD' if ratio >= CONSISTENCY_HARD_RATIO else 'WARN' if ratio >= CONSISTENCY_WARN_RATIO else 'OK'}"

    if ratio >= CONSISTENCY_HARD_RATIO and _last_consistency_warn[0] != warn_key:
        _last_consistency_warn[0] = warn_key
        log_event("consistency_rule_hard", ratio=ratio, largest=largest.profit, total=total_profit)
        tg_send(
            f"🚨 <b>CONSISTENCY RULE AT RISK</b>\n"
            f"Largest trade: ${largest.profit:,.2f} ({ratio:.1%} of total profit)\n"
            f"FTMO threshold: 45% — you are at {ratio:.1%}.\n"
            f"Challenge may be <b>invalidated</b> if this grows.\n"
            f"Consider: take smaller next wins, or let losses reduce the largest's share.",
        )
    elif ratio >= CONSISTENCY_WARN_RATIO and _last_consistency_warn[0] != warn_key:
        _last_consistency_warn[0] = warn_key
        log_event("consistency_rule_warn", ratio=ratio, largest=largest.profit, total=total_profit)
        tg_send(
            f"⚠️ <b>Consistency Rule Warning</b>\n"
            f"Largest trade: ${largest.profit:,.2f} ({ratio:.1%} of total profit)\n"
            f"FTMO invalidates if this exceeds 45%. Current: {ratio:.1%}.\n"
            f"Buffer: {(0.45 - ratio):.1%}",
        )


def check_daily_dd_warning(current_equity_usd: float, day_start_usd: float) -> None:
    """Send one Telegram warning per day if daily DD passes CB_DAILY_DD_WARN_PCT."""
    if day_start_usd <= 0:
        return
    daily_pct = (current_equity_usd - day_start_usd) / day_start_usd
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if daily_pct <= -CB_DAILY_DD_WARN_PCT and _last_dd_warn_sent[0] != today:
        _last_dd_warn_sent[0] = today
        dd_usd = current_equity_usd - day_start_usd
        log_event("daily_dd_warning", daily_pct=daily_pct)
        tg_send(
            f"⚠️ <b>Daily Drawdown Warning</b>\n"
            f"Today: <b>{daily_pct:.2%}</b> (${dd_usd:+,.2f})\n"
            f"Daily-loss cap: -{MAX_DAILY_LOSS_PCT:.0%}. Buffer left: {(daily_pct + MAX_DAILY_LOSS_PCT):.2%}\n"
            f"Consider /pause if this gets worse.",
        )


def rebuild_open_positions_from_mt5() -> None:
    """Reconcile open-positions.json with the live MT5 positions on boot.

    Round-7 #11: if the executor is restarted while positions are open
    (e.g. crash, reboot, deploy), open-positions.json may be stale or wiped.
    Without this, manage_open_positions() can't trail/exit those tickets.
    Strategy: pull all magic=231 positions from MT5, merge with whatever
    open-positions.json currently holds (preserve trailing-stop state for
    known tickets, add minimal entries for unknown tickets so SL/TP are
    still managed by MT5 server-side and time/break-even logic resumes).
    """
    try:
        positions = mt5.positions_get() or []
    except Exception as e:
        log_event("rebuild_open_positions_mt5_get_failed", error=str(e))
        return
    bot_positions = [p for p in positions if getattr(p, "magic", None) == 231]

    existing = read_json(OPEN_POS_PATH, {"positions": []})
    by_ticket = {p["ticket"]: p for p in existing.get("positions", [])}

    rebuilt: list[dict] = []
    added = 0
    kept = 0
    for live in bot_positions:
        ticket = live.ticket
        if ticket in by_ticket:
            # Preserve trailing/PTP/chandelier state from on-disk record.
            rebuilt.append(by_ticket[ticket])
            kept += 1
        else:
            # Minimal stub — allows time-exit + max-hold to fire even on
            # tickets we lost state for. Trailing-stop / PTP / chandelier
            # cannot be resumed (no entry config), so we leave them None.
            direction = "long" if live.type == mt5.POSITION_TYPE_BUY else "short"
            rebuilt.append({
                "ticket": ticket,
                "signalAsset": live.symbol,
                "sourceSymbol": live.symbol,
                "direction": direction,
                "lot": live.volume,
                "entry_price": live.price_open,
                "stop_price": live.sl or 0.0,
                "tp_price": live.tp or 0.0,
                "max_hold_until": 0,  # 0 disables time exit on rebuilt stubs
                "opened_at": datetime.fromtimestamp(live.time, tz=timezone.utc).isoformat(),
                "trailing_stop": None,
                "trailing_activated": False,
                "partial_tp": None,
                "partial_tp_done": False,
                "partial_tp_levels": None,
                "partial_tp_levels_done": [],
                "chandelier": None,
                "chandelier_armed": False,
                "chandelier_best_close": None,
                "break_even": None,
                "break_even_done": False,
                "time_exit": None,
                "time_exit_reached_min_gain": False,
                "_rebuilt_from_mt5": True,
            })
            added += 1

    # Drop on-disk records whose tickets are no longer live (already closed).
    dropped = len(by_ticket) - kept
    write_json(OPEN_POS_PATH, {"positions": rebuilt})
    log_event(
        "rebuild_open_positions_complete",
        live_total=len(bot_positions),
        kept=kept,
        added_stubs=added,
        dropped_stale=dropped,
    )


def acquire_singleton_or_exit() -> None:
    """Refuse to start when another executor is already running on this state dir.

    Two concurrent executors → racing MT5 order_send + clobbered state files.
    We write our PID into STATE_DIR/executor.pid; if the file already exists
    AND the recorded PID is alive, exit. Stale PID files are taken over.
    """
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    pid_file = STATE_DIR / "executor.pid"
    if pid_file.exists():
        try:
            other_pid = int(pid_file.read_text().strip())
        except Exception:
            other_pid = 0
        if other_pid > 0 and other_pid != os.getpid():
            alive = False
            try:
                if os.name == "nt":
                    import ctypes
                    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
                    handle = ctypes.windll.kernel32.OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION, False, other_pid
                    )
                    if handle:
                        alive = True
                        ctypes.windll.kernel32.CloseHandle(handle)
                else:
                    os.kill(other_pid, 0)
                    alive = True
            except (OSError, ProcessLookupError):
                alive = False
            except Exception:
                alive = False
            if alive:
                msg = (
                    f"Another ftmo_executor is already running "
                    f"(pid={other_pid}, state_dir={STATE_DIR}). Refusing to start."
                )
                print(msg, file=sys.stderr)
                log_event("singleton_refused", other_pid=other_pid)
                sys.exit(11)
    try:
        pid_file.write_text(str(os.getpid()))
    except Exception:
        pass

    # Mid-session FTMO_TF switch protection: refuse to attach to a state-dir
    # whose recorded timeframe differs from ours when there are still open
    # positions. Otherwise the new TF's signal stream loses sight of the
    # legacy positions and we may double-enter / drop SL management.
    marker = STATE_DIR / "tf-marker.json"
    open_pos_path = STATE_DIR / "open-positions.json"
    has_open = False
    try:
        if open_pos_path.exists():
            payload = json.loads(open_pos_path.read_text("utf8"))
            positions = payload.get("positions") if isinstance(payload, dict) else None
            has_open = bool(positions)
    except Exception:
        has_open = False
    if marker.exists():
        try:
            recorded = json.loads(marker.read_text("utf8")).get("ftmo_tf")
        except Exception:
            recorded = None
        if recorded and recorded != _FTMO_TF and has_open:
            msg = (
                f"FTMO_TF changed from {recorded} to {_FTMO_TF} while open "
                f"positions exist in {STATE_DIR}. Close them first or use "
                f"the previous timeframe to manage them."
            )
            print(msg, file=sys.stderr)
            log_event(
                "ftmo_tf_switch_blocked", recorded=recorded, current=_FTMO_TF
            )
            sys.exit(12)
    try:
        marker.write_text(json.dumps({"ftmo_tf": _FTMO_TF}))
    except Exception:
        pass

    def _release_singleton() -> None:
        try:
            if pid_file.exists():
                try:
                    cur = int(pid_file.read_text().strip())
                except Exception:
                    cur = -1
                if cur == os.getpid():
                    pid_file.unlink(missing_ok=True)
        except Exception:
            pass

    import atexit
    atexit.register(_release_singleton)


def main_loop() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    acquire_singleton_or_exit()

    # Connect with retry
    while not mt5_init_with_retry():
        log_event("initial_connect_retry", backoff_sec=RECONNECT_BACKOFF_SEC)
        time.sleep(RECONNECT_BACKOFF_SEC)

    # BUGFIX 2026-04-29 (R12 Agent 2 Bug 1): reconcile FIRST so any "placed"
    # markers can write a complete open_positions entry (with PTP/chand/breakEven
    # config) before rebuild overwrites the file with the bare MT5 snapshot.
    # Round 13 Bug 1: reconcile pending-orders write-ahead log to detect
    # crashed-mid-order_send signals (re-queue or cleanup).
    reconcile_pending_order_markers()
    # Round-7 #11: reconcile on-disk position state with MT5 truth on boot.
    # Critical when the executor restarts while trades are open.
    rebuild_open_positions_from_mt5()

    mode = "MOCK" if MOCK_MODE else "LIVE (MT5)"
    tg_send(
        f"🤖 <b>FTMO Executor ONLINE</b> [{mode}]\n"
        f"Start balance: ${CHALLENGE_START_BALANCE:,.0f}\n"
        f"Daily-loss cap: -{MAX_DAILY_LOSS_PCT:.0%}\n"
        f"Total-loss cap: -{MAX_TOTAL_LOSS_PCT:.0%}\n"
        f"Poll interval: {POLL_INTERVAL_SEC}s"
    )
    log_event("executor_started", mode=mode, state_dir=str(STATE_DIR))

    try:
        while True:
            try:
                if not mt5_ensure_connected():
                    continue
                handle_kill_request()
                sync_account_state()

                # Sample equity history for dashboard charts
                acct = mt5_get_equity()
                if acct["equity"] is not None:
                    sample_equity_history(acct["equity"])
                    day_start_usd = read_json(DAILY_STATE_PATH, {}).get("equity_at_day_start_usd", acct["equity"])
                    check_daily_dd_warning(acct["equity"], day_start_usd)
                    # R28: Track intraday peak for dailyPeakTrailingStop. Even
                    # when no signal arrives, peak must keep ratcheting up so
                    # the gate triggers at the correct moment.
                    if DPT_ENABLED:
                        update_day_peak(acct["equity"])

                # Circuit breaker (may trip → set paused)
                check_circuit_breaker()

                # FTMO Consistency Rule (warn when single trade approaching 45%)
                check_consistency_rule()

                # News auto-close (flatten positions before high-impact events)
                check_news_auto_close()

                if is_paused():
                    # Paused: skip placing new orders but still manage open positions
                    manage_open_positions()
                else:
                    process_pending_signals()
                    manage_open_positions()

                # iter236+: place daily ping trade if target was hit (for FTMO 5-day rule)
                maybe_place_ping_trade()
            except Exception as e:
                log_event("loop_error", error=str(e))
                # Rate-limit Telegram alerts: only send once per 30min per unique error message
                err_key = str(e)[:120]
                now_ts = time.time()
                last_sent = _loop_error_last_sent.get(err_key, 0)
                if now_ts - last_sent > 1800:
                    tg_send(f"⚠️ <b>Executor Loop Error</b>\n<code>{html_escape(str(e))}</code>")
                    _loop_error_last_sent[err_key] = now_ts
                    # BUGFIX 2026-04-28 (Round 12): cap dict size to prevent
                    # unbounded growth from diverse error messages over months.
                    if len(_loop_error_last_sent) > 100:
                        # Drop oldest entries (Python 3.7+ dict is insertion-ordered)
                        for old_key in list(_loop_error_last_sent.keys())[:50]:
                            del _loop_error_last_sent[old_key]
            time.sleep(POLL_INTERVAL_SEC)
    except KeyboardInterrupt:
        log_event("executor_stopped", reason="keyboard_interrupt")
        tg_send("🛑 <b>Executor Stopped</b> (Ctrl+C)")
    finally:
        try:
            mt5.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    # BUGFIX 2026-04-28 (Round 23 C1): handle SIGTERM (sent by PM2 on restart)
    # so we trigger the same KeyboardInterrupt cleanup path. Without this,
    # MT5 connection terminates mid-order_send → orphan trades without SL/TP.
    import signal as _signal
    def _on_sigterm(*_args):  # type: ignore[reportUnusedVariable]
        # signal-handler signature requires *args; we ignore them.
        raise KeyboardInterrupt()
    try:
        _signal.signal(_signal.SIGTERM, _on_sigterm)
    except (AttributeError, ValueError):
        pass  # Windows doesn't support all signals
    main_loop()
