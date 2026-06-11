# Micro-Lot Demo-Lauf — Fill-vs-Backtest-Validierung (vor Funded-Deploy)

**Ziel:** beweisen, dass das LIVE-Verhalten (echte Fills, Spread, Slippage, Swap,
Fill-Latenz, partielle Fills, Reconnects) zu den Backtest-Annahmen passt — bevor
echtes Geld läuft. Das fängt genau das, was kein Code-Audit kann.

> Stand der Audits (2026-05-29): Engine-Parität bestätigt (Rust-Backtest ≈ TS ≈
> Python via `parity_check.py`, 0.0000 % Bulk-Drift). Execution-Path-Audit
> (4 Agents) ohne account-fatalen KRIT; equity=None→$100k, /pause-Signal-Verlust
> und der Portfolio-Cap sind gefixt/aktiviert. Dieser Demo-Lauf validiert die
> **realen Fills**, die im Backtest nur modelliert sind.

## 0. Voraussetzungen

- Windows + MetaTrader 5, eingeloggt auf einem **Demo-Account** (FTMO- oder
  BrightFunded-Demo — kein echtes Geld). Setup-Details: `tools/PRE_LIVE_SETUP.md`
  - `tools/README-ftmo-bot.md`.
- Repo gesynct, `npm run build` gelaufen.
- `.env.ftmo.demo1` aus `.env.ftmo.demo1.example` erstellt und befüllt:
  `FTMO_EXPECTED_LOGIN` (deine Demo-Login-Nr.), MT5 Login/Server, Ticker.

## 1. Safety-Settings (in `.env.ftmo.demo1` setzen)

```ini
RISK_FRAC_HARD_CAP=0.005      # Mikro-Lot-Floor: Lots runden auf broker volume_min (~0.01)
FTMO_PORTFOLIO_MAX_RISK=0.20  # Portfolio-Cap (Audit-Fix) — schon im .example default
REGIME_GATE_ENABLED=true
```

> `RISK_FRAC_HARD_CAP=0.005` ist der dokumentierte Mikro-Lot-Floor
> (`ftmo_executor.py:2437`): darunter verweigert `compute_lot_size` den Trade
> (statt Risiko aufzublähen), also nicht tiefer setzen.

## 2. Drei Prozesse parallel starten

```powershell
# (A) Signal-Generierung (Binance-Poll → signal-alerts.log / pending-signals.json)
npm run dev          # bzw. der Signal-Service laut README-ftmo-bot.md

# (B) Executor (platziert Mikro-Lot-Orders auf MT5-Demo)
$env:FTMO_ENV_FILE=".env.ftmo.demo1"; python tools\ftmo_executor.py

# (C) Paper-Verifier (parallel, vergleicht Paper-PnL vs. echten Live-PnL)
python tools\live_paper_verifier.py
```

## 3. Tägliche Validierungs-Checks

Aus `ftmo-state*/executor-log.jsonl` + Paper-Verifier-Telegram:

| Check                      | Wo                                             | Erwartung                                                       |
| -------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| **Fill-Slippage**          | order-Log: `fill_price` vs Signal `entryPrice` | Differenz ≤ `MAX_ENTRY_SLIPPAGE_PCT` (0,5 %); sonst abgebrochen |
| **SL/TP gesetzt**          | MT5-Terminal je Position                       | beide gesetzt, korrekte Seite, ~Signal-Distanz                  |
| **Lot-Größe**              | order-Log `lot`                                | ≈ broker `volume_min` (~0,01)                                   |
| **Paper-vs-Live-Drift**    | `live_paper_verifier` Reconciliation           | **< 0,3 %** Equity; >0,3 % → Bug-Verdacht                       |
| **Keine Regel-Verletzung** | Demo-Equity                                    | nie −5 % Tag / −10 % gesamt                                     |

## 4. Die 3 gefixten Pfade aktiv prüfen (provozieren)

1. **equity=None-Defer** (Reconnect-Schutz): MT5 kurz trennen/neu-verbinden
   während ein Signal-Batch ansteht → Log muss `signals_deferred_equity_unavailable`
   zeigen, **keine** Order auf Fake-Equity, Signale bleiben pending.
2. **/pause-Signal-Erhalt**: bei anstehendem Multi-Signal-Batch `/pause` per
   Telegram → `/resume`. Log zeigt `signals_paused_mid_batch`; nach Resume dürfen
   die un-platzierten Signale **nicht verloren** sein (werden platziert oder
   bleiben pending).
3. **Portfolio-Cap**: bei vielen gleichzeitigen Signalen muss ab summiertem
   risk_frac > 0,20 ein `portfolio_risk_block` im Log stehen (kein weiterer Entry).

## 5. Dauer & Kriterien

- **Mindestens 1 Woche** (deckt Wochenende, mehrere Signal-Batches, ≥1 Reconnect).
- **Erfolg (→ Funded-Deploy erwägen):** Paper-vs-Live-Drift < 0,3 % stabil, Fills
  innerhalb Slippage-Toleranz, keine Regel-Verletzung, alle 3 Fixes verhalten
  sich wie oben.
- **Abbruch (→ Bug suchen):** Drift > 0,3 % anhaltend, Fills deutlich daneben,
  irgendeine DL/TL-Verletzung, oder Crash ohne Auto-Recovery.

## 6. Was das NICHT abdeckt

- Funded-Account-Regeln (Consistency etc.) — auf dem echten Funded-Account
  separat verifizieren.
- Regime-Risiko: die OOS-Validierung (~25 % / ~7 %) lief auf 2024-2026
  (trend-freundlich); ein Bär/Range-Regime kann live tiefer liegen.
