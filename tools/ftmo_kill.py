"""
FTMO Bot Kill Switch — closes ALL open positions placed by the iter231 bot
(filtered by magic=231). Use in emergency if bot misbehaves.

Run: python tools/ftmo_kill.py

Round 4 audit hardening (2026-05-04):
- symbol_info / symbol_info_tick None-checks (delisted symbols no longer crash)
- try/finally ensures mt5.shutdown() always runs
- Optional Telegram notification on completion (non-fatal if telegram_notify missing)
"""
import sys
import MetaTrader5 as mt5

try:
    from telegram_notify import tg_send  # type: ignore
except Exception:
    def tg_send(_text: str) -> bool:  # noqa: D401 - shim
        return False


def main():
    if not mt5.initialize():
        print(f"MT5 init failed: {mt5.last_error()}")
        sys.exit(1)

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
        # Always notify + shutdown, even if loop raised.
        try:
            if bot_positions:
                tg_send(f"💀 KILL SWITCH: closed {n_ok}/{len(bot_positions)} positions")
        except Exception:
            # Telegram errors must never block the kill-switch shutdown.
            pass
        mt5.shutdown()


if __name__ == "__main__":
    main()
