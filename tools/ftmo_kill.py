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


# 2026-05-15 R3 audit Bug #2 (MITTEL): mirror ftmo_executor's per-account
# magic derivation so the kill switch only touches THIS account's tickets.
# Identical algorithm — SHA-1 mod 100, deterministic across restarts.
def _compute_magic_id() -> int:
    base = 231
    account_id = os.environ.get("FTMO_ACCOUNT_ID", "").strip()
    if not account_id:
        return base
    import hashlib

    digest = hashlib.sha1(account_id.encode("utf-8")).digest()
    offset = int.from_bytes(digest[:4], "big") % 100
    return base + offset


MAGIC = _compute_magic_id()
PING_MAGIC = MAGIC + 1


def _resolve_state_dir() -> Path:
    """Return the same FTMO_STATE_DIR the executor uses (env override wins,
    else legacy `ftmo-state-<TF>` cwd-relative). Multi-account deploys set
    FTMO_STATE_DIR explicitly via ecosystem-multi.config.js.

    2026-05-15 Codex-Audit Bug 4: previously this silently fell back to the
    R28_V6_PASSLOCK default TF when FTMO_STATE_DIR/FTMO_TF were unset → a
    `python ftmo_kill.py` run from any cwd would pause the WRONG account
    (the one whose state-dir happened to match the default). We now:
      1. honor FTMO_STATE_DIR / FTMO_TF / FTMO_ACCOUNT_ID exactly,
      2. verify the resolved path actually exists; if not, refuse to write
         a stale pause-marker (returns the path but `_write_pause_marker`
         will skip the write).
    """
    explicit = os.environ.get("FTMO_STATE_DIR")
    if explicit:
        return Path(explicit)
    tf = os.environ.get("FTMO_TF", "2h-trend-v5-r28-v6-passlock")
    acct = os.environ.get("FTMO_ACCOUNT_ID", "")
    suffix = f"-{acct}" if acct else ""
    return Path.cwd() / f"ftmo-state-{tf}{suffix}"


