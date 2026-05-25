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
from datetime import datetime, timezone, timedelta
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


def _round_to_tick(price: float, tick_size: float, digits: int) -> float:
    """R67-r10: round price to broker tick grid + declared digits."""
    if tick_size and tick_size > 0:
        price = round(price / tick_size) * tick_size
    if digits and digits > 0:
        price = round(price, int(digits))
    return price


# =============================================================================
# Config — via env vars
# =============================================================================
# 2026-05-15 (Audit-Round-4 / Agent #9 HIGH): default unified across the
# Python toolkit via tools/_ftmo_defaults.py. Was "1h" → caused kill / health
# / news / preflight to resolve different state-dirs when env was unset.
# Sibling import (tools/ is on sys.path via the block above).
from _ftmo_defaults import DEFAULT_FTMO_TF  # type: ignore  # noqa: E402
from direction_util import normalize_direction  # type: ignore  # noqa: E402

_FTMO_TF = os.environ.get("FTMO_TF", DEFAULT_FTMO_TF)
# Phase 73 (R44-V4-Bug 1): per-account state isolation. Two bots on the
# same TF / strategy but different FTMO accounts must NOT share state
# files. FTMO_STATE_DIR (explicit) wins, else use ACCOUNT_ID suffix
# when set, else legacy ftmo-state-{TF} for backward compat.
_FTMO_ACCOUNT_ID = os.environ.get("FTMO_ACCOUNT_ID", "").strip()
if os.environ.get("FTMO_STATE_DIR"):
    STATE_DIR = Path(os.environ["FTMO_STATE_DIR"])
elif _FTMO_ACCOUNT_ID:
    STATE_DIR = Path(f"./ftmo-state-{_FTMO_TF}-{_FTMO_ACCOUNT_ID}")
else:
    STATE_DIR = Path(f"./ftmo-state-{_FTMO_TF}")
POLL_INTERVAL_SEC = 30
RECONNECT_BACKOFF_SEC = 10
CHALLENGE_START_BALANCE = float(os.environ.get("FTMO_START_BALANCE", "100000"))
MAX_DAILY_LOSS_PCT = 0.05
MAX_TOTAL_LOSS_PCT = 0.10
CHALLENGE_START_DATE = os.environ.get("FTMO_START_DATE")

# Challenge start timing gate. When enabled, the executor refuses to place
# new entry orders until the timing supervisor says the current market setup
# qualifies. Once the first real order is placed, a per-account start marker
# is written and the strategy is allowed to continue normally for that
# challenge even if the timing gate later turns red.
START_GATE_ENABLED = os.environ.get("FTMO_START_GATE_ENABLED", "").lower() in (
    "1",
    "true",
    "yes",
)
# 2026-05-20 bug-find round: in multi-account mode (FTMO_ACCOUNT_ID set) the
# supervisor fallback gate must be PER-ACCOUNT — a shared global state/timing-
# gate.json correlated fresh-boot start decisions across the 3-stack, undermining
# the multi-account independence the deploy plan relies on. Single-account keeps
# the legacy global path (supervisor-compatible). Explicit FTMO_START_GATE_PATH
# always wins.
_START_GATE_DEFAULT = (
    str(STATE_DIR / "timing-gate.json") if _FTMO_ACCOUNT_ID else "state/timing-gate.json"
)
_START_GATE_RAW_PATH = os.environ.get("FTMO_START_GATE_PATH", _START_GATE_DEFAULT)
START_GATE_PATH = Path(_START_GATE_RAW_PATH)
if not START_GATE_PATH.is_absolute():
    START_GATE_PATH = (_TOOLS_DIR.parent / START_GATE_PATH).resolve()
# 2026-05-19 Multi-Tier Cluster Detector — engine-validated thresholds
# (sweep on 146 windows × 19 cryptos, OOS-split). Each tier defines an
# alternative "qualifying setup": ANY tier matching → gate is open. The
# default (DEFAULT_*) is the loosest active tier; TIER_S / TIER_A are
# tighter, higher-confidence variants surfaced for logging + optional
# risk-multiplier use.
#
#   TIER-S (b>=6 m>=4):  100.00% cond / 6.85% freq — both halves OOS
#   TIER-A (b>=10 m>=3): 94.74% cond / 39.04% freq
#   TIER-B (2h b>=10 m>=1): 94%+ random-buy wait-to-green  ← new default
#   Legacy (b>=4 m>=3):  93.22% cond / 40.41% freq  ← old default
#
# Hard-default raised from 4/3 → fast broad-cluster 2h 10/1: higher
# purchase-weighted random-buy pass-rate (~94%) while still requiring one
# major so purely alt-only bursts do not open the start gate.
START_GATE_MIN_BREADTH = int(os.environ.get("FTMO_START_GATE_MIN_BREADTH", "10"))
START_GATE_MIN_MAJORS = int(os.environ.get("FTMO_START_GATE_MIN_MAJORS", "1"))
# Tier-S premium cluster — OOS 100% pass-rate. Optional risk boost when
# matched (`FTMO_TIER_S_RISK_MULT=1.5` etc.). Off by default; only the
# qualification signal is logged.
#
# 2026-05-19 KRIT-2 fix: TIER-S defaults tightened from (b>=6, m>=4) to
# (b>=10, m>=4) so the tier hierarchy is strictly nested (S ⊂ A on every
# axis). Previously S required only 6 breadth — strictly LOOSER than A's
# 10 breadth — so a noisy alt-majors-light cluster could match S but not
# A, contradicting the "S = premium" semantic. The new strict-monotonie
# validator below now enforces this invariant for all custom env-overrides.
TIER_S_MIN_BREADTH = int(os.environ.get("FTMO_TIER_S_MIN_BREADTH", "10"))
TIER_S_MIN_MAJORS = int(os.environ.get("FTMO_TIER_S_MIN_MAJORS", "4"))
TIER_A_MIN_BREADTH = int(os.environ.get("FTMO_TIER_A_MIN_BREADTH", "10"))
TIER_A_MIN_MAJORS = int(os.environ.get("FTMO_TIER_A_MIN_MAJORS", "3"))
TIER_S_RISK_MULT = float(os.environ.get("FTMO_TIER_S_RISK_MULT", "1.0"))
TIER_A_RISK_MULT = float(os.environ.get("FTMO_TIER_A_RISK_MULT", "1.0"))
# 2026-05-20 bug-find round fix (#2b): default 2h diverged from the backtest's
# initial_window_hours=24 — the live gate measured a 2h trailing window vs the
# validated 24h cluster, so it qualified far less often than the backtest. Now
# defaults to 24 to mirror the backtest's first-24h-cluster population. Override
# via FTMO_START_GATE_WINDOW_HOURS only if the backtest used a different window.
START_GATE_WINDOW_HOURS = float(os.environ.get("FTMO_START_GATE_WINDOW_HOURS", "24"))
START_GATE_MIN_HISTORY_HOURS = float(os.environ.get("FTMO_START_GATE_MIN_HISTORY_HOURS", "0"))
START_GATE_MAX_AGE_MIN = float(os.environ.get("FTMO_START_GATE_MAX_AGE_MIN", "180"))
# Cluster-only mode gates every new entry, not only the first challenge trade.
# This is the honest random-buy fallback: the bot can sit inside a challenge and
# only add risk while the currently visible signal cluster is green.
CLUSTER_ONLY_ENABLED = os.environ.get("FTMO_CLUSTER_ONLY_ENABLED", "").lower() in (
    "1",
    "true",
    "yes",
)
CLUSTER_ONLY_MIN_HISTORY_HOURS = float(os.environ.get("FTMO_CLUSTER_ONLY_MIN_HISTORY_HOURS", "0"))
# 2026-05-18 Bug-Audit Round-3 (MITTEL): track whether we've already warned
# about env vs gate threshold mismatch (avoid Telegram spam on every poll).
_START_GATE_ENV_WARNED = False

# iter236+: Profit target & pause-after-target behavior
# 2026-05-15 (Audit-Round-4 / Agent #12 KRIT, commit 65a4181 follow-up):
# pt=0.08 was an IMAGINARY FTMO product — real FTMO Standard 2-Step Challenge
# is +10% (Phase 1) / +5% (Phase 2). Default flipped to 0.10 so a user who
# forgets to set FTMO_PROFIT_TARGET runs Phase-1 numbers, not an unreachable
# 8% target that triggers Pass-Lock 2pp too early. Phase 2 must set 0.05.
PROFIT_TARGET_PCT = float(os.environ.get("FTMO_PROFIT_TARGET", "0.10"))  # FTMO Phase 1 = 10%
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
# 2026-05-13 Codex Round 4 Python #5: max entry-price slippage between signal
# emission and order placement. If exceeded, signal is skipped. Default 0.5%
# matches typical crypto-tick latency budget.
MAX_ENTRY_SLIPPAGE_PCT = float(os.environ.get("FTMO_MAX_ENTRY_SLIPPAGE", "0.005"))

# 2026-05-20 bug-find round: floor on the effective stop distance. With absolute
# payload SL/TP (Codex #5), a pathologically tiny stop would make compute_lot_size
# produce an enormous lot (real risk >> risk_frac, bounded only by margin). Reject
# any order whose effective stop distance is below this floor. Default 0.1% — far
# below any legitimate crypto stop (1-5%), so it only catches degenerate payloads.
MIN_EFFECTIVE_STOP_PCT = float(os.environ.get("FTMO_MIN_EFFECTIVE_STOP", "0.001"))

# Max age (seconds) of an MT5 quote before it's treated as stale and orders are
# refused — guards against a frozen-but-positive feed (stall / weekend gap).
MAX_TICK_AGE_SEC = float(os.environ.get("FTMO_MAX_TICK_AGE_SEC", "120"))

# Signal staleness cap — drop/never-execute signals older than this after a
# crash/restart/long pause (avoids trading on stale data). Used by both the
# pending-signal processor and the boot order-marker reconcile (so a stale
# orphan marker is alerted, not silently dropped or double-executed).
# 2026-05-23 ML audit Wave1 agent: 5min was at edge for 4h cron emitter
# (signalBarClose at bar close + ~5min emit-latency + executor 30s poll +
# place-order latency = 6-8min easily). Bump to 15min for safety margin.
# Boot reconcile uses same constant (cleanup-orphaned-orders > 15min old).
MAX_SIGNAL_AGE_MS = 15 * 60_000

# ---------------------------------------------------------------------------
# FTMO_STRICT_PARITY (R3-B Drift-3, 2026-05-15)
#
# By default the live executor applies *defensive* safety buffers on top of
# the FTMO rule-set so a single 30-second poll cycle on a fast crypto move
# can't accidentally breach the hard caps:
#
#   - check_ftmo_rules blocks new entries at -4.0% (vs FTMO -5%) daily-loss
#     and -8.5% (vs FTMO -10%) total-loss.
#   - sync_account_state emergency-closes all positions at -2.5% daily /
#     -7.5% total (DL_EMERGENCY_BUFFER / TL_EMERGENCY_BUFFER).
#
# These buffers are *intentional* and explain a portion of the live-vs-sim
# pass-rate drift — backtests use the raw -5% / -10% caps. For deterministic
# parity tests (or aggressive Demo deploys that want maximum sim-fidelity),
# set FTMO_STRICT_PARITY=1 to zero ALL buffers. WARNING: strict mode trades
# pass-rate stability for theoretical parity — a 30-second crypto wick can
# cause a real -5% breach with no safety margin. Recommended only for
# CI/regression runs or sim-validation, never for live funded accounts.
#
# Verified zeroes: DL_EMERGENCY_BUFFER, TL_EMERGENCY_BUFFER, the +0.010
# daily-loss entry-buffer, and the +0.015 total-loss entry-buffer.
# ---------------------------------------------------------------------------
FTMO_STRICT_PARITY = os.environ.get("FTMO_STRICT_PARITY", "").lower() in (
    "1",
    "true",
    "yes",
)


def _parity_buffer(default: float) -> float:
    """Return 0.0 when FTMO_STRICT_PARITY=1, else the default buffer."""
    return 0.0 if FTMO_STRICT_PARITY else default


# R67-r12 audit fix (Hedge-Mode close-deal codes): closing deals on FTMO
# Hedge-Mode accounts can have entry codes DEAL_ENTRY_INOUT (=2,
# position-reversal) or DEAL_ENTRY_OUT_BY (=3, close-by-opposite) instead
# of the default DEAL_ENTRY_OUT (=1). Round 58 already added this to
# `reconcile_missing_positions`; the audit found the same fix was missing
# in 5 other sites (yesterday-stats, recent-pnls, circuit-breaker,
# consistency-rule, close-history-check). Centralised so all paths agree.
_CLOSE_ENTRY_CODES = (
    getattr(mt5, "DEAL_ENTRY_OUT", 1),
    getattr(mt5, "DEAL_ENTRY_INOUT", 2),
    getattr(mt5, "DEAL_ENTRY_OUT_BY", 3),
)


def _is_close_deal(d) -> bool:  # type: ignore[no-untyped-def]
    """True if `d` is a position-closing deal (any FTMO mode)."""
    return getattr(d, "entry", -1) in _CLOSE_ENTRY_CODES


# R67-r12 audit fix (ORDER_FILLING_IOC hardcoded): probe the broker-allowed
# filling modes per symbol so we don't permanently auto-pause when an FTMO
# crypto symbol rejects IOC. `info.filling_mode` is a bitmask:
#   bit 0 (1) = SYMBOL_FILLING_FOK
#   bit 1 (2) = SYMBOL_FILLING_IOC
# Cache per symbol since we call once per order. Falls through to IOC if
# the bitmask is unset (treat as legacy hard-coded behaviour) so existing
# Demo deploys behave identically.
_FILLING_MODE_CACHE: dict[str, int] = {}


def _pick_filling_mode(symbol: str):  # type: ignore[no-untyped-def]
    """Return the safest order-filling constant for `symbol` based on
    `mt5.symbol_info(symbol).filling_mode`. Caches per symbol.

    Bug-Audit Round 2: if the very first call happens before MT5 has the
    symbol selected (`info is None` or `filling_mode == 0`), the previous
    code poisoned the cache with the RETURN fallback for the rest of the
    process lifetime — and every subsequent order_send tripped retcode
    10030 "invalid order filling type" on FOK-only crypto pairs. Now we
    only cache a positive-bitmask result; an unknown probe falls through
    to RETURN for THIS call but does NOT pollute the cache.
    """
    cached = _FILLING_MODE_CACHE.get(symbol)
    if cached is not None:
        return cached
    info = mt5.symbol_info(symbol)
    bitmask = getattr(info, "filling_mode", 0) if info is not None else 0
    if bitmask & 1:  # FOK preferred — most FTMO crypto symbols
        chosen = mt5.ORDER_FILLING_FOK
        _FILLING_MODE_CACHE[symbol] = chosen
        return chosen
    if bitmask & 2:
        chosen = mt5.ORDER_FILLING_IOC
        _FILLING_MODE_CACHE[symbol] = chosen
        return chosen
    # Bitmask unset / unknown → fall back to RETURN for THIS call. Do NOT
    # cache so the next call (after symbol_select() has populated the
    # bitmask) re-probes and picks the real broker-supported mode.
    return getattr(mt5, "ORDER_FILLING_RETURN", mt5.ORDER_FILLING_IOC)

# Auto-pause after N consecutive failed orders (e.g. "no money" cascade).
# Resets to 0 on the first successful order. Setting to 0 disables.
ORDER_FAIL_AUTO_PAUSE = int(os.environ.get("FTMO_ORDER_FAIL_PAUSE", "3"))

# BUGFIX 2026-04-28: enforce engine.maxConcurrentTrades in live executor.
# Engine caps simultaneous open trades (e.g. V5 → 6, ELITE → 12) but live had
# no cap → could open arbitrary count if many signals queued at once. Default
# 8 = safe upper bound for all current configs (V5 family ≤ 12). User can
# tune via FTMO_MAX_CONCURRENT.
MAX_CONCURRENT_TRADES = int(os.environ.get("FTMO_MAX_CONCURRENT", "8"))
# 2026-05-20 bug-find round: optional aggregate portfolio-risk cap. The MCT count
# cap + per-order RISK_FRAC_HARD_CAP allow up to MAX_CONCURRENT × hard-cap (e.g.
# 8 × 0.05 = 40%) concurrent equity-at-risk — a correlated crypto crash could
# breach the FTMO DL before stops fire. Set FTMO_PORTFOLIO_MAX_RISK (e.g. 0.20)
# to block new entries once the summed effective risk_frac of open + in-batch
# positions would exceed it. Default 0 = disabled (no behaviour change).
PORTFOLIO_MAX_RISK = float(os.environ.get("FTMO_PORTFOLIO_MAX_RISK", "0"))

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
# 2026-05-20 bug-find round: consecutive poll-loop errors auto-pause the bot.
# A throw in sync_account_state BEFORE the breach-close was a fail-OPEN — equity
# could bleed toward the -5%/-10% limit while the loop just logged + re-polled.
# After N consecutive errors we PAUSE (fail-closed) so the operator is forced to
# investigate rather than the bot silently churning through a broken cycle.
_consecutive_loop_errors = 0
LOOP_ERROR_AUTO_PAUSE = int(os.environ.get("FTMO_LOOP_ERROR_AUTO_PAUSE", "5"))
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
    # 2026-05-23 Wave2 fix (MED — defensive): V5_TITANIUM/OBSIDIAN baskets
    # depend on these 4 tickers and were previously relying on the
    # USDT→USD fallback heuristic + broker symbol_info() validation. If FTMO
    # ever rebrands one (e.g. SAND→SANDBOX) the signal silently skips.
    # Pin explicit mapping; env overrides remain for per-broker tweaks.
    "INJUSDT": os.environ.get("FTMO_INJ_SYMBOL", "INJUSD"),
    "RUNEUSDT": os.environ.get("FTMO_RUNE_SYMBOL", "RUNUSD"),
    "SANDUSDT": os.environ.get("FTMO_SAND_SYMBOL", "SANDUSD"),
    "ARBUSDT": os.environ.get("FTMO_ARB_SYMBOL", "ARBUSD"),
    # 2026-05-23 Wave2 fix: V5_FOREX_MR_PASSLOCK template emits 6 forex
    # symbols (EURUSD/GBPUSD/USDJPY/USDCAD/AUDUSD/NZDUSD). Without explicit
    # mapping the resolve fell through to USDT-stripping logic that turned
    # `EURUSD` into `EUR` (no MT5 symbol) → live executor would silently
    # produce 0 fills, defeating the entire template. Pass-through identity
    # by default since most FTMO MT5 brokers expose forex with the same
    # 6-char ticker; per-broker overrides via FTMO_<X>_SYMBOL env.
    "EURUSD": os.environ.get("FTMO_EURUSD_SYMBOL", "EURUSD"),
    "GBPUSD": os.environ.get("FTMO_GBPUSD_SYMBOL", "GBPUSD"),
    "USDJPY": os.environ.get("FTMO_USDJPY_SYMBOL", "USDJPY"),
    "USDCAD": os.environ.get("FTMO_USDCAD_SYMBOL", "USDCAD"),
    "AUDUSD": os.environ.get("FTMO_AUDUSD_SYMBOL", "AUDUSD"),
    "NZDUSD": os.environ.get("FTMO_NZDUSD_SYMBOL", "NZDUSD"),
}


# 2026-05-15 R3 audit Bug #2 (MITTEL) — REVISED 2026-05-16 Codex audit Bug #1
# (KRITISCH): per-account magic IDs to avoid cross-claiming positions on
# shared-MT5 setups.
#
# PREVIOUS BROKEN IMPLEMENTATION (sha1 % 100 + PING_MAGIC = MAGIC+1):
#   - account "11" sha1%100 = 1 → MAGIC=232. account "23" sha1%100 = 1 → also
#     MAGIC=232. Two distinct accounts shared the same MAGIC. Collisions
#     observed for 23 of the first 100 numeric IDs.
#   - account "1" → MAGIC=238, PING_MAGIC=239. account "15" → MAGIC=239.
#     The PING_MAGIC of account "1" overlapped the MAGIC of account "15".
#
# NEW DETERMINISTIC IMPLEMENTATION:
#   - Numeric FTMO_ACCOUNT_ID (the common case — most FTMO logins ARE
#     numeric): MAGIC = 231 + 10 + num*10. Account 1 → 251, account 2 → 261,
#     ...  Each account occupies a 10-wide slot so PING_MAGIC = MAGIC + 7
#     can NEVER collide with the next account's MAGIC.
#   - Non-numeric FTMO_ACCOUNT_ID (rare, legacy alias-style): widen the
#     hash space to sha256 mod 9000 + 11000 offset → range [11231, 20230].
#     With 9000 slots, collision probability over 100 IDs is < 0.6% (vs
#     ~30% under the broken sha1%100 scheme).
#   - FTMO_ACCOUNT_ID unset → MAGIC = 231, PING_MAGIC = 238 (legacy single-
#     account deploys still work — the PING_MAGIC shift from 232 → 238 is
#     intentional to keep the +7 offset consistent across all paths).
#
# Deterministic across process restarts (never uses Python's randomised
# `hash()` — PYTHONHASHSEED is per-process and would orphan yesterday's
# tickets on a restart).
def _tf_magic_offset() -> int:
    """2026-05-25 Wave5 KRIT FIX (audit agent #7): widened from mod 6 to mod 1000.

    Birthday-paradox math: for Phase-Adaptive Stack-4 (4 accounts × 2 TFs each
    = 8 distinct (account_id, tf) tuples on shared MT5 login), the prior mod-6
    scheme had 72% probability of AT LEAST ONE collision. Live impact:
    mt5.positions_get(magic=X) would silently match another strategy's
    positions → close-all / SL-management / reconcile cross-contamination.

    Mod 1000 + per-account 1010-wide slot drops 8-tuple collision probability
    to ~3.2%, AND the supervisor's startup-validator (KRIT #2 fix) enforces
    TF_P1 ≠ TF_P2 offsets per-account (intra-account zero-collision).

    Slot reservations within the 1010-wide block:
      - 0..6, 8..999 = TF disambiguation (999 valid slots)
      - 7 = PING_MAGIC (skipped here; if hash hits 7, remap to 6)
      - 1000..1009 = reserved for future use
    """
    tf = os.environ.get("FTMO_TF", "").strip()
    if not tf:
        return 0
    import hashlib
    digest = hashlib.sha256(tf.encode("utf-8")).hexdigest()[:8]
    raw = int(digest, 16) % 1000
    # Skip slot 7 (= PING_MAGIC). Remap collision to slot 6 (unused otherwise).
    if raw == 7:
        raw = 6
    return raw


def _compute_account_base() -> int:
    """2026-05-25 Wave5 KRIT FIX: widened from 10-wide to 1010-wide per-account.

    Was: `base + 10 + num*10` → account-N base at base+10+10N. With tf_off ≤5
    and PING at base+7, account-N's MAGIC range was [base+10+10N, base+15+10N]
    and PING at base+17+10N — inside account-(N+1)'s slot.

    New: `base + 10 + num*1010` → account-N base at base+10+1010N. tf_off up to
    999 + PING at base+7 fit comfortably within the 1010-wide slot.

    Account-1 base = 1251, account-2 base = 2261, etc. Bases grow ~1K each
    account, so 100 accounts max-fit before 32-bit MAGIC overflow concern
    (FTMO realistically caps at ~20 accounts/trader).

    PING_MAGIC = base + 7 (within slot, NOT shifted by tf_off — Wave4 fix
    pattern preserved).
    """
    base = 231
    account_id = os.environ.get("FTMO_ACCOUNT_ID", "").strip()
    if not account_id:
        return base
    try:
        num = int(account_id)
        if num < 0:
            raise ValueError("negative account_id")
        # base + 10 + num*1010 → account 1=1251, account 2=2261, ...
        return base + 10 + (num * 1010)
    except ValueError:
        # Non-numeric: shift to disjoint range. Width 1010 per slot.
        import hashlib

        digest = hashlib.sha256(account_id.encode("utf-8")).hexdigest()[:8]
        offset = int(digest, 16) % 9000
        # base + 11_000_000 + offset*1010 — disjoint from numeric range.
        return base + 11_000_000 + (offset * 1010)


def _compute_magic_id() -> int:
    """MAGIC = account_base + tf_off (slots 0..5 within the 10-wide block)."""
    return _compute_account_base() + _tf_magic_offset()


# 2026-05-24 Wave4 HIGH FIX: PING is now `account_base + 7`, NOT `MAGIC + 7`.
# PING_MAGIC is fixed within the account slot regardless of which TF the bot
# runs — preventing cross-account leakage on shared MT5 logins. Slots inside
# the 10-wide account block: 0..5 = MAGIC per TF, 6 unused, 7 = PING, 8..9
# reserved for future use.
MAGIC = _compute_magic_id()
PING_MAGIC = _compute_account_base() + 7


PENDING_PATH = STATE_DIR / "pending-signals.json"
EXECUTED_PATH = STATE_DIR / "executed-signals.json"
ACCOUNT_PATH = STATE_DIR / "account.json"
OPEN_POS_PATH = STATE_DIR / "open-positions.json"
PAUSE_STATE_PATH = STATE_DIR / "pause-state.json"  # iter236+ pause-after-target tracking
EXECUTOR_LOG_PATH = STATE_DIR / "executor-log.jsonl"
DAILY_STATE_PATH = STATE_DIR / "daily-reset.json"
DAY_PEAK_PATH = STATE_DIR / "day-peak.json"  # R28: dailyPeakTrailingStop state
# 2026-05-18 Live-Cluster-Detector (replaces supervisor's 30-day-old gate proxy).
# Every signal Node generates lands in pending-signals.json, the executor logs
# each new arrival here with {ts_ms, asset, direction}. The gate check reads
# the configured recent window of this log to compute distinct symbols + majors.
SIGNAL_HISTORY_PATH = STATE_DIR / "signal-history.jsonl"
MAJORS_LIST = ("BTC", "ETH", "BNB", "SOL")
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
    if START_GATE_ENABLED:
        if START_GATE_MIN_BREADTH < 0:
            errs.append(f"FTMO_START_GATE_MIN_BREADTH={START_GATE_MIN_BREADTH} must be >= 0")
        if START_GATE_MIN_MAJORS < 0:
            errs.append(f"FTMO_START_GATE_MIN_MAJORS={START_GATE_MIN_MAJORS} must be >= 0")
        if TIER_S_MIN_BREADTH < 0 or TIER_S_MIN_MAJORS < 0:
            errs.append(
                f"FTMO_TIER_S thresholds ({TIER_S_MIN_BREADTH}/{TIER_S_MIN_MAJORS}) "
                "must be >= 0"
            )
        if TIER_A_MIN_BREADTH < 0 or TIER_A_MIN_MAJORS < 0:
            errs.append(
                f"FTMO_TIER_A thresholds ({TIER_A_MIN_BREADTH}/{TIER_A_MIN_MAJORS}) "
                "must be >= 0"
            )
        # 2026-05-19 KRIT-2 fix: tier-monotonie validator.
        #
        # Previous design relied on docstring-claimed hierarchy (S premium
        # > A > B) but had NO programmatic check. A user setting e.g.
        # `FTMO_TIER_S_MIN_BREADTH=2 FTMO_TIER_S_MIN_MAJORS=20` with the
        # default `TIER_A=10/3` would silently invert the hierarchy: an
        # alt-burst cluster (b=15, m=2) could fail TIER-S (m<20) but still
        # match TIER-A (b>=10, m>=3 — wait, m=2 < 3 too), but a cluster
        # (b=15, m=5) matches both — and S's lower-breadth threshold means
        # a noisier (lower-breadth) cluster qualifies as "premium" S over
        # the stricter A. A naive `SUM(S) >= SUM(A)` check would miss
        # axis-specific inversions: e.g. S=(2, 20) sums to 22 and A=(20, 3)
        # sums to 23, looking similar even though S is dramatically weaker
        # on breadth. Enforce per-axis monotonie instead.
        if TIER_S_MIN_BREADTH < TIER_A_MIN_BREADTH:
            errs.append(
                f"FTMO_TIER_S_MIN_BREADTH={TIER_S_MIN_BREADTH} must be >= "
                f"FTMO_TIER_A_MIN_BREADTH={TIER_A_MIN_BREADTH} "
                "(S is premium → must be at least as tight as A on breadth)"
            )
        if TIER_S_MIN_MAJORS < TIER_A_MIN_MAJORS:
            errs.append(
                f"FTMO_TIER_S_MIN_MAJORS={TIER_S_MIN_MAJORS} must be >= "
                f"FTMO_TIER_A_MIN_MAJORS={TIER_A_MIN_MAJORS} "
                "(S is premium → must be at least as tight as A on majors)"
            )
        if TIER_S_RISK_MULT <= 0 or TIER_S_RISK_MULT > 3.0:
            errs.append(f"FTMO_TIER_S_RISK_MULT={TIER_S_RISK_MULT} out of (0, 3]")
        if TIER_A_RISK_MULT <= 0 or TIER_A_RISK_MULT > 3.0:
            errs.append(f"FTMO_TIER_A_RISK_MULT={TIER_A_RISK_MULT} out of (0, 3]")
        if not 0 < START_GATE_WINDOW_HOURS <= 72:
            errs.append(
                f"FTMO_START_GATE_WINDOW_HOURS={START_GATE_WINDOW_HOURS} out of (0, 72]"
            )
        if not 0 <= START_GATE_MIN_HISTORY_HOURS <= START_GATE_WINDOW_HOURS:
            errs.append(
                "FTMO_START_GATE_MIN_HISTORY_HOURS="
                f"{START_GATE_MIN_HISTORY_HOURS} out of [0, {START_GATE_WINDOW_HOURS}]"
            )
        if START_GATE_MAX_AGE_MIN <= 0:
            errs.append(f"FTMO_START_GATE_MAX_AGE_MIN={START_GATE_MAX_AGE_MIN} must be > 0")
    if CLUSTER_ONLY_ENABLED and not 0 <= CLUSTER_ONLY_MIN_HISTORY_HOURS <= START_GATE_WINDOW_HOURS:
        errs.append(
            "FTMO_CLUSTER_ONLY_MIN_HISTORY_HOURS="
            f"{CLUSTER_ONLY_MIN_HISTORY_HOURS} out of [0, {START_GATE_WINDOW_HOURS}]"
        )
    if errs:
        msg = "Invalid config — refusing to start:\n" + "\n".join("  - " + e for e in errs)
        print(f"[executor] FATAL: {msg}", file=sys.stderr)
        sys.exit(1)


_validate_config()


# =============================================================================
# IO helpers
# =============================================================================
def _rotate_jsonl_if_needed(path: Path, max_mb: int = 50, keep: int = 14) -> None:
    """Rotate at max_mb; keep last `keep` daily archives.
    R67-r10: prevent unbounded archive accumulation.

    2026-05-15 Codex-Audit Wave-2 Bug 10 (NIEDRIG/MITTEL): rotation suffix
    used `%Y%m%d` only. A second rotation within the same UTC day
    silently overwrote the earlier archive (`mv -f` semantics via
    `Path.rename`) — log evidence for an early-morning incident vanished
    when a noisy afternoon triggered a second rotation. Now we use
    `%Y%m%dT%H%M%S` (ISO compact) so each rotation gets a unique archive
    even at sub-second cadence (combined with a counter fallback for the
    same-second edge case).
    """
    try:
        if path.exists() and path.stat().st_size > max_mb * 1024 * 1024:
            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
            archive = path.with_suffix(f".{ts}.jsonl")
            # Same-second collision guard: append a counter if the chosen
            # archive name is already taken (e.g. two parallel processes
            # rotating within the same wall-clock second).
            if archive.exists():
                for n in range(1, 1000):
                    candidate = path.with_suffix(f".{ts}-{n:03d}.jsonl")
                    if not candidate.exists():
                        archive = candidate
                        break
            path.rename(archive)
        # Reap old archives (regardless of whether we just rotated).
        # Glob covers both the legacy `YYYYMMDD` and the new `YYYYMMDDT...`
        # suffixes — `[0-9]{8}` is a strict prefix of both forms.
        stem = path.stem
        suffix = path.suffix
        archives = sorted(
            path.parent.glob(f"{stem}.[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*{suffix}"),
            key=lambda p: p.name,
            reverse=True,
        )
        for old in archives[keep:]:
            try:
                old.unlink(missing_ok=True)
            except Exception:
                pass
    except Exception:
        pass


