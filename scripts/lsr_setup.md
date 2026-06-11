# LSR Collector — Continuous Forward Collection

**Goal**: Build 30-60 Tage forward-LSR sample für gating signal evaluation
(per Codex's recommendation).

## Files erzeugt

`scripts/cache_bakeoff/{SYMBOL}_lsr_{kind}_30m.json`

- Symbols: BTC, ETH, SOL, BNB (all USDT pairs)
- Kinds: global, top_accounts, top_positions
- Schema: `[{"t": ms, "r": longShortRatio, "l": longFrac, "s": shortFrac}]`

## Running

### One-Shot (manual)

```bash
cd /home/flooe/projects/tradevision-ai
python3 scripts/lsr_collector.py
```

### Daemon Mode (terminal-attached)

```bash
python3 scripts/lsr_collector.py --daemon
```

Loops every 30min, polite rate-limit.

### Recommended: Cron-Job (production)

Edit crontab with `crontab -e` and add:

```
*/30 * * * * cd /home/flooe/projects/tradevision-ai && /usr/bin/python3 scripts/lsr_collector.py >> /tmp/lsr_collector.log 2>&1
```

## Status Check

```bash
ls -la scripts/cache_bakeoff/*_lsr_*.json
wc -c scripts/cache_bakeoff/*_lsr_*.json | tail -5
```

## Validation After 30+ Days

Once ~30 days collected, sample size = 30 days × 48 bars/day = 1440 bars per
endpoint. Sufficient for initial predictive power evaluation:

```bash
python3 scripts/lsr_predictive_test.py  # TODO: build similar to premium_index_predictive_test
```

## Why LSR Forward Only

Per Codex consultation (2026-05-17):

> "Binance free API only exposes the latest 30 days, max 500 rows.
> Not usable for validating a 2024-01 to 2026-05 backtest.
> Paid historical source (Tardis/Amberdata) is the only clean path.
> Best pragmatic step: deploy Multi-Account 7-Stack live, while logging
> real LS-ratio forward in parallel. Revisit LS after 30-60 days as a
> forward-tested add-on."

## Status

- Initial pull: 2026-05-17, 6000 records across 12 files
- Forward-collection: ⏳ pending cron-job setup
