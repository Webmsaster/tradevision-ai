"""
Pre-Flight Check — runnable BEFORE first `pm2 start ecosystem.config.js`.

Verifies all preconditions for a safe live FTMO deploy. Exits 0 if GO,
exits 1 if NO-GO with a list of blocking issues.

Usage:
    python tools/preflight_check.py
    # or with custom env file:
    python tools/preflight_check.py .env.ftmo.demo2

Exit codes:
    0  GO — all checks passed
    1  NO-GO — blocking issue, deploy aborted
    2  Configuration error — file missing or unreadable
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from urllib import request as urlreq
from urllib.error import HTTPError, URLError

# Re-use the executor's token-redaction helper to avoid leaking tokens in logs
sys.path.insert(0, str(Path(__file__).parent))


def _green(s: str) -> str:
    return f"\033[92m{s}\033[0m"


def _red(s: str) -> str:
    return f"\033[91m{s}\033[0m"


def _yellow(s: str) -> str:
    return f"\033[93m{s}\033[0m"


def _redact_token(s: str) -> str:
    """Strip /bot<digits>:<token> URLs from any logged string."""
    import re
    return re.sub(r"/bot\d+:[A-Za-z0-9_-]+", "/bot<REDACTED>", s)


# =============================================================================
# Check helpers
# =============================================================================

class Result:
    def __init__(self, name: str, ok: bool, msg: str, blocking: bool = True):
        self.name = name
        self.ok = ok
        self.msg = msg
        self.blocking = blocking

    def render(self) -> str:
        if self.ok:
            return f"  {_green('✓')} {self.name}: {self.msg}"
        prefix = _red("✗") if self.blocking else _yellow("⚠")
        return f"  {prefix} {self.name}: {self.msg}"


def check(name: str, blocking: bool = True) -> Callable[[Callable[[], tuple[bool, str]]], Callable[[], Result]]:
    def deco(fn: Callable[[], tuple[bool, str]]) -> Callable[[], Result]:
        def wrapped() -> Result:
            try:
                ok, msg = fn()
                return Result(name, ok, msg, blocking)
            except Exception as e:
                return Result(name, False, f"check threw: {e}", blocking)
        return wrapped
    return deco


# =============================================================================
# Individual checks
# =============================================================================

@check("FTMO_TF env var", blocking=True)
def check_ftmo_tf() -> tuple[bool, str]:
    tf = os.environ.get("FTMO_TF")
    if not tf:
        return False, "missing — set to e.g. 2h-trend-v5-quartz-lite-r28-v6-v4engine"
    if "r28-v6" not in tf:
        return True, f"{tf} (note: not R28_V6 — current champion is r28-v6-v4engine)"
    return True, tf


@check("FTMO_ACCOUNT_ID env var (multi-account)", blocking=False)
def check_account_id() -> tuple[bool, str]:
    aid = os.environ.get("FTMO_ACCOUNT_ID")
    if not aid:
        return False, "missing — single-account legacy mode (OK for one bot, set for multi)"
    if not aid.replace("_", "").replace("-", "").isalnum():
        return False, f"contains invalid chars: {aid!r}"
    return True, aid


@check("FTMO_EXPECTED_LOGIN env var (R57 safety)", blocking=False)
def check_expected_login() -> tuple[bool, str]:
    el = os.environ.get("FTMO_EXPECTED_LOGIN")
    if not el:
        return False, "missing — bot will trade on whichever MT5 account is logged in (RISKY)"
    if not el.isdigit():
        return False, f"must be integer (FTMO MT5 login is numeric): {el!r}"
    return True, f"{el} — bot will exit if MT5 connects to different account"


@check("FTMO_START_BALANCE env var", blocking=True)
def check_start_balance() -> tuple[bool, str]:
    sb = os.environ.get("FTMO_START_BALANCE", "100000")
    try:
        v = float(sb)
        if v <= 0:
            return False, f"must be positive: {sb!r}"
        return True, f"{int(v)} USD"
    except ValueError:
        return False, f"not a number: {sb!r}"


@check("Telegram bot token", blocking=True)
def check_telegram_token() -> tuple[bool, str]:
    aid = os.environ.get("FTMO_ACCOUNT_ID")
    # Per-account convention from R57
    token = (
        os.environ.get(f"TELEGRAM_BOT_TOKEN_{aid}") if aid else None
    ) or os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        return False, "missing — set TELEGRAM_BOT_TOKEN (or _<ACCOUNT_ID>) from @BotFather"
    if ":" not in token or len(token) < 35:
        return False, f"token format suspicious (expected 1234567890:ABC..., got len={len(token)})"
    # Verify with /getMe
    url = f"https://api.telegram.org/bot{token}/getMe"
    try:
        req = urlreq.Request(url, headers={"User-Agent": "preflight"})
        with urlreq.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if not data.get("ok"):
                return False, f"Telegram /getMe replied not-OK: {data!r}"
            bot = data.get("result", {})
            return True, f"@{bot.get('username', '?')} (id={bot.get('id', '?')})"
    except HTTPError as e:
        if e.code == 401:
            return False, "401 Unauthorized — token is wrong or revoked"
        if e.code == 404:
            return False, "404 — bot doesn't exist (token may be deleted)"
        return False, _redact_token(f"HTTP {e.code}: {e}")
    except URLError as e:
        return False, _redact_token(f"network: {e}")


@check("Telegram chat ID", blocking=True)
def check_telegram_chat() -> tuple[bool, str]:
    aid = os.environ.get("FTMO_ACCOUNT_ID")
    cid = (
        os.environ.get(f"TELEGRAM_CHAT_ID_{aid}") if aid else None
    ) or os.environ.get("TELEGRAM_CHAT_ID")
    if not cid:
        return False, "missing — set TELEGRAM_CHAT_ID (positive integer)"
    try:
        cid_int = int(cid)
        if cid_int <= 0:
            return False, f"chat ID must be positive (got {cid_int}); negative = group/channel"
        return True, f"chat={cid_int}"
    except ValueError:
        return False, f"not an integer: {cid!r}"


@check("State directory writable", blocking=True)
def check_state_dir() -> tuple[bool, str]:
    tf = os.environ.get("FTMO_TF", "default")
    aid = os.environ.get("FTMO_ACCOUNT_ID")
    explicit = os.environ.get("FTMO_STATE_DIR")
    if explicit:
        sd = Path(explicit)
    elif aid:
        sd = Path.cwd() / f"ftmo-state-{tf}-{aid}"
    else:
        sd = Path.cwd() / f"ftmo-state-{tf}"
    try:
        sd.mkdir(parents=True, exist_ok=True)
        test_file = sd / ".preflight_test"
        test_file.write_text("ok")
        test_file.unlink()
        return True, str(sd)
    except OSError as e:
        return False, f"cannot write to {sd}: {e}"


@check("Disk free space > 1GB", blocking=False)
def check_disk_space() -> tuple[bool, str]:
    import shutil
    try:
        free = shutil.disk_usage(Path.cwd()).free
        gb = free / (1024**3)
        if gb < 1.0:
            return False, f"only {gb:.2f} GB free (recommend >1 GB for logs + state)"
        return True, f"{gb:.1f} GB free"
    except OSError as e:
        return False, f"cannot stat disk: {e}"


@check("Binance API reachable", blocking=False)
def check_binance() -> tuple[bool, str]:
    try:
        url = "https://fapi.binance.com/fapi/v1/ping"
        with urlreq.urlopen(url, timeout=5) as resp:
            if resp.status == 200:
                # also check time skew
                t_url = "https://fapi.binance.com/fapi/v1/time"
                with urlreq.urlopen(t_url, timeout=5) as t_resp:
                    server_ms = json.loads(t_resp.read().decode())["serverTime"]
                local_ms = int(time.time() * 1000)
                skew_ms = abs(server_ms - local_ms)
                if skew_ms > 5000:
                    return False, f"clock skew {skew_ms}ms (Binance rejects requests > 5s skew)"
                return True, f"reachable, clock skew {skew_ms}ms (OK)"
            return False, f"unexpected status {resp.status}"
    except (HTTPError, URLError) as e:
        return False, f"unreachable: {e}"


@check("MT5 module available", blocking=False)
def check_mt5_module() -> tuple[bool, str]:
    if os.environ.get("FTMO_MOCK") == "1":
        return True, "FTMO_MOCK=1 set — using mock_mt5 (skip real MT5 check)"
    try:
        import MetaTrader5  # noqa: F401
        return True, f"MetaTrader5 v{MetaTrader5.__version__}"
    except ImportError:
        return False, "MetaTrader5 not installed (Windows-only); run `pip install MetaTrader5`"


@check("MT5 connect + expected login (R57)", blocking=True)
def check_mt5_connect() -> tuple[bool, str]:
    if os.environ.get("FTMO_MOCK") == "1":
        return True, "FTMO_MOCK=1 — skipping real MT5 connect"
    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError:
        return False, "MetaTrader5 not installed (skipping)"
    if not mt5.initialize():
        err = mt5.last_error()
        return False, f"initialize() failed: {err}"
    info = mt5.account_info()
    if info is None:
        mt5.shutdown()
        return False, "account_info() returned None — terminal not logged in?"
    expected = os.environ.get("FTMO_EXPECTED_LOGIN")
    if expected:
        try:
            exp_int = int(expected)
            if info.login != exp_int:
                mt5.shutdown()
                return False, f"WRONG ACCOUNT — connected to {info.login}, expected {exp_int}"
        except ValueError:
            mt5.shutdown()
            return False, f"FTMO_EXPECTED_LOGIN={expected!r} not an integer"
    bal = info.balance
    server = info.server
    mt5.shutdown()
    return True, f"login={info.login} balance={bal:.2f} server={server}"


@check("News-blackout module loadable", blocking=False)
def check_news_blackout() -> tuple[bool, str]:
    try:
        from news_blackout import HIGH_IMPACT_EVENTS_2026
        n = len(HIGH_IMPACT_EVENTS_2026)
        if n < 30:
            return False, f"only {n} hardcoded 2026 events (expected 48)"
        return True, f"{n} hardcoded 2026 events loaded"
    except ImportError as e:
        return False, f"cannot import news_blackout: {e}"


@check("ftmo_executor module loadable", blocking=True)
def check_ftmo_executor() -> tuple[bool, str]:
    try:
        os.environ.setdefault("FTMO_MOCK", "1")  # avoid actual MT5 connect
        import ftmo_executor as exe
        # sanity: required functions present
        required = ["place_market_order", "handle_daily_reset", "check_ftmo_rules"]
        missing = [n for n in required if not hasattr(exe, n)]
        if missing:
            return False, f"missing functions: {missing}"
        return True, "all critical functions present"
    except Exception as e:
        return False, f"import failed: {e}"


@check("Regime gate config", blocking=False)
def check_regime_gate() -> tuple[bool, str]:
    enabled = os.environ.get("REGIME_GATE_ENABLED", "false").lower() == "true"
    if not enabled:
        return True, "disabled (default — bot trades all regimes)"
    block = os.environ.get("REGIME_GATE_BLOCK", "trend-down")
    valid = {"trend-up", "trend-down", "chop", "high-vol", "calm"}
    blocks = [b.strip() for b in block.split(",")]
    invalid = [b for b in blocks if b not in valid]
    if invalid:
        return False, f"invalid regime tokens: {invalid} (valid: {sorted(valid)})"
    return True, f"enabled — blocks: {blocks}"


@check("Slippage modeling config", blocking=False)
def check_slippage() -> tuple[bool, str]:
    e = os.environ.get("SLIPPAGE_ENTRY_SPREADS", "1.5")
    s = os.environ.get("SLIPPAGE_STOP_SPREADS", "3.0")
    try:
        e_f = float(e)
        s_f = float(s)
        if e_f < 0 or s_f < 0:
            return False, f"slippage must be ≥ 0 (entry={e_f}, stop={s_f})"
        if e_f > 5 or s_f > 10:
            return False, f"slippage extreme — entry={e_f} stop={s_f} (likely typo)"
        return True, f"entry={e_f} spreads, stop={s_f} spreads"
    except ValueError:
        return False, f"non-numeric slippage env: entry={e!r} stop={s!r}"


# =============================================================================
# Main
# =============================================================================

def load_env_file(path: Path) -> None:
    """Load KEY=VALUE pairs from a file into os.environ (bash-style)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        # strip surrounding quotes
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k.strip(), v)