def log_event(event: str, level: str = "info", **kwargs: Any) -> None:
    """BUGFIX 2026-04-28 (Round 30): added severity level. Default 'info' for
    backwards compat; pass level='warn' or 'error' for parseable filtering.

    Round 7 audit fix (2026-05-04, KRITISCH): rotation+append wrapped under
    `_file_lock(executor-log.lock)` so concurrent appenders never straddle a
    rename (mirrors TS-side `appendAndRotate` in scripts/ftmoLiveService.ts).
    Three issues this resolves:
      1. Rotation-Append-Race: rotator could rename mid-write, sending a line
         to the rotated archive while the next caller wrote to the new inode.
      2. No fsync: kernel buffers could lose the most recent log lines on a
         VPS power-loss, masking the *cause* of the crash.
      3. Multi-account same FTMO_TF: two executors with the same TF but
         different account IDs would otherwise interleave bytes — JSONL
         parsers reject the result.
    """
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "event": event,
        **kwargs,
    }
    # 2026-05-20 bug-find round: default=str so a non-JSON-serializable kwarg
    # (raw exception, Decimal, datetime, MT5 named-tuple) can never raise inside
    # the trade loop's logging path — logging must never crash trading.
    line = json.dumps(entry, default=str) + "\n"
    lock_path = STATE_DIR / "executor-log.lock"
    with _file_lock(lock_path, timeout_sec=2.0, stale_sec=2.0):
        _rotate_jsonl_if_needed(EXECUTOR_LOG_PATH)
        with open(EXECUTOR_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass  # best-effort on filesystems that don't support fsync
    # 2026-05-15 (Audit-Round-6 / Agent #10 WARNUNG): kwargs is dumped to
    # stdout for live-tail convenience, but multiple call-sites pass
    # sensitive fields (e.g. `mt5_connected` includes `login`, `balance`,
    # `equity`, `server`). The JSONL file is the authoritative sink with
    # file-locked + fsync'd writes; the stdout mirror previously echoed
    # the full kwargs into PM2 / systemd logs that may be piped to less
    # protected aggregators. Now stdout shows only `event` and `level`,
    # plus an explicit allow-list of non-sensitive fields. To debug, tail
    # the JSONL file directly.
    _SAFE_LOG_KEYS = {"event", "level", "ts", "ok", "n", "reason", "phase"}
    _safe_view = {k: v for k, v in kwargs.items() if k in _SAFE_LOG_KEYS}
    if _safe_view:
        print(f"[executor] [{level}] {event}: {_safe_view}")
    else:
        print(f"[executor] [{level}] {event}")


def read_json(path: Path, fallback: Any) -> Any:
    """Read a JSON state file, returning `fallback` if missing or corrupt.

    Round 7 audit fix (2026-05-04, WARNING): on `JSONDecodeError`, rename the
    corrupt file to `path.corrupt.<unix-ts>` and fire a Telegram alert. Prior
    behavior silently returned `fallback`, which could mask high-stakes state
    like `pause-state.json` (target_hit=True) — a corrupt file would let the
    bot resume trading after a passed challenge.
    """
    try:
        if not path.exists():
            return fallback
        with open(path) as f:
            data = json.load(f)
        # 2026-05-23 Wave1 audit fix (HIGH): schema version mismatch warning.
        # Bumping PYTHON_STATE_SCHEMA flags pre-bump state files; reader
        # currently warns + returns the data so manual migration can run.
        # In future bumps with breaking changes, add a migrate-or-fail path here.
        if isinstance(data, dict):
            sv = data.get("_schema_version")
            if sv is not None and sv != PYTHON_STATE_SCHEMA:
                print(
                    f"[executor] WARN: {path.name} schema_version={sv} != "
                    f"current {PYTHON_STATE_SCHEMA} — may need migration"
                )
        return data
    except json.JSONDecodeError as e:
        ts = int(time.time())
        corrupt_path = path.with_suffix(path.suffix + f".corrupt.{ts}")
        try:
            path.rename(corrupt_path)
            preserved = str(corrupt_path)
        except OSError:
            preserved = "(rename-failed)"
        # R67-r10: reap quarantine files older than 30 days
        try:
            cutoff = time.time() - 30 * 86400
            for old in path.parent.glob(f"{path.name}.corrupt.*"):
                try:
                    ts_str = old.suffix.lstrip(".")
                    if ts_str.isdigit() and int(ts_str) < cutoff:
                        old.unlink(missing_ok=True)
                except Exception:
                    pass
        except Exception:
            pass
        msg = f"corrupt JSON at {path.name}: {e}; preserved as {preserved}"
        print(f"[executor] {msg}")
        try:
            tg_send(f"<b>State corruption</b>\n{html_escape(msg)}")
        except Exception:
            pass  # don't let Telegram failure mask the corruption
        return fallback
    except Exception as e:
        print(f"[executor] failed to read {path}: {e}")
        return fallback


# 2026-05-23 Wave1 audit fix (HIGH): Python state file schema versioning.
# Previous state writes had no schema_version → silent stale-load risk on any
# field rename (cdUntilBarIdx→cdUntilBarsSeen incident class). Bump
# PYTHON_STATE_SCHEMA whenever a Python state file's structure changes; readers
# can compare and migrate. Top-level dict payloads get the field auto-injected.
PYTHON_STATE_SCHEMA = 1


def write_json(path: Path, obj: Any) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    # Auto-inject/overwrite schema_version on top-level dict payloads.
    # Lists / atomic values pass through unchanged.
    # 2026-05-23 Wave2 fix: ALWAYS overwrite (was: only-if-missing). Sticky
    # old-version key would survive PYTHON_STATE_SCHEMA bumps and defeat the
    # warning loop / future migrations on round-tripped state.
    if isinstance(obj, dict):
        obj = {**obj, "_schema_version": PYTHON_STATE_SCHEMA}
    # BUGFIX 2026-04-28: PID-suffixed tmp prevents cross-process race
    # (Node telegramBot and Python both write bot-controls.json).
    # Round 60 audit fix (2026-05-05): add f.flush() + os.fsync() to mirror
    # the TS-side saveState durability guarantee. Prior version was at risk
    # of post-crash partial-revert: tmp.replace() promoted a not-yet-flushed
    # tmpfile, leaving account.json with stale content if the VPS lost power
    # before kernel buffers reached disk.
    # Round 7 audit fix (2026-05-04, KRITISCH): also fsync the parent
    # directory so the `tmp.replace(path)` rename itself is durable. Without
    # this, on power-loss after the file fsync but before the dir-entry hits
    # disk, the rename can be lost — `path` then points to the OLD inode,
    # leaving an orphaned-but-fsynced tmpfile next to the stale state file.
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    # 2026-05-13 Codex Round 7 #B14 FIX: try/finally so .tmp.<pid> doesn't
    # orphan when json.dump or tmp.replace raise (ENOSPC, EPERM on Windows
    # after AV-scan locks, EXDEV across mounts). Without cleanup, repeated
    # write failures fill the state-dir with orphan tmpfiles and an
    # operator can't tell which is canonical.
    renamed = False
    try:
        with open(tmp, "w") as f:
            # allow_nan=False: reject NaN/Inf which would produce invalid
            # JSON readable by Python but rejected by JS/Rust consumers.
            # Forces upstream code to clean numerics before serialising.
            json.dump(obj, f, indent=2, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        tmp.replace(path)
        renamed = True
    finally:
        if not renamed:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
    # POSIX: fsync the parent dir so the rename is durable. Best-effort on
    # Windows / unsupported FS (os.open of a directory raises there).
    try:
        dirfd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    except (OSError, AttributeError):
        pass  # Windows or unsupported FS — best-effort


def _start_gate_state_path() -> Path:
    """Per-account marker path. Each bot tracks its own challenge-start
    independently so multi-account setups (3-stack) don't bleed start-state
    across accounts — bot A starting must NOT cause bot B+C to skip waiting
    for their own qualifying setup.

    2026-05-18 Bug-Audit (KRIT): contract verified — gate-file is shared
    (single source of qualified-truth) but each bot independently decides
    when IT has started (via positions OR marker). Memory's "3-stack 64%"
    Funded-Probability already assumes correlated start-windows; per-account
    marker preserves that semantic.
    """
    return STATE_DIR / "start-gate-state.json"


def _log_signals_to_history(signals: list) -> None:
    """Append each new signal to signal-history.jsonl with timestamp.

    2026-05-18 LIVE-CLUSTER-DETECTOR: Node generates signals via the same
    engine logic as the backtest. By logging each here as it arrives, we
    build a real-time signal-firing log that's IDENTICAL in semantics to
    the backtest's `state.closed_trades` cluster count. The gate check
    reads back the configured recent window to compute live cluster status.

    Idempotent: each call appends ALL signals passed in. Caller should only
    pass NEW signals (not yet logged). We dedupe by (signalBarClose, asset).
    """
    if not signals:
        return
    try:
        # 2026-05-23 Wave1 audit fix (HIGH): wrap dedup-read + rotate + append
        # in signal-history.lock so tracker + executor + cluster-reader don't
        # race. Without this lock: tracker and executor both compute the same
        # dedup-set, both append → duplicate entries → compute_live_cluster()
        # over-counts → false-positive cluster-green. Rotation is also non-
        # atomic vs concurrent O_APPEND fds → writes can land in archived
        # inode and be lost. Using context-manager keeps indentation flat.
        with _file_lock(STATE_DIR / "signal-history.lock"):
            _log_signals_to_history_locked(signals)
        return
    except Exception as e:
        log_event("signal_history_log_failed", error=str(e))
        return


def _log_signals_to_history_locked(signals: list) -> None:
    """Internal: caller MUST hold signal-history.lock."""
    if not signals:
        return
    try:
        # 2026-05-19 HOCH-2 fix: dedup window must be TIME-based, not a fixed
        # tail of 200 lines. Previous `splitlines()[-200:]` was unsafe in two
        # ways:
        #   (a) a single burst of >200 fresh signals overwrites the dedup
        #       buffer with its own tail, allowing same-bar signals from the
        #       same burst to slip through.
        #   (b) on bot restart reading days-old data, the most-recent 200
        #       lines might predate the current evaluation window entirely,
        #       so any signal whose `(signalBarClose, asset)` matched an
        #       entry just OUTSIDE that 200-line slice would be re-logged.
        # New rule: dedup against every entry written within `2 ×
        # START_GATE_WINDOW_HOURS` (covers the full evaluation window plus a
        # safety overlap so just-rotated signals can't be replayed). This
        # cost is bounded — signal-history.jsonl rotates at 10MB (HOCH-1)
        # and the rolling read is already done by compute_live_cluster.
        now_ms = int(time.time() * 1000)
        dedup_window_ms = int(2 * START_GATE_WINDOW_HOURS * 3600 * 1000)
        dedup_cutoff_ms = now_ms - dedup_window_ms
        existing_keys: set = set()
        if SIGNAL_HISTORY_PATH.exists():
            try:
                for line in SIGNAL_HISTORY_PATH.read_text().splitlines():
                    if not line.strip():
                        continue
                    try:
                        r = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    # Skip entries older than the dedup window — they're
                    # safely outside any possible re-emit horizon (and any
                    # genuine collision against them is already prevented
                    # by Node, since signals only re-fire on a NEW bar).
                    ts = r.get("ts_ms")
                    if isinstance(ts, (int, float)) and ts < dedup_cutoff_ms:
                        continue
                    existing_keys.add((r.get("signalBarClose"), r.get("asset")))
            except OSError:
                pass

        new_entries: list = []
        for s in signals:
            key = (s.get("signalBarClose"), s.get("assetSymbol"))
            if key in existing_keys:
                continue
            # 2026-05-23 ML audit Round 11.2: normalize direction at write so
            # downstream signal-history readers (cluster-gate, parity-check)
            # never see "LONG"/"Long" case-drift from upstream emitters.
            new_entries.append({
                "ts_ms": now_ms,
                "asset": s.get("assetSymbol"),
                "signalBarClose": s.get("signalBarClose"),
                "direction": normalize_direction(s.get("direction")),
                "sourceSymbol": s.get("sourceSymbol"),
            })
            existing_keys.add(key)

        if not new_entries:
            return
        SIGNAL_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        # 2026-05-19 HOCH-1 fix: rotate signal-history.jsonl when it grows
        # past 10MB; keep last 7 daily archives. Without rotation the file
        # grows unbounded over a long live-deploy (every Node-emitted
        # signal appends), eventually slowing the per-poll
        # `compute_live_cluster()` read-loop and exhausting disk on long
        # runs. Mirrors the equity-history rotation pattern (R67-r9).
        _rotate_jsonl_if_needed(SIGNAL_HISTORY_PATH, max_mb=10, keep=7)
        # 2026-05-18 Bug-Audit Round-3 lesson: explicit O_APPEND for atomicity.
        fd = os.open(str(SIGNAL_HISTORY_PATH),
                     os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            for entry in new_entries:
                os.write(fd, (json.dumps(entry) + "\n").encode("utf-8"))
        finally:
            os.close(fd)
    except Exception as e:
        log_event("signal_history_log_failed", error=str(e))


def compute_live_cluster() -> dict:
    """Read signal-history.jsonl, count distinct symbols + majors in the gate window.

    Returns a dict with:
      - breadth: int (distinct symbols)
      - majors: int (distinct majors among BTC/ETH/BNB/SOL)
      - qualified: bool (breadth >= MIN_BREADTH AND majors >= MIN_MAJORS)
      - ts_ms: current evaluation timestamp
      - history_count: total entries in the gate window
      - oldest_log_ms: ts_ms of oldest entry in the gate window (or None)

    This is the LIVE-AUTHORITATIVE cluster status. Identical semantic to
    backtest's `qualified_at_start` but measured on real live signals.
    """
    now_ms = int(time.time() * 1000)
    cutoff_ms = now_ms - int(START_GATE_WINDOW_HOURS * 3600 * 1000)
    symbols: set = set()
    majors: set = set()
    count = 0
    oldest: Optional[int] = None
    if SIGNAL_HISTORY_PATH.exists():
        try:
            # 2026-05-23 Wave2 fix: take the signal-history lock for the read.
            # Writers hold this lock (see _log_signals_to_history at L822). A
            # bare read here can observe a half-flushed appended line → JSON
            # parse error or partial record + missed gate. Cluster gate is
            # safety-critical (decides whether to send orders) — must be
            # consistent with what writers atomically committed.
            with _file_lock(STATE_DIR / "signal-history.lock"):
                lines = SIGNAL_HISTORY_PATH.read_text().splitlines()
            for line in lines:
                if not line.strip():
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = r.get("ts_ms")
                if not isinstance(ts, (int, float)):
                    continue
                if ts < cutoff_ms:
                    continue
                asset = r.get("asset")
                if not isinstance(asset, str):
                    continue
                # 2026-05-20 bug-find round fix (#2a): mirror the backtest's
                # `cluster_symbol_key` exactly. Breadth must count distinct FULL
                # strategy-labels — `ETH-MR` and `ETH-TREND` are 2 symbols, NOT
                # 1. The old `split("-")[0]` collapsed every ETH-variant to a
                # single `ETH`, systematically UNDER-counting breadth vs the
                # backtest → live gate qualified far less often. Fold only
                # `-PYRAMID`→`-TREND` (backtest parity); strip `USDT` only for
                # raw no-dash exchange symbols.
                key = asset.upper()
                if key.endswith("-PYRAMID"):
                    key = key[: -len("-PYRAMID")] + "-TREND"
                if "-" not in key and key.endswith("USDT"):
                    key = key[:-4]
                symbols.add(key)
                # Majors: prefix match (key == major OR key starts "major-").
                for mj in MAJORS_LIST:
                    if key == mj or key.startswith(mj + "-"):
                        majors.add(mj)
                        break
                count += 1
                ts_i = int(ts)
                oldest = ts_i if oldest is None else min(oldest, ts_i)
        except OSError:
            pass
    b, m = len(symbols), len(majors)
    # 2026-05-19 Multi-tier cluster classification. Tier names are surfaced
    # for logging + optional per-tier risk multiplier. `qualified` is True
    # when ANY tier matches (S > A > default = B); empty string means no
    # qualifying cluster.
    if b >= TIER_S_MIN_BREADTH and m >= TIER_S_MIN_MAJORS:
        tier = "S"
        risk_mult = TIER_S_RISK_MULT
    elif b >= TIER_A_MIN_BREADTH and m >= TIER_A_MIN_MAJORS:
        tier = "A"
        risk_mult = TIER_A_RISK_MULT
    elif b >= START_GATE_MIN_BREADTH and m >= START_GATE_MIN_MAJORS:
        tier = "B"
        risk_mult = 1.0
    else:
        tier = ""
        risk_mult = 0.0
    qualified = tier != ""
    return {
        "ts_ms": now_ms,
        "breadth": b,
        "majors": m,
        "qualified": qualified,
        "tier": tier,
        "risk_mult": risk_mult,
        "history_count": count,
        "oldest_log_ms": oldest,
        "window_hours": START_GATE_WINDOW_HOURS,
        "symbols": sorted(symbols),
        "majors_seen": sorted(majors),
    }


def _gate_timestamp_age_min(gate: dict) -> Optional[float]:
    ts = gate.get("ts")
    if isinstance(ts, (int, float)) and ts > 0:
        return (time.time() * 1000 - float(ts)) / 60000
    ts_iso = gate.get("ts_iso")
    if isinstance(ts_iso, str) and ts_iso:
        try:
            parsed = datetime.fromisoformat(ts_iso.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return (datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds() / 60
        except ValueError:
            return None
    return None


def _challenge_started_from_state(open_positions: Optional[dict] = None) -> bool:
    """Returns True iff the challenge has already produced its first trade.

    2026-05-18 Bug-Audit (MITTEL): Be strict about `state.get("started")` —
    only treat it as started if it's literally True (not e.g. the string
    "true" or 1; we wrote it as bool, anything else means file corrupt
    and we should NOT silently auto-start).
    """
    state = read_json(_start_gate_state_path(), {})
    if state.get("started") is True:
        return True
    if open_positions and open_positions.get("positions"):
        return True
    return False


def check_start_gate_block(open_positions: Optional[dict] = None) -> Optional[str]:
    """Return a block reason while a fresh challenge is waiting for start gate.

    2026-05-18 LIVE-CLUSTER-DETECTOR: signal-history-based gate replaces the
    supervisor's 30-day-old window proxy. Logic:
      1. If challenge already started (marker or open positions) → no block.
      2. Compute live cluster from signal-history.jsonl (configured window).
      3. Need optional warm-up, breadth >= MIN, majors >= MIN.
      4. Otherwise: block with reason describing what's missing.

    This is intentionally a start-only gate. After first fill the marker
    persists qualifying status — no need to re-check.

    Fallback: if signal-history is missing/empty (bot just started), we
    still consult the legacy supervisor gate file (START_GATE_PATH) so
    operators with the old supervisor still get some signal.
    """
    if not START_GATE_ENABLED:
        return None
    if _challenge_started_from_state(open_positions):
        return None

    # Primary: live cluster from signal-history.
    live = compute_live_cluster()
    if live["history_count"] == 0:
        # No signal history yet — fallback to legacy supervisor gate.
        if not START_GATE_PATH.exists():
            return "start_gate_warmup: no signal-history yet, supervisor gate also missing"
    else:
        # Optional warm-up. Fast-cluster mode sets this to 0 because the
        # signal-count condition itself is the early confirmation.
        oldest = live.get("oldest_log_ms")
        if oldest is not None:
            age_h = (live["ts_ms"] - oldest) / 3_600_000
            if age_h < START_GATE_MIN_HISTORY_HOURS:
                return (
                    f"start_gate_warmup: signal-history only {age_h:.1f}h old "
                    f"(need >={START_GATE_MIN_HISTORY_HOURS:.1f}h)"
                )
        if live["qualified"]:
            return None  # green via live cluster
        return (
            "start_gate_red_live: "
            f"breadth={live['breadth']}/{START_GATE_MIN_BREADTH} "
            f"majors={live['majors']}/{START_GATE_MIN_MAJORS} "
            f"(live last {START_GATE_WINDOW_HOURS:g}h, {live['history_count']} signals)"
        )

    # === Legacy supervisor fallback (only when signal-history is empty) ===
    gate = read_json(START_GATE_PATH, {})
    # 2026-05-18 Bug-Audit Round-3 (MITTEL): warn ONCE if operator's env-vars
    # disagree with the engine's thresholds embedded in the gate file. Bot
    # uses engine's `qualified` flag (single source of truth), so env-vars
    # don't actually change behavior — but operator might think they do.
    global _START_GATE_ENV_WARNED
    if not _START_GATE_ENV_WARNED:
        gate_min_breadth = gate.get("min_breadth")
        gate_min_majors = gate.get("min_majors")
        if (gate_min_breadth is not None and gate_min_breadth != START_GATE_MIN_BREADTH) or (
            gate_min_majors is not None and gate_min_majors != START_GATE_MIN_MAJORS
        ):
            log_event(
                "start_gate_env_mismatch",
                env_breadth=START_GATE_MIN_BREADTH,
                env_majors=START_GATE_MIN_MAJORS,
                gate_breadth=gate_min_breadth,
                gate_majors=gate_min_majors,
                note="bot uses gate.qualified flag — env vars are informational only",
            )
        _START_GATE_ENV_WARNED = True
    age_min = _gate_timestamp_age_min(gate)
    if age_min is None:
        return "start_gate_stale: missing/invalid timestamp"
    # 2026-05-18 Bug-Audit (MITTEL): clock-skew handled symmetrically. NTP-jitter
    # >1min should block — moderate skew used to silently pass because
    # `age_min < -5` was too lax, letting stale files with mild future-ts through.
    if age_min < -1:
        return f"start_gate_invalid_clock: gate timestamp {abs(age_min):.1f}min in future (NTP-skew?)"
    if abs(age_min) > START_GATE_MAX_AGE_MIN:
        return f"start_gate_stale: |age|={abs(age_min):.1f}min > {START_GATE_MAX_AGE_MIN:.1f}min"

    # 2026-05-18 Bug-Audit (KRITISCH): JSON might have qualified as string
    # "false"/"true" instead of bool — `bool("false") == True` would let the
    # bot trade at red gate. Strictly require `is True`. Also coerce numeric
    # fields defensively (string "4" → 4, None → 0, float → int).
    def _to_int(v: Any, default: int = 0) -> int:
        try:
            if v is None or v == "":
                return default
            return int(float(v))
        except (TypeError, ValueError):
            return default

    # 2026-05-18 Bug-Audit (HOCH): single source of truth = engine's
    # `qualified` flag from the gate file. Engine already applied its
    # thresholds; the bot does NOT double-check with its own min values
    # (that caused the threshold-triple drift: env vs supervisor-hardcoded
    # vs engine could disagree). We only validate that the file actually
    # came from the engine by requiring the breadth/majors fields exist.
    breadth = _to_int(gate.get("breadth"))
    majors = _to_int(gate.get("majors"))
    qualified = gate.get("qualified") is True
    if not qualified:
        return (
            "start_gate_red: "
            f"qualified=False breadth={breadth} majors={majors}"
        )
    # 2026-05-18 Bug-Audit Round-3 (MITTEL): defense-in-depth — if engine
    # writes qualified=true but breadth/majors=0 (engine bug, uninit bool),
    # refuse to trade. Memory documents 6× champion-debunk-cases from
    # engine bugs; this is a cheap sanity-check that closes a future bug
    # class without re-introducing threshold-drift.
    if breadth <= 0 or majors <= 0:
        return (
            "start_gate_sanity_fail: qualified=True but "
            f"breadth={breadth} majors={majors} (engine inconsistency)"
        )
    return None


def check_cluster_entry_block() -> Optional[str]:
    """Return a block reason when cluster-only mode should skip new entries.

    Unlike `check_start_gate_block`, this is NOT cleared by
    `start-gate-state.json`. It is evaluated before every new pending-signal
    batch so the bot can keep managing open trades while refusing to add fresh
    risk during red cluster regimes.
    """
    if not CLUSTER_ONLY_ENABLED:
        return None

    live = compute_live_cluster()
    if live["history_count"] == 0:
        return "cluster_only_warmup: no signal-history yet"

    oldest = live.get("oldest_log_ms")
    if oldest is not None:
        age_h = (live["ts_ms"] - oldest) / 3_600_000
        if age_h < CLUSTER_ONLY_MIN_HISTORY_HOURS:
            return (
                f"cluster_only_warmup: signal-history only {age_h:.1f}h old "
                f"(need >={CLUSTER_ONLY_MIN_HISTORY_HOURS:.1f}h)"
            )

    if live["qualified"]:
        return None
    return (
        "cluster_only_red_live: "
        f"breadth={live['breadth']}/{START_GATE_MIN_BREADTH} "
        f"majors={live['majors']}/{START_GATE_MIN_MAJORS} "
        f"tier={live.get('tier', '') or '-'} "
        f"(live last {START_GATE_WINDOW_HOURS:g}h, {live['history_count']} signals)"
    )


def mark_start_gate_started(first_signal: dict, ticket: int) -> None:
    """Idempotent marker write.

    2026-05-18 Bug-Audit (HOCH): use O_CREAT|O_EXCL for the first write so
    concurrent workers don't both clobber first_ticket/first_asset fields.
    The read-then-write pattern was a TOCTOU race.
    """
    if not START_GATE_ENABLED:
        return
    path = _start_gate_state_path()
    # 2026-05-18 Bug-Audit (NIEDRIG): warn but accept ticket=0/None — the
    # state of "started" is more important than the diagnostic field.
    safe_ticket: Optional[int] = ticket if ticket and ticket > 0 else None
    marker = {
        "started": True,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "first_ticket": safe_ticket,
        "first_asset": first_signal.get("assetSymbol"),
        "first_source_symbol": first_signal.get("sourceSymbol"),
        "gate_path": str(START_GATE_PATH),
        "min_breadth": START_GATE_MIN_BREADTH,
        "min_majors": START_GATE_MIN_MAJORS,
    }
    # Atomic CAS via O_CREAT|O_EXCL — fails if file already exists, which
    # means another worker already marked the start.
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # 2026-05-18 Bug-Audit Round-3 (MITTEL): 0o600 not 0o644. Marker
        # contains first_ticket + account-mapping data — shared VPS users
        # should not be able to read it.
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, json.dumps(marker, indent=2).encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        # 2026-05-18 Bug-Audit (MITTEL): also fsync parent dir so the new
        # marker entry is durable across power-loss between create and the
        # next FS commit. Best-effort on Windows / unsupported FS.
        try:
            dirfd = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
        except (OSError, AttributeError):
            pass
        log_event(
            "start_gate_activated",
            ticket=safe_ticket,
            asset=first_signal.get("assetSymbol"),
            gate_path=str(START_GATE_PATH),
        )
    except FileExistsError:
        # Another worker already wrote it — that's fine, it's idempotent.
        pass
    except OSError as e:
        log_event(
            "start_gate_marker_write_failed",
            error=str(e),
            ticket=safe_ticket,
        )


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
#
# Phase 34 (Code-Quality Audit refactor): the lock impl was lifted into
# tools/process_lock.py and is mirrored by src/utils/processLock.ts. The
# `_file_lock` name is kept as a thin alias so existing call-sites work.
from process_lock import file_lock as _file_lock  # type: ignore  # noqa: F401


def update_controls(updater) -> dict:
    """Atomic read-modify-write on bot-controls.json under cross-process lock.
    `updater` receives a dict and mutates it in-place (or returns a new dict).
    Returns the post-update dict.

    Phase 49 (R45-1): explicit `stale_sec=2.0` (was relying on the default
    which Phase 38 raised from 0 → 30). At 30s, a TS-side bot crash while
    holding the lock would freeze update_controls for half a minute per
    call — Telegram /pause / /kill UI looked dead. 2s matches the
    pre-Phase-38 behavior tuned for this resource.
    """
    lock_path = STATE_DIR / "bot-controls.lock"
    # 2026-05-23 Wave2 fix (B5 MED — lock-timeout asymmetry): bump Python
    # timeout 2s → 5s and stale 2s → 5s to match TS (`telegramBot.ts:704-708`
    # uses timeoutMs:5000, staleMs:5000). The asymmetric 2s window let
    # Python's stale-recovery unlink a TS-side lock that was legitimately
    # held >2s during a Telegram 429 retry inside setControls. Lost /pause
    # or /kill flags would result. Aligning both sides eliminates the race.
    with _file_lock(lock_path, timeout_sec=5.0, stale_sec=5.0):
        controls = read_json(CONTROLS_PATH, {})
        result = updater(controls)
        if isinstance(result, dict):
            controls = result
        write_json(CONTROLS_PATH, controls)
        return controls


# =============================================================================
# MT5 connection — with reconnect
# =============================================================================
# R67 audit: cache expected_login as int so the steady-state warm path
# (mt5_ensure_connected, called every poll cycle ~30s) can verify the MT5
# terminal hasn't silently switched accounts mid-session — broker session
# restart, manual user re-login, Windows fast-user-switch can route Account-A
# signals onto Account-B funds while the TCP socket stays alive.
_EXPECTED_LOGIN_INT: Optional[int] = None


def mt5_init_with_retry() -> bool:
    """Try to initialize. On success returns True. Caller handles retry.

    Honors MT5_PATH env var so multiple parallel MT5 installations can be
    targeted (e.g. one terminal per FTMO account on the same VPS).

    Round 57 multi-account safety (2026-05-03):
    On a multi-terminal VPS the executor could attach to the wrong MT5
    process (`mt5.initialize()` defaults to "any running terminal"). When
    `FTMO_EXPECTED_LOGIN` is set we cross-check `account_info().login`
    after attach and refuse to trade on a mismatched account — better to
    crash than to silently route Account A's signals onto Account B's funds.
    """
    mt5_path = os.environ.get("MT5_PATH", "").strip()
    ok = mt5.initialize(path=mt5_path) if mt5_path else mt5.initialize()  # type: ignore[call-arg]
    if ok:
        info = mt5.account_info()
        if info is not None:
            # Round 57: verify we attached to the expected FTMO account.
            expected_raw = os.environ.get("FTMO_EXPECTED_LOGIN", "").strip()
            if expected_raw:
                try:
                    expected = int(expected_raw)
                except ValueError:
                    log_event(
                        "mt5_expected_login_invalid",
                        value=expected_raw,
                        level="error",
                    )
                    tg_send(
                        f"🔴 <b>FTMO_EXPECTED_LOGIN invalid</b>\nValue: <code>{html_escape(expected_raw)}</code>\nMust be an integer login id. Refusing to trade."
                    )
                    sys.exit(2)
                if int(info.login) != expected:
                    log_event(
                        "mt5_wrong_account",
                        got=int(info.login),
                        want=expected,
                        server=getattr(info, "server", "?"),
                        path=mt5_path or "default",
                        level="error",
                    )
                    tg_send(
                        f"🔴 <b>MT5 wrong account!</b>\nGot login <code>{int(info.login)}</code> but FTMO_EXPECTED_LOGIN=<code>{expected}</code>.\nProcess will exit (will NOT trade on wrong account).",
        critical=True,
                    )
                    try:
                        mt5.shutdown()
                    except Exception:
                        pass
                    sys.exit(2)
                # R67 audit: cache expected login as int so the warm path
                # in mt5_ensure_connected() can re-validate every cycle
                # without re-parsing the env var.
                global _EXPECTED_LOGIN_INT
                _EXPECTED_LOGIN_INT = expected
            else:
                # No expected login configured — log a one-line warning so
                # multi-account operators see it, but don't fail.
                log_event(
                    "mt5_expected_login_unset",
                    note="no FTMO_EXPECTED_LOGIN configured — skipping account verification",
                    got=int(info.login),
                )
            # 2026-05-23 Wave2 fix (KRIT — daily-loss currency check):
            # CHALLENGE_START_BALANCE / MAX_DAILY_LOSS_PCT thresholds are
            # USD-denominated. An EUR/GBP/CHF account would silently use
            # EUR-equity against USD caps → ~10-15% mis-comparison and a
            # real-breach risk in EUR-down-vs-USD weeks. Honor an explicit
            # override via FTMO_EXPECTED_CURRENCY (FundingPips uses USD;
            # FTMO Standard 2-Step is USD by default but EUR accounts exist).
            acct_currency = (getattr(info, "currency", "") or "").upper()
            expected_currency = os.environ.get("FTMO_EXPECTED_CURRENCY", "USD").upper()
            if acct_currency and expected_currency and acct_currency != expected_currency:
                log_event(
                    "mt5_currency_mismatch",
                    expected=expected_currency,
                    got=acct_currency,
                    level="error",
                )
                tg_send(
                    f"🚨 <b>Currency mismatch</b>\n"
                    f"MT5 account is in {acct_currency} but bot expects {expected_currency}. "
                    f"All FTMO thresholds (DL/TL caps) are denominated in {expected_currency}. "
                    f"Set FTMO_EXPECTED_CURRENCY={acct_currency} only if you've verified the "
                    f"caps match your account's currency conversion."
                )
                # Hard-fail unless operator explicitly opted out via env var.
                if os.environ.get("FTMO_ALLOW_CURRENCY_MISMATCH", "").lower() not in ("1", "true", "yes"):
                    sys.exit(13)
            log_event("mt5_connected", login=info.login, server=info.server, balance=info.balance, equity=info.equity, path=mt5_path or "default", currency=acct_currency or "?")
            return True
    err = mt5.last_error() if hasattr(mt5, "last_error") else ("?", "?")
    log_event("mt5_init_failed", error=str(err), path=mt5_path or "default")
    return False


def mt5_ensure_connected() -> bool:
    """Check if MT5 is still connected. If not, try to reconnect. Blocks until success."""
    info = mt5.account_info()
    if info is not None:
        # R67 audit fix: re-validate FTMO_EXPECTED_LOGIN on every cycle.
        # mt5_init_with_retry() validates only on cold-init; the steady-state
        # path here (called every ~30s) was just `if info is not None: return`
        # → silent account-drift leaked through.
        if _EXPECTED_LOGIN_INT is not None and int(info.login) != _EXPECTED_LOGIN_INT:
            log_event(
                "mt5_account_changed_mid_session",
                got=int(info.login),
                want=_EXPECTED_LOGIN_INT,
                level="error",
            )
            tg_send(
                f"🔴 <b>MT5 account drift mid-session!</b>\nGot login <code>{int(info.login)}</code>, expected <code>{_EXPECTED_LOGIN_INT}</code>.\nExecutor exiting — will NOT trade on wrong account.",
                critical=True,
            )
            try:
                mt5.shutdown()
            except Exception:
                pass
            sys.exit(2)
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


_MT5_ACCOUNT_CACHE_TTL_S = 1.0  # short — single poll iteration fires within ms
_mt5_account_cache: tuple[float, dict] | None = None


def mt5_get_equity() -> dict:
    """Get current account equity/balance/margin/free_margin.

    2026-05-24 PERF AUDIT: mt5.account_info() is a Windows-COM RPC
    (~1-50ms per call depending on connection). Per poll iteration it's
    called by mt5_get_equity (1×), check_target_and_pause (1× via this
    fn), sync_account_state (1× direct), check_daily_dd_warning (1×) =
    3-5 RPCs × ~10ms = 30-50ms wasted per 30s poll. Small TTL cache
    (1s) coalesces the in-iteration calls without staleness risk
    (next iteration is 30s away → cache always fresh on entry).
    """
    global _mt5_account_cache
    now = time.time()
    if _mt5_account_cache is not None:
        cached_at, cached = _mt5_account_cache
        if now - cached_at < _MT5_ACCOUNT_CACHE_TTL_S:
            return cached
    info = mt5.account_info()
    if info is None:
        result = {"equity": None, "balance": None, "margin": None, "free_margin": None}
    else:
        result = {
            "equity": float(info.equity),
            "balance": float(info.balance),
            "margin": float(info.margin),
            "free_margin": float(info.margin_free),
        }
    _mt5_account_cache = (now, result)
    return result


def _invalidate_mt5_account_cache() -> None:
    """Force-refresh on the next mt5_get_equity call. Use after any
    action that may mutate equity (order placement, close, daily reset)."""
    global _mt5_account_cache
    _mt5_account_cache = None


# =============================================================================
# FTMO rules + daily reset
# =============================================================================
def check_ftmo_rules(current_equity: float, day_start_equity: float) -> Optional[str]:
    """Block-new-entries gate — runs each pending-signal cycle.

    Bug-Audit Phase 3 (Python Bug 1+2): widened buffers so we stop QUEUING
    new orders well before the actual FTMO -5% / -10% caps. Emergency-close
    of OPEN positions is handled separately in sync_account_state with a
    larger buffer (see DL_EMERGENCY_BUFFER / TL_EMERGENCY_BUFFER).

    R67-r9 audit: zero-divisor guard on day_start_equity. Without this, a
    corrupt daily-reset.json (or fresh-boot before the first daily-reset
    write) returns 0.0 → ZeroDivisionError → crashes the trade loop. Now
    we refuse to entry-check rather than crash, blocking new entries until
    next reset cycle restores valid state.
    """
    if not day_start_equity or day_start_equity <= 0:
        log_event(
            "ftmo_rules_invalid_day_start",
            day_start_equity=day_start_equity,
            level="warn",
        )
        return "invalid day_start_equity — refusing to entry-check"
    daily_pct = (current_equity - day_start_equity) / day_start_equity
    # 2026-05-13 Codex Round 4 Python #8 FIX: configurable entry-block buffer.
    # Defaults preserve existing live safety overlay (block at -4%/-8.5%),
    # but FTMO_STRICT_PARITY=1 zeroes the buffer for exact-sim parity runs
    # used in daily drift-vs-simulator validation.
    dl_block_buf = 0.0 if STRICT_PARITY else DL_ENTRY_BLOCK_BUFFER
    tl_block_buf = 0.0 if STRICT_PARITY else TL_ENTRY_BLOCK_BUFFER
    if daily_pct <= -MAX_DAILY_LOSS_PCT + dl_block_buf:
        return f"daily_loss: {daily_pct:.2%} near -{MAX_DAILY_LOSS_PCT:.0%} cap"
    total_pct = (current_equity - CHALLENGE_START_BALANCE) / CHALLENGE_START_BALANCE
    if total_pct <= -MAX_TOTAL_LOSS_PCT + tl_block_buf:
        return f"total_loss: {total_pct:.2%} near -{MAX_TOTAL_LOSS_PCT:.0%} cap"
    return None


# Bug-Audit Phase 3: emergency-close thresholds.
# DL: close all open positions when intraday drawdown reaches -2.5% to leave
#     SL slippage room before the actual -5% breach.
# TL: close all open positions at -7.5% to prevent the -10% all-time breach
#     (was completely missing — only DL had emergency close).
# 2026-05-13 Codex Round 4 Python #8 FIX: buffers configurable via env.
# Default values preserve existing live safety behavior (slippage room +
# requote tolerance). Set FTMO_STRICT_PARITY=1 to zero them for exact-sim
# drift-monitor runs — DO NOT use strict-parity for actual live trading,
# only for backtest-comparison validation.
# 2026-05-23 Wave2 fix (KRIT — daily-loss cap audit): bump DL entry-block
# buffer 1.0% → 2.0%. Previous 1.0% was SMALLER than typical 30s-poll
# crypto gap (BTC routinely gaps 1-2% in <30s). Bot could open a new
# position at -4.0% intraday and a single-bar gap past -5% would breach.
# 2.0% margin covers >95% of observed 30s gaps in the BTC/ETH basket.
DL_ENTRY_BLOCK_BUFFER = float(os.environ.get("FTMO_DL_ENTRY_BLOCK_BUFFER", "0.020"))
TL_ENTRY_BLOCK_BUFFER = float(os.environ.get("FTMO_TL_ENTRY_BLOCK_BUFFER", "0.015"))
DL_EMERGENCY_BUFFER_DEFAULT = float(os.environ.get("FTMO_DL_EMERGENCY_BUFFER", "0.025"))
TL_EMERGENCY_BUFFER_DEFAULT = float(os.environ.get("FTMO_TL_EMERGENCY_BUFFER", "0.025"))
STRICT_PARITY = os.environ.get("FTMO_STRICT_PARITY", "").lower() in ("1", "true", "yes")
DL_EMERGENCY_BUFFER = 0.0 if STRICT_PARITY else DL_EMERGENCY_BUFFER_DEFAULT
TL_EMERGENCY_BUFFER = 0.0 if STRICT_PARITY else TL_EMERGENCY_BUFFER_DEFAULT


def get_day_peak_state() -> dict:
    """
    R28: dailyPeakTrailingStop persistent state.
    Returns {date: "YYYY-MM-DD", peak_equity_usd: float, last_check_ts: iso}.
    Date is Prague timezone to align with FTMO daily-reset boundary.
    """
    return read_json(DAY_PEAK_PATH, {"date": None, "peak_equity_usd": 0.0})


def _eu_prague_fallback_tz() -> timezone:
    """DST-aware fixed-offset fallback for Europe/Prague used ONLY when
    zoneinfo/tzdata is unavailable (degraded Windows deploy).

    2026-05-21 bug-find round: the previous hard-coded ``timezone(timedelta(
    hours=1))`` (CET, +1) was wrong by a full hour for ~7 months of the year —
    EU summer time (CEST, +2) runs from the last Sunday of March 01:00 UTC to
    the last Sunday of October 01:00 UTC. A +1 offset during that window
    shifts the FTMO daily-loss / day-peak reset boundary one hour off Prague
    midnight, which can fire the reset mid-session and corrupt intraday
    tracking. This computes the correct CET/CEST offset from the EU DST rule
    so the fallback is right year-round without needing tzdata.
    """
    from datetime import timedelta as _td

    now = datetime.now(timezone.utc)
    year = now.year

    def _last_sunday_0100(month: int) -> datetime:
        d = datetime(year, month, 31, 1, 0, tzinfo=timezone.utc)
        while d.weekday() != 6:  # Mon=0 .. Sun=6
            d -= _td(days=1)
        return d

    dst_start = _last_sunday_0100(3)
    dst_end = _last_sunday_0100(10)
    offset_hours = 2 if dst_start <= now < dst_end else 1
    return timezone(_td(hours=offset_hours))


def update_day_peak(current_equity_usd: float) -> float:
    """
    R28: Update intraday peak equity. Resets at Prague midnight (matching
    FTMO daily-loss anchor). Returns the current day-peak.

    Mirrors engine line 5045-5048: dayPeak ratchets only upward within a day.
    """
    try:
        # 2026-05-15 (Audit-Round-6 / Agent #1 KRIT): on Windows-without-tzdata
        # the ZoneInfo lookup raises `zoneinfo.ZoneInfoNotFoundError` (subclass
        # of KeyError, NOT ImportError) → previous handler missed it and the
        # bot crashed on the first tick. `tzdata` is now in requirements.txt,
        # but the exception clause catches KeyError belt-and-suspenders
        # (ZoneInfoNotFoundError inherits from KeyError → safe even when the
        # import itself failed and the name is unbound).
        from zoneinfo import ZoneInfo  # type: ignore
        prague_tz = ZoneInfo("Europe/Prague")
    except (ImportError, KeyError):
        prague_tz = _eu_prague_fallback_tz()
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


# Regime-Gate (Round 52): pre-filter entries based on BTC market regime.
# Backtest analysis (5.55y / 136 windows / R28_V4 / V4 Live Engine) found:
#   trend-up:    69.23% pass-rate (13 windows)
#   chop:        54.10% pass-rate (61 windows)
#   high-vol:    47.83% pass-rate (46 windows)
#   trend-down:  31.25% pass-rate (16 windows)  ← BLOCK BY DEFAULT
#
# Skipping `trend-down` regimes alone lifts pass-rate from 50.74% → 53.33%
# (+2.6pp). Skipping `trend-down + high-vol` → 56.76% (+6pp) but blocks
# 45% of windows (long wait between challenges).
#
# Default block-list = {trend-down}. Configurable via env:
#   REGIME_GATE_ENABLED=true
#   REGIME_GATE_BLOCK="trend-down,high-vol"
#   REGIME_GATE_BTC_SYMBOL="BTCUSD" (broker-resolved automatically if unset)
REGIME_GATE_ENABLED = os.getenv("REGIME_GATE_ENABLED", "false").lower() == "true"
REGIME_GATE_BLOCK = set(
    s.strip()
    for s in os.getenv("REGIME_GATE_BLOCK", "trend-down").split(",")
    if s.strip()
)
REGIME_GATE_BTC_SYMBOL = os.getenv("REGIME_GATE_BTC_SYMBOL", "")
# Cache regime classification — recompute at most every 30 min so we don't
# hammer MT5 history copy on every signal tick.
_REGIME_CACHE: dict = {"ts": 0, "regime": None}


def classify_btc_regime() -> Optional[str]:
    """
    Classify the last 168h (7d) BTC market regime using MT5 H1 bars.
    Returns one of {"trend-up", "trend-down", "chop", "high-vol", "calm"} or
    None if data is unavailable. Result is cached for 30 minutes.

    Mirrors scripts/_regimeAnalysisR28V4.test.ts so live and backtest agree.
    """
    now = datetime.now(timezone.utc).timestamp()
    if now - _REGIME_CACHE["ts"] < 1800 and _REGIME_CACHE["regime"] is not None:
        return _REGIME_CACHE["regime"]
    btc_sym = REGIME_GATE_BTC_SYMBOL or _resolve_broker_symbol("BTCUSDT")
    if not btc_sym:
        log_event("regime_classify_skip", reason="no btc symbol")
        return None
    try:
        # H1 × 168 bars = 7 days
        rates = mt5.copy_rates_from_pos(btc_sym, mt5.TIMEFRAME_H1, 0, 168)
        if rates is None or len(rates) < 100:
            log_event("regime_classify_skip", reason="insufficient bars",
                      bars=len(rates) if rates is not None else 0)
            return None
        closes = [float(r["close"]) for r in rates]
        first, last = closes[0], closes[-1]
        if first <= 0:
            return None
        trend = (last - first) / first
        # Annualised realised vol from log-returns
        import math as _m
        rets = []
        for i in range(1, len(closes)):
            if closes[i - 1] > 0 and closes[i] > 0:
                rets.append(_m.log(closes[i] / closes[i - 1]))
        if not rets:
            return None
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / max(1, len(rets))
        stdev = _m.sqrt(var)
        # H1 bars → 24*365 per year
        annual_vol = stdev * _m.sqrt(24 * 365)
        regime: str
        if annual_vol >= 0.6:
            regime = "high-vol"
        elif abs(trend) <= 0.02 and annual_vol < 0.15:
            regime = "calm"
        elif trend > 0.05:
            regime = "trend-up"
        elif trend < -0.05:
            regime = "trend-down"
        else:
            regime = "chop"
        _REGIME_CACHE["ts"] = now
        _REGIME_CACHE["regime"] = regime
        log_event("regime_classified", regime=regime,
                  trend_pct=round(trend * 100, 2),
                  annual_vol_pct=round(annual_vol * 100, 2))
        return regime
    except Exception as e:
        log_event("regime_classify_error", error=str(e))
        return None


def check_regime_gate_block() -> Optional[str]:
    """
    Returns blocker reason if current BTC regime is in the block-list,
    else None. Disabled by default (REGIME_GATE_ENABLED=false).
    """
    if not REGIME_GATE_ENABLED:
        return None
    regime = classify_btc_regime()
    if regime is None:
        return None  # fail-open: don't block on classification failure
    if regime in REGIME_GATE_BLOCK:
        return f"regime_gate: BTC regime '{regime}' is in block-list (low historical pass-rate)"
    return None


# Macro news-blackout (Round 53): block entries around high-impact USD
# events (FOMC, CPI, NFP, PPI, GDP). Crypto vol spikes around these
# consistently tag SLs and burn the 5% daily-loss cap. Default OFF —
# enable with NEWS_BLACKOUT_ENABLED=true. Window is
# [-NEWS_BLACKOUT_MIN_BEFORE, +NEWS_BLACKOUT_MIN_AFTER] minutes around
# each release. See tools/news_blackout.py for the hardcoded 2026 schedule.
NEWS_BLACKOUT_ENABLED = os.getenv("NEWS_BLACKOUT_ENABLED", "false").lower() == "true"
NEWS_BLACKOUT_MIN_BEFORE = int(os.getenv("NEWS_BLACKOUT_MIN_BEFORE", "30"))
NEWS_BLACKOUT_MIN_AFTER = int(os.getenv("NEWS_BLACKOUT_MIN_AFTER", "60"))
# 2026-05-20 bug-find round: the news auto-close (position flattening before
# high-impact events) was NOT gated by any flag — it flattened positions even
# when NEWS_BLACKOUT_ENABLED=false (surprising "disabled" behaviour). Now gated
# by its own flag that DEFAULTS to the blackout flag, so disabling blackout is a
# clean no-op while still allowing auto-close to be controlled independently.
NEWS_AUTO_CLOSE_ENABLED = (
    os.getenv("NEWS_AUTO_CLOSE_ENABLED", str(NEWS_BLACKOUT_ENABLED)).lower() == "true"
)


def check_news_blackout() -> Optional[str]:
    """
    Returns blocker reason if we are currently inside a macro-news
    blackout window, else None. Wraps tools/news_blackout.py. Disabled
    by default (NEWS_BLACKOUT_ENABLED=false).
    """
    if not NEWS_BLACKOUT_ENABLED:
        return None
    try:
        from news_blackout import is_blackout_window  # type: ignore
    except Exception as exc:
        log_event("news_blackout_import_failed", error=str(exc))
        return None
    blocked, reason = is_blackout_window(
        datetime.now(timezone.utc),
        blackout_minutes_before=NEWS_BLACKOUT_MIN_BEFORE,
        blackout_minutes_after=NEWS_BLACKOUT_MIN_AFTER,
    )
    return f"news_blackout: {reason}" if blocked else None


# Realistic slippage modeling (Round 53): close V4-Engine → Live drift.
#
# V4 Live Engine assumes idealized fills at exact bar prices. Real MT5
# execution has fixed + variable spread, ~50-200 ms order roundtrip latency,
# partial fills in thin markets, and worse fill on stop-out (price already
# moving against you when SL triggers).
#
# Slippage unit = symbol_info.spread × symbol_info.point (broker spread in
# price units). Configurable via env:
#   SLIPPAGE_DISABLED=true   → bypass entirely (use for parity tests)
#   SLIPPAGE_ENTRY_SPREADS=1.5 (default) — entry fills 1-2 spreads worse
#   SLIPPAGE_STOP_SPREADS=3.0  (default) — stop-out fills 2-4 spreads worse
# TP/PTP are limit orders → neutral (fill at exact price or not at all).
SLIPPAGE_DISABLED = os.getenv("SLIPPAGE_DISABLED", "false").lower() == "true"
SLIPPAGE_ENTRY_SPREADS = float(os.getenv("SLIPPAGE_ENTRY_SPREADS", "1.5"))
SLIPPAGE_STOP_SPREADS = float(os.getenv("SLIPPAGE_STOP_SPREADS", "3.0"))


def _apply_slippage(
    price: float,
    direction: str,
    action: str,
    symbol_info: Any,
) -> float:
    """
    Worsen `price` by a realistic slippage amount (symbol spread × N).

    Args:
        price: input fill price (mid / bid / ask)
        direction: "long" or "short" — determines which way "worse" goes
        action: "entry" | "stop_out" | "tp" | "ptp"
        symbol_info: MT5 SymbolInfo (uses .spread × .point as unit)

    Returns:
        Slipped price. Long entry → higher (paid more); short entry → lower
        (received less). Stop-out is symmetric (always worse for the trader).
        TP/PTP are limit orders and never slip — return price unchanged.
    """
    if SLIPPAGE_DISABLED:
        return price
    if action in ("tp", "ptp"):
        return price  # limit orders fill at exact price or not at all

    if action == "entry":
        spreads = SLIPPAGE_ENTRY_SPREADS
    elif action == "stop_out":
        spreads = SLIPPAGE_STOP_SPREADS
    else:
        return price  # unknown action → no-op (safe default)

    # Slippage unit = broker-reported spread (in points) × point size.
    # Some brokers / mocks expose `spread` (int, in points), some don't.
    point = float(getattr(symbol_info, "point", 0.0) or 0.0)
    raw_spread = getattr(symbol_info, "spread", None)
    if raw_spread is None or point <= 0:
        # Fallback: derive from bid/ask gap when broker doesn't report spread.
        bid = float(getattr(symbol_info, "bid", 0.0) or 0.0)
        ask = float(getattr(symbol_info, "ask", 0.0) or 0.0)
        if ask > bid > 0:
            slip_unit = (ask - bid)
        else:
            return price  # can't model → fail-open (parity with old behavior)
    else:
        slip_unit = float(raw_spread) * point

    delta = slip_unit * spreads
    if direction == "long":
        # Long pays more on entry / sells lower on stop-out → both worse via +/-
        if action == "entry":
            return price + delta  # paid more (ask creep)
        else:  # stop_out
            return price - delta  # sold lower (price already gapping down)
    elif direction == "short":
        if action == "entry":
            return price - delta  # received less (bid creep)
        else:  # stop_out
            return price + delta  # bought back higher (price gapping up)
    else:
        return price  # unknown direction → no-op


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

    Phase 39 (R44-V231-2): wraps the read-modify-write under file_lock so
    concurrent invocations (e.g. multiple polling cycles, sync_account
    helper) don't lose updates. Without the lock, both could read peak=110,
    A see current=115 + write 115, B see current=112 + write 112 → corrupted
    peak that under-throttles peakDrawdownThrottle.
    """
    lock_path = CHALLENGE_PEAK_PATH.with_suffix(".lock")
    with _file_lock(lock_path, timeout_sec=5.0, stale_sec=10.0):
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
    """Return the current challenge-day index (0-based, Prague calendar days).

    Round 57 (R57-PY-1) fix: previous implementation had two bugs.

    1. `(now - start).days` returns calendar-day-difference but ignores
       hours when the timestamps were equally aligned, AND breaks when start
       has an activation-time (e.g. 16:00). With start=Mon 16:00 and
       now=Tue 10:00, `(now - start).days` returned 0 even though the
       challenge has already entered Tue (FTMO calendar-day 1).

    2. `replace(tzinfo=prague_tz)` on a NAIVE datetime forces the offset
       at *parse time*; spring-forward DST then makes `(now - start)`
       off by 1h vs the real Prague wall-clock interval — which can
       flip the day boundary at the spring-forward / fall-back transition.

    Fix: parse `CHALLENGE_START_DATE` as either a date (`YYYY-MM-DD`,
    treated as 00:00 Prague) or an ISO timestamp (with optional time-of-day,
    interpreted as Prague local time). Then compute:

        challenge_day = prague_calendar_day(now) - prague_calendar_day(start)

    Pure calendar-day arithmetic via `.date()`, DST-safe because the
    ZoneInfo lookup happens against the actual wall-clock day, not via
    a naive subtraction.

    Activation-time-of-day is informational (e.g. for logging) — the
    challenge counts whole Prague-days from midnight to midnight, so
    a 16:00 activation still belongs to "day 0" until next Prague midnight.
    """
    if not CHALLENGE_START_DATE:
        return 0
    try:
        # 2026-05-24 Codex audit MED FIX: prior `except ImportError` only
        # caught the case where `zoneinfo` itself is missing (pre-3.9
        # Python). On systems where zoneinfo is present but the OS lacks
        # `tzdata` (minimal Docker base images, some Windows configs),
        # `ZoneInfo("Europe/Prague")` raises ZoneInfoNotFoundError (a
        # subclass of KeyError, NOT ImportError). That exception bubbled
        # to the outer except at L2025, returning 0 → challenge_day stuck
        # at day 0 forever → minTradingDays counter never increments →
        # bot can never satisfy FTMO 4-day rule → silent stall.
        try:
            from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
            try:
                prague_tz = ZoneInfo("Europe/Prague")
            except ZoneInfoNotFoundError:
                prague_tz = _eu_prague_fallback_tz()
        except ImportError:
            prague_tz = _eu_prague_fallback_tz()
        # Accept either bare date "YYYY-MM-DD" or ISO timestamp with time.
        # `datetime.fromisoformat` parses both.
        parsed = datetime.fromisoformat(CHALLENGE_START_DATE)
        # If naive (no tzinfo), interpret as Prague local time.
        if parsed.tzinfo is None:
            start = parsed.replace(tzinfo=prague_tz)
        else:
            start = parsed.astimezone(prague_tz)
        now = datetime.now(prague_tz)
        # Pure calendar-day subtraction (DST-safe).
        return max(0, (now.date() - start.date()).days)
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
        # 2026-05-15 (Audit-Round-6 / Agent #1 KRIT): on Windows-without-tzdata
        # the ZoneInfo lookup raises `zoneinfo.ZoneInfoNotFoundError` (subclass
        # of KeyError, NOT ImportError) → previous handler missed it and the
        # bot crashed on the first tick. `tzdata` is now in requirements.txt,
        # but the exception clause catches KeyError belt-and-suspenders
        # (ZoneInfoNotFoundError inherits from KeyError → safe even when the
        # import itself failed and the name is unbound).
        from zoneinfo import ZoneInfo  # type: ignore
        prague_tz = ZoneInfo("Europe/Prague")
    except (ImportError, KeyError):
        # Python <3.9 fallback — use fixed CET offset
        prague_tz = _eu_prague_fallback_tz()  # DST-aware CET/CEST
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
        # 2026-05-21 bug-round: PERSIST the recovered anchor so it cannot slide
        # upward on subsequent polls. Previously every poll re-hit this corrupt
        # branch and re-anchored to the (moving) current equity, so the
        # daily-loss baseline drifted toward current → daily_pct trended to 0
        # and could MASK a real breach. Lock the anchor once; the loud alert
        # above already flags that today's DL may be understated.
        recovered = {
            "date": last_date,
            "equity_at_day_start_usd": float(current_equity_usd),
            "snapped_at": datetime.now(timezone.utc).isoformat(),
            "tz": "Europe/Prague",
            "recovered_from_corrupt": True,
        }
        write_json(DAILY_STATE_PATH, recovered)
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
    given Prague date. Pulls from MT5 history. Returns (0,0,0,0,0) if no data.

    2026-05-15 Codex-Audit Wave-2 Bug 9 (NIEDRIG/MITTEL): the daily-summary
    Telegram is anchored to the Prague trading-day (matching FTMO's
    accounting); `_build_daily_summary` is called with `last_date` already in
    Europe/Prague. Previously this function expanded that date into
    `datetime(y, m, d, 0, 0, 0, tzinfo=UTC)` — i.e. Prague-day name with UTC
    boundaries. Trades placed close to midnight Prague (22:00 / 23:00 UTC
    depending on DST) were attributed to the WRONG daily summary, hiding
    the late-day loss or counting a win twice. Use Prague boundaries to
    match `handle_daily_reset` / `_prague_today_str`.
    """
    try:
        # 2026-05-15 (Audit-Round-6 / Agent #1 KRIT): on Windows-without-tzdata
        # the ZoneInfo lookup raises `zoneinfo.ZoneInfoNotFoundError` (subclass
        # of KeyError, NOT ImportError) → previous handler missed it and the
        # bot crashed on the first tick. `tzdata` is now in requirements.txt,
        # but the exception clause catches KeyError belt-and-suspenders
        # (ZoneInfoNotFoundError inherits from KeyError → safe even when the
        # import itself failed and the name is unbound).
        from zoneinfo import ZoneInfo  # type: ignore
        prague_tz = ZoneInfo("Europe/Prague")
    except (ImportError, KeyError):
        prague_tz = _eu_prague_fallback_tz()  # DST-aware CET/CEST
    try:
        # date_str is "YYYY-MM-DD"
        y, m, d = (int(x) for x in date_str.split("-"))
        day_start = datetime(y, m, d, 0, 0, 0, tzinfo=prague_tz)
        day_end = datetime(y, m, d, 23, 59, 59, tzinfo=prague_tz)
        deals = mt5.history_deals_get(day_start, day_end) or []
        closes = [d for d in deals if getattr(d, "magic", 0) == MAGIC and _is_close_deal(d)]
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
# 2026-05-15 Codex-Audit Bug 7: track when None-cache entries were written so
# transient MT5 / symbol-window failures don't blacklist a symbol for the
# whole process lifetime. Hit-cache entries (str values) stay forever — they
# are stable broker-symbol mappings.
_SYMBOL_CACHE_NEG_TS: dict[str, float] = {}
# Negative-cache TTL in seconds; tunable via env for ops.
_SYMBOL_NEG_CACHE_TTL = float(os.environ.get("FTMO_SYMBOL_NEG_CACHE_TTL_SEC", "60"))


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

    2026-05-15 Codex-Audit Bug 7: positive cache (str) is permanent; negative
    cache (None) has a TTL so a transient symbol_info failure doesn't
    blacklist the asset until process restart.
    """
    if binance_symbol in _SYMBOL_CACHE:
        cached = _SYMBOL_CACHE[binance_symbol]
        if cached is not None:
            return cached
        # Negative cache: respect TTL, then retry.
        cached_at = _SYMBOL_CACHE_NEG_TS.get(binance_symbol, 0.0)
        if (time.time() - cached_at) < _SYMBOL_NEG_CACHE_TTL:
            return None
        # TTL expired → drop and re-resolve below.
        _SYMBOL_CACHE.pop(binance_symbol, None)
        _SYMBOL_CACHE_NEG_TS.pop(binance_symbol, None)

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

    # 2026-05-20 bug-find round (H1): verify a GENERATED candidate's base asset
    # before accepting it — a separator/suffix/drop-E variant could otherwise
    # match a DIFFERENT broker instrument and place an order on the wrong symbol.
    # The explicit SYMBOL_MAP override is curated → trusted as-is. Generated
    # candidates must share the first 3 base chars (covers BTC/BTCUSD/BTC.x and
    # legit shortenings like AAVE→AAV, but rejects wild collisions).
    expected_base = binance_symbol.upper().replace("USDT", "").replace("USD", "")
    base_prefix = expected_base[:2]  # 2 chars: tolerant of AAVE→AAV shortenings
    for candidate in unique:
        try:
            info = mt5.symbol_info(candidate)
            if info is None:
                continue
            is_curated = mapped is not None and candidate == mapped
            cand_base = (
                candidate.upper()
                .replace("USDT", "").replace("USD", "")
                .lstrip("/.-_").rstrip("/.-_")
                .split(".")[0]
            )
            if not is_curated and base_prefix and not cand_base.startswith(base_prefix):
                log_event(
                    "symbol_candidate_base_mismatch", level="warn",
                    binance=binance_symbol, candidate=candidate, expected_base=expected_base,
                )
                continue
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
    _SYMBOL_CACHE_NEG_TS[binance_symbol] = time.time()
    log_event(
        "symbol_unresolved",
        binance=binance_symbol,
        tried=unique,
        ttl_sec=_SYMBOL_NEG_CACHE_TTL,
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
    # 2026-05-13 Codex Round 4 Python #5 FIX: broker-confirmed SL/TP exposed
    # to caller so the persisted position record reflects BROKER REALITY
    # (rounded to tick grid, slippage-adjusted), NOT the idealized signal
    # payload values. Without these, BE/PTP/trail logic computed deltas
    # against persisted-but-stale levels while the broker held different
    # SL/TP → state-vs-reality drift on every modifier.
    stop_price: Optional[float] = None
    tp_price: Optional[float] = None


# ---------------------------------------------------------------------------
# R3-B Drift-2: risk_frac sanity-check (2026-05-15)
#
# The Rust backtest engine applies a 9-stage sizing ladder (live_loss_cap,
# day_risk_mult, maxRiskFrac, modelled_loss check, kelly_tier, sharpe_sizing,
# day_progressive, time_decay, hard cap) before emitting the per-signal
# risk_frac. The live executor *trusts* that output and only enforces the
# RISK_FRAC_HARD_CAP=0.05 ceiling — meaning a signal-service bug that emits
# anomalously low/high risk_frac would pass through silently.
#
# Defense-in-depth: sanity-check incoming risk_frac against a plausible
# range. Outliers are flagged (and optionally rejected) so we catch
# signal-service regressions BEFORE they cost equity. Default: alert-only.
# Set FTMO_RISK_SANITY_REJECT=1 to additionally reject outlier signals.
# Set FTMO_RISK_SANITY_ENABLED=0 to disable entirely.
#
# Plausible range derivation:
#   - Lower bound 0.005 (= 0.5%): below this the broker volume_min usually
#     clips the lot to zero anyway. A signal < 0.005 indicates either an
#     end-of-day time-decay multiplier collapse or a sizing-ladder bug
#     (kelly_tier returning ~0). Either way, worth a warn.
#   - Upper bound = min(RISK_FRAC_HARD_CAP, 0.03) = 0.03 default.
#     Rust default risk_frac is ~0.01-0.025; 0.03 = +20% headroom over the
#     typical max. Anything above is a signal-service regression worth
#     surfacing (even if RISK_FRAC_HARD_CAP would also clip it).
# ---------------------------------------------------------------------------
RISK_SANITY_ENABLED = os.environ.get("FTMO_RISK_SANITY_ENABLED", "1").lower() in (
    "1",
    "true",
    "yes",
)
RISK_SANITY_REJECT = os.environ.get("FTMO_RISK_SANITY_REJECT", "0").lower() in (
    "1",
    "true",
    "yes",
)
RISK_SANITY_MIN = float(os.environ.get("FTMO_RISK_SANITY_MIN", "0.005"))
RISK_SANITY_MAX = float(
    os.environ.get("FTMO_RISK_SANITY_MAX", str(min(RISK_FRAC_HARD_CAP, 0.03)))
)


def _sanity_check_risk_frac(payload_risk_frac: float, asset_symbol: str) -> Optional[str]:
    """Validate that ``payload_risk_frac`` falls inside the plausible range.

    Returns ``None`` when the value is within range OR sanity is disabled.
    Returns a reason-string when the value is an outlier. Caller decides
    whether to reject the signal (RISK_SANITY_REJECT=1) or merely warn.

    The function ALWAYS emits a ``log_event`` + Telegram alert on outliers
    so the operator sees a signal-service regression even in non-reject
    mode. This is defense-in-depth: the Rust 9-stage sizing ladder may have
    bugs (kelly_tier returning 0, day_risk_mult inverted, etc.) and the
    cheap sanity-check surfaces them before live equity is at risk.
    """
    if not RISK_SANITY_ENABLED:
        return None
    try:
        rf = float(payload_risk_frac)
    except (TypeError, ValueError):
        log_event(
            "risk_frac_invalid_type",
            asset=asset_symbol,
            payload_risk_frac=str(payload_risk_frac),
            level="warn",
        )
        return f"risk_frac type-invalid ({payload_risk_frac!r}) — refusing entry"
    if not (RISK_SANITY_MIN <= rf <= RISK_SANITY_MAX):
        reason = (
            f"risk_frac {rf:.4f} outside plausible range "
            f"[{RISK_SANITY_MIN:.4f}, {RISK_SANITY_MAX:.4f}]"
        )
        log_event(
            "risk_frac_outlier",
            asset=asset_symbol,
            risk_frac=rf,
            min=RISK_SANITY_MIN,
            max=RISK_SANITY_MAX,
            will_reject=RISK_SANITY_REJECT,
            level="warn",
        )
        try:
            tg_send(
                "⚠️ <b>Risk-Frac Outlier</b>\n"
                f"{html_escape(asset_symbol)} risk={rf:.4f} "
                f"(plausible {RISK_SANITY_MIN:.3f}–{RISK_SANITY_MAX:.3f})\n"
                + ("🚫 SIGNAL REJECTED" if RISK_SANITY_REJECT else "(alert only)")
            )
        except Exception:
            # tg_send failure must never block sizing — already logged.
            pass
        return reason if RISK_SANITY_REJECT else None
    return None


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
    # Bug-Audit Round 2: parity with R67-r11 — prefer freshest L1 from
    # symbol_info_tick over the cached symbol_info.bid/ask. symbol_info()
    # mid-quotes can be tens-of-ticks stale during fast moves and would
    # mis-size the lot in a way that breaches risk on the actual fill.
    sym_name = getattr(symbol_info, "name", None)
    live_tick = mt5.symbol_info_tick(sym_name) if sym_name else None
    if live_tick is not None and live_tick.bid > 0 and live_tick.ask > 0:
        current_price = live_tick.bid if direction == "short" else live_tick.ask
    elif direction == "short":
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
    signal_stop_price: Optional[float] = None,
    signal_tp_price: Optional[float] = None,
) -> OrderResult:
    """
    Place a LONG or SHORT market order.
    direction="short": sell at bid, SL above, TP below.
    direction="long": buy at ask, SL below, TP above.

    2026-05-20 Codex Round 4 Python #5 FIX (final part): when the signal
    payload carries absolute `signal_stop_price`/`signal_tp_price`, place
    THOSE exact levels instead of recomputing relative SL/TP off the live
    tick. The engine's backtest exits at those absolute prices, so placing
    the relative re-derivation drifts every exit by the entry-slippage delta.
    The entry-slippage REJECT (caller, MAX_ENTRY_SLIPPAGE_PCT) already bounds
    that drift; this aligns the held levels with the backtest plan exactly.
    Lot is still sized on the EFFECTIVE stop distance (R55 fix) so realized
    risk stays = risk_frac regardless of which level source is used. Falls
    back to relative recompute when payload levels are absent (tests/legacy).
    """
    ftmo_symbol = _resolve_broker_symbol(binance_symbol)
    if not ftmo_symbol:
        return OrderResult(False, None, f"unknown symbol {binance_symbol}", None, None)
    if not mt5.symbol_select(ftmo_symbol, True):
        return OrderResult(False, None, f"symbol_select failed for {ftmo_symbol}", None, None)
    info = mt5.symbol_info(ftmo_symbol)
    if info is None:
        return OrderResult(False, None, f"symbol_info not ready for {ftmo_symbol}", None, None)
    # R67-r11: source the entry quote from the live tick instead of the cached
    # symbol_info bid/ask. symbol_info() can return stale mid-quotes (cached up
    # to a few ticks old), while symbol_info_tick() is always the freshest L1
    # snapshot. We still keep `info` for tick_size/digits/volume_step lookups.
    tick = mt5.symbol_info_tick(ftmo_symbol)
    if tick is None or tick.bid <= 0 or tick.ask <= 0:
        return OrderResult(False, None, f"no live tick for {ftmo_symbol}", None, None)
    # 2026-05-20 bug-find round: reject a STALE-but-positive quote (broker feed
    # stall, weekend gap on a crypto-CFD). A frozen quote passes the bid/ask>0
    # check but sizing/placing against it is dangerous. tick.time is epoch
    # seconds; skip the check in mock mode or when time is unavailable (0).
    if not MOCK_MODE:
        tick_age = time.time() - float(getattr(tick, "time", 0) or 0)
        if getattr(tick, "time", 0) and tick_age > MAX_TICK_AGE_SEC:
            log_event("stale_tick_rejected", level="warn", symbol=ftmo_symbol, age_s=round(tick_age, 1))
            return OrderResult(False, None, f"stale tick for {ftmo_symbol} (age {tick_age:.0f}s)", None, None)

    # Hard-cap risk_frac before sizing — defends against legacy 200% formula.
    if risk_frac > RISK_FRAC_HARD_CAP:
        print(
            f"[executor] WARN: incoming risk_frac={risk_frac:.4f} exceeds hard cap "
            f"{RISK_FRAC_HARD_CAP:.4f} — clamping for {ftmo_symbol}"
        )
        risk_frac = RISK_FRAC_HARD_CAP
    # 2026-05-23 ML audit Wave1 agent: Engine enforces stop_pct ≤ 0.05 via
    # liveCaps in 7 signal-modules; Python live-side was missing the mirror
    # check. Signal-source bug with stop_pct=0.10 would have passed through
    # unbounded to MT5 → 2× FTMO daily-loss exposure per trade. Skip rather
    # than clip (signal-source bug → don't trade it).
    # 2026-05-25 Wave5 KRIT FIX: env-driven cap matches engine's per-template
    # `liveCaps {maxStopPct}`. Was hardcoded 0.05; if a template uses
    # `maxStopPct: 0.03`, live would still permit 5% stops → engine-contract
    # violation. Asymmetric with `RISK_FRAC_HARD_CAP` which already had env override.
    LIVE_MAX_STOP_PCT = float(os.environ.get("FTMO_LIVE_MAX_STOP_PCT", "0.05"))
    if stop_pct > LIVE_MAX_STOP_PCT:
        log_event("live_stop_pct_exceeded", asset=ftmo_symbol, stop_pct=stop_pct, level="warn")
        return OrderResult(
            False, None,
            f"stop_pct={stop_pct:.4f} exceeds live cap {LIVE_MAX_STOP_PCT:.4f}",
            None, None,
        )

    # Use payload absolute levels only if BOTH are present + positive (all-or-
    # nothing keeps SL/TP from mixing absolute + relative sources). Narrow into
    # local non-None floats so the ternaries below stay type-clean.
    _sl: Optional[float] = signal_stop_price if (signal_stop_price is not None and signal_stop_price > 0) else None
    _tp: Optional[float] = signal_tp_price if (signal_tp_price is not None and signal_tp_price > 0) else None
    if _sl is None or _tp is None:
        _sl = None
        _tp = None
    use_payload_levels = _sl is not None and _tp is not None
    if direction == "short":
        entry_price = tick.bid
        stop_price = _sl if _sl is not None else entry_price * (1 + stop_pct)
        tp_price = _tp if _tp is not None else entry_price * (1 - tp_pct)
        order_type = mt5.ORDER_TYPE_SELL
    elif direction == "long":
        entry_price = tick.ask
        stop_price = _sl if _sl is not None else entry_price * (1 - stop_pct)
        tp_price = _tp if _tp is not None else entry_price * (1 + tp_pct)
        order_type = mt5.ORDER_TYPE_BUY
    else:
        return OrderResult(False, None, f"unknown direction {direction}", None, None)

    # Sanity-guard payload levels against the live entry. Even after the
    # caller's entry-slippage reject, a malformed payload (stop on the wrong
    # side, or entry already past the level) would place an instantly-invalid
    # order. Require SL/TP on the correct side of the entry; reject otherwise.
    if use_payload_levels:
        long_ok = direction == "long" and stop_price < entry_price < tp_price
        short_ok = direction == "short" and tp_price < entry_price < stop_price
        if not (long_ok or short_ok):
            log_event(
                "payload_levels_invalid",
                level="warn",
                asset=binance_symbol,
                direction=direction,
                entry=entry_price,
                stop=stop_price,
                tp=tp_price,
            )
            return OrderResult(
                False, None,
                f"payload SL/TP on wrong side (entry={entry_price} sl={stop_price} tp={tp_price})",
                None, None,
            )

    # R67-r10: round SL/TP to broker tick grid + declared digits to avoid
    # retcode 10016 "Invalid stops" on symbols with non-trivial tick size
    # (FX JPY 0.001, indices 0.1). Crypto (digits=2-3, tick=0.01) is a
    # no-op but cheap.
    tick_size = float(getattr(info, "trade_tick_size", 0.0) or getattr(info, "point", 0.0) or 0.0)
    digits = int(getattr(info, "digits", 0) or 0)
    stop_price = _round_to_tick(stop_price, tick_size, digits)
    tp_price = _round_to_tick(tp_price, tick_size, digits)

    # 2026-05-20 bug-find round fix (B4): re-validate SL/TP side AFTER tick
    # rounding. _round_to_tick can snap a sub-tick stop onto/past the entry,
    # so the pre-round side guard is not sufficient. Applies to BOTH payload
    # and relative levels (a tiny relative stop_pct can collapse on rounding too).
    long_side_ok = direction == "long" and stop_price < entry_price < tp_price
    short_side_ok = direction == "short" and tp_price < entry_price < stop_price
    if not (long_side_ok or short_side_ok):
        log_event(
            "levels_wrong_side_after_round", level="warn", asset=binance_symbol,
            direction=direction, entry=entry_price, stop=stop_price, tp=tp_price,
        )
        return OrderResult(
            False, None,
            f"SL/TP collapsed to wrong side after rounding (entry={entry_price} sl={stop_price} tp={tp_price})",
            None, None,
        )

    # Round 53: realistic slippage on entry. SL/TP stay relative to the
    # theoretical mid (engine planned them that way) — only the order
    # `price` and the reported fill move. This mirrors real MT5 behavior:
    # the trader's stop-distance plan is preserved, but the actual fill
    # is 1-2 spreads worse than the quoted ask/bid.
    fill_price = _apply_slippage(entry_price, direction, "entry", info)

    # Round 55 audit fix: recompute lot AFTER slippage using the effective
    # stop distance (|fill_price − stop_price| / fill_price). Previously the
    # lot was sized with the theoretical `stop_pct` while the order fills at
    # `fill_price` and SL stays at `stop_price` → real loss-per-SL exceeds
    # the engine-planned `risk_frac` by the slippage delta. Sizing with the
    # effective distance keeps real loss = risk_frac on the fill.
    #
    # R56 audit fix: previous code silently fell back to theoretical stop_pct
    # when fill_price <= 0, AND silently let pathological slippage > 3× the
    # planned stop collapse the position into volume_min. Both cases now
    # reject the order with a clear error so the caller / TG-alert sees it.
    if fill_price <= 0:
        return OrderResult(False, None, f"invalid fill_price={fill_price}", None, None)
    effective_stop_pct = abs(fill_price - stop_price) / fill_price
    # 2026-05-20 bug-find round fix (B3): floor on effective stop distance.
    # A near-zero distance (e.g. malformed tiny payload SL) would size an
    # enormous lot — real risk far exceeding risk_frac, capped only by margin.
    if effective_stop_pct < MIN_EFFECTIVE_STOP_PCT:
        log_event(
            "stop_too_tight", level="warn", asset=binance_symbol,
            effective=round(effective_stop_pct, 6), floor=MIN_EFFECTIVE_STOP_PCT,
        )
        return OrderResult(
            False, None,
            f"effective stop too tight ({effective_stop_pct:.5f} < floor {MIN_EFFECTIVE_STOP_PCT})",
            None, None,
        )
    if effective_stop_pct > stop_pct * 3:
        log_event("slippage_excessive", level="warn", planned=stop_pct, effective=effective_stop_pct)
        return OrderResult(
            False,
            None,
            f"slippage too large (eff_stop={effective_stop_pct:.4f} vs planned {stop_pct:.4f})",
            None,
            None,
        )
    lot = compute_lot_size(info, risk_frac, effective_stop_pct, account_equity, direction)
    if lot <= 0:
        # BUGFIX 2026-04-28: Was silent. Now logs symbol-info dump so user can
        # diagnose why lot=0 (typically broker volume_min too high or tick_size=0).
        diag = (
            f"lot=0 for {ftmo_symbol}: vol_min={getattr(info, 'volume_min', '?')} "
            f"vol_step={getattr(info, 'volume_step', '?')} tick_value={getattr(info, 'trade_tick_value', '?')} "
            f"tick_size={getattr(info, 'trade_tick_size', '?')} point={getattr(info, 'point', '?')} "
            f"contract={getattr(info, 'trade_contract_size', '?')} risk={risk_frac:.4f} eff_stop={effective_stop_pct:.4f}"
        )
        log_event("lot_zero", asset=binance_symbol, ftmo_symbol=ftmo_symbol, diag=diag)
        tg_send(f"⚠️ <b>Lot=0 skip</b>\n{ftmo_symbol}\n<code>{html_escape(diag)}</code>")
        return OrderResult(False, None, "lot computation returned 0", None, None)

    # Margin pre-check — ask MT5 to validate the order. If margin would
    # exceed free_margin, halve the lot until it fits or hit volume_min.
    # This stops the "retcode=10019 No money" cascade dead.
    lot = _fit_lot_to_margin(ftmo_symbol, order_type, lot, fill_price, stop_price, tp_price, info)
    if lot <= 0:
        return OrderResult(False, None, "no lot size fits free margin", None, fill_price)

    # 2026-05-25 Wave5 KRIT FIX: derive deviation from MAX_ENTRY_SLIPPAGE_PCT
    # × price / point instead of hardcoded 20 points. Was: 20pts on BTCUSD
    # (point=0.01) = 0.20 USD slippage tolerance — REQUOTE-rejects almost any
    # tick on a 60k asset. 20pts on JPY pair (point=0.001) = 2 pips — too
    # lenient. Dynamic = matches signal-source slippage budget per-symbol.
    # `info` is the mt5.symbol_info object from line ~2576.
    _info_point = getattr(info, "point", 0) or 0
    _dynamic_dev = (
        max(20, int(MAX_ENTRY_SLIPPAGE_PCT * fill_price / _info_point))
        if _info_point > 0
        else 20
    )
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": ftmo_symbol,
        "volume": lot,
        "type": order_type,
        "price": fill_price,
        "sl": stop_price,
        "tp": tp_price,
        "deviation": _dynamic_dev,
        "magic": MAGIC,
        "comment": comment[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": _pick_filling_mode(ftmo_symbol),
    }
    # 2026-05-23 Wave1 audit fix (KRIT-deferred): news-blackout RE-CHECK
    # immediately before order_send. The upstream check_news_blackout() at
    # line 3513 runs ~10-30s before this order_send (signal validation +
    # MCT counter + position cap + price calc + tick wait). If that gap
    # straddles the blackout-start (e.g. signal received at FOMC-31min,
    # order placed at FOMC-29min), the trade lands INSIDE the blackout
    # window. This second check closes the race: O(1) lookup against the
    # cached event list, ~50µs overhead per order.
    news_block_recheck = check_news_blackout()
    if news_block_recheck:
        log_event(
            "news_blackout_race_block",
            asset=ftmo_symbol,
            reason=news_block_recheck,
            level="warn",
        )
        return OrderResult(
            False, None,
            f"news-blackout entered during order prep: {news_block_recheck}",
            lot, None,
        )
    # 2026-05-23 Wave2 fix: retry transient retcodes (REQUOTE / PRICE_OFF /
    # PRICE_CHANGED / CONNECTION). Previous code returned immediately on
    # first failure, dropping a signal that the broker would have accepted
    # 200ms later. Also: accept both DONE and DONE_PARTIAL (10009) — the
    # post-send block already handles partial-fill volume reconciliation.
    _DONE_OK = {mt5.TRADE_RETCODE_DONE, getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", -1)}
    _RETRY_CODES = {
        getattr(mt5, "TRADE_RETCODE_REQUOTE", 10004),
        getattr(mt5, "TRADE_RETCODE_PRICE_CHANGED", 10020),
        getattr(mt5, "TRADE_RETCODE_PRICE_OFF", 10021),
        getattr(mt5, "TRADE_RETCODE_CONNECTION", 10031),
    }
    result = None
    last_err = ""
    for attempt in range(3):
        result = mt5.order_send(request)
        if result is None:
            last_err = "order_send returned None"
            time.sleep(0.2 * (attempt + 1))
            continue
        if result.retcode in _DONE_OK:
            break
        last_err = f"retcode={result.retcode} {getattr(result, 'comment', '')}"
        if result.retcode in _RETRY_CODES and attempt < 2:
            time.sleep(0.2 * (attempt + 1))
            continue
        break
    if result is None:
        return OrderResult(False, None, last_err or "order_send returned None", lot, fill_price)
    if result.retcode not in _DONE_OK:
        return OrderResult(False, None, last_err, lot, fill_price)
    # 2026-05-16 Round 9 HIGH FIX (ftmo_executor agent): MT5 also returns
    # `TRADE_RETCODE_DONE_PARTIAL` (10009) on partial fills. Use `result.volume`
    # (the broker-filled qty) as the authoritative size; pass it back so the
    # caller stores the actual fill, not the requested size.
    # 2026-05-23 Wave2 fix: volume=0 on DONE_PARTIAL means nothing actually
    # filled → treat as failure (do NOT fall back to requested `lot` — would
    # create a phantom position with no broker counterpart). On full DONE,
    # volume=0 typically means the broker/mock omitted the field; fall back
    # to the requested lot (matches pre-Wave2 behavior for non-partial).
    raw_volume = getattr(result, "volume", None)
    done_partial = result.retcode == getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", -1)
    if raw_volume is None:
        filled_lot = lot
    elif raw_volume <= 0.0:
        if done_partial:
            return OrderResult(
                False, None,
                f"zero-fill DONE_PARTIAL (no broker position created)",
                lot, fill_price,
            )
        filled_lot = lot  # full DONE + 0 volume = mock omission, trust request
    else:
        filled_lot = raw_volume
    if filled_lot < lot * 0.99:
        # Partial fill — warn but accept (don't reject, position IS open).
        # Pass actual filled volume so risk-mgmt downstream uses correct size.
        print(
            f"[ftmo] WARN partial_fill {ftmo_symbol}: requested={lot} filled={filled_lot} retcode={result.retcode}",
            flush=True,
        )
        lot = filled_lot
    # Prefer the broker-reported fill (real MT5) when available, else fall
    # back to our slipped price (mock or no-fill-price retcode).
    reported = getattr(result, "price", 0.0) or 0.0
    # 2026-05-13 Codex Round 4 Python #5 FIX: read broker-confirmed SL/TP
    # from the freshly-opened position. MT5's OrderSendResult doesn't
    # always carry sl/tp, but mt5.positions_get(ticket=...) does. Falls
    # back to the request values (which match the order MT5 just accepted)
    # if the lookup fails. The persisted SL/TP MUST match broker reality
    # so BE/PTP/trail/chandelier modifiers compute correct deltas later.
    broker_sl = stop_price
    broker_tp = tp_price
    if not MOCK_MODE:
        try:
            poslist = mt5.positions_get(ticket=result.order)
            if poslist:
                p = poslist[0]
                if getattr(p, "sl", 0.0):
                    broker_sl = float(p.sl)
                if getattr(p, "tp", 0.0):
                    broker_tp = float(p.tp)
        except Exception:
            pass  # keep request values
    # 2026-05-24 PERF: invalidate the account-info cache so the next
    # mt5_get_equity() call after a successful order picks up the new
    # margin/free_margin instead of serving the stale pre-order snapshot.
    _invalidate_mt5_account_cache()
    return OrderResult(
        True,
        result.order,
        None,
        lot,
        reported if reported > 0 else fill_price,
        stop_price=broker_sl,
        tp_price=broker_tp,
    )


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
            "type_filling": _pick_filling_mode(ftmo_symbol),
        }
        check = check_fn(req)
        if check is None:
            return cur_lot  # API hiccup — let order_send try
        if check.retcode == 0 or check.retcode == mt5.TRADE_RETCODE_DONE:
            return cur_lot
        # 10019 = "No money", 10014 = "Invalid volume", 10016 = "Invalid stops"
        if check.retcode != 10019:
            if check.retcode == 10016:
                log_event(
                    "order_check_invalid_stops",
                    symbol=ftmo_symbol,
                    sl=stop_price,
                    tp=tp_price,
                    level="warn",
                    hint="SL/TP not on tick grid — verify _round_to_tick was applied",
                )
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


def close_position(ticket: int, exit_reason_override: Optional[str] = None) -> bool:
    """Close an open position by ticket. Returns True only on confirmed close.

    Phase 84 (R51-PY-C1): when `mt5.positions_get(ticket=...)` returns
    None/empty we cannot tell whether (a) the position was already closed
    legitimately or (b) the API hiccupped. The previous code returned True
    in BOTH cases, so a transient API failure during emergency-close
    would mark the ticket "closed" and the executor would stop retrying
    while the actual position kept bleeding into DL/TL.
    Now we verify via `history_deals_get`: a confirmed exit-deal for the
    ticket within the last 24h means the position genuinely closed; no
    deal history → return False so the caller retries.
    """
    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        try:
            since = datetime.now(timezone.utc) - timedelta(hours=24)
            now = datetime.now(timezone.utc)
            deals = mt5.history_deals_get(since, now) or []
            # entry deal has type=DEAL_ENTRY_IN; closing deal has DEAL_ENTRY_OUT.
            for d in deals:
                if getattr(d, "position_id", None) == ticket and _is_close_deal(d):
                    return True
        except Exception as e:
            log_event("close_position_history_check_failed", ticket=ticket, error=str(e))
        return False
    pos = positions[0]
    # R67-r12: source close-price from live tick (parity with entry-path
    # R67-r11 fix). symbol_info().bid/ask can be 0 on weekend/market-closed
    # gaps → MT5 retcode 10015 "Invalid price" or worst-case match on stale
    # quote. symbol_info_tick() reflects current L1; refuse the close if no
    # tick is available (caller will retry on next polling cycle).
    tick = mt5.symbol_info_tick(pos.symbol)
    if tick is None or tick.bid <= 0 or tick.ask <= 0:
        log_event("close_position_no_tick", ticket=ticket, symbol=pos.symbol)
        return False
    price = tick.ask if pos.type == mt5.POSITION_TYPE_SELL else tick.bid
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": pos.symbol,
        "volume": pos.volume,
        "type": mt5.ORDER_TYPE_BUY if pos.type == mt5.POSITION_TYPE_SELL else mt5.ORDER_TYPE_SELL,
        "position": ticket,
        "price": price,
        "deviation": 20,
        "magic": MAGIC,
        "comment": "iter231 close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": _pick_filling_mode(pos.symbol),
    }
    # Bug-Audit Round 3: parity with _modify_position_sl — 1-shot retry on
    # transient retcodes (REQUOTE/PRICE_OFF/TIMEOUT). Without this a failed
    # emergency close (DL/TL/news) leaves the position bleeding while we
    # silently mark it "not closed" → next poll repeats the same flaky path.
    transient_retcodes = {
        getattr(mt5, "TRADE_RETCODE_REQUOTE", 10004),
        getattr(mt5, "TRADE_RETCODE_PRICE_OFF", 10021),
        getattr(mt5, "TRADE_RETCODE_TIMEOUT", 10008),
    }
    result = mt5.order_send(request)
    if (
        result is not None
        and result.retcode != mt5.TRADE_RETCODE_DONE
        and getattr(result, "retcode", None) in transient_retcodes
    ):
        time.sleep(0.25)
        # Re-fetch the live tick so the retry doesn't replay an off-quote price.
        tick = mt5.symbol_info_tick(pos.symbol)
        if tick is not None and tick.bid > 0 and tick.ask > 0:
            request["price"] = (
                tick.ask if pos.type == mt5.POSITION_TYPE_SELL else tick.bid
            )
        result = mt5.order_send(request)
    ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
    if ok and result is not None:
        # Drift-monitor: log entry_price, planned SL/TP from MT5's position
        # data (set when order was placed) plus actual close price. Joiner
        # by ticket id reconstructs slippage on close vs planned exit.
        entry_price = getattr(pos, "price_open", None)
        sl = getattr(pos, "sl", None)
        tp = getattr(pos, "tp", None)
        actual = result.price
        # R67 audit fix: caller can pass an explicit exit_reason_override for
        # NON-broker-driven closes (emergency-close-all, kill-switch, time-exit,
        # news-blackout, hold-expired). Original code always inferred "tp" or
        # "stop" from price-proximity → corrupted the live-vs-backtest drift
        # pipeline by tagging every emergency exit as a TP/SL hit with bogus
        # slippage_bps. Only fall back to proximity-inference when caller
        # signals an actual broker-driven close ("auto" or None for legacy
        # callers — but legacy paths should be migrated to pass explicit reason).
        if exit_reason_override and exit_reason_override not in ("auto",):
            exit_reason = exit_reason_override
        elif sl and tp and entry_price:
            tp_dist = abs(actual - tp) if tp else float("inf")
            sl_dist = abs(actual - sl) if sl else float("inf")
            exit_reason = "tp" if tp_dist < sl_dist else "stop"
        else:
            exit_reason = "manual"
        slippage_bps = None
        planned_exit = None
        if exit_reason == "tp" and tp:
            planned_exit = tp
            slip = (tp - actual) / tp if pos.type == mt5.POSITION_TYPE_BUY else (actual - tp) / tp
            slippage_bps = round(slip * 10_000, 2)  # positive = adverse
        elif exit_reason == "stop" and sl:
            planned_exit = sl
            slip = (sl - actual) / sl if pos.type == mt5.POSITION_TYPE_BUY else (actual - sl) / sl
            slippage_bps = round(slip * 10_000, 2)
        # 2026-05-15 Codex-Audit Bug 10: include realized pnl + swap/commission
        # in the close-log so the Next.js dashboard /api/ftmo-state can compute
        # win-rate / PF / avg-win-loss. MT5's `position` object exposes
        # `profit` (unrealized PnL of remaining lot before close) and `swap`
        # accrued so far; the post-close history-deal has the realized PnL.
        # Best-effort: derive PnL from the open-position object + recent
        # close-deal if we can find it.
        pnl_realized: Optional[float] = None
        pnl_swap: Optional[float] = None
        pnl_commission: Optional[float] = None
        try:
            # First look at the close-deal that just executed — most accurate.
            since = datetime.now(timezone.utc) - timedelta(minutes=5)
            now = datetime.now(timezone.utc)
            deals = mt5.history_deals_get(since, now) or []
            for d in deals:
                if getattr(d, "position_id", None) == ticket and _is_close_deal(d):
                    pnl_realized = float(getattr(d, "profit", 0.0) or 0.0)
                    pnl_swap = float(getattr(d, "swap", 0.0) or 0.0)
                    pnl_commission = float(getattr(d, "commission", 0.0) or 0.0)
                    break
            # Fallback: pre-close MTM profit on the position object.
            if pnl_realized is None:
                pnl_realized = float(getattr(pos, "profit", 0.0) or 0.0)
                pnl_swap = float(getattr(pos, "swap", 0.0) or 0.0)
        except Exception:
            # PnL is best-effort — never block the close-log on a derivation
            # exception.
            pass
        log_event(
            "closed",
            ticket=ticket,
            close_price=actual,
            entry_price=entry_price,
            planned_exit=planned_exit,
            sl=sl,
            tp=tp,
            exit_reason=exit_reason,
            slippage_bps=slippage_bps,
            symbol=getattr(pos, "symbol", None),
            volume=getattr(pos, "volume", None),
            pnl=pnl_realized,
            swap=pnl_swap,
            commission=pnl_commission,
        )
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


def _prague_today_str() -> str:
    """Return today's date in Europe/Prague TZ as YYYY-MM-DD.

    R56 audit fix: FTMO counts trading-days at Prague midnight (00:00 CET/CEST),
    not UTC. Using UTC in summer (UTC+2) skews the day-boundary by 2h and can
    swallow an entire trading day on the boundary.
    """
    try:
        # 2026-05-15 (Audit-Round-6 / Agent #1 KRIT): on Windows-without-tzdata
        # the ZoneInfo lookup raises `zoneinfo.ZoneInfoNotFoundError` (subclass
        # of KeyError, NOT ImportError) → previous handler missed it and the
        # bot crashed on the first tick. `tzdata` is now in requirements.txt,
        # but the exception clause catches KeyError belt-and-suspenders
        # (ZoneInfoNotFoundError inherits from KeyError → safe even when the
        # import itself failed and the name is unbound).
        from zoneinfo import ZoneInfo  # type: ignore
        prague_tz = ZoneInfo("Europe/Prague")
    except (ImportError, KeyError):
        # Python <3.9 fallback — fixed CET offset (ignores DST).
        prague_tz = _eu_prague_fallback_tz()
    return datetime.now(prague_tz).strftime("%Y-%m-%d")


def _get_broker_equity_now(mock_fallback: float | None = None) -> float | None:
    """Refresh broker equity from MT5. Returns None if unavailable (mock
    without fallback or disconnect). 2026-05-13 Codex Round 4 Python #4
    helper.

    2026-05-16 Round 9 MED FIX (ftmo_executor agent): accept optional
    `mock_fallback` so MOCK mode can supply current_equity instead of
    returning None. Without this, the PASSLOCK refresh-guard at L2161
    silently bypassed in tests — MOCK PASSLOCK runs latched on
    current_equity without post-funding re-check, producing false-positive
    pass-rates in test suites.
    """
    if MOCK_MODE:
        return mock_fallback
    try:
        info = mt5.account_info()
    except Exception:
        return None
    if info is None:
        return None
    try:
        return float(info.equity)
    except (AttributeError, TypeError, ValueError):
        return None


def check_target_and_pause(current_equity: float) -> bool:
    """
    Returns True if pause is active (target hit, waiting for minTradingDays).
    On first detection of target hit: send Telegram, set state.

    2026-05-13 Codex Round 4 Python #4 KRITISCH FIX: previously target_hit
    was latched BEFORE _emergency_close_all_positions ran. If close failed
    (MT5 requote / spread / disconnect) or post-close equity dropped below
    target (swap, commission, slippage on close), state remained
    `target_hit=true` while live equity was actually below target → false
    PASSLOCK pause. Mirrors the Rust harness fix in commit bdc26bb.

    New order: close FIRST → refresh broker equity → only latch target_hit
    when BOTH (a) all closes succeeded AND (b) post-close equity ≥ target.
    """
    if not PAUSE_AT_TARGET:
        return False
    state = get_pause_state()
    if state["passed"]:
        return True  # already passed, keep skipping
    target_equity = CHALLENGE_START_BALANCE * (1 + PROFIT_TARGET_PCT)
    if current_equity >= target_equity and not state["target_hit"]:
        # R67 audit fix (Bug-Audit-Round): R60 PASSLOCK closeAllOnTargetReached
        # was implemented in V4 backtest engine (see project_round60_engine_patches.md)
        # but was NOT propagated to the live Python executor. The full +6.62pp
        # PASSLOCK pass-rate edge depends on locking equity at first target hit.
        # Gate via FTMO_PASSLOCK env (default ON for R60+ champion configs).
        passlock = os.environ.get("FTMO_PASSLOCK", "1").lower() in ("1", "true", "yes")
        if passlock:
            close_outcome = _emergency_close_all_positions("target_reached_passlock_R60")
            # 2026-05-13 Codex Python #4 FIX: bail without latching if any
            # close failed. Next cycle will retry.
            if not close_outcome.get("all_closed", False):
                tg_send(
                    "⚠️ <b>PASSLOCK close PARTIAL FAIL — target NOT latched</b>\n"
                    f"Trigger equity: <b>${current_equity:,.2f}</b>\n"
                    f"Failed closes: <b>{close_outcome.get('failed', 0)}</b>\n"
                    "Bot state remains ACTIVE. Will retry on next cycle."
                )
                log_event(
                    "target_hit_deferred_partial_close",
                    equity=current_equity,
                    target=target_equity,
                    failed=close_outcome.get("failed", 0),
                )
                return False
            # Refresh broker equity AFTER close — swap, commission, and
            # slippage on the close-trade can pull equity below target even
            # when MTM mid-bar said we were above it.
            # 2026-05-16 Round 9 MED FIX: pass current_equity as mock-fallback
            # so MOCK MODE also runs the refresh-guard (test parity).
            refreshed = _get_broker_equity_now(mock_fallback=current_equity)
            if refreshed is not None and refreshed < target_equity:
                tg_send(
                    "⚠️ <b>PASSLOCK funding/slippage drift — target NOT latched</b>\n"
                    f"Pre-close equity: ${current_equity:,.2f}\n"
                    f"Post-close equity: <b>${refreshed:,.2f}</b> &lt; target ${target_equity:,.2f}\n"
                    "Bot state remains ACTIVE."
                )
                log_event(
                    "target_hit_deferred_funding_drift",
                    pre_close=current_equity,
                    post_close=refreshed,
                    target=target_equity,
                )
                return False
            # Post-close equity confirms the pass — use the refreshed value
            # for the Telegram and state record.
            if refreshed is not None:
                current_equity = refreshed
        # R56 audit fix: use Prague-TZ date (FTMO trading-day anchor).
        today = _prague_today_str()
        state["target_hit"] = True
        state["target_hit_date"] = today
        write_pause_state(state)
        log_event("target_hit", equity=current_equity, target=target_equity)
        tg_send(
            f"🎯 <b>+{PROFIT_TARGET_PCT*100:.0f}% TARGET HIT!</b>\n"
            f"Equity: <b>${current_equity:,.2f}</b> (start ${CHALLENGE_START_BALANCE:,.0f})\n"
            f"🛑 <b>BOT PAUSED</b> — no more risk trades.\n"
            + ("🔒 <b>PASSLOCK</b> — all positions force-closed.\n" if passlock else "")
            + f"⏳ Waiting for {MIN_TRADING_DAYS} trading-day minimum.\n"
            f"Daily ping trades will be placed to clock the rule."
        )
    return state["target_hit"]


def maybe_place_ping_trade() -> None:
    """If in pause + ping not placed today, place tiny long+close to count trading day."""
    state = get_pause_state()
    if not state["target_hit"] or state["passed"]:
        return
    # R56 audit fix: ping_dates are FTMO trading-days → Prague TZ, not UTC.
    today = _prague_today_str()
    if today in state["ping_dates"]:
        return  # already pinged today

    if MOCK_MODE:
        log_event("ping_trade_mock", date=today)
        state["ping_dates"].append(today)
    else:
        sym = SYMBOL_MAP.get(PING_SYMBOL_BINANCE, "ETHUSD")
        # R56 audit fix: wrap order_send in idempotency-marker (write-ahead log)
        # — same as the main signal path. If executor crashes between order_send
        # and ping_dates.append, the marker lets reconcile_pending_order_markers
        # detect the phantom long on next boot.
        ping_marker = _write_ping_order_marker(today, sym)
        try:
            info = mt5.symbol_info(sym)
            if info is None:
                log_event("ping_trade_failed", reason=f"symbol {sym} not found")
                _clear_pending_order_marker(ping_marker)
                return
            tick = mt5.symbol_info_tick(sym)
            # R67-r12: bid/ask>0 check (parity with R67-r11 entry-path).
            if tick is None or tick.bid <= 0 or tick.ask <= 0:
                log_event("ping_trade_failed", reason="no tick data")
                _clear_pending_order_marker(ping_marker)
                return
            # Bug-Audit Round 3: open-leg was missing type_filling AND
            # type_time. On FOK-only crypto brokers MT5 returns retcode 10030
            # "invalid order filling type" and the ping is permanently
            # skipped for the day → MIN_TRADING_DAYS counter stalls →
            # challenge cannot pass even after target+pause. Parity with the
            # close-leg fix (R67-r12) and main-signal path.
            request_buy = {
                "action": mt5.TRADE_ACTION_DEAL, "symbol": sym, "volume": PING_LOT_SIZE,
                "type": mt5.ORDER_TYPE_BUY, "price": tick.ask,
                "deviation": 20, "magic": PING_MAGIC, "comment": "iter236-ping",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": _pick_filling_mode(sym),
            }
            result = mt5.order_send(request_buy)
            if result is None or getattr(result, "retcode", None) != mt5.TRADE_RETCODE_DONE:
                log_event("ping_trade_failed", retcode=getattr(result, "retcode", None))
                _clear_pending_order_marker(ping_marker)
                return
            # Close immediately
            # 2026-05-15 Codex-Audit Bug 8: previously a ping was credited
            # (ping_dates.append) whenever the open-leg succeeded, even if
            # positions_get() returned an empty list (MT5 sync lag) and we
            # silently never closed the new long. That left an orphan
            # magic=232 long un-closed AND counted the trading-day as done →
            # double risk: equity drift on the un-closed long + MIN_TRADING_DAYS
            # gate satisfied with no actual closed trade.
            # Fix: require at least one successful position-found-and-closed
            # cycle before crediting the ping.
            closed_at_least_one = False
            positions = mt5.positions_get(symbol=sym) or []
            magic_positions = [p for p in positions if getattr(p, "magic", 0) == PING_MAGIC]
            for pos in magic_positions:
                tick2 = mt5.symbol_info_tick(sym)
                if tick2 is None or tick2.bid <= 0 or tick2.ask <= 0:
                    continue
                close_request = {
                    "action": mt5.TRADE_ACTION_DEAL, "symbol": sym, "volume": pos.volume,
                    "type": mt5.ORDER_TYPE_SELL, "position": pos.ticket,
                    "price": tick2.bid, "deviation": 20, "magic": PING_MAGIC,
                    "comment": "iter236-ping-close",
                    "type_filling": _pick_filling_mode(sym),
                }
                # R67-r12 audit fix: check the close-leg result. Was
                # silently ignored, leaving an SL-less magic=232 ping
                # position open at MT5 if the close requoted/rejected.
                # We log it + leave the marker in place so the next
                # boot's reconcile picks it up.
                close_res = mt5.order_send(close_request)
                if close_res is None or getattr(close_res, "retcode", None) != mt5.TRADE_RETCODE_DONE:
                    log_event(
                        "ping_close_failed",
                        ticket=getattr(pos, "ticket", None),
                        retcode=getattr(close_res, "retcode", None),
                    )
                    tg_send(
                        "⚠️ <b>Ping-close failed</b>\n"
                        f"ticket <code>{getattr(pos, 'ticket', '?')}</code> "
                        f"retcode={getattr(close_res, 'retcode', None)} — orphan ping position."
                    )
                    # Don't append to ping_dates and don't clear the
                    # marker — boot reconcile will pick it up.
                    return
                closed_at_least_one = True
            if not closed_at_least_one:
                # 2026-05-15 Codex-Audit Bug 8: open succeeded but no matching
                # magic=232 position was visible. Leave marker in place so
                # boot-reconcile picks up the orphan and closes it; do NOT
                # credit the ping for today.
                log_event(
                    "ping_open_no_position_found",
                    symbol=sym,
                    queried=len(positions),
                    level="warn",
                )
                tg_send(
                    "⚠️ <b>Ping-open succeeded but position not visible</b>\n"
                    f"symbol <code>{sym}</code> — leaving marker for boot reconcile. "
                    "Trading-day NOT credited."
                )
                return
            log_event("ping_trade_placed", date=today, symbol=sym, lot=PING_LOT_SIZE)
            state["ping_dates"].append(today)
            # 2026-05-15 Codex-Audit Wave-2 Bug 5 (MITTEL): write the pause-
            # state durably BEFORE deleting the marker. The previous order
            # was (1) mutate state in-memory, (2) delete marker, (3) fsync
            # state to disk via `write_pause_state` below. A crash between
            # (2) and (3) lost both the ping_dates entry AND the marker →
            # the trading-day credit disappeared with no recovery path, while
            # MT5 already had the closed ping deal. Pre-emptive fsync makes
            # recovery robust: if we crash after fsync but before the unlink,
            # boot-reconcile sees the marker AND the persisted ping_dates
            # entry and short-circuits any re-attempt.
            write_pause_state(state)
            _clear_pending_order_marker(ping_marker)
        except Exception as e:
            log_event("ping_trade_exception", error=str(e))
            # Leave the marker in place so boot-time reconcile can detect
            # whether the order actually filled (via positions / history_deals).
            return
    write_pause_state(state)

    # Check if challenge passed
    # 2026-05-15 Codex-Audit Bug 1 (KRITISCH): previously
    # `len(ping_dates) + 1 >= MIN_TRADING_DAYS` treated target_hit_date as a
    # COUNT to add to ping_dates. That double-counted in two scenarios:
    #   (a) target_hit_date got appended to ping_dates by an earlier
    #       maybe_place_ping_trade run on the same Prague day (which is
    #       still possible because target detection runs on every cycle
    #       and the ping path appends `today` regardless of target_hit_date
    #       overlap).
    #   (b) MIN_TRADING_DAYS=4 → off-by-one false-pass when only 3 ping
    #       trades were actually placed but `+1` masked the missing day.
    # Honest count: number of *unique* Prague trading-days on which
    # we have a recorded ping or the target_hit_date.
    distinct_days = set(state.get("ping_dates", []) or [])
    if state.get("target_hit_date"):
        distinct_days.add(state["target_hit_date"])
    if len(distinct_days) >= MIN_TRADING_DAYS:
        if not state["passed"]:
            state["passed"] = True
            write_pause_state(state)
            tg_send(
                f"🏆 <b>CHALLENGE PASSED!</b> 🎉\n"
                f"Target hit: {state['target_hit_date']}\n"
                f"Total trading days: {len(distinct_days)}\n"
                f"Bot will continue placing ping trades until you reset state."
            )
            log_event("challenge_passed", trading_days=len(distinct_days))


def process_pending_signals() -> None:
    # Phase 33 (Audit Bug 1 — CRITICAL): acquire pending-signals.lock so we
    # serialize against the Node service's R-M-W. Phase 19 added the lock
    # on the Node side but not here — Python was racing the Node writer,
    # leaving the cross-process race only HALF closed.
    #
    # Round 55 audit fix: previously the lock wrapped only the initial read.
    # The order_send loop, slippage, regime/news gates AND the final write
    # of `remaining` ran OUTSIDE the lock — Node could append a signal X
    # mid-flight, then Python's final write_json(PENDING) silently dropped X.
    # Round 55 closed that race by holding the lock for the FULL critical
    # section (read → MT5 order_send loop → Telegram → write).
    #
    # 2026-05-15 Codex-Audit Wave-2 Bug 6 (MITTEL): the wide lock caused the
    # OPPOSITE problem — `order_send` (5-30s on slow brokers) + per-signal
    # Telegram (`tg_send` is ~200ms but can stall on 429/timeout) kept the
    # lock held longer than the Node side's 5s default `withFileLock`
    # timeout. Node then either dropped signals or force-claimed our lock
    # (`staleMs:5000` default) → cross-process races re-opened.
    #
    # New pattern (3 phases):
    #   Phase A (under lock): read pending+executed+open_positions, then
    #     clear `PENDING_PATH` to {"signals": []} so Node sees our snapshot
    #     as "consumed" and any new signals go to a fresh queue.
    #   Phase B (NO lock): MT5 order_send loop, slippage gates, Telegram.
    #     This is where the wall-clock budget lives — Node can append
    #     freely during this phase.
    #   Phase C (under lock): re-read PENDING_PATH (= Node's new appends),
    #     merge with our `remaining` + retried signals, write
    #     pending/executed/open_positions. Re-read is what protects against
    #     the original Round 55 race; the lock just keeps the write atomic
    #     vs Node's R-M-W.
    pending_lock = STATE_DIR / "pending-signals.lock"

    # Phase A — read + clear queue under lock.
    with _file_lock(pending_lock, timeout_sec=10.0, stale_sec=30.0):
        data = read_json(PENDING_PATH, {"signals": []})
        snapshot_pending = data.get("signals", [])
        if not snapshot_pending:
            return
        executed = read_json(EXECUTED_PATH, {"executions": []})
        open_positions = read_json(OPEN_POS_PATH, {"positions": []})
        # 2026-05-18 LIVE-CLUSTER-DETECTOR: log all new signals BEFORE we
        # decide whether to execute. The gate-check downstream reads this
        # history to compute live cluster — needs ALL signal arrivals
        # regardless of whether they end up executed/blocked.
        _log_signals_to_history(snapshot_pending)
        # Atomically remove the snapshot from the queue so Node treats it
        # as consumed. Any new signals Node appends from here on land in a
        # fresh `{"signals": []}` and will be merged back in Phase C.
        write_json(PENDING_PATH, {"signals": []})

    # Phase B — process the snapshot WITHOUT holding the lock.
    proc = _process_signals_unlocked(
        snapshot_pending, executed, open_positions
    )

    # Phase C — merge + write under lock.
    with _file_lock(pending_lock, timeout_sec=10.0, stale_sec=30.0):
        # Re-read pending: Node may have appended new signals during Phase B.
        latest = read_json(PENDING_PATH, {"signals": []})
        late_signals = latest.get("signals", [])
        # Dedup new arrivals against our snapshot (Node may have racily
        # re-queued one we already processed if it didn't see our Phase-A
        # clear in time).
        original_keys = {
            (s.get("signalBarClose"), s.get("assetSymbol")) for s in snapshot_pending
        }
        new_signals = [
            s for s in late_signals
            if (s.get("signalBarClose"), s.get("assetSymbol")) not in original_keys
        ]
        if new_signals:
            log_event("merged_late_signals", count=len(new_signals))
            # 2026-05-18 LIVE-CLUSTER: also log late arrivals to history.
            _log_signals_to_history(new_signals)
        merged_pending = proc["remaining"] + new_signals
        # Cap executed entries at 500 (same as Round 12 fix).
        executed_out = proc["executed"]
        if len(executed_out.get("executions", [])) > 500:
            executed_out["executions"] = executed_out["executions"][-500:]
        # 2026-05-15 R3 audit Bug #1 (HIGH): crash-safe write order.
        # OPEN_POS_PATH FIRST: it is the only file with unrecoverable V12
        # state (PTP done-flags, partial-tp-levels, chandelier highWaterMark,
        # max_hold_until, trailing). A crash between writes leaves MT5 with
        # the live ticket but no JSON state → boot reconcile rebuilds only a
        # minimal stub and loses the V12 features.
        # EXECUTED_PATH SECOND: audit log, recoverable from MT5 deal history.
        # PENDING_PATH LAST: clearing the signal queue is the consumed-marker.
        # Doing this last guarantees that a partial-crash leaves the signal
        # in PENDING so the next loop retries it idempotently against the
        # WAL marker (which is only cleared AFTER all three writes succeed).
        write_json(OPEN_POS_PATH, proc["open_positions"])
        write_json(EXECUTED_PATH, executed_out)
        write_json(PENDING_PATH, {"signals": merged_pending})
        # WAL-marker cleanup: only after all three writes succeed. See
        # Wave-2 Bug 1 KRITISCH note in `_process_signals_unlocked`.
        for marker in proc["placed_markers"]:
            _clear_pending_order_marker(marker)


def _process_signals_unlocked(
    pending: list[dict],
    executed: dict,
    open_positions: dict,
) -> dict:
    """2026-05-15 Codex-Audit Wave-2 Bug 6 (MITTEL): Phase-B handler.

    Process a pre-snapshotted batch of pending signals WITHOUT holding the
    pending-signals.lock. Caller is responsible for:
      - Reading pending/executed/open_positions under the lock (Phase A)
      - Atomically clearing PENDING_PATH so Node sees them as consumed
      - Writing the returned `remaining` / `executed` / `open_positions`
        back under the lock (Phase C), merging in any new arrivals.

    Splitting the function this way keeps the wall-clock budget of MT5
    `order_send` + Telegram out of the lock window, so the Node-side
    5s default `withFileLock` timeout doesn't trip on a slow broker.

    Returns a dict with keys: `remaining` (signals to keep in pending),
    `executed`, `open_positions`, `placed_markers` (WAL markers to delete
    after writes succeed).
    """
    acct = mt5_get_equity()
    account_equity = acct["equity"] or CHALLENGE_START_BALANCE
    day_start_usd = handle_daily_reset(account_equity)

    # iter236+: if target reached, skip all new signal trades. The pause logic
    # writes state and Telegram-alerts on first detection. Ping trades are
    # placed separately in main_loop via maybe_place_ping_trade().
    if check_target_and_pause(account_equity):
        log_event("signals_skipped_post_target", count=len(pending))
        # Mark all pending as "skipped_post_target" so they don't re-trigger.
        # Caller (`process_pending_signals`) will write executed + clear
        # the pending queue under the lock in Phase C.
        for sig in pending:
            executed["executions"].append({
                "signal": sig, "result": "skipped_post_target",
                "ts": datetime.now(timezone.utc).isoformat(),
            })
        return {
            "remaining": [],
            "executed": executed,
            "open_positions": open_positions,
            "placed_markers": [],
        }

    start_gate_block = check_start_gate_block(open_positions)
    if start_gate_block:
        log_event(
            "start_gate_block",
            count=len(pending),
            reason=start_gate_block,
            gate_path=str(START_GATE_PATH),
        )
        for sig in pending:
            executed["executions"].append({
                "signal": sig,
                "result": "start_gate_blocked",
                "reason": start_gate_block,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
        return {
            "remaining": [],
            "executed": executed,
            "open_positions": open_positions,
            "placed_markers": [],
        }

    cluster_entry_block = check_cluster_entry_block()
    if cluster_entry_block:
        log_event(
            "cluster_entry_block",
            count=len(pending),
            reason=cluster_entry_block,
        )
        for sig in pending:
            executed["executions"].append({
                "signal": sig,
                "result": "cluster_entry_blocked",
                "reason": cluster_entry_block,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
        return {
            "remaining": [],
            "executed": executed,
            "open_positions": open_positions,
            "placed_markers": [],
        }

    remaining: list[dict] = []
    # BUGFIX 2026-04-28: signal staleness check — drop signals older than 5min
    # to prevent trading on stale data after crash/restart/long pause.
    # 2026-05-20: MAX_SIGNAL_AGE_MS is now a module constant (shared with the
    # boot reconcile so the orphan-marker staleness rule matches exactly).
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    # MCT counter — tracks orders placed during THIS batch run so back-to-back
    # signals can't bypass the cap before MT5's positions_get sees them.
    in_batch_placed = 0
    in_batch_risk = 0.0  # summed effective risk_frac placed this batch (portfolio cap)
    # 2026-05-15 Codex-Audit Wave-2 Bug 1 (KRITISCH): markers of successfully
    # placed orders are held until after pending/executed/open-positions are
    # durably written. Then bulk-deleted. A crash in that window leaves the
    # markers in place so boot-reconcile can detect the orphan broker fill.
    placed_markers: list[Path] = []
    for i, sig in enumerate(pending):
        # 2026-05-23 Wave2 fix (KRIT — /pause race): main-loop pre-gate only
        # catches pause BEFORE the cycle starts. A multi-signal batch can take
        # 30s+ to fire (5-30s per place_market_order). Without this check, a
        # /pause landed mid-batch would still execute every remaining order.
        # Re-check AFTER first iteration (i > 0) — the pre-gate handles i=0;
        # checking again on i=0 would create a double-evaluation that breaks
        # tests using the default state dir's bot-controls.json.
        if i > 0 and is_paused():
            log_event("signals_paused_mid_batch", remaining=len(pending) - i)
            # Re-queue the remaining un-placed signals so they're not lost.
            pending_rest = pending[i:]
            if pending_rest:
                try:
                    existing_pending = read_json(PENDING_PATH, {"signals": []})
                    existing_pending["signals"] = existing_pending.get("signals", []) + pending_rest
                    write_json(PENDING_PATH, existing_pending)
                except Exception as e:
                    log_event("signals_paused_requeue_failed", error=str(e), level="warn")
            break
        # 2026-05-23 Wave2 fix (KRIT-1): emit a `signal_received` event so
        # health_monitor.check_real_liveness can detect the signals-but-zero-
        # orders cascade. Was missing → the entire 24h-rejection-cascade
        # branch was dead code.
        log_event(
            "signal_received",
            asset=sig.get("assetSymbol"),
            direction=sig.get("direction"),
            source=sig.get("sourceSymbol"),
        )
        # BUGFIX 2026-04-28 (Round 24): validate required fields up-front to
        # prevent KeyError crashes from malformed signals (schema drift, manual
        # JSON edits, corruption). Skip + log signal if any required field missing.
        # 2026-05-20 bug-find round: signalBarClose is required — without it the
        # marker-ID hash collapses to a constant for same-asset/direction signals
        # (overwrites the WAL marker → boot-reconcile can only recover one of two
        # crashed orders) and the dedup key collapses (lost trade).
        # 2026-05-21 bug-round: sourceSymbol is accessed via direct sig["sourceSymbol"]
        # at the same-asset-exclusivity check, order placement, and open-position
        # write (no .get fallback) — a malformed signal missing it would raise an
        # uncaught KeyError that trips the fail-CLOSED loop guard and pauses the bot.
        # Validate it up-front like the other unconditionally-used fields.
        required_fields = ["assetSymbol", "sourceSymbol", "riskFrac", "stopPct", "tpPct", "stopPrice", "tpPrice", "maxHoldUntil", "entryPrice", "signalBarClose"]
        missing = [f for f in required_fields if f not in sig]
        if missing:
            log_event("signal_invalid_schema", missing=missing, sig_keys=list(sig.keys()))
            tg_send(f"⚠️ <b>Invalid signal schema</b>\nMissing: {html_escape(','.join(missing))}")
            executed["executions"].append({"signal": sig, "result": "invalid_schema", "missing": missing, "ts": datetime.now(timezone.utc).isoformat()})
            continue
        sig_ts = sig.get("signalBarClose") or sig.get("ts_ms")
        # Bug-Audit Round 1: previously `if sig_ts and ...` let signals WITHOUT
        # a timestamp bypass the staleness check entirely — a malformed/legacy
        # signal could be replayed days later. Also missing clock-skew guard:
        # a signal from the future (Windows clock drift, signal-source clock
        # ahead) had `now_ms - sig_ts` negative → never tripped staleness.
        # Now: drop signals missing/invalid ts, and drop signals more than
        # 60s in the future as suspected clock drift.
        CLOCK_DRIFT_TOLERANCE_MS = 60_000  # 60s ahead-of-now allowed
        if not isinstance(sig_ts, (int, float)) or sig_ts <= 0:
            log_event("signal_missing_ts", asset=sig["assetSymbol"])
            tg_send(f"⏰ <b>Signal dropped — no timestamp</b>\n{html_escape(sig['assetSymbol'])}")
            executed["executions"].append({
                "signal": sig, "result": "missing_ts",
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue
        age_ms = now_ms - int(sig_ts)
        if age_ms > MAX_SIGNAL_AGE_MS:
            age_min = age_ms / 60000
            log_event("signal_stale_drop", asset=sig["assetSymbol"], age_min=round(age_min, 1))
            tg_send(f"⏰ <b>Signal stale, dropped</b>\n{html_escape(sig['assetSymbol'])}\nage={age_min:.1f}min")
            executed["executions"].append({
                "signal": sig, "result": "stale_drop", "age_min": round(age_min, 1),
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue
        if age_ms < -CLOCK_DRIFT_TOLERANCE_MS:
            # Signal claims to be from the future > tolerance → clock drift.
            # Drop rather than execute (signal source could be a corrupt
            # timestamp injection or wall-clock skew between Win/Linux).
            drift_sec = -age_ms / 1000
            log_event("signal_future_drop", asset=sig["assetSymbol"], drift_sec=round(drift_sec, 1), level="warn")
            tg_send(f"⏰ <b>Signal dropped — clock drift</b>\n{html_escape(sig['assetSymbol'])}\n+{drift_sec:.1f}s in future")
            executed["executions"].append({
                "signal": sig, "result": "future_ts_drift", "drift_sec": round(drift_sec, 1),
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue
        blocker = check_ftmo_rules(account_equity, day_start_usd)
        if blocker:
            log_event("rule_block", asset=sig["assetSymbol"], reason=blocker)
            tg_send(f"🛑 <b>FTMO Rule Block</b>\nAsset: {html_escape(sig['assetSymbol'])}\nReason: {html_escape(blocker)}")
            executed["executions"].append({
                "signal": sig, "result": "blocked", "reason": blocker,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue

        # R3-B Drift-2: risk_frac sanity-check (2026-05-15). Defense-in-depth
        # against signal-service regressions in the Rust 9-stage sizing
        # ladder. Returns None when in-range OR sanity disabled OR alert-only
        # mode (default). Returns reason-string only when REJECT mode is
        # active AND value is out-of-range. See _sanity_check_risk_frac doc.
        # 2026-05-24 Codex audit HIGH FIX: prior `float(sig.get("riskFrac") or 0.0)`
        # crashed the entire executor loop with ValueError when riskFrac was
        # a non-numeric string (e.g. corrupted upstream payload "abc") because
        # `"abc" or 0.0` returns the truthy string, then float() throws. Also
        # NaN string would silently produce NaN and contaminate sizing math.
        # Wrap in try/except so a single bad signal is rejected, not the loop.
        _rf_raw = sig.get("riskFrac")
        try:
            _rf_val = float(_rf_raw) if _rf_raw is not None else 0.0
            if not math.isfinite(_rf_val):
                raise ValueError("not finite")
        except (TypeError, ValueError):
            executed["executions"].append({
                "signal": sig,
                "result": "invalid_risk_frac",
                "reason": f"riskFrac={_rf_raw!r} not parseable as finite float",
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue
        sanity_reject = _sanity_check_risk_frac(_rf_val, sig["assetSymbol"])
        if sanity_reject:
            executed["executions"].append({
                "signal": sig, "result": "risk_sanity_rejected", "reason": sanity_reject,
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
            tg_send(f"🛡️ <b>Day-Peak Trail Block</b>\n{html_escape(sig['assetSymbol'])}\n{html_escape(dpt_block)}")
            executed["executions"].append({
                "signal": sig, "result": "dpt_blocked", "reason": dpt_block,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue

        # Regime-Gate (Round 52): block entries during low-pass-rate market
        # regimes. Default blocks BTC trend-down (31% pass-rate vs 50% avg).
        # Disabled by default; enable via REGIME_GATE_ENABLED=true. Cached
        # 30 min so it costs ~zero per-signal.
        rg_block = check_regime_gate_block()
        if rg_block:
            log_event("regime_gate_block", asset=sig["assetSymbol"], reason=rg_block)
            tg_send(f"📉 <b>Regime Gate Block</b>\n{html_escape(sig['assetSymbol'])}\n{html_escape(rg_block)}")
            executed["executions"].append({
                "signal": sig, "result": "regime_blocked", "reason": rg_block,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue

        # News-Blackout (Round 53): block entries around high-impact USD
        # macro events (FOMC, CPI, NFP, PPI, GDP). Disabled by default;
        # enable via NEWS_BLACKOUT_ENABLED=true.
        news_block = check_news_blackout()
        if news_block:
            log_event("news_blackout_block", asset=sig["assetSymbol"], reason=news_block)
            tg_send(f"📰 <b>News-Blackout</b>\n{html_escape(sig['assetSymbol'])}\n{html_escape(news_block)}")
            executed["executions"].append({
                "signal": sig, "result": "news_blackout", "reason": news_block,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue

        # BUGFIX 2026-04-28: enforce maxConcurrentTrades parity with engine.
        # Bug-Audit Phase 3 (Python Bug 11): mt5.positions_get(magic=) is NOT
        # a documented filter — on new MT5 builds raises TypeError, on old
        # builds silently ignores → returns ALL positions including manual
        # trades from other bots. Filter by magic manually.
        all_positions = mt5.positions_get() or []
        live_positions = [p for p in all_positions if getattr(p, "magic", 0) == MAGIC]
        open_count = len(live_positions) + in_batch_placed
        if open_count >= MAX_CONCURRENT_TRADES:
            log_event("mct_block", asset=sig["assetSymbol"], open=open_count, cap=MAX_CONCURRENT_TRADES)
            tg_send(f"🛑 <b>MCT Cap Reached</b>\n{html_escape(sig['assetSymbol'])} skipped\nOpen: {open_count}/{MAX_CONCURRENT_TRADES}")
            executed["executions"].append({
                "signal": sig, "result": "mct_blocked",
                "open_count": open_count, "cap": MAX_CONCURRENT_TRADES,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue

        # 2026-05-15 Codex-Audit Wave-2 Bug 4 (HOCH): direction MUST be one of
        # ("long", "short"). The previous code silently fell back to "long" on
        # any malformed / missing direction — a legacy short signal with a
        # mistyped direction field could open a long with mirror-image SL/TP
        # placement (SL below entry for a "long" derived from a short signal
        # is INSIDE the actual stop level → catastrophic). Skip + log explicit
        # rejection instead of guessing the trade side.
        # 2026-05-23 ML audit Round 11.2: case-insensitive normalize before
        # validation gate. Previous code rejected legitimate "LONG"/"Long"
        # signals (case-drift from MT5/upstream) AND any downstream
        # `direction == "long"` compare would have silently sign-flipped if
        # the upstream casing slipped past validation.
        direction = normalize_direction(sig.get("direction"))
        if direction not in ("long", "short"):
            log_event(
                "signal_invalid_direction",
                asset=sig.get("assetSymbol"),
                got=direction,
                level="warn",
            )
            tg_send(
                f"⚠️ <b>Signal dropped — invalid direction</b>\n"
                f"{html_escape(sig.get('assetSymbol', '<?>'))}\n"
                f"direction=<code>{html_escape(str(direction))}</code> "
                "(expected 'long' or 'short')"
            )
            executed["executions"].append({
                "signal": sig, "result": "invalid_direction",
                "direction": direction,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue

        # 2026-05-20 bug-find round: same-asset same-direction exclusivity. The
        # engine permits a long+short straddle on one asset but NEVER two
        # same-direction positions; without this guard a re-emitted signal (new
        # bar) stacks a 2nd same-side position → concentration / doubled risk on
        # one asset. (live_positions is re-fetched per signal above, so a fill
        # from earlier in this batch is already visible here.)
        _sig_broker = _resolve_broker_symbol(sig["sourceSymbol"])
        _want_type = mt5.POSITION_TYPE_BUY if direction == "long" else mt5.POSITION_TYPE_SELL
        if _sig_broker and any(
            getattr(p, "symbol", "") == _sig_broker and getattr(p, "type", None) == _want_type
            for p in live_positions
        ):
            log_event("same_asset_same_dir_block", asset=sig["assetSymbol"], direction=direction)
            executed["executions"].append({
                "signal": sig, "result": "same_asset_open", "direction": direction,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            continue

        regime = sig.get("regime", "BEAR_CHOP")
        tag = "iter213-bull" if regime == "BULL" else "iter231"

        # 2026-05-13 Codex Round 4 Python #5 FIX: entry-slippage tolerance.
        # Reject signals whose payload entryPrice has drifted too far from
        # the current MT5 tick. Without this, a long signal at $50,000 could
        # fill at $50,500+ in volatile bars, putting the SL inside the
        # actual entry (instant stop-out). Tolerance from env, default 0.5%.
        sig_entry_for_slip = sig.get("entryPrice")
        if not DRY_RUN and sig_entry_for_slip and sig_entry_for_slip > 0:
            ftmo_sym = _resolve_broker_symbol(sig["sourceSymbol"])
            if ftmo_sym:
                tick_now = mt5.symbol_info_tick(ftmo_sym) if not MOCK_MODE else None
                if tick_now is not None:
                    current_quote = tick_now.ask if direction == "long" else tick_now.bid
                    if current_quote > 0:
                        slip_pct = abs(current_quote - sig_entry_for_slip) / sig_entry_for_slip
                        if slip_pct > MAX_ENTRY_SLIPPAGE_PCT:
                            log_event(
                                "signal_skipped_entry_slippage",
                                asset=sig["assetSymbol"],
                                signal_entry=sig_entry_for_slip,
                                current=current_quote,
                                slip_pct=round(slip_pct, 5),
                                cap=MAX_ENTRY_SLIPPAGE_PCT,
                            )
                            tg_send(
                                f"⚠️ <b>Entry-slip skip</b>\n"
                                f"{html_escape(sig['assetSymbol'])} {direction.upper()}\n"
                                f"Signal: ${sig_entry_for_slip:.4f} · Now: ${current_quote:.4f}\n"
                                f"Slip: {slip_pct*100:.2f}% > cap {MAX_ENTRY_SLIPPAGE_PCT*100:.2f}%"
                            )
                            executed["executions"].append({
                                "signal": sig,
                                "result": "entry_slippage_skip",
                                "slip_pct": round(slip_pct, 5),
                                "ts": datetime.now(timezone.utc).isoformat(),
                            })
                            continue

        if DRY_RUN:
            log_event("dry_run_order", asset=sig["assetSymbol"], risk=sig["riskFrac"], stop=sig["stopPct"])
            tg_send(
                f"🧪 <b>DRY RUN — would place order</b>\n"
                f"{html_escape(sig['assetSymbol'])} {direction.upper()}\n"
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

        # 2026-05-19 KRIT-1 fix: wire TIER risk-multiplier into sizing.
        # Previously TIER_S/A_RISK_MULT were env-vars + surfaced in
        # compute_live_cluster()['risk_mult'] but NEVER applied to the
        # actual `riskFrac` passed to `place_market_order`. So a user
        # setting `FTMO_TIER_S_RISK_MULT=1.5` saw the dict field but
        # got identical lot sizes vs. multiplier=1.0 — silent no-op.
        # Fix: read the current live-cluster tier classification, multiply
        # `riskFrac` by the matched tier's multiplier, then cap at
        # RISK_FRAC_HARD_CAP (defense-in-depth, place_market_order already
        # caps but we want a transparent log line at the boost site).
        sig_risk_frac = float(sig["riskFrac"])
        _live_cluster_now: dict = {}
        try:
            _live_cluster_now = compute_live_cluster()
            _tier_risk_mult = float(_live_cluster_now.get("risk_mult", 1.0) or 1.0)
        except Exception:
            _tier_risk_mult = 1.0
        if _tier_risk_mult and _tier_risk_mult != 1.0:
            boosted = sig_risk_frac * _tier_risk_mult
            capped = min(boosted, RISK_FRAC_HARD_CAP)
            if abs(capped - sig_risk_frac) > 1e-9:
                log_event(
                    "tier_risk_mult_applied",
                    asset=sig["assetSymbol"],
                    tier=_live_cluster_now.get("tier", ""),
                    risk_mult=_tier_risk_mult,
                    original_risk_frac=round(sig_risk_frac, 6),
                    boosted_risk_frac=round(boosted, 6),
                    final_risk_frac=round(capped, 6),
                    capped=(capped < boosted),
                )
                sig_risk_frac = capped

        # 2026-05-21 bug-find round: clamp to the hard cap UNCONDITIONALLY, not
        # only inside the tier-mult branch above. place_market_order already
        # caps the ORDER itself, but the portfolio-risk accounting below (and
        # `in_batch_risk`) used the raw `sig["riskFrac"]` when tier_mult == 1.0.
        # If a signal-service bug emits riskFrac > hard cap, the accounting then
        # over-counted batch exposure (open positions store the CAPPED
        # effective_risk_frac) and spuriously blocked legit entries. Make the
        # accounted value match what actually gets placed.
        sig_risk_frac = min(sig_risk_frac, RISK_FRAC_HARD_CAP)

        # 2026-05-20 bug-find round: aggregate portfolio-risk cap (opt-in via
        # FTMO_PORTFOLIO_MAX_RISK). Blocks a new entry once the summed effective
        # risk_frac of open + in-batch positions + this signal would exceed the
        # ceiling — defends against MCT×hard-cap concurrent-risk stacking that a
        # correlated crash could breach before stops fire.
        if PORTFOLIO_MAX_RISK > 0:
            _open_risk = sum(
                float(p.get("effective_risk_frac", 0) or 0)
                for p in read_json(OPEN_POS_PATH, {"positions": []}).get("positions", [])
            )
            if _open_risk + in_batch_risk + sig_risk_frac > PORTFOLIO_MAX_RISK:
                log_event(
                    "portfolio_risk_block", asset=sig["assetSymbol"],
                    open_risk=round(_open_risk, 4), in_batch=round(in_batch_risk, 4),
                    this=round(sig_risk_frac, 4), cap=PORTFOLIO_MAX_RISK,
                )
                executed["executions"].append({
                    "signal": sig, "result": "portfolio_risk_block",
                    "ts": datetime.now(timezone.utc).isoformat(),
                })
                continue

        result = place_market_order(
            binance_symbol=sig["sourceSymbol"],
            direction=direction,
            risk_frac=sig_risk_frac,
            stop_pct=sig["stopPct"],
            tp_pct=sig["tpPct"],
            account_equity=account_equity,
            comment=f"{marker_short} {tag} {sig['assetSymbol']}",
            # 2026-05-20 Codex #5 final fix: place the engine's absolute SL/TP
            # so live exits match the backtest plan exactly (entry-slippage
            # already bounded by the reject above). None → relative fallback.
            signal_stop_price=sig.get("stopPrice"),
            signal_tp_price=sig.get("tpPrice"),
        )
        # 2026-05-15 Codex-Audit Wave-2 Bug 1 (KRITISCH): strict WAL pattern.
        #
        # Problem A: previously the marker was deleted immediately after a
        # successful `order_send()` (`_clear_pending_order_marker` inside
        # `if result.ok:`), BEFORE the pending-signals / executed-signals /
        # open-positions state was written at the end of the loop. A crash
        # in that window would leave a real broker fill with NO marker AND
        # NO open-position record → boot-reconcile cannot detect or attach.
        #
        # Problem B: on a failed `order_send()`, the marker was left behind
        # for boot-reconcile to "investigate" — but reconcile re-queues
        # markers without a matching MT5 deal as pending signals → duplicate
        # order attempts on restart. We DO know the order didn't fill, so
        # delete the marker explicitly on send-fail.
        #
        # New rule:
        #   - send FAIL: delete marker immediately (we have authoritative
        #     proof from MT5 that no order was placed).
        #   - send OK:  keep marker in `placed_markers`; delete ONLY after
        #     pending/executed/open-positions writes at the bottom of the
        #     loop succeed. Boot-reconcile keeps its "marker + no MT5 deal
        #     + no open-position" inference intact.
        if result.ok:
            # 2026-05-18 Bug-Audit (KRITISCH): mark_start_gate_started BEFORE
            # placed_markers.append. If we crash between the two writes, recovery
            # is cleaner: open_positions will surface the live trade on the
            # next poll → _challenge_started_from_state returns True → gate
            # check passes. With reversed order a crash mid-window could leave
            # boot-reconcile orphan markers while gate-state stayed False.
            mark_start_gate_started(sig, int(result.ticket or 0))
            placed_markers.append(order_marker)
            _reset_order_fail_counter()
            in_batch_placed += 1
            in_batch_risk += sig_risk_frac  # portfolio-risk cap accounting
            # Drift-monitor fields: capture signal-side prediction + MT5
            # actual fill so the daily report can attribute live drift to
            # entry slippage, spread cost, or stop_pct slippage. Read the
            # spread from the symbol info we resolved earlier.
            sig_entry = sig.get("entryPrice")
            slippage_bps = None
            if sig_entry and sig_entry > 0 and result.entry_price:
                slip = (result.entry_price - sig_entry) / sig_entry
                # Long entries fill higher (positive slip = paid more).
                # Short entries fill lower (negative slip = received less).
                # Normalise so positive = adverse for the trader.
                # Use already-normalized local `direction` (validated above
                # via normalize_direction) — not raw sig["direction"] which
                # may have upstream casing drift.
                if direction == "short":
                    slip = -slip
                slippage_bps = round(slip * 10_000, 2)
            # Re-resolve broker symbol (cached) to read the live spread at
            # fill time. _resolve_symbol returns None if mapping is missing,
            # in which case we just omit the spread field.
            ftmo_symbol = _resolve_broker_symbol(sig["sourceSymbol"])
            broker_symbol_info = mt5.symbol_info(ftmo_symbol) if ftmo_symbol else None
            spread_pts = getattr(broker_symbol_info, "spread", None) if broker_symbol_info else None
            log_event(
                "order_placed",
                asset=sig["assetSymbol"],
                ticket=result.ticket,
                lot=result.lot,
                entry=result.entry_price,
                signal_entry=sig_entry,
                signal_stop=sig.get("stopPrice"),
                signal_tp=sig.get("tpPrice"),
                direction=direction,  # use normalized local, not raw sig
                # 2026-05-19 KRIT-1 fix: also log effective risk_frac (post
                # TIER risk-multiplier) so the audit trail captures both the
                # signal-emitted nominal and the actually-sized value.
                risk_frac=sig.get("riskFrac"),
                effective_risk_frac=round(sig_risk_frac, 6),
                stop_pct=sig.get("stopPct"),
                tp_pct=sig.get("tpPct"),
                slippage_bps=slippage_bps,
                spread_pts=spread_pts,
            )
            tg_send(
                f"✅ <b>ORDER PLACED</b>\n"
                f"{html_escape(sig['assetSymbol'])} {direction.upper()}\n"
                f"Ticket: <code>{result.ticket}</code>\n"
                f"Lot: {result.lot} @ ${result.entry_price:.4f}\n"
                f"Risk: {sig_risk_frac*100:.3f}% of equity"
            )
            open_positions["positions"].append({
                "ticket": result.ticket,
                # 2026-05-13 Codex Round 4 Python #9 FIX: persist engine-side
                # ticket id so restart-recovery via mt5.positions_get() can
                # join broker tickets back to engine state. Format matches
                # OpenPositionV4 (`ftmoLiveEngineV4.ts:2018`) and Rust
                # make_ticket_id post commit bdc26bb: ${symbol}@${entryTime}@${dir}.
                # Falls back to a deterministic reconstruction from signal
                # fields if the wrapper didn't supply engineTicketId.
                "engine_ticket_id": sig.get(
                    "engineTicketId",
                    f"{sig['assetSymbol']}@{sig.get('entryTime', sig.get('signalBarClose', 0))}@{direction}",
                ),
                "engine_entry_time": sig.get("entryTime"),
                "signalAsset": sig["assetSymbol"],
                "sourceSymbol": sig["sourceSymbol"],
                "direction": direction,
                "lot": result.lot,
                # Phase 39 (R44-PY-1): preserve ORIGINAL volume for partial-TP
                # multi-level math. Without this, every level's `frac` was
                # applied to the SHRINKING current volume, so 30% + 40% closed
                # 30% + 0.7×40% = 58% instead of the engine's 70%.
                "original_lot": result.lot,
                # 2026-05-20 bug-find round: persist effective risk_frac so the
                # aggregate portfolio-risk cap can sum exposure across positions.
                "effective_risk_frac": round(sig_risk_frac, 6),
                "entry_price": result.entry_price,
                # 2026-05-13 Codex Round 4 Python #5 FIX: persist BROKER-
                # confirmed SL/TP (from mt5.positions_get on the new ticket,
                # or fallback to the order-request values) instead of the
                # signal payload's idealized levels. Without this fix, BE/PTP/
                # trail/chandelier modifiers later computed deltas against a
                # stale "stop_price" while the broker held a different SL.
                "stop_price": result.stop_price or sig["stopPrice"],
                "tp_price": result.tp_price or sig["tpPrice"],
                # Keep the signal-side values for drift diagnostics so reports
                # can attribute differences to slippage, spread, or rounding.
                "signal_stop_price": sig["stopPrice"],
                "signal_tp_price": sig["tpPrice"],
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
            # 2026-05-15 Codex-Audit Wave-2 Bug 1B (KRITISCH): on a send-fail
            # we have authoritative confirmation that no broker order exists.
            # Delete the WAL marker immediately so boot-reconcile doesn't
            # re-queue this signal on restart (which would attempt a 2nd
            # order). The marker is only needed when MT5 status is unknown.
            _clear_pending_order_marker(order_marker)
            _bump_order_fail_counter(result.error or "unknown")
            log_event("order_failed", asset=sig["assetSymbol"], error=result.error)
            tg_send(f"❌ <b>ORDER FAILED</b>\n{html_escape(sig['assetSymbol'])}\nError: {html_escape(result.error or 'unknown')}")
            # BUGFIX 2026-04-28: retry transient errors instead of silently dropping.
            err_str = (result.error or "").lower()
            # R67-r12 audit fix: add filling-mode mismatch keys (retcode 10030
            # / "invalid order filling type"). Without this every order on a
            # FOK-only crypto symbol failed once and was permanently dropped,
            # quickly tripping `_bump_order_fail_counter` → auto-pause. The
            # `_pick_filling_mode()` probe avoids the failure on the happy
            # path, but if the broker briefly disagrees we still get a retry.
            retryable_keywords = [
                "timeout", "no money", "requote", "off quotes",
                "trade disabled", "10027",
                "invalid order filling", "unsupported filling", "10030",
            ]
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
            # If auto-pause kicked in, stop processing more pending signals.
            # 2026-05-15 Codex-Audit Wave-2 Bug 2 (HOCH): use the enumerate
            # index `i` directly rather than `pending.index(sig)`. The
            # latter returns the FIRST match by structural equality, so a
            # later duplicate signal dict (same assetSymbol+signalBarClose,
            # which happens on signal-source restart races) would re-queue
            # everything from the first occurrence — including signals we
            # already processed earlier in this loop.
            if is_paused():
                remaining.extend(pending[i + 1:])
                break

    # 2026-05-15 Codex-Audit Wave-2 Bug 6 (MITTEL): merge + writes happen in
    # Phase C of `process_pending_signals` (caller). This function returns
    # the in-progress state and lets the caller pick up Node's late writes
    # before persisting.
    return {
        "remaining": remaining,
        "executed": executed,
        "open_positions": open_positions,
        "placed_markers": placed_markers,
    }


# 2026-05-15 Codex-Audit Wave-2 Bug 6 (MITTEL): keep the old function name
# as a thin compatibility shim. Existing tests inspect this symbol's source
# (direction-default regression) or call it directly without the lock. The
# shim wraps the new Phase-A/Phase-B/Phase-C flow used by the production
# `process_pending_signals` entrypoint.
def _process_pending_signals_locked() -> None:
    """Backward-compat wrapper around the new 3-phase flow.

    Earlier audit-rounds (Round 55) exposed this name as the locked
    critical section; tests still call it directly. We delegate to the
    same 3-phase logic used by `process_pending_signals` but without
    acquiring the outer lock (caller is expected to hold it, as the
    function name suggests).
    """
    data = read_json(PENDING_PATH, {"signals": []})
    snapshot = data.get("signals", [])
    if not snapshot:
        return
    executed = read_json(EXECUTED_PATH, {"executions": []})
    open_positions = read_json(OPEN_POS_PATH, {"positions": []})
    # Mirror Phase A: atomically clear the pending queue so callers that
    # treat the wrapper as the lock-holder see the snapshot as consumed.
    write_json(PENDING_PATH, {"signals": []})

    proc = _process_signals_unlocked(snapshot, executed, open_positions)

    # Phase C — re-read pending, merge with new arrivals, persist.
    try:
        latest = read_json(PENDING_PATH, {"signals": []})
        late_signals = latest.get("signals", [])
        original_keys = {
            (s.get("signalBarClose"), s.get("assetSymbol")) for s in snapshot
        }
        new_signals = [
            s for s in late_signals
            if (s.get("signalBarClose"), s.get("assetSymbol")) not in original_keys
        ]
        if new_signals:
            log_event("merged_late_signals", count=len(new_signals))
            # 2026-05-18 LIVE-CLUSTER: also log late arrivals to history.
            _log_signals_to_history(new_signals)
    except Exception as e:
        log_event("merge_check_failed", error=str(e))
        new_signals = []
    merged_pending = proc["remaining"] + new_signals
    executed_out = proc["executed"]
    if len(executed_out.get("executions", [])) > 500:
        executed_out["executions"] = executed_out["executions"][-500:]
    # 2026-05-15 R3 audit Bug #1 (HIGH): crash-safe write order — same as
    # `process_pending_signals`. open_positions first (V12 state irrecoverable
    # from MT5 alone), executed second (audit log, recoverable from deal
    # history), pending last (signal queue, retry-safe via WAL markers).
    write_json(OPEN_POS_PATH, proc["open_positions"])
    write_json(EXECUTED_PATH, executed_out)
    write_json(PENDING_PATH, {"signals": merged_pending})
    for marker in proc["placed_markers"]:
        _clear_pending_order_marker(marker)


def _modify_position_sl(ticket: int, new_sl: float) -> bool:
    """Modify SL of an open position via MT5 SLTP request.

    Bug-Audit Round 2: previously the request always echoed `float(pos.tp)` —
    if `pos.tp == 0` (e.g. broker dropped the TP, or a previous SLTP-modify
    cleared it) MT5 rejects with retcode 10016 "Invalid stops" or, worse,
    silently kills the TP entirely. Now we omit the TP field unless we have
    a non-zero one, so the broker keeps the existing TP. Also: single-shot
    retry on transient REQUOTE/timeout retcodes (10004/10008/10021).
    """
    live = mt5.positions_get(ticket=ticket)
    if not live:
        return False
    pos = live[0]
    # R67-r10: round new SL to tick grid (caller passes computed price like
    # entry × (1 - trailPct) which is generally NOT on the broker grid).
    sl_rounded = float(new_sl)
    info = mt5.symbol_info(pos.symbol)
    if info is not None:
        tick_size = float(getattr(info, "trade_tick_size", 0.0) or getattr(info, "point", 0.0) or 0.0)
        digits = int(getattr(info, "digits", 0) or 0)
        sl_rounded = _round_to_tick(sl_rounded, tick_size, digits)
    request: dict = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": pos.symbol,
        "position": ticket,
        "sl": sl_rounded,
        "magic": MAGIC,
    }
    # Only include tp when broker has a non-zero TP set; sending tp=0 is
    # interpreted as "cancel the TP" by most MT5 builds.
    existing_tp = float(getattr(pos, "tp", 0.0) or 0.0)
    if existing_tp > 0:
        request["tp"] = existing_tp
    # First attempt + one retry on transient retcodes.
    transient_retcodes = {
        getattr(mt5, "TRADE_RETCODE_REQUOTE", 10004),
        getattr(mt5, "TRADE_RETCODE_PRICE_OFF", 10021),
        getattr(mt5, "TRADE_RETCODE_TIMEOUT", 10008),
    }
    for attempt in range(2):
        result = mt5.order_send(request)
        if result is not None and result.retcode == mt5.TRADE_RETCODE_DONE:
            return True
        retcode = getattr(result, "retcode", None)
        if attempt == 0 and retcode in transient_retcodes:
            time.sleep(0.25)
            continue
        log_event(
            "sl_modify_failed",
            ticket=ticket,
            retcode=retcode,
            error=getattr(result, "comment", ""),
            attempt=attempt + 1,
        )
        return False
    return False


def _favorable_extreme(pos: dict, direction: str, current_price: float) -> float:
    """2026-05-20 bug-find round (H2): live approximation of the engine's bar
    high/low. The Rust/TS engine arms break-even / trailing / chandelier on the
    bar's HIGH (long) or LOW (short) — the favorable intrabar extreme. The
    30s-poll live bot only sees ticks, so it tracks the running peak/trough in
    `peak_price_seen`. Using the raw `price_current` (≈ close) instead made the
    live mirrors arm LATER than the backtest and miss ratchets on reverting
    wicks → systematic live < backtest. Updates pos['peak_price_seen'] in place
    and returns the favorable extreme. (PTP already used peak; this brings
    BE/trail/chandelier into the same wick-touch semantics.)
    """
    prev = pos.get("peak_price_seen")
    if direction == "short":
        ext = min(prev, current_price) if prev is not None else current_price
    else:
        ext = max(prev, current_price) if prev is not None else current_price
    pos["peak_price_seen"] = ext
    return ext


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
    direction = normalize_direction(pos.get("direction")) or "long"
    entry = float(pos.get("entry_price", p.price_open))
    # H2 fix: trail off the favorable intrabar extreme (wick), like the engine.
    current_price = _favorable_extreme(pos, direction, float(p.price_current))
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


def _close_partial_lot(ticket: int, close_lot: float, reason: str) -> float:
    """
    Close `close_lot` of an open position via opposite-direction market order.
    Used by partialTakeProfit and partialTakeProfitLevels. Floors to broker
    volume_step.

    2026-05-20 bug-find round: returns the ACTUALLY-closed volume (0.0 on
    failure), not a bool. The broker may partially fill the close; callers must
    track the real reduction so multi-level PTP doesn't mismark a level done
    while a larger-than-intended remainder stays open (risk drift).
    """
    live = mt5.positions_get(ticket=ticket)
    if not live:
        return 0.0
    pos = live[0]
    info = mt5.symbol_info(pos.symbol)
    if info is None:
        return 0.0
    step = info.volume_step or 0.01
    vol_min = info.volume_min or 0.01
    # Floor partial-close lot down to step grid; refuse if below min
    close_lot = math.floor(close_lot / step) * step
    if close_lot < vol_min or close_lot >= pos.volume:
        return 0.0  # too small or would close everything
    # R67-r12: live-tick price (same fix as close_position_at_market).
    tick = mt5.symbol_info_tick(pos.symbol)
    if tick is None or tick.bid <= 0 or tick.ask <= 0:
        log_event("partial_close_no_tick", ticket=ticket, symbol=pos.symbol)
        return 0.0
    price = tick.ask if pos.type == mt5.POSITION_TYPE_SELL else tick.bid
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": pos.symbol,
        "volume": float(close_lot),
        "type": mt5.ORDER_TYPE_BUY if pos.type == mt5.POSITION_TYPE_SELL else mt5.ORDER_TYPE_SELL,
        "position": ticket,
        "price": price,
        "deviation": 20,
        "magic": MAGIC,
        "comment": f"r11 {reason}"[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": _pick_filling_mode(pos.symbol),
    }
    result = mt5.order_send(request)
    ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
    if ok and result is not None:
        # Use the broker-reported filled volume — a partial fill closes less
        # than requested; the caller must see the real reduction.
        actual = float(getattr(result, "volume", 0.0) or close_lot)
        if actual < close_lot * 0.99:
            log_event("partial_close_partial_fill", level="warn", ticket=ticket,
                      requested=close_lot, filled=actual, reason=reason)
        else:
            log_event("partial_close", ticket=ticket, lot=actual, reason=reason, price=result.price)
        return actual
    log_event("partial_close_failed", ticket=ticket, lot=close_lot, retcode=getattr(result, "retcode", None))
    return 0.0


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
    direction = normalize_direction(pos.get("direction")) or "long"
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
    # 2026-05-15 Codex-Audit Bug 9: previously used pos["sourceSymbol"] (Binance
    # ticker like ETHUSDT) for symbol_info — but MT5 wants the broker symbol
    # (ETHUSD, etc.). symbol_info would return None → vol_min defaulted to
    # 0.01 → either skipped legitimate PTP fires (lot=0.005 broker minlot)
    # or false-fired below broker minlot. Always use the live position's
    # broker symbol `p.symbol`, which is authoritative.
    info = mt5.symbol_info(p.symbol)
    vol_min_check = info.volume_min if info else 0.01
    if close_lot < vol_min_check:
        pos["partial_tp_done"] = True
        log_event("ptp_skipped_tiny_lot",
                  ticket=pos["ticket"], close_lot=close_lot, vol_min=vol_min_check)
        return pos
    if _close_partial_lot(pos["ticket"], close_lot, "ptp") > 0:
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
    direction = normalize_direction(pos.get("direction")) or "long"
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
    # Phase 39 (R44-PY-1): closeFraction is fraction of ORIGINAL volume,
    # not current. Without this, after a 30% partial fired, a subsequent
    # 40% level would close 0.7×40%=28% of the *current* volume = 19.6%
    # of original, instead of the engine's 40% of original.
    original_lot = float(pos.get("original_lot") or p.volume)
    # 2026-05-20 bug-find round: track the LIVE remaining volume across levels.
    # When several levels trigger in one poll (price gapped), each close shrinks
    # the position; the old code capped every level against the stale pre-loop
    # p.volume and ignored partial fills, so a later leg's close was refused and
    # silently dropped (under-close / residual). Now cap against `held`, reduce
    # `held` by the ACTUAL closed volume, and treat the final triggered leg as
    # the remainder so no sub-step residual is stranded.
    info = mt5.symbol_info(p.symbol)
    vol_min = float(getattr(info, "volume_min", 0.01) or 0.01) if info else 0.01
    held = float(p.volume)
    for idx, lv in enumerate(levels):
        if done[idx]:
            continue
        trigger = float(lv.get("triggerPct", 0))
        frac = float(lv.get("closeFraction", 0))
        if unrealized < trigger or frac <= 0:
            continue
        close_lot = min(original_lot * frac, held)
        # If closing this leg would strand a sub-min remainder, close the whole
        # remaining position instead.
        # 2026-05-21 bug-find round: the old `close_lot = held` path was always
        # silently dropped — `_close_partial_lot` REFUSES `close_lot >= pos.volume`
        # (it must never flatten a position), so the final PTP leg never fired and
        # the full remainder kept riding (risk drift). Route the full-remainder
        # exit through close_position(), the proper flatten path.
        if held - close_lot < vol_min:
            if close_position(pos["ticket"], exit_reason_override=f"ptpL{idx}_final"):
                done[idx] = True
                held = 0.0
                log_event("partial_tp_level_fired", ticket=pos["ticket"],
                          tier=idx, trigger=trigger, fraction=frac,
                          unrealized=unrealized, closed_lot=close_lot,
                          held_after=0.0, full_close=True)
            break
        if close_lot <= 0:
            continue
        actual = _close_partial_lot(pos["ticket"], close_lot, f"ptpL{idx}")
        if actual > 0:
            done[idx] = True
            held = max(0.0, held - actual)
            log_event("partial_tp_level_fired", ticket=pos["ticket"],
                      tier=idx, trigger=trigger, fraction=frac,
                      unrealized=unrealized, closed_lot=actual, held_after=held)
        if held <= 0:
            break
    pos["partial_tp_levels_done"] = done
    return pos


def _fetch_recent_atr(binance_symbol: str, period: int = 14, bar_minutes: int = 30) -> float | None:
    """Compute current ATR(period) from the freshest broker bars.
    Returns None if MT5 lookup fails — caller falls back to atrAtEntry.

    2026-05-13 Codex Round 4 Python #7 helper: enables _apply_chandelier_stop
    to re-evaluate ATR each management cycle instead of using the fixed
    signal-time snapshot. Matches TS engine semantics
    (ftmoDaytrade24h.ts:4044-4077 recomputes ATR per bar).
    """
    if MOCK_MODE:
        return None
    ftmo_sym = _resolve_broker_symbol(binance_symbol)
    if not ftmo_sym:
        return None
    try:
        if bar_minutes >= 60:
            tf = mt5.TIMEFRAME_H1 if bar_minutes == 60 else mt5.TIMEFRAME_H4
        elif bar_minutes >= 30:
            tf = mt5.TIMEFRAME_M30
        elif bar_minutes >= 15:
            tf = mt5.TIMEFRAME_M15
        elif bar_minutes >= 5:
            tf = mt5.TIMEFRAME_M5
        else:
            tf = mt5.TIMEFRAME_M1
        bars = mt5.copy_rates_from_pos(ftmo_sym, tf, 0, period + 2)
        if bars is None or len(bars) < period + 1:
            return None
        # Wilder ATR(period). TR_i = max(high-low, |high-prevClose|, |low-prevClose|).
        # Then ATR_period = SMA(TR, period); after that, Wilder smoothing:
        # ATR_t = (ATR_{t-1}*(period-1) + TR_t) / period.
        trs: list[float] = []
        for i in range(1, len(bars)):
            high = float(bars[i]["high"])
            low = float(bars[i]["low"])
            prev_close = float(bars[i - 1]["close"])
            tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
            trs.append(tr)
        if len(trs) < period:
            return None
        atr = sum(trs[:period]) / period
        for tr in trs[period:]:
            atr = (atr * (period - 1) + tr) / period
        return atr if atr > 0 else None
    except Exception:
        return None


def _apply_chandelier_stop(pos: dict) -> dict:
    """ATR-based trailing stop: highest_close − K × ATR (long) or
    lowest_close + K × ATR (short). Arms only after price moves
    minMoveR × stopPct in favorable direction. Only ratchets, never widens.
    Mirrors engine src/utils/ftmoDaytrade24h.ts:4044-4077.

    2026-05-13 Codex Round 4 Python #7 FIX: re-evaluate ATR each cycle
    via _fetch_recent_atr() instead of using the fixed snapshot
    `atrAtEntry`. Engine + Rust harness recompute ATR every bar, so live
    must too. Falls back to atrAtEntry if MT5 copy_rates lookup fails
    (mock mode, disconnect, or new symbol with no history).
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
    # Live ATR — fall back to atrAtEntry on lookup failure.
    atr_period = int(cfg.get("atrPeriod", 14))
    bar_minutes = int(cfg.get("barMinutes", 30))
    source_symbol = pos.get("sourceSymbol", "")
    live_atr = _fetch_recent_atr(source_symbol, atr_period, bar_minutes) if source_symbol else None
    atr_for_calc = live_atr if (live_atr is not None and live_atr > 0) else atr_at_entry
    live = mt5.positions_get(ticket=pos["ticket"])
    if not live:
        return pos
    p = live[0]
    direction = normalize_direction(pos.get("direction")) or "long"
    # H2 fix: chandelier arms + anchors on the favorable intrabar extreme (wick),
    # mirroring the engine's high_watermark, not the tick close.
    current_price = _favorable_extreme(pos, direction, float(p.price_current))
    current_close = current_price  # favorable-extreme as the close approximation
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
        new_sl = best - mult * atr_for_calc
    else:
        if best is None or current_close < best:
            best = current_close
        new_sl = best + mult * atr_for_calc
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
                  old_sl=current_sl, new_sl=new_sl, best=best,
                  atr_used=atr_for_calc, atr_live=live_atr, atr_entry=atr_at_entry,
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
    direction = normalize_direction(pos.get("direction")) or "long"
    # H2 fix: BE arms on the favorable intrabar extreme (wick), like the engine —
    # so a profit wick that reverts before the next poll still arms break-even.
    favorable = _favorable_extreme(pos, direction, float(p.price_current))
    unrealized = _unrealized_pct(pos, favorable)
    if unrealized < threshold:
        return pos
    entry = float(pos.get("entry_price", p.price_open))
    current_sl = float(p.sl) if p.sl else None
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
        # 2026-05-15 Codex-Audit Wave-2 Bug 3 (HOCH): only return True if the
        # close actually succeeded. Returning True unconditionally caused the
        # caller (`manage_open_positions`) to drop this position from
        # `still_open` even when the broker rejected the close → engine state
        # lost the position while the live trade stayed open + unmanaged.
        if close_position(pos["ticket"], exit_reason_override="time_exit"):
            tg_send(
                f"⏳ <b>Time-exit close</b>\n"
                f"{pos['signalAsset']} ticket <code>{pos['ticket']}</code>\n"
                f"Held {int(bars_held)} bars, no min-gain reached."
            )
            return True
        log_event(
            "time_exit_close_failed",
            ticket=pos["ticket"],
            level="warn",
        )
        return False
    return False


def _signal_marker_id(sig: dict) -> str:
    """Deterministic ID for write-ahead log: same signal → same ID.

    2026-05-23 Wave2 fix (HIGH #1): collision-safe across multi-strategy
    setups. Previous key was `(assetSymbol, signalBarClose, direction)`.
    Two strategies (e.g. AMBER + TITANIUM) running in the same process and
    emitting `BTC-TREND long` at the same close produced IDENTICAL marker
    paths → silent overwrite of one of the two WAL records. Adding
    `sourceSymbol` + the optional `strategyTag`/`templateName` field
    disambiguates without breaking single-strategy idempotency.
    """
    import hashlib
    tag = sig.get("strategyTag") or sig.get("templateName") or ""
    key = (
        f"{sig.get('assetSymbol','')}|{sig.get('sourceSymbol','')}|"
        f"{sig.get('signalBarClose','')}|{sig.get('direction','')}|{tag}"
    )
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


def _write_ping_order_marker(date_str: str, symbol: str) -> Path:
    """R56 audit fix: write-ahead log marker for ping trades. Mirrors the
    main-signal write-ahead-log idiom. Marker is keyed by date+symbol so a
    crash mid-ping is detectable on next boot — without the marker, an
    executor crash between mt5.order_send and ping_dates.append leaves a
    phantom long with no recovery path."""
    PENDING_ORDERS_DIR.mkdir(parents=True, exist_ok=True)
    import hashlib
    mid = "ping_" + hashlib.sha1(f"{date_str}|{symbol}".encode()).hexdigest()[:11]
    marker = PENDING_ORDERS_DIR / f"{mid}.json"
    write_json(marker, {
        "id": mid,
        "ping": True,
        "date": date_str,
        "symbol": symbol,
        "ts": datetime.now(timezone.utc).isoformat(),
    })
    return marker


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
    # 2026-05-15 Codex-Audit Bug 3: ping trades use magic=232 (signal=231).
    # Previously ping-markers fell into the generic 231-only comment match,
    # so a successful ping-open with a failed close would be re-queued as a
    # phantom signal AND its magic=232 orphan position lived on forever
    # (manage_open_positions ignores magic!=231). We now split markers by
    # type: signal-markers (have `signal` key) vs ping-markers (`ping=True`).
    try:
        all_positions = mt5.positions_get() or []
        signal_positions = [p for p in all_positions if getattr(p, "magic", 0) == MAGIC]
        ping_positions = [p for p in all_positions if getattr(p, "magic", 0) == PING_MAGIC]
        comments = {p.comment for p in signal_positions}
    except Exception:
        comments = set()
        ping_positions = []
    # BUGFIX 2026-04-28 (Round 36 Bug 3): also check recent history (closed orders
    # within last 60 minutes) — a successful order_send may have completed and
    # already SL/TP'd before the reconcile runs. Without this we'd re-queue
    # signals that already filled-and-exited → duplicate trade on next pickup.
    ping_history_comments: set[str] = set()
    # 2026-05-20 bug-find round fix (#3a): the fixed 60-min history window was
    # too short. After a long downtime/reboot, a trade that filled AND closed
    # more than 60 min ago is absent from BOTH live positions and the 60-min
    # deal history → wrongly judged "never placed" → re-queued → DOUBLE ORDER.
    # Look back to the oldest surviving marker's mtime (so any filled+closed
    # trade whose marker still exists is reliably found), floored at 60 min and
    # capped at 14 days.
    try:
        oldest_marker_s = min((m.stat().st_mtime for m in markers), default=time.time())
    except OSError:
        oldest_marker_s = time.time()
    lookback_s = min(max(60 * 60, time.time() - oldest_marker_s + 3600), 14 * 24 * 3600)
    try:
        # R56 audit fix: use UTC-aware datetimes — naive datetime triggers
        # broker-TZ ambiguity (MT5 interprets naive as broker-local on
        # Windows, causing window misalignment when broker-TZ != system-TZ).
        recent_deals = mt5.history_deals_get(
            datetime.fromtimestamp(time.time() - lookback_s, tz=timezone.utc),
            datetime.now(timezone.utc),
        ) or []
        for d in recent_deals:
            m = getattr(d, "magic", 0)
            c = getattr(d, "comment", "")
            if m == MAGIC:
                comments.add(c)
            elif m == PING_MAGIC:
                ping_history_comments.add(c)
    except Exception:
        pass
    requeued = []
    cleaned = 0
    ping_orphans_closed = 0
    ping_cleaned = 0
    stale_orphans = 0
    for marker in markers:
        try:
            data = read_json(marker, {})
            is_ping = bool(data.get("ping"))
            if is_ping:
                # 2026-05-15 Codex-Audit Bug 3: handle ping markers separately.
                # A ping is "complete" only when (a) any magic=232 open
                # position has been closed AND (b) no magic=232 orphan is
                # still open for the symbol. If an orphan ping position is
                # still alive, force-close it now — generic order management
                # ignores magic=232 entirely.
                ping_symbol = data.get("symbol", "")
                orphan = [p for p in ping_positions if getattr(p, "symbol", "") == ping_symbol]
                if orphan:
                    for pos in orphan:
                        try:
                            tick = mt5.symbol_info_tick(ping_symbol)
                            if tick is None or tick.bid <= 0 or tick.ask <= 0:
                                continue
                            opposite = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
                            close_price = tick.bid if pos.type == mt5.ORDER_TYPE_BUY else tick.ask
                            close_req = {
                                "action": mt5.TRADE_ACTION_DEAL,
                                "symbol": ping_symbol,
                                "volume": pos.volume,
                                "type": opposite,
                                "position": pos.ticket,
                                "price": close_price,
                                "deviation": 20,
                                "magic": PING_MAGIC,
                                "comment": "iter236-ping-recover",
                                "type_filling": _pick_filling_mode(ping_symbol),
                            }
                            res = mt5.order_send(close_req)
                            if res is not None and getattr(res, "retcode", None) == mt5.TRADE_RETCODE_DONE:
                                ping_orphans_closed += 1
                            else:
                                log_event(
                                    "ping_orphan_close_failed",
                                    ticket=getattr(pos, "ticket", None),
                                    retcode=getattr(res, "retcode", None),
                                    level="warn",
                                )
                        except Exception as e:
                            log_event("ping_orphan_close_exception", error=str(e), level="warn")
                # Marker can be cleaned in any case — if we crashed before
                # ping_dates.append, the date was lost anyway; main_loop will
                # try a fresh ping on the next cycle when today's date is
                # not in ping_dates.
                marker.unlink(missing_ok=True)
                ping_cleaned += 1
                continue
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
                # 2026-05-15 Codex-Audit Bug 3: only re-queue if the marker
                # carries an actual signal payload. Empty `sig` could come
                # from a corrupt/legacy file; re-queueing {} previously
                # filled pending-signals.json with no-op blanks.
                # 2026-05-20 bug-find round fix (#3b): only re-queue if the
                # signal is still fresh. A stale orphan (older than the
                # staleness cap) would be silently dropped by the pending
                # processor → missed position with no trace. Re-queue fresh
                # ones; ALERT on stale ones so the operator can decide.
                if sig:
                    sig_ts = sig.get("signalBarClose") or sig.get("ts_ms")
                    age_ms = (
                        int(time.time() * 1000) - int(sig_ts)
                        if isinstance(sig_ts, (int, float)) else None
                    )
                    if age_ms is not None and age_ms > MAX_SIGNAL_AGE_MS:
                        log_event(
                            "stale_orphan_marker_not_requeued", level="warn",
                            asset=sig.get("assetSymbol"), age_ms=age_ms,
                        )
                        stale_orphans += 1
                    else:
                        requeued.append(sig)
                marker.unlink(missing_ok=True)
        except Exception as e:
            log_event("marker_reconcile_failed", marker=str(marker), error=str(e), level="warn")
    if requeued:
        # 2026-05-15 Codex-Audit Bug 2: take pending-signals.lock so a
        # concurrent Node signal-service writer + executor reconcile can't
        # race. Previously this read-modify-write happened lock-free → a
        # Node append in the gap would be lost (silently overwritten by
        # our merged dict).
        pending_lock = STATE_DIR / "pending-signals.lock"
        with _file_lock(pending_lock, timeout_sec=10.0, stale_sec=30.0):
            existing = read_json(PENDING_PATH, {"signals": []})
            existing["signals"] = existing.get("signals", []) + requeued
            write_json(PENDING_PATH, existing)
        log_event("orphan_signals_requeued", count=len(requeued))
        tg_send(f"🔄 <b>Recovery</b>\nRe-queued {len(requeued)} orphan signal(s) from previous crash")
    if ping_orphans_closed > 0:
        tg_send(f"🧹 <b>Ping-Recovery</b>\nClosed {ping_orphans_closed} orphan ping position(s) from previous crash")
    if stale_orphans > 0:
        tg_send(
            f"⚠️ <b>Stale orphan markers</b>\n{stale_orphans} crash-orphan signal(s) "
            f"too old to safely re-execute (>{MAX_SIGNAL_AGE_MS // 60000}min). Cleaned, "
            f"NOT re-queued — manual check if a position is missing."
        )
    log_event(
        "order_marker_reconcile_done",
        cleaned=cleaned,
        requeued=len(requeued),
        stale_orphans=stale_orphans,
        ping_cleaned=ping_cleaned,
        ping_orphans_closed=ping_orphans_closed,
        lookback_s=int(lookback_s),
    )


def _emergency_close_all_positions(reason: str) -> dict:
    """BUGFIX 2026-04-28 (Round 23 C2): force-close all open positions when
    daily-loss approaches breach. Was previously only blocking new signals
    while existing positions could still drag equity past -5%.

    BUGFIX 2026-04-28 (Round 36 Bug 1): keep tickets whose close FAILED in
    OPEN_POS_PATH so the next loop retries — wiping unconditionally meant
    a single requote/timeout left an orphan position at MT5 with no
    further trail/time-exit/close attempt → equity could still breach.

    R67-r12 audit fix (HIGH severity — affects PASSLOCK Pass-Lock guarantee):
    primary source-of-truth is now MT5, not OPEN_POS_PATH. The JSON file can
    be stale in two scenarios:
      1. crash between order_send and manage_open_positions writeback,
      2. PASSLOCK fires inside process_pending_signals before the next
         manage-cycle wrote the new ticket to OPEN_POS_PATH.
    With the old JSON-only iteration, fresh MT5 positions were missed,
    state["target_hit"]=True still set, and the Pass-Lock-Mode bouted out
    while live positions could still drag equity below target. We now
    iterate `mt5.positions_get(magic=231)` and merge JSON metadata for the
    Telegram pretty-print.
    """
    # R67-RR6 audit fix (MED): on MT5 disconnect, `mt5.positions_get()`
    # returns None (vs empty list = "no positions"). The previous `or []`
    # collapsed both into "nothing to close" → emergency-close no-op'd
    # silently and OPEN_POS_PATH got wiped, losing the JSON-tracked
    # tickets we'd need on next reconnect. Now we differentiate: None =
    # connection lost → bail out, KEEP the OPEN_POS_PATH so the next
    # cycle can retry once MT5 returns.
    mt5_live = mt5.positions_get()
    if mt5_live is None:
        log_event(
            "emergency_close_skipped_mt5_disconnect",
            reason=reason,
        )
        tg_send(
            "⚠️ <b>Emergency Close DEFERRED</b>\n"
            f"MT5 disconnected — cannot enumerate live positions. Reason: "
            f"{html_escape(reason)}. Will retry on next sync cycle."
        )
        # 2026-05-13 Codex Round 4 Python #4: signal that NO positions were
        # closed so callers don't latch PASSLOCK state on a deferred close.
        return {"closed": 0, "failed": 0, "all_closed": False, "deferred": True}
    # 2026-05-24 Codex audit MED FIX: prior filter caught only MAGIC,
    # missing PING_MAGIC orphans. If a daily ping trade was open when
    # an emergency close fired (DL/TL/news), the ping would survive,
    # bleeding equity while the executor marked all-clear. Match both
    # magics, like the external ftmo_kill.py at L330 already does.
    bot_positions = [
        p for p in mt5_live
        if getattr(p, "magic", 0) in (MAGIC, PING_MAGIC)
    ]
    open_json = read_json(OPEN_POS_PATH, {"positions": []}).get("positions", [])
    json_by_ticket = {
        p["ticket"]: p for p in open_json if isinstance(p, dict) and "ticket" in p
    }
    closed = 0
    failed_positions: list[dict] = []
    # Pass explicit exit_reason so the drift-monitor pipeline doesn't tag
    # emergency closes as TP/SL hits with bogus slippage.
    emergency_reason_tag = f"emergency:{reason[:32]}"
    for mt5_pos in bot_positions:
        ticket = mt5_pos.ticket
        meta = json_by_ticket.get(
            ticket,
            {
                "ticket": ticket,
                "signalAsset": getattr(mt5_pos, "symbol", "unknown"),
            },
        )
        if close_position(ticket, exit_reason_override=emergency_reason_tag):
            closed += 1
        else:
            failed_positions.append(meta)
    # Also keep any JSON-tracked tickets whose MT5 record disappeared but
    # we couldn't verify closure for (defensive — manage_open_positions
    # treats `position_gone` as success, but if MT5 was unreachable we
    # don't want to silently drop the row).
    mt5_ticket_set = {p.ticket for p in bot_positions}
    for ticket, meta in json_by_ticket.items():
        if ticket not in mt5_ticket_set:
            # Position no longer at MT5 — was already closed (SL/TP/manual).
            # Drop from retry list.
            continue
    if closed > 0:
        log_event("emergency_close", reason=reason, closed=closed, failed=len(failed_positions))
        tg_send(f"🚨 <b>Emergency Close {closed} positions</b>\nReason: {html_escape(reason)}", critical=True)
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
    # 2026-05-13 Codex Round 4 Python #4 (KRITISCH) — return outcome so
    # callers (esp. check_target_and_pause) can defer state-mutations
    # (target_hit latch) until ALL closes succeed AND broker equity is
    # refreshed. Returns {"closed": int, "failed": int, "all_closed": bool}.
    return {
        "closed": closed,
        "failed": len(failed_positions),
        "all_closed": len(failed_positions) == 0,
    }


# ---------------------------------------------------------------------------
# R3-B Drift-1: funding-cost / swap reconciliation (2026-05-15)
#
# The Rust backtest engine models funding/swap as a daily-cross deduction in
# `pnl.rs` (line 117-126). The live executor does NOT model funding/swap
# inside the management cycle — it implicitly relies on the MT5 broker's
# accounting at position close (`pos.swap`). This introduces silent drift
# between sim-projected PnL and live broker reality.
#
# Defense-in-depth: periodically compute the expected funding-cost burden
# based on currently-open positions × hold-duration × the per-asset
# swap_bp_per_day (from FUNDING_RATES env JSON), and compare against the
# sum of `pos.swap` reported by MT5. Drift above FUNDING_DRIFT_THRESHOLD
# (default 0.5% of start balance) raises an alert.
#
# Default: DISABLED (opt-in via FTMO_FUNDING_RECONCILE=1). Most FTMO crypto
# accounts have zero swap rates so the check would be noise. Enable on FX
# / commodities deploys or when comparing sim-vs-live drift in CI.
#
# Per-position close: when close_position(...) succeeds we ALSO log
# `expected_funding` vs `actual_swap` so a post-mortem can attribute drift
# to a specific instrument/period.
# ---------------------------------------------------------------------------
FUNDING_RECONCILE_ENABLED = os.environ.get(
    "FTMO_FUNDING_RECONCILE", ""
).lower() in ("1", "true", "yes")

# Per-asset annualised swap rate (basis points / day). Override via env JSON,
# e.g. FTMO_FUNDING_RATES='{"BTCUSD": 0.5, "ETHUSD": 0.3}'. Zero rates skip
# the per-position accrual; only assets with non-zero rates are reconciled.
try:
    FUNDING_RATES = json.loads(os.environ.get("FTMO_FUNDING_RATES", "{}"))
    if not isinstance(FUNDING_RATES, dict):
        FUNDING_RATES = {}
except (TypeError, ValueError):
    FUNDING_RATES = {}

# Alert threshold: report when |Σ expected − Σ actual| / start_balance > X.
FUNDING_DRIFT_THRESHOLD = float(
    os.environ.get("FTMO_FUNDING_DRIFT_THRESHOLD", "0.005")  # 0.5% of start
)
# Run reconciliation every N main-loop iterations (poll cycles).
FUNDING_RECONCILE_EVERY_N = int(
    os.environ.get("FTMO_FUNDING_RECONCILE_EVERY_N", "120")  # 120 × 30s = 1h
)

# Module-level cycle counter for periodic reconciliation.
_funding_reconcile_cycle_count = 0
# Rate-limit duplicate drift alerts (avoid spam during long-running drift).
_funding_drift_last_alert_ts: float = 0.0


def _expected_swap_for_position(pos: dict, now_ms: Optional[int] = None) -> float:
    """Return the engine-projected swap cost (USD) for ``pos`` so far.

    Mirrors the Rust `pnl.rs` cross-day swap accrual: ``swap_bp_per_day``
    × number of UTC-day crossings between entry and now, scaled by the
    notional implied by the position lot × entry_price. Returns 0.0 when
    the asset has no configured swap rate or required fields are missing.
    """
    asset = pos.get("signalAsset") or pos.get("sourceSymbol")
    if not asset:
        return 0.0
    rate_bp_per_day = float(FUNDING_RATES.get(asset, 0.0))
    if rate_bp_per_day <= 0.0:
        return 0.0
    opened_iso = pos.get("opened_at")
    if not opened_iso:
        return 0.0
    try:
        opened_dt = datetime.fromisoformat(opened_iso.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return 0.0
    if opened_dt.tzinfo is None:
        opened_dt = opened_dt.replace(tzinfo=timezone.utc)
    if now_ms is None:
        now_dt = datetime.now(timezone.utc)
    else:
        now_dt = datetime.fromtimestamp(now_ms / 1000.0, tz=timezone.utc)
    ms_per_day = 86_400_000
    entry_day = int(opened_dt.timestamp() * 1000) // ms_per_day
    exit_day = int(now_dt.timestamp() * 1000) // ms_per_day
    crossings = max(0, exit_day - entry_day)
    if crossings == 0:
        return 0.0
    lot = float(pos.get("lot") or 0.0)
    entry_price = float(pos.get("entry_price") or 0.0)
    if lot <= 0 or entry_price <= 0:
        return 0.0
    notional_usd = lot * entry_price
    return notional_usd * (rate_bp_per_day / 10_000.0) * crossings


def _reconcile_funding_drift(force: bool = False) -> Optional[dict]:
    """Compare engine-projected funding cost vs MT5-reported swap.

    Called once every FUNDING_RECONCILE_EVERY_N main-loop cycles. Returns
    None when disabled / no positions / no configured rates, else a dict
    with ``{expected, actual, drift, threshold}`` for inspection/tests.

    Side effects on drift detection:
      - ``log_event("funding_drift_detected", ...)``
      - Telegram alert (rate-limited to once per 15min per process)
    """
    global _funding_reconcile_cycle_count, _funding_drift_last_alert_ts
    if not FUNDING_RECONCILE_ENABLED:
        return None
    _funding_reconcile_cycle_count += 1
    if not force and _funding_reconcile_cycle_count % FUNDING_RECONCILE_EVERY_N != 0:
        return None
    if not FUNDING_RATES:
        return None
    open_positions = read_json(OPEN_POS_PATH, {"positions": []})
    positions = open_positions.get("positions", [])
    if not positions:
        return None

    # Expected: sum of per-position engine-projected swap accruals.
    expected_total = 0.0
    for pos in positions:
        expected_total += _expected_swap_for_position(pos)
    if expected_total == 0.0:
        # All open positions are zero-swap assets — nothing to reconcile.
        return None

    # Actual: sum of pos.swap from MT5 across our magic=231 tickets.
    actual_total = 0.0
    try:
        for pos in positions:
            live = mt5.positions_get(ticket=pos["ticket"])
            if live:
                actual_total += float(getattr(live[0], "swap", 0.0) or 0.0)
    except Exception as e:
        log_event(
            "funding_reconcile_mt5_failed", error=str(e), level="warn"
        )
        return None

    drift_usd = expected_total - actual_total
    drift_frac = drift_usd / CHALLENGE_START_BALANCE if CHALLENGE_START_BALANCE > 0 else 0.0
    summary = {
        "expected": expected_total,
        "actual": actual_total,
        "drift": drift_usd,
        "drift_frac": drift_frac,
        "threshold": FUNDING_DRIFT_THRESHOLD,
        "positions_checked": len(positions),
    }
    if abs(drift_frac) > FUNDING_DRIFT_THRESHOLD:
        log_event("funding_drift_detected", level="warn", **summary)
        # Rate-limit Telegram alerts to once per 15min so a multi-hour
        # divergence doesn't flood the channel.
        now_ts = time.time()
        if now_ts - _funding_drift_last_alert_ts > 900:
            _funding_drift_last_alert_ts = now_ts
            try:
                tg_send(
                    "⚠️ <b>Funding Drift Detected</b>\n"
                    f"Expected: ${expected_total:,.2f}\n"
                    f"Actual (MT5 swap): ${actual_total:,.2f}\n"
                    f"Drift: ${drift_usd:,.2f} ({drift_frac:.2%} of start balance)\n"
                    f"Threshold: {FUNDING_DRIFT_THRESHOLD:.2%}"
                )
            except Exception:
                # Telegram failure must never break the trade loop.
                pass
    else:
        log_event("funding_reconcile_ok", **summary)
    return summary


def manage_open_positions() -> None:
    open_positions = read_json(OPEN_POS_PATH, {"positions": []})
    now_ms = int(time.time() * 1000)
    still_open: list[dict] = []
    for pos in open_positions.get("positions", []):
        live = mt5.positions_get(ticket=pos["ticket"])
        if not live:
            # R3-B Drift-1: persist engine-projected funding cost so a
            # post-mortem can attribute live PnL drift to swap accruals.
            # Asset without a configured rate → expected=0.0 (no-op).
            expected_funding = _expected_swap_for_position(pos)
            log_event(
                "position_gone",
                ticket=pos["ticket"],
                reason="closed by SL/TP or manually",
                expected_funding_usd=round(expected_funding, 4),
                signal_asset=pos.get("signalAsset"),
            )
            tg_send(f"📉 <b>Position Closed (SL/TP)</b>\n{pos['signalAsset']} ticket <code>{pos['ticket']}</code>")
            continue
        # 2026-05-13 Codex Round 4 Python #3 FIX: max_hold_until=0 OR a
        # sentinel like JS Number.MAX_SAFE_INTEGER (9007199254740991) means
        # "no time exit configured". The TS wrapper now emits this sentinel
        # for V4-Sim parity (V4 simulator disables hold-bars time-exit;
        # ftmoLiveEngineV4.ts:997-1003). Only fire hold-expired when
        # max_hold_until is a realistic ms-timestamp (≤ 1e15 = year ~33658).
        max_hold = pos.get("max_hold_until", 0)
        if 0 < max_hold < 1_000_000_000_000_000 and now_ms >= max_hold:
            log_event("hold_expired", ticket=pos["ticket"])
            # 2026-05-15 Codex-Audit Wave-2 Bug 3 (HOCH): if close fails, keep
            # the position in still_open so the next loop retries instead of
            # silently dropping live-broker state. Previously `continue` ran
            # unconditionally → engine forgot the ticket while the live trade
            # kept running unmanaged.
            if close_position(pos["ticket"], exit_reason_override="hold_expired"):
                tg_send(f"⏱ <b>Hold Expired — Closed</b>\n{pos['signalAsset']} ticket <code>{pos['ticket']}</code>")
                continue
            log_event(
                "hold_expired_close_failed",
                ticket=pos["ticket"],
                level="warn",
            )
            # Fall through to normal management (BE/trail/etc.) so SL still
            # reacts. Next loop retries the hold-expired close.
            still_open.append(pos)
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

    # R56 audit fix: tz-aware datetimes for history_deals_get (broker-TZ safe).
    deals = mt5.history_deals_get(
        datetime.fromtimestamp(time.time() - 30 * 86400, tz=timezone.utc),
        datetime.now(timezone.utc),
    )
    recent_pnls: list[float] = []
    if deals:
        closes = [d for d in deals if d.magic == MAGIC and _is_close_deal(d)]
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
    tg_send("🛑 <b>Kill-request received</b> — closing all bot positions...", critical=True)
    # Bug-Audit Round 1: parity with _emergency_close_all_positions — distinguish
    # MT5 disconnect (None) from "no positions" (empty list). Previously `or []`
    # collapsed both → kill silently no-op'd on disconnect AND the killRequested
    # flag was cleared, losing the operator's emergency intent. Now we DEFER
    # (keep flag set, stay paused) so the next reconnect retries the kill.
    positions = mt5.positions_get()
    if positions is None:
        log_event("kill_request_deferred_mt5_disconnect", level="warn")
        tg_send(
            "⚠️ <b>Kill-request DEFERRED</b>\n"
            "MT5 disconnected — cannot enumerate positions. Bot remains PAUSED "
            "with killRequested set; will retry on next reconnect."
        )
        # Pause immediately even if we can't close yet — caller will retry.
        def _pause_only(c: dict) -> dict:
            c["paused"] = True
            return c
        update_controls(_pause_only)
        return False
    closed = 0
    failed = 0
    # 2026-05-16 Codex audit Bug #4: internal kill must also close PING
    # trades (magic=PING_MAGIC), matching the external `ftmo_kill.py` filter.
    # Previously only MAGIC matched → ping trades survived an internal kill
    # request, even though `/kill` is supposed to flatten EVERYTHING this bot
    # opened.
    bot_positions = [
        p for p in positions if getattr(p, "magic", 0) in (MAGIC, PING_MAGIC)
    ]
    for pos in bot_positions:
        if close_position(pos.ticket, exit_reason_override="kill_request"):
            closed += 1
        else:
            failed += 1
    # 2026-05-15 Codex-Audit Bug 5: only clear killRequested when ALL closes
    # succeeded. A silent clear after partial-fail previously left live
    # positions running while the operator saw "Kill complete" — defeating
    # the kill switch's safety guarantee. We always set paused=True so no
    # NEW signals fire, but keep killRequested=true so the next handle_kill_request
    # cycle retries the un-closed tickets.
    all_closed = failed == 0
    def _apply(c: dict) -> dict:
        if all_closed:
            c["killRequested"] = False
        # else: leave killRequested=True so next cycle retries.
        c["paused"] = True
        return c
    update_controls(_apply)
    if all_closed:
        tg_send(
            f"🛑 <b>Kill complete</b> — {closed} position(s) closed. "
            f"Bot is PAUSED. Send /resume to re-enable."
        )
        log_event("kill_complete", closed=closed)
    else:
        tg_send(
            f"⚠️ <b>Kill PARTIAL</b> — closed {closed}/{len(bot_positions)}, "
            f"{failed} FAILED. Bot stays PAUSED with killRequested still set; "
            f"executor will retry next cycle."
        )
        log_event("kill_partial", closed=closed, failed=failed, level="warn")
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
# Bug-Audit Round 3: seed-on-first-call sentinel. After process restart the
# module-global resets to 0, but the broker's deal history still shows the
# pre-restart losing streak. Without this sentinel, the very first
# check_circuit_breaker() poll after restart computes `streak > 0` and re-
# trips even immediately after the user issued /resume → /pause loop.
_cb_streak_seeded = [False]
_last_dd_warn_sent = [""]  # date of last dd warn sent, to avoid spam


def sample_equity_history(current_equity_usd: float) -> None:
    """Append equity snapshot to equity-history.jsonl every EQUITY_HISTORY_INTERVAL_SEC.

    R67-r9 audit: was missing rotation, lock, and fsync — at 288 lines/day
    × ~150 bytes ≈ 16MB/year per account, the file grew unbounded. Now
    rotated via _rotate_jsonl_if_needed (20MB cap), fsync'd for
    crash-durability, and lock-protected against future concurrent writers.
    """
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
    line = json.dumps(entry) + "\n"
    lock_path = STATE_DIR / "equity-history.lock"
    try:
        with _file_lock(lock_path, timeout_sec=2.0, stale_sec=2.0):
            _rotate_jsonl_if_needed(EQUITY_HISTORY_PATH, max_mb=20)
            with open(EQUITY_HISTORY_PATH, "a", encoding="utf-8") as f:
                f.write(line)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
    except Exception as e:
        # Don't crash the main loop on equity-history persistence failure.
        log_event("equity_history_write_failed", error=str(e), level="warn")


def check_circuit_breaker() -> Optional[str]:
    """
    Check recent closed trades (last 20 in 30d window) for consecutive losses.
    Returns a block-reason string if the CB trips, else None.
    Also sends daily-DD warning via Telegram once per day if threshold exceeded.
    """
    # R56 audit fix: tz-aware datetimes for history_deals_get (broker-TZ safe).
    deals = mt5.history_deals_get(
        datetime.fromtimestamp(time.time() - 30 * 86400, tz=timezone.utc),
        datetime.now(timezone.utc),
    )
    if not deals:
        return None

    closes = [d for d in deals if d.magic == MAGIC and _is_close_deal(d)]
    closes.sort(key=lambda d: d.time)

    # Count consecutive losses from most recent
    streak = 0
    for d in reversed(closes[-CB_LOSS_STREAK * 2:]):
        if d.profit < 0:
            streak += 1
        else:
            break

    # Bug-Audit Round 3: on the very first check after a process restart, the
    # in-memory `_last_cb_check_streak[0]` is 0 and any historical losing
    # streak satisfies `streak > 0` → the just-resumed bot gets immediately
    # re-paused. Seed the high-water mark to the observed historical streak
    # on first call so we only trip on a NEW loss that grows the streak.
    if not _cb_streak_seeded[0]:
        _last_cb_check_streak[0] = streak
        _cb_streak_seeded[0] = True
        return None

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


# Bug-Audit Round 3: previously an in-memory-only set. After a process
# restart the executor would re-announce + re-close on the SAME upcoming
# news event (because the event-timestamp dedupe was lost). With PM2
# auto-restarts that can easily happen during the 30-min approach window
# of a high-impact print → repeat Telegram alert + a second flatten pass
# that wipes any positions the trader manually re-opened in between.
# Persist to disk so restarts honor the dedupe.
NEWS_ANNOUNCED_PATH = STATE_DIR / "news-announced.json"


def _load_news_announced() -> set[int]:
    data = read_json(NEWS_ANNOUNCED_PATH, {"ts": []})
    out: set[int] = set()
    for t in data.get("ts", []):
        try:
            out.add(int(t))
        except (TypeError, ValueError):
            continue
    return out


def _save_news_announced(s: set[int]) -> None:
    write_json(NEWS_ANNOUNCED_PATH, {"ts": sorted(s)})


_news_closes_announced: set[int] = _load_news_announced()


def check_news_auto_close() -> None:
    """
    Read news-events.json (written by Node service). If any high-impact
    event is within NEWS_CLOSE_MINUTES_BEFORE minutes, close all bot
    positions and pause new entries briefly.
    """
    # 2026-05-20 bug-find round: respect the enable flag so a disabled
    # blackout config does not silently flatten positions.
    if not NEWS_AUTO_CLOSE_ENABLED:
        return
    data = read_json(NEWS_PATH, {"events": []})
    raw_events = data.get("events", [])
    if not raw_events:
        return

    # R67 audit fix: coerce timestamps to int once up-front. Original code
    # only coerced in the inclusion filter; downstream `e["timestamp"] in
    # _news_closes_announced` set-membership and `_news_closes_announced.add`
    # used the raw value. If the Node news-service ever emits timestamps as
    # strings (Zod-coerce, JSON.stringify quirks), the de-dupe set would
    # silently fail (every poll = new alert) and the eviction `<` mixes
    # str/int → TypeError. Drop malformed events with a warn.
    events: list[dict] = []
    for e in raw_events:
        ts_raw = e.get("timestamp", 0)
        try:
            ts = int(ts_raw)
        except (TypeError, ValueError):
            log_event("news_event_invalid_ts", raw=str(ts_raw)[:80], level="warn")
            continue
        events.append({**e, "timestamp": ts})

    now_ms = int(time.time() * 1000)
    threshold_ms = NEWS_CLOSE_MINUTES_BEFORE * 60 * 1000
    incoming = [
        e for e in events
        if 0 <= (e["timestamp"] - now_ms) <= threshold_ms
        and e.get("impact") == "High"
    ]
    if not incoming:
        return

    # Close all bot positions.
    # Bug-Audit Round 1: distinguish MT5 disconnect (None) from "no positions"
    # (empty list). Previously `or []` collapsed both — a news event arriving
    # during an MT5 outage would be marked as "announced" via the dedupe set
    # without ANY position being closed, and the alert would never re-fire
    # when the connection returned (high-impact news → unmanaged exposure).
    raw_positions = mt5.positions_get()
    if raw_positions is None:
        log_event("news_auto_close_skipped_mt5_disconnect", level="warn")
        tg_send(
            "⚠️ <b>News Auto-Close DEFERRED</b>\n"
            "MT5 disconnected — cannot enumerate positions. Will retry next poll."
        )
        return
    bot_positions = [p for p in raw_positions if p.magic == MAGIC]
    if bot_positions:
        # BUGFIX 2026-04-28: evict timestamps older than 7 days to prevent
        # unbounded set growth in long-running bot.
        cutoff_ms = now_ms - 7 * 24 * 3600 * 1000
        _news_closes_announced.difference_update(
            t for t in list(_news_closes_announced) if t < cutoff_ms
        )
        # Bug-Audit Round 3: previously the close-loop fired UNCONDITIONALLY
        # after the dedupe loop, even when every incoming event was already
        # announced (no fresh trigger). On a re-poll where positions briefly
        # re-appear (or were manually re-opened by the trader), this re-fired
        # closes without a corresponding Telegram alert. Now we only close
        # when at least one event in this poll is genuinely new.
        any_new = False
        for e in incoming:
            if e["timestamp"] in _news_closes_announced:
                continue
            any_new = True
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
        if any_new:
            # Bug-Audit Round 3: persist the announced-set so restarts don't
            # re-announce+re-close on the same event timestamp.
            _save_news_announced(_news_closes_announced)
            for pos in bot_positions:
                close_position(pos.ticket, exit_reason_override="news_blackout")


def check_consistency_rule() -> None:
    """
    FTMO Consistency Rule: no single trade may account for > 45% of total profit
    (varies: 30-50% depending on plan; FTMO Standard = 45%).
    We warn at 35% and alert hard at 42%.

    Scans last 60d of closed deals with magic=231, identifies largest winner,
    compares to total profit. If ratio exceeds warn threshold, sends Telegram.
    """
    # R56 audit fix: tz-aware datetimes for history_deals_get (broker-TZ safe).
    deals = mt5.history_deals_get(
        datetime.fromtimestamp(time.time() - 60 * 86400, tz=timezone.utc),
        datetime.now(timezone.utc),
    )
    if not deals:
        return
    closes = [d for d in deals if d.magic == MAGIC and _is_close_deal(d)]
    wins = [d for d in closes if d.profit > 0]
    if not wins:
        return

    total_profit = sum(d.profit for d in closes)
    if total_profit <= 0:
        return  # No net profit yet, rule not applicable

    largest = max(wins, key=lambda d: d.profit)
    ratio = largest.profit / total_profit

    # Bug-Audit Round 3: dedupe-key was UTC date — drifted ~1-2h from the FTMO
    # daily-reset boundary (Prague midnight). Result: at the Prague-day
    # rollover the warning would fire twice (once before, once after the UTC
    # boundary 1-2h later) or miss the rollover entirely depending on poll
    # phase. Anchor to the same TZ as handle_daily_reset.
    today = _prague_today_str()
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
    # Bug-Audit Round 3: dedupe-key was UTC date — drifted 1-2h from the
    # FTMO/Prague daily-reset boundary that handle_daily_reset uses. Parity
    # with check_consistency_rule fix.
    today = _prague_today_str()
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


def reconcile_missing_positions() -> None:
    """Round 57 (R57-PY-3): on boot, find positions that were open per
    open-positions.json but are NO LONGER on MT5 (closed during the
    executor off-period via SL/TP), and reconcile them via history_deals.

    Without this, the on-disk open-positions.json silently drops the
    ticket via `rebuild_open_positions_from_mt5`'s stale-cleanup, and
    the engine never sees the closing PnL. The trade is "lost" — but
    the broker's equity reflects it, so equity-tracking logic gets out
    of sync (peak/dayPeak/lossStreak/kelly all miss the trade).

    Strategy:
      1. Read the on-disk open positions (set A).
      2. Pull current MT5 positions (set B).
      3. For tickets in A \\ B (missing): query history_deals for the
         most recent deal with that POSITION_ID. Record exit-price,
         exit-time, and PnL into a `closed-during-offline.json` log
         for the upstream V4 engine to consume.

    Note: this is best-effort — if MT5 history is incomplete or the
    deal happened outside the search window (we look back 7 days),
    the ticket is dropped without reconciliation. Telegram alert
    notifies the user when this happens so they can investigate.
    """
    try:
        live_positions = mt5.positions_get() or []
    except Exception as e:
        log_event("reconcile_missing_mt5_get_failed", error=str(e))
        return
    live_tickets = {p.ticket for p in live_positions if getattr(p, "magic", None) == MAGIC}

    existing = read_json(OPEN_POS_PATH, {"positions": []})
    on_disk = existing.get("positions", [])
    if not on_disk:
        return

    missing = [p for p in on_disk if p.get("ticket") not in live_tickets]
    if not missing:
        return

    log_event("reconcile_missing_start", count=len(missing))
    # 2026-05-23 Wave2 fix (KRIT-2): widen lookback 7d → 14d to match the
    # WAL-marker reconcile path (reconcile_pending_order_markers) and survive
    # multi-day VPS outages that drove the Wave1 hunt.
    since = datetime.now(timezone.utc) - timedelta(days=14)
    until = datetime.now(timezone.utc)
    reconciled: list[dict] = []
    unreconciled: list[dict] = []

    for pos in missing:
        ticket = pos.get("ticket")
        if not ticket:
            continue
        try:
            # 2026-05-23 Wave2 fix (KRIT-3): query MT5 with `position=ticket`
            # instead of pulling all-deals-in-range and filtering in Python.
            # Avoids ~100k deal hard-limit + O(N²) cost across all missing
            # tickets. Fall back to time-range query if the broker MT5 build
            # lacks the kwarg (rare).
            deals = None
            try:
                deals = mt5.history_deals_get(position=ticket) or []
            except TypeError:
                deals = mt5.history_deals_get(since, until) or []
            if not deals:
                deals = mt5.history_deals_get(since, until) or []
            # Filter to this position's closing deal. MT5 deal has
            # `position_id` linking to the original open ticket; the
            # closing deal has entry in (DEAL_ENTRY_OUT, DEAL_ENTRY_INOUT,
            # DEAL_ENTRY_OUT_BY) depending on broker mode.
            #
            # Round 58 (Critical Fix #3): Round 57 only matched
            # DEAL_ENTRY_OUT (=1) which is the Netting-Mode close. FTMO
            # accounts can also be Hedge-Mode where:
            #   - DEAL_ENTRY_INOUT (=2) is a position-reversal (close +
            #     open opposite, e.g. long → short via single deal).
            #   - DEAL_ENTRY_OUT_BY (=3) is a "close by opposite position"
            #     fill where one position is closed against another.
            # Both produce a closing deal we must capture for reconcile.
            close_entry_codes = (
                getattr(mt5, "DEAL_ENTRY_OUT", 1),
                getattr(mt5, "DEAL_ENTRY_INOUT", 2),
                getattr(mt5, "DEAL_ENTRY_OUT_BY", 3),
            )
            close_deals = [
                d for d in deals
                if getattr(d, "position_id", None) == ticket
                and getattr(d, "entry", None) in close_entry_codes
            ]
            if not close_deals:
                unreconciled.append({"ticket": ticket, "symbol": pos.get("signalAsset")})
                continue
            # Pick the latest close deal for safety (positions can have
            # multiple partial closes — last one is the final exit).
            close_deals.sort(key=lambda d: getattr(d, "time", 0))
            final = close_deals[-1]
            exit_price = float(getattr(final, "price", 0.0))
            # 2026-05-23 Wave2 fix (KRIT-1): Rust ExitReason enum only accepts
            # tp|stop|time|manual (lowercase serde). Wave1 wrote "offline_close"
            # which made the Rust deserializer reject the WHOLE offline-log
            # file → all recovered trades silently lost. Map MT5 DEAL_REASON
            # to a Rust-known string; fall back to "manual" for everything else.
            mt5_reason = getattr(final, "reason", None)
            REASON_SL = getattr(mt5, "DEAL_REASON_SL", 4)
            REASON_TP = getattr(mt5, "DEAL_REASON_TP", 5)
            REASON_SO = getattr(mt5, "DEAL_REASON_SO", 6)  # Stop-Out (margin)
            if mt5_reason == REASON_TP:
                mapped_reason = "tp"
            elif mt5_reason in (REASON_SL, REASON_SO):
                mapped_reason = "stop"
            else:
                mapped_reason = "manual"
            # Prefer time_msc (millisecond precision) when MT5 provides it.
            time_msc = getattr(final, "time_msc", None)
            if isinstance(time_msc, (int, float)) and time_msc > 0:
                exit_time_ms = int(time_msc)
            else:
                exit_time_ms = int(getattr(final, "time", 0)) * 1000
            profit = float(getattr(final, "profit", 0.0))
            reconciled.append({
                "ticket": ticket,
                "symbol": pos.get("signalAsset", ""),
                "direction": pos.get("direction", ""),
                "entry_price": pos.get("entry_price"),
                "exit_price": exit_price,
                "exit_time_ms": exit_time_ms,
                "profit_usd": profit,
                "reconciled_at": datetime.now(timezone.utc).isoformat(),
                "reason": mapped_reason,
                "recovery_source": "offline_reconcile",  # diagnostic-only
            })
            log_event(
                "reconcile_missing_position",
                ticket=ticket,
                exit_price=exit_price,
                profit=profit,
            )
        except Exception as e:
            log_event(
                "reconcile_missing_position_failed",
                ticket=ticket,
                error=str(e),
                level="warn",
            )
            unreconciled.append({"ticket": ticket, "symbol": pos.get("signalAsset")})

    # Persist reconciled trades for V4 engine to consume on next state-load.
    if reconciled:
        offline_log_path = STATE_DIR / "closed-during-offline.json"
        existing_log = read_json(offline_log_path, {"trades": []})
        existing_log["trades"] = existing_log.get("trades", []) + reconciled
        write_json(offline_log_path, existing_log)
        tg_send(
            f"🔄 <b>Offline Reconcile</b>\n"
            f"{len(reconciled)} position(s) closed during offline period — see {offline_log_path.name}"
        )
    if unreconciled:
        tg_send(
            f"⚠️ <b>Reconcile Warning</b>\n"
            f"{len(unreconciled)} ticket(s) gone from MT5 with no matching history deal — manual check needed"
        )
    log_event(
        "reconcile_missing_done",
        reconciled=len(reconciled),
        unreconciled=len(unreconciled),
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
    bot_positions = [p for p in positions if getattr(p, "magic", None) == MAGIC]

    existing = read_json(OPEN_POS_PATH, {"positions": []})
    by_ticket = {p["ticket"]: p for p in existing.get("positions", [])}

    # 2026-05-20 Codex Round 4 Python #9 FIX: when on-disk open-positions state
    # is lost (crash/wipe) but the position is still live, recover the FULL
    # management config (PTP / chandelier / trailing / break-even / time-exit /
    # max-hold) from the executed-signals audit log keyed by MT5 ticket — each
    # "placed" execution persists the whole signal payload + ticket. Without
    # this the rebuilt stub had all modifiers None → positions silently lost
    # PTP/trail/chandelier and ran naked to broker SL/TP.
    executed_by_ticket: dict[int, dict] = {}
    try:
        _ex = read_json(EXECUTED_PATH, {"executions": []})
        for _e in _ex.get("executions", []):
            if _e.get("result") == "placed" and _e.get("ticket") is not None and _e.get("signal"):
                # Last write wins (most recent placement for this ticket).
                executed_by_ticket[int(_e["ticket"])] = _e
    except Exception as e:
        log_event("rebuild_executed_log_read_failed", error=str(e), level="warn")

    rebuilt: list[dict] = []
    added = 0
    kept = 0
    recovered = 0
    for live in bot_positions:
        ticket = live.ticket
        if ticket in by_ticket:
            # Preserve trailing/PTP/chandelier state from on-disk record.
            rebuilt.append(by_ticket[ticket])
            kept += 1
            continue

        direction = "long" if live.type == mt5.POSITION_TYPE_BUY else "short"
        ex_rec = executed_by_ticket.get(ticket)
        # 2026-05-20 bug-find round fix (B2): guard against cross-challenge
        # ticket REUSE. FTMO assigns a fresh low ticket counter per challenge
        # but reuses the same STATE_DIR/FTMO_TF, so a stale "placed" record from
        # an old challenge can share a ticket int with a NEW live position. State
        # files are not challenge-scoped, so verify the executed record actually
        # describes THIS live position: same direction AND entry price within
        # entry-slippage tolerance. On mismatch, treat as no record → safe stub.
        if ex_rec is not None:
            _rec_dir = ex_rec.get("signal", {}).get("direction")
            _rec_entry = ex_rec.get("actual_entry") or ex_rec.get("signal", {}).get("entryPrice")
            _dir_ok = _rec_dir == direction
            _entry_ok = (
                isinstance(_rec_entry, (int, float)) and _rec_entry > 0
                and abs(live.price_open - _rec_entry) / _rec_entry <= MAX_ENTRY_SLIPPAGE_PCT * 4
            )
            if not (_dir_ok and _entry_ok):
                log_event(
                    "rebuild_stale_record_rejected", level="warn", ticket=ticket,
                    rec_dir=_rec_dir, live_dir=direction,
                    rec_entry=_rec_entry, live_entry=live.price_open,
                )
                ex_rec = None  # fall through to minimal stub
        if ex_rec is not None:
            # Recover full config from the persisted signal payload. Broker
            # position is source-of-truth for live lot/entry/SL/TP; the signal
            # supplies the management config that the stub could not.
            sig = ex_rec["signal"]
            orig_lot = float(ex_rec.get("lot") or live.volume)
            # If the live volume is below the original, ≥1 partial-TP already
            # fired before the state loss. We cannot know WHICH levels, so mark
            # all PTP levels done (prevents a double scale-out on the now-smaller
            # position — the safe direction). Trailing/chandelier/break-even
            # re-arm naturally on the next manage cycle, so they default to
            # not-yet-fired and re-evaluate against current price.
            ptp_already_fired = live.volume < orig_lot * 0.99
            ptp_levels = sig.get("partialTakeProfitLevels")
            n_levels = len(ptp_levels) if ptp_levels else 0
            mhu = sig.get("maxHoldUntil")
            rebuilt.append({
                "ticket": ticket,
                "engine_ticket_id": sig.get(
                    "engineTicketId",
                    f"{sig.get('assetSymbol', live.symbol)}@{sig.get('entryTime', sig.get('signalBarClose', 0))}@{direction}",
                ),
                "engine_entry_time": sig.get("entryTime"),
                "signalAsset": sig.get("assetSymbol", live.symbol),
                "sourceSymbol": sig.get("sourceSymbol", live.symbol),
                "direction": direction,
                "lot": live.volume,
                "original_lot": orig_lot,
                # 2026-05-21 bug-round: persist effective_risk_frac on crash-
                # recovery rebuild. Normal placement stores it (used by the
                # aggregate portfolio-risk cap, which reads
                # p.get("effective_risk_frac", 0)). Without it, rebuilt positions
                # contributed 0 → the cap UNDER-counted open exposure after a
                # restart and could admit entries that breach PORTFOLIO_MAX_RISK.
                # Reconstruct from the signal's riskFrac clamped to the hard cap
                # (exact for the common tier_mult==1 path; conservative-ish else).
                "effective_risk_frac": round(
                    min(float(sig.get("riskFrac", 0) or 0), RISK_FRAC_HARD_CAP), 6
                ),
                "entry_price": live.price_open,
                "stop_price": live.sl or 0.0,
                "tp_price": live.tp or 0.0,
                "signal_stop_price": sig.get("stopPrice"),
                "signal_tp_price": sig.get("tpPrice"),
                "original_stop_pct": sig.get("stopPct"),
                "peak_price_seen": live.price_open,
                "max_hold_until": mhu if isinstance(mhu, (int, float)) else 0,
                "opened_at": datetime.fromtimestamp(live.time, tz=timezone.utc).isoformat(),
                "trailing_stop": sig.get("trailingStop"),
                "trailing_activated": False,
                "partial_tp": sig.get("partialTakeProfit"),
                "partial_tp_done": ptp_already_fired,
                "partial_tp_levels": ptp_levels,
                "partial_tp_levels_done": [ptp_already_fired] * n_levels,
                "chandelier": sig.get("chandelierExit"),
                "chandelier_armed": False,
                "chandelier_best_close": None,
                "break_even": sig.get("breakEvenAtProfit"),
                "break_even_done": False,
                "time_exit": sig.get("timeExit"),
                "time_exit_reached_min_gain": False,
                "_rebuilt_from_executed_log": True,
            })
            recovered += 1
            continue

        # Minimal stub — no executed-log record for this ticket (e.g. opened by
        # a different bot version / log pruned). Allows time-exit + max-hold to
        # fire; trailing-stop / PTP / chandelier cannot be resumed → left None.
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
        recovered_from_log=recovered,
        added_stubs=added,
        dropped_stale=dropped,
    )


def backfill_original_lot_on_boot() -> None:
    """Phase 57 (R45-3): backfill `original_lot` on positions placed before
    Phase 39 introduced the field.

    Without backfill, `_apply_partial_tp_levels` falls back to current
    `p.volume` for those positions — closing less than intended on
    subsequent levels. Best-effort guess: current volume (correct if no
    partial has fired yet; if a partial did fire we under-close, which
    is the safe direction).
    """
    try:
        existing = read_json(OPEN_POS_PATH, {"positions": []})
        positions = existing.get("positions", [])
        patched = 0
        for pos in positions:
            if "original_lot" not in pos:
                pos["original_lot"] = float(pos.get("lot") or 0.0)
                patched += 1
        if patched > 0:
            write_json(OPEN_POS_PATH, {"positions": positions})
            log_event("backfill_original_lot_complete", patched=patched)
    except Exception as e:
        log_event("backfill_original_lot_failed", error=str(e))


def acquire_singleton_or_exit() -> None:
    """Refuse to start when another executor is already running on this state dir.

    Two concurrent executors → racing MT5 order_send + clobbered state files.
    We write our PID into STATE_DIR/executor.pid; if the file already exists
    AND the recorded PID is alive, exit. Stale PID files are taken over.
    """
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    pid_file = STATE_DIR / "executor.pid"

    # 2026-05-14 Codex Wave-2 Bug #4 FIX: atomic O_CREAT|O_EXCL replaces the
    # read-then-write race. Two simultaneous launches can no longer both
    # observe "no peer" + both win the write. On EEXIST we probe liveness
    # and, only if the peer is dead, unlink + retry atomic-create.
    def _try_atomic_create() -> bool:
        try:
            flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
            fd = os.open(str(pid_file), flags, 0o644)
            try:
                os.write(fd, str(os.getpid()).encode("ascii"))
            finally:
                os.close(fd)
            return True
        except FileExistsError:
            return False
        except Exception:
            # EACCES / EROFS / ENOSPC — best-effort, match prior fallback.
            return False

    def _peer_alive(pid: int) -> bool:
        try:
            if os.name == "nt":  # type: ignore[reportUnnecessaryComparison]
                import ctypes
                PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
                handle = ctypes.windll.kernel32.OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION, False, pid
                )
                if handle:
                    ctypes.windll.kernel32.CloseHandle(handle)
                    return True
                return False
            os.kill(pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False
        except Exception:
            return False

    if not _try_atomic_create():
        # EEXIST: someone holds the slot. Inspect their PID.
        try:
            other_pid = int(pid_file.read_text().strip())
        except Exception:
            other_pid = 0
        if other_pid > 0 and other_pid != os.getpid() and _peer_alive(other_pid):
            msg = (
                f"Another ftmo_executor is already running "
                f"(pid={other_pid}, state_dir={STATE_DIR}). Refusing to start."
            )
            print(msg, file=sys.stderr)
            log_event("singleton_refused", other_pid=other_pid)
            sys.exit(11)
        # Peer is dead (or pidfile malformed). Try to take over atomically.
        try:
            pid_file.unlink()
        except Exception:
            pass
        if not _try_atomic_create():
            # Someone won the race between our unlink and create.
            try:
                race_pid = int(pid_file.read_text().strip())
            except Exception:
                race_pid = 0
            msg = (
                f"ftmo_executor lost race for state-dir lock "
                f"(other_pid={race_pid}, state_dir={STATE_DIR})."
            )
            print(msg, file=sys.stderr)
            log_event("singleton_refused", other_pid=race_pid)
            sys.exit(11)

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
    global _consecutive_loop_errors
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
    # Round 57 (R57-PY-3): reconcile positions that disappeared from MT5
    # while we were offline (SL/TP fired during downtime). Must run BEFORE
    # `rebuild_open_positions_from_mt5` so we can read the on-disk
    # positions list before it gets overwritten with the bare MT5 snapshot.
    # Logs offline closes to `closed-during-offline.json` for V4 engine
    # to consume on next state-load.
    reconcile_missing_positions()
    # Round-7 #11: reconcile on-disk position state with MT5 truth on boot.
    # Critical when the executor restarts while trades are open.
    rebuild_open_positions_from_mt5()
    # Phase 57 (R45-3): backfill `original_lot` on existing open positions
    # placed before Phase 39. Without this, the partial-TP-levels math
    # falls back to current `p.volume` for those positions, closing less
    # than intended on subsequent levels. Best-effort guess: current
    # volume (correct if no partial has fired yet; if a partial did fire
    # we under-close — safe direction).
    backfill_original_lot_on_boot()

    mode = "MOCK" if MOCK_MODE else "LIVE (MT5)"
    tg_send(
        f"🤖 <b>FTMO Executor ONLINE</b> [{mode}]\n"
        f"Start balance: ${CHALLENGE_START_BALANCE:,.0f}\n"
        f"Daily-loss cap: -{MAX_DAILY_LOSS_PCT:.0%}\n"
        f"Total-loss cap: -{MAX_TOTAL_LOSS_PCT:.0%}\n"
        f"Start gate: {'ON' if START_GATE_ENABLED else 'OFF'}\n"
        f"Start gate rule: {START_GATE_WINDOW_HOURS:g}h "
        f"breadth>={START_GATE_MIN_BREADTH} majors>={START_GATE_MIN_MAJORS}\n"
        f"Cluster-only entries: {'ON' if CLUSTER_ONLY_ENABLED else 'OFF'}\n"
        f"Poll interval: {POLL_INTERVAL_SEC}s"
    )
    log_event(
        "executor_started",
        mode=mode,
        state_dir=str(STATE_DIR),
        start_gate=START_GATE_ENABLED,
        cluster_only=CLUSTER_ONLY_ENABLED,
        start_gate_path=str(START_GATE_PATH),
        start_gate_window_hours=START_GATE_WINDOW_HOURS,
        start_gate_min_breadth=START_GATE_MIN_BREADTH,
        start_gate_min_majors=START_GATE_MIN_MAJORS,
        start_gate_min_history_hours=START_GATE_MIN_HISTORY_HOURS,
    )

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
                    # Bug-Audit Round 4 (HIGH severity — PASSLOCK race):
                    # check_target_and_pause was ONLY called from inside
                    # _process_pending_signals_locked, so if equity crossed
                    # the profit-target mid-cycle via a PTP partial fire,
                    # trailing-stop tick, or natural SL/TP exit, the pause
                    # flag was not set until the NEXT signal-processing
                    # call — leaving a poll-interval-wide window where new
                    # positions could be opened OR existing positions could
                    # drift back below target without the closeAllOn-
                    # TargetReached PASSLOCK firing. We now run the check
                    # once per loop iteration BEFORE manage_open_positions
                    # / process_pending_signals so the equity-crossing is
                    # caught in the same cycle. check_target_and_pause is
                    # idempotent: subsequent calls after target_hit=True
                    # short-circuit on `state["passed"]` or the early
                    # `target_hit` write+log block, so this only fires
                    # the emergency-close-all on the FIRST detection.
                    check_target_and_pause(acct["equity"])

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

                # R3-B Drift-1: periodic funding/swap reconciliation. Returns
                # early when disabled (default), no open positions, or not at
                # the configured cycle boundary. See _reconcile_funding_drift.
                try:
                    _reconcile_funding_drift()
                except Exception as e:
                    log_event("funding_reconcile_error", error=str(e), level="warn")

                # iter236+: place daily ping trade if target was hit (for FTMO 5-day rule)
                maybe_place_ping_trade()
                # 2026-05-20 bug-find round: a fully clean cycle resets the
                # consecutive-error counter (fail-closed auto-pause below).
                _consecutive_loop_errors = 0
            except Exception as e:
                log_event("loop_error", error=str(e))
                # 2026-05-20 bug-find round: fail-CLOSED on repeated errors. If a
                # cycle keeps throwing (e.g. before the breach-close in
                # sync_account_state), pause so equity can't silently bleed while
                # the loop just logs + re-polls. Critical alert bypasses backoff.
                _consecutive_loop_errors += 1
                if (
                    LOOP_ERROR_AUTO_PAUSE > 0
                    and _consecutive_loop_errors >= LOOP_ERROR_AUTO_PAUSE
                    and not is_paused()
                ):
                    update_controls(lambda c: {**c, "paused": True, "lastCommand": {
                        "ts": datetime.now(timezone.utc).isoformat(),
                        "cmd": "/auto-pause",
                        "reason": f"{_consecutive_loop_errors} consecutive loop errors",
                    }})
                    tg_send(
                        f"🛑 <b>BOT AUTO-PAUSED</b>\n{_consecutive_loop_errors} consecutive "
                        f"loop errors — equity protection may be impaired.\n"
                        f"Last: <code>{html_escape(str(e)[:120])}</code>\nInvestigate + /resume.",
                        critical=True,
                    )
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
        # 2026-05-23 Wave1 audit fix (HIGH): final state flush BEFORE mt5
        # shutdown. SIGTERM mid-cycle previously left open positions only
        # in the LAST committed write_json — if SIGTERM landed between
        # mt5.order_send and the subsequent write_json, the ticket lived
        # at broker but was missing from disk → orphan-rescue via WAL
        # markers only. Final-flush all live MT5 positions to open-positions.json
        # so reconciliation on restart starts from authoritative truth.
        try:
            live = mt5.positions_get() or []
            mine = [
                p for p in live
                if getattr(p, "magic", 0) in (MAGIC, PING_MAGIC)
            ]
            snapshot = [
                {
                    "ticket": int(p.ticket),
                    "symbol": p.symbol,
                    "direction": "long" if p.type == mt5.POSITION_TYPE_BUY else "short",
                    "lot": float(p.volume),
                    "entry_price": float(p.price_open),
                    "sl": float(p.sl) if p.sl else None,
                    "tp": float(p.tp) if p.tp else None,
                    "profit_usd": float(p.profit),
                    "magic": int(p.magic),
                    "time_msc": int(getattr(p, "time_msc", 0)),
                    "comment": str(getattr(p, "comment", "")),
                    "_snapshot_reason": "sigterm_cleanup",
                    "_snapshot_at": datetime.now(timezone.utc).isoformat(),
                }
                for p in mine
            ]
            sigterm_snapshot_path = STATE_DIR / "positions-sigterm-snapshot.json"
            write_json(sigterm_snapshot_path, {"snapshotAt": int(time.time()), "positions": snapshot})
            log_event("sigterm_position_snapshot", count=len(snapshot))
        except Exception as e:
            log_event("sigterm_snapshot_failed", error=str(e), level="warn")
        try:
            mt5.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    # BUGFIX 2026-04-28 (Round 23 C1): handle SIGTERM (sent by PM2 on restart)
    # so we trigger the same KeyboardInterrupt cleanup path. Without this,
    # MT5 connection terminates mid-order_send → orphan trades without SL/TP.
    import signal as _signal
    def _on_sigterm(*_):
        # signal-handler signature requires *args; we ignore them.
        raise KeyboardInterrupt()
    try:
        _signal.signal(_signal.SIGTERM, _on_sigterm)
    except (AttributeError, ValueError):
        pass  # Windows doesn't support all signals
    main_loop()
