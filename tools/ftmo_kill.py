"""
FTMO Bot Kill Switch — closes ALL open positions placed by the iter231 bot
(filtered by magic=231). Use in emergency if bot misbehaves.

Run: python tools/ftmo_kill.py

Round 4 audit hardening (2026-05-04):
- symbol_info / symbol_info_tick None-checks (delisted symbols no longer crash)
- try/finally ensures mt5.shutdown() always runs
- Optional Telegram notification on completion (non-fatal if telegram_notify missing)

R67-r12 audit fix:
- Writes a pause-marker (`bot-controls.json {paused: true, killRequested: true}`)
  into the active state-dir so the executor's poll loop doesn't immediately
  reopen positions after a kill. Operator must `/resume` via Telegram (or
  delete the file) to lift the pause.
- Multi-account note: kill operates on the MT5 instance it connects to —
  it does NOT scope by FTMO_ACCOUNT_ID. Run kill on the same Windows VPS /
  MT5 terminal as the affected bot account.
"""
import json
import os
import sys
import time
from pathlib import Path

_TOOLS_DIR = Path(__file__).resolve().parent
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

if os.environ.get("FTMO_MOCK", "").lower() in ("1", "true", "yes"):
    import mock_mt5 as mt5  # type: ignore
else:
    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError:
        import mock_mt5 as mt5  # type: ignore

try:
    from telegram_notify import tg_send  # type: ignore
except Exception:
    def tg_send(_: str) -> bool:  # noqa: D401 - shim
        return False


def _resolve_state_dir() -> Path:
    """Return the same FTMO_STATE_DIR the executor uses (env override wins,
    else legacy `ftmo-state-<TF>` cwd-relative). Multi-account deploys set
    FTMO_STATE_DIR explicitly via ecosystem-multi.config.js."""
    explicit = os.environ.get("FTMO_STATE_DIR")
    if explicit:
        return Path(explicit)
    tf = os.environ.get("FTMO_TF", "2h-trend-v5-r28-v6-passlock")
    acct = os.environ.get("FTMO_ACCOUNT_ID", "")
    suffix = f"-{acct}" if acct else ""
    return Path.cwd() / f"ftmo-state-{tf}{suffix}"


def _write_pause_marker(state_dir: Path, n_closed: int, n_total: int) -> None:
    """Write `bot-controls.json` so the executor pauses after restart.
    Uses a temp+rename for atomicity; ignores all errors (kill must always
    proceed even if the FS is misconfigured).

    Bug-Audit Round 1: parity with executor `write_json` — fsync the file
    AND the parent dir so a power-loss right after the kill doesn't lose
    the pause marker (which would let the executor resume trading after
    a reboot, defeating the entire purpose of the kill switch). Also
    PID-suffix the tmpfile to avoid clashes with a concurrent executor
    write to the same path.
    """
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
        target = state_dir / "bot-controls.json"
        payload = {
            "paused": True,
            "killRequested": True,
            "killAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "killClosed": n_closed,
            "killTotal": n_total,
            "reason": "ftmo_kill.py emergency kill — manual /resume required",
        }
        # PID-suffixed tmp avoids race with executor's parallel write_json.
        tmp = target.with_suffix(target.suffix + f".tmp.{os.getpid()}")
        # Use open()+fsync rather than write_text so we durably flush before
        # rename (otherwise rename can promote a not-yet-flushed tmpfile).
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps(payload, indent=2))
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        tmp.replace(target)
        # POSIX dir fsync makes the rename itself durable. Best-effort on
        # Windows / unsupported FS — kill must proceed regardless.
        try:
            dirfd = os.open(str(state_dir), os.O_RDONLY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
        except (OSError, AttributeError):
            pass
    except Exception as e:
        print(f"[kill] WARN: failed to write pause marker: {e}")


def main():
    mt5_path = os.environ.get("MT5_PATH", "").strip()
    init_ok = mt5.initialize(mt5_path) if mt5_path else mt5.initialize()
    if not init_ok:
        print(f"MT5 init failed: {mt5.last_error()}")
        sys.exit(1)

    # Bug-Audit Round 1: multi-account VPS safety. Parity with executor's
    # mt5_init_with_retry: if FTMO_EXPECTED_LOGIN is set, refuse to kill
    # when the attached MT5 terminal does NOT belong to the expected
    # account. Without this guard, running `ftmo_kill.py` on a host with
    # multiple MT5 terminals could attach to the wrong terminal and close
    # OTHER accounts' positions (catastrophic on a shared challenge VPS).
    expected_raw = os.environ.get("FTMO_EXPECTED_LOGIN", "").strip()
    if expected_raw:
        info = mt5.account_info()
        try:
            expected = int(expected_raw)
        except ValueError:
            print(f"[kill] ERROR: FTMO_EXPECTED_LOGIN invalid value '{expected_raw}' — refusing to kill")
            try:
                mt5.shutdown()
            except Exception:
                pass
            sys.exit(2)
        if info is None or int(getattr(info, "login", 0)) != expected:
            got = int(getattr(info, "login", 0)) if info is not None else None
            print(f"[kill] ERROR: wrong MT5 account (got={got}, want={expected}) — refusing to kill")
            try:
                tg_send(
                    f"🔴 <b>KILL refused — wrong MT5 account</b>\n"
                    f"Got login <code>{got}</code>, want <code>{expected}</code>."
                )
            except Exception:
                pass
            try:
                mt5.shutdown()
            except Exception:
                pass
            sys.exit(2)

    n_ok = 0
    bot_positions = []
    try:
        positions = mt5.positions_get()
        if not positions:
            print("No open positions.")
            return

        bot_positions = [p for p in positions if p.magic == 231]
        if not bot_positions:
            print(f"No bot positions (magic=231). {len(positions)} other positions left untouched.")
            return

        print(f"Closing {len(bot_positions)} bot positions...")
        for pos in bot_positions:
            info = mt5.symbol_info(pos.symbol)
            if info is None:
                print(f"  ticket {pos.ticket} ({pos.symbol}): SKIPPED — symbol_info None (delisted?)")
                continue
            tick = mt5.symbol_info_tick(pos.symbol)
            if tick is None:
                print(f"  ticket {pos.ticket} ({pos.symbol}): SKIPPED — no tick")
                continue
            price = tick.ask if pos.type == mt5.POSITION_TYPE_SELL else tick.bid
            result = mt5.order_send({
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": pos.symbol,
                "volume": pos.volume,
                "type": mt5.ORDER_TYPE_BUY if pos.type == mt5.POSITION_TYPE_SELL else mt5.ORDER_TYPE_SELL,
                "position": pos.ticket,
                "price": price,
                "deviation": 50,
                "magic": 231,
                "comment": "iter231 KILL",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_IOC,
            })
            ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
            if ok:
                n_ok += 1
            print(f"  ticket {pos.ticket} ({pos.symbol}): {'CLOSED' if ok else f'FAILED retcode={result.retcode if result else None}'}")
    finally:
        # Always write pause-marker, notify + shutdown — even if loop raised.
        try:
            _write_pause_marker(_resolve_state_dir(), n_ok, len(bot_positions))
        except Exception:
            # Marker write must never block the kill-switch shutdown.
            pass
        try:
            if bot_positions:
                tg_send(
                    f"💀 KILL SWITCH: closed {n_ok}/{len(bot_positions)} positions. "
                    f"Bot is now PAUSED — send /resume to reactivate."
                )
        except Exception:
            # Telegram errors must never block the kill-switch shutdown.
            pass
        mt5.shutdown()


if __name__ == "__main__":
    main()