def main() -> int:
    print(f"\n{_green('=' * 60)}")
    print(f"  Pre-Flight Check — {datetime.now(timezone.utc).isoformat()}")
    print(f"{_green('=' * 60)}\n")

    # Optional env-file argument
    if len(sys.argv) > 1:
        env_path = Path(sys.argv[1])
        if not env_path.exists():
            print(_red(f"Env file not found: {env_path}"))
            return 2
        print(f"Loading env from {env_path}...")
        load_env_file(env_path)
    else:
        # Default: look for .env.ftmo in cwd
        for default in (".env.ftmo", ".env.local", ".env"):
            p = Path(default)
            if p.exists():
                print(f"Loading env from {p}...")
                load_env_file(p)
                break

    checks = [
        check_ftmo_tf,
        check_account_id,
        check_expected_login,
        check_start_balance,
        check_telegram_token,
        check_telegram_chat,
        check_state_dir,
        check_disk_space,
        check_binance,
        check_mt5_module,
        check_mt5_connect,
        check_news_blackout,
        check_ftmo_executor,
        check_regime_gate,
        check_slippage,
    ]

    results = [c() for c in checks]
    print()
    for r in results:
        print(r.render())

    blocking_failures = [r for r in results if not r.ok and r.blocking]
    warnings = [r for r in results if not r.ok and not r.blocking]

    print(f"\n{_green('=' * 60)}")
    if blocking_failures:
        print(_red(f"  ✗ NO-GO — {len(blocking_failures)} blocking issue(s)"))
        for r in blocking_failures:
            print(_red(f"    - {r.name}: {r.msg}"))
        if warnings:
            print(_yellow(f"  + {len(warnings)} warning(s) (non-blocking)"))
        print(_green('=' * 60))
        return 1

    if warnings:
        print(_yellow(f"  ⚠ GO with {len(warnings)} warning(s) — review before deploy:"))
        for r in warnings:
            print(_yellow(f"    - {r.name}: {r.msg}"))
    else:
        print(_green(f"  ✓ GO — all {len(results)} checks passed"))
    print(_green('=' * 60))
    return 0


if __name__ == "__main__":
    sys.exit(main())
