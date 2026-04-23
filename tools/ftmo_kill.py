"""
FTMO Bot Kill Switch — closes ALL open positions placed by the iter231 bot
(filtered by magic=231). Use in emergency if bot misbehaves.

Run: python tools/ftmo_kill.py
"""
import sys
import MetaTrader5 as mt5


def main():
    if not mt5.initialize():
        print(f"MT5 init failed: {mt5.last_error()}")
        sys.exit(1)

    positions = mt5.positions_get()
    if not positions:
        print("No open positions.")
        mt5.shutdown()
        return

    bot_positions = [p for p in positions if p.magic == 231]
    if not bot_positions:
        print(f"No bot positions (magic=231). {len(positions)} other positions left untouched.")
        mt5.shutdown()
        return

    print(f"Closing {len(bot_positions)} bot positions...")
    for pos in bot_positions:
        info = mt5.symbol_info(pos.symbol)
        price = info.ask if pos.type == mt5.POSITION_TYPE_SELL else info.bid
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
        print(f"  ticket {pos.ticket} ({pos.symbol}): {'CLOSED' if ok else f'FAILED retcode={result.retcode if result else None}'}")

    mt5.shutdown()


if __name__ == "__main__":
    main()