def _write_pause_marker(
    state_dir: Path,
    n_closed: int,
    n_total: int,
    all_closed: bool = True,
) -> None:
    """Write `bot-controls.json` so the executor pauses after restart.
    Uses a temp+rename for atomicity; ignores all errors (kill must always
    proceed even if the FS is misconfigured).

    Bug-Audit Round 1: parity with executor `write_json` — fsync the file
    AND the parent dir so a power-loss right after the kill doesn't lose
    the pause marker (which would let the executor resume trading after
    a reboot, defeating the entire purpose of the kill switch). Also
    PID-suffix the tmpfile to avoid clashes with a concurrent executor
    write to the same path.

    2026-05-15 Codex-Audit Bug 4 + Bug 6:
    - state_dir is verified to exist BEFORE we write the marker. Without
      this guard a wrong/typo-FTMO_STATE_DIR would silently mkdir a fresh
      ftmo-state-* tree and write a pause-marker into it — pausing nothing
      real, while the actual executor kept trading.
    - all_closed=False (manual or partial kill) means we leave
      killRequested=True so a subsequent executor cycle retries. After a
      FULL successful manual kill (all_closed=True) we set killRequested
      back to False so the executor does NOT re-trigger a 2nd kill loop
      on resume; the kill is "done", paused=True keeps trading off.
    """
    try:
        # 2026-05-15 Codex-Audit Bug 4: refuse to write a marker into a
        # never-before-seen directory. The executor creates its state_dir
        # on first run; if ours doesn't exist, we resolved the wrong path.
        if not state_dir.exists():
            print(
                f"[kill] WARN: state_dir does not exist: {state_dir}\n"
                f"  → refusing to write pause-marker (would pause a non-existent bot).\n"
                f"  → set FTMO_STATE_DIR or FTMO_TF/FTMO_ACCOUNT_ID to the active bot."
            )
            return
        target = state_dir / "bot-controls.json"
        payload = {
            "paused": True,
            "killRequested": not all_closed,
            "killAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "killClosed": n_closed,
            "killTotal": n_total,
            "killAllClosed": all_closed,
            "reason": (
                "ftmo_kill.py emergency kill — manual /resume required"
                if all_closed
                else "ftmo_kill.py PARTIAL kill — executor will retry remaining closes"
            ),
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
    positions_unknown = False  # 2026-05-15 Codex-Audit Bug 4: MT5 disconnect signal
    try:
        # 2026-05-15 Codex-Audit Bug 4: positions_get() returns None on MT5
        # connection failure (NOT empty list). Treating None as "no positions"
        # made the kill switch a silent no-op on disconnect — operator saw
        # "No open positions." then walked away believing they were safe
        # while live positions kept dragging equity. Now we retry with
        # exponential backoff, then HARD-FAIL with a clear error.
        positions = None
        backoffs = (0.5, 1.0, 2.0, 4.0)
        for i, delay in enumerate(backoffs):
            positions = mt5.positions_get()
            if positions is not None:
                break
            print(f"[kill] positions_get returned None (attempt {i+1}/{len(backoffs)}) — retrying in {delay}s")
            time.sleep(delay)

        if positions is None:
            positions_unknown = True
            err = None
            try:
                err = mt5.last_error()
            except Exception:
                pass
            print(
                "[kill] ERROR: MT5 positions_get returned None after retries.\n"
                f"  last_error={err}\n"
                "  → cannot enumerate positions, kill switch DID NOT close anything.\n"
                "  → bot will still be PAUSED so no new signals fire."
            )
            try:
                tg_send(
                    "🔴 <b>KILL FAILED — MT5 disconnect</b>\n"
                    "positions_get() returned None after 4 retries.\n"
                    f"last_error: <code>{err}</code>\n"
                    "Bot has been paused but live positions may still be open."
                )
            except Exception:
                pass
            sys.exit(3)

        if not positions:
            print("No open positions.")
            return

        # 2026-05-15 Codex-Audit Wave-2 Bug 11 (NIEDRIG): also close ping
        # trades (magic=232) on emergency kill. A pending ping-open could
        # otherwise survive the kill, leaving an SL-less long on the books
        # while the operator believed "everything is closed". Both magics
        # belong to the same iter231 bot; kill should fully shut it down.
        bot_positions = [p for p in positions if getattr(p, "magic", 0) in (MAGIC, PING_MAGIC)]
        if not bot_positions:
            print(f"No bot positions (magic {MAGIC}/{PING_MAGIC}). {len(positions)} other positions left untouched.")
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
            # 2026-05-15 Codex-Audit Wave-2 Bug 11 (NIEDRIG): preserve the
            # position's own magic in the close request so a magic=232 ping
            # close is also tagged as 232. Some MT5 builds reject closes
            # with a magic mismatch ("invalid magic for position"), so we
            # echo the source magic explicitly.
            pos_magic = int(getattr(pos, "magic", MAGIC) or MAGIC)
            result = mt5.order_send({
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": pos.symbol,
                "volume": pos.volume,
                "type": mt5.ORDER_TYPE_BUY if pos.type == mt5.POSITION_TYPE_SELL else mt5.ORDER_TYPE_SELL,
                "position": pos.ticket,
                "price": price,
                "deviation": 50,
                "magic": pos_magic,
                "comment": "iter231 KILL" if pos_magic == MAGIC else "iter232-ping KILL",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_IOC,
            })
            ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
            if ok:
                n_ok += 1
            print(f"  ticket {pos.ticket} ({pos.symbol}): {'CLOSED' if ok else f'FAILED retcode={result.retcode if result else None}'}")
    finally:
        # 2026-05-15 Codex-Audit Bug 6: write a clean marker on a fully
        # successful kill (paused=True, killRequested=False), otherwise
        # the executor would see killRequested=True on resume and run a
        # second redundant kill cycle. Skip the marker write entirely when
        # MT5 was unreachable (we already exit(3) in that branch, finally
        # runs first → don't overwrite real state with stale "killClosed=0").
        if not positions_unknown:
            try:
                all_closed = bool(bot_positions) and n_ok == len(bot_positions)
                _write_pause_marker(
                    _resolve_state_dir(), n_ok, len(bot_positions), all_closed=all_closed
                )
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
        try:
            mt5.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    main()
