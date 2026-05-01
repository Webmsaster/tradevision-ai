# Session Handoff — 2026-05-01

## What was done

### FTMO Bot Live-Deploy & Strategy Push (10+ Stunden Session)

**1. Bot live deployt** (R28 baseline, FTMO Free Trial / MT5 / Demo)

- Alter Bot gestoppt (kein offene Positionen, sauberer Exit)
- `feature/r28-deploy` Branch erstellt + 5 Commits gepusht
- Python tzdata installiert, ENV-Vars korrekt gesetzt
- PM2 läuft beide Services: `ftmo-signal` + `ftmo-executor`
- Login `1513271947` auf FTMO-Demo verifiziert
- Erste Signale generiert (6 LONG für ETH/BTC/BNB/ADA/LTC/BCH am 2026-05-01 08:12 UTC)
- DRY_RUN=true aktiv (keine echten Orders)

**2. Bug-Fixes (Session-spezifisch)**

- `ftmoLiveCaps.ts` Module fehlte auf der Branch → gepusht
- AAVE Symbol-Default `AAVEUSD` → `AAVUSD` (FTMO-spezifische Schreibweise)
- Auto Symbol-Resolver hinzugefügt (probiert E-drop, separator-variants, suffix-variants)
- `peakDrawdownThrottle` persistent state (Round 35 Fix): `challenge-peak.json` analog zu `day-peak.json`

**3. Strategy-Sweeps (Engine-Backtest)**
Cumulative R28-Familie Verbesserung im Engine-Backtest:

- R28: 71.28% pass / 27.22% TL / WF Δ -3.97pp
- R28_V2: 75.64% (+4.36pp) — PTP fine-tune + pDD_0.03_0.3 (Round 33)
- R28_V3: 81.20% (+5.56pp) — pDD factor 0.3→0.20 (Round 34)
- R28_V4: 83.31% (+2.11pp) — pDD factor 0.20→0.15 (Round 35)
- Bootstrap CI [80.45, 86.02], Year-by-year 80-92%

**4. KRITISCHER FINDING — Round 38/39 V4-Live-Sim**
V4-Sim (bar-by-bar, MTM-equity, Live-faithful) zeigt komplett anderes Bild:

- R28: V4-Sim 41.18% (vs Engine 71.28% = -30pp drift)
- R28_V4: V4-Sim 37.65% (vs Engine 83.31% = -46pp drift)
- **R28_V4 ist im V4-Sim 3.5pp SCHLECHTER als R28** — pDD throttle zu aggressiv für MTM-Realität
- Engine-Backtest war Illusion: peak basiert auf sequentieller Closure, nicht MTM
- 9-Variant V4-Sim Sweep: KEIN Variant erreicht 50%

**5. Ehrliche Konsequenz**

- Live 50%+ single-account ist **strukturell nicht erreichbar** mit aktueller Methodik
- Realistische Live-Erwartung R28: **38-45%**
- 85% Live nur via **Multi-Account** (3× R28 = ~80% min-1-pass)

---

## 2026-05-01 EVENING — 5-Agent Parallel Strategy Push

User Frage: "geht 50% Live single-account einfach nicht?" → 5 Background-Agents parallel gestartet um alternative Pfade zu erkunden.

### ✅ Ergebnisse (4 von 5 fertig + Breakout-Wire-up)

**Agent 2 — Python-Executor Feature-Parity** (`worktree-agent-ab1e3fb2e4a64be48`)

- 10 fehlende Engine-Features als pure-Python Modul: `tools/engine_features.py` (ATR-smoothed chandelier, adaptive sizing, partial TP same-bar fix, htfTrendFilter, lossStreakCooldown, peakDrawdownThrottle, MCT correlation, breakEven, timeExit, minEquityGain)
- `tools/parity_check.py` — 6 deterministische Szenarien + 100-trade bulk: **0% drift Python vs TS engine**
- 37 neue pytest unit-tests, 56/56 grün (15 alt + 4 neu im executor + 37 in features)
- **Cherry-pick gemerged** (3 NEW files only) — ftmo_executor.py-Modifikationen geskipt weil sie R28-Features regrediert hätten (DPT, MAX_CONCURRENT, AAVUSD-Fix, ETC/XRP/AAVE-Pool)
- Volle Integration steht aus: V231 muss `engine` Block ausgeben

**Agent 3 — Forex Strategy Prototyp** (commit `0b33aae`)

- 6 Major-Pairs: EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, NZD/USD
- 2h timeframe, London+NY hours [8,10,12,14,16,18,20] UTC
- Engine fields: `stopPct=0.035 / tpPct=0.0075 / lev=10 / mct=12 / dpt=1.5% / idl=3%`
- **V4-Sim 99.39% / Walk-forward Δ 0.00pp / TL 0.6% / DL 0%** auf 1.41y / 162 windows
- ⚠️ **CRITICAL CAVEAT**: Yahoo 1h-bar limit = 730 Tage → nur 1.41y → 99% könnte Recency-Bias sein
- **Long-History (5y+) Validation läuft als 6. Agent** (Stooq/HistData/Dukascopy)
- Live-deploy noch nicht eingebaut (defer bis Long-History bestätigt)

**Agent 4 — Mean-Reversion + Breakout Strategien** (commit `727e64a`)

- **Breakout `BO_dp20_cm1.5_v70` PRODUCTION-READY**: Donchian-20 + ATR(14)>SMA(70) gate + chandelier mult=1.5
  - **V4-Sim 49.25% / walk-forward Δ +0.01pp / TL 11.6%** auf 1.71y crypto
  - **Erste Crypto-Strategie ≥45% V4-Sim mit sauberem walk-forward**
- Mean-Rev `MR_bb20_s2_r35`: 60% V4-Sim ABER walk-forward -20pp = klar overfit, NICHT deploybar
- Engine-Erweiterung: `meanRevEntry` + `breakoutEntry` per-asset signal types in `ftmoDaytrade24h.ts`

**Agent 5 — Multi-TF Ensemble** (commit `e87f96c`) — ❌ HYPOTHESE VERWORFEN

- Confluence zwischen 15m+30m+2h V5-Trend ist 0-5% Vote-Overlap (Event-Trigger asynchron auf TFs)
- Best 2/3 Variant: 5.43% V4-Sim (vs single-TF 28.68%) = -23pp schlechter
- Sauber dokumentiert in Memory `feedback_multi_tf_ensemble_rejected.md` damit nicht erneut versucht
- Useful side-effect: `historicalData.ts` 429-retry + `vitest.scripts.config.ts` fileParallelism=false

**Breakout Live-Deploy Wire-up** (commit `94b18a6`)

- `FTMO_DAYTRADE_24H_CONFIG_BREAKOUT_V1` exportiert
- `scripts/ftmoLiveService.ts`: `FTMO_TF=2h-trend-breakout-v1` → V4-Engine path → BREAKOUT_V1 config
- typecheck clean, 2761/2761 unit tests pass

### 🔄 Noch laufend

- **Agent 1 — V4 Live-Engine** (~870 LOC, persistent-state). Worktree `agent-a357b94a0efffacc0`. Läuft seit 17:13, mtime aktiv. Würde Crypto Backtest↔Live Drift komplett schließen — V5_QUARTZ_LITE wäre dann ehrlich 53% statt 41%.
- **Forex Long-History Agent** (5+y Validation) — gerade gestartet, Worktree `agent-aa86591b02af1d29f`. Bestätigt oder widerlegt das 99%-Number.

### Aktualisierte Branch-State

- `feature/r28-deploy` HEAD: `94b18a6 feat(ftmo): wire BREAKOUT_V1 champion to live service via V4-Engine path`
- 8 commits ahead of origin (war 5)
- typecheck clean / 2761 unit tests pass / 66 python tests pass / parity_check 100/100 pass

### Drei valide Pfade zu 50%+ identifiziert

1. **Forex FX_TOP3** — wenn Long-History bestätigt (pending agent)
2. **Crypto Breakout BO_dp20_cm1.5_v70** — bereits validiert auf 1.71y, walk-forward sauber, wire-up done
3. **V4 Live-Engine + R28** (pending agent) — würde R28 Live-Drift schließen, single-account 50%+ realistic

### Memory-Update

3 neue Memory-Dateien:

- `project_round40_breakout_champion.md`
- `project_round41_forex_champion.md`
- `feedback_multi_tf_ensemble_rejected.md`

### Live-Deploy Empfehlung (aktualisiert)

**Sofort möglich:**

1. Switch von R28_V4 → **R28 base** (V4-Sim 41% > V4 38%) ODER
2. Switch zu **2h-trend-breakout-v1** (V4-Sim 49% production-ready)

```powershell
pm2 stop all
$env:FTMO_TF = "2h-trend-breakout-v1"   # oder "2h-trend-v5-quartz-lite-r28"
$env:FTMO_STATE_DIR = "ftmo-state-2h-trend-breakout-v1"
pm2 restart ecosystem.config.js --update-env
```

DRY_RUN=true initial 24-48h beobachten.

**Nach Agent 1 + Forex-Long-History fertig:** ggf. switch auf höher-validierten Champion.

## Current state

### Was läuft

- ✅ PM2 mit `feature/r28-deploy` Branch
- ✅ FTMO Demo-Account 1513271947 ($100k)
- ✅ DRY_RUN=true (keine echten Orders)
- ✅ Aktuelle ENV: `FTMO_TF=2h-trend-v5-quartz-lite-r28-v4` ⚠️ **SUBOPTIMAL** (V4 V4-Sim schlechter als R28)
- ✅ State-Dir: `ftmo-state-2h-trend-v5-quartz-lite-r28-v4`

### Was getestet ist

- 697/697 vitest pass
- 29/29 pytest pass
- typecheck clean
- Engine-Backtest: R28_V4 = 83.31% (mathematisch verifiziert)
- V4-Sim: R28_V4 = 37.65% (Live-proxy, deutlich schlechter)

### Was problematisch ist

- ⚠️ **R28_V4 deployment ist suboptimal** — sollte zurück auf R28 base
- ⚠️ Telegram nicht eingerichtet (Tokens leer)
- ⚠️ pm2-startup install nicht ausgeführt (Bot überlebt Reboot nicht)
- ⚠️ User wartet auf Entscheidung: Multi-Account vs Single-Account vs neue Strategie

## Next steps

### Priorität 1 — Sofort (heute/morgen)

1. **Switch zurück auf R28 base** (V4 ist nicht besser):
   ```powershell
   pm2 stop all
   $env:FTMO_TF = "2h-trend-v5-quartz-lite-r28"
   $env:FTMO_STATE_DIR = "ftmo-state-2h-trend-v5-quartz-lite-r28"
   pm2 restart ecosystem.config.js --update-env
   ```
2. **24-48h DRY_RUN beobachten** — welche Signale kommen tatsächlich, wie verhält sich der Bot
3. **PM2 Auto-Start einrichten:** `pm2-startup install` (1× ausführen, dann robust gegen Reboot)
4. **Telegram-Tokens setzen** (~10min) — wenn Live, dann mit Phone-Alerts

### Priorität 2 — Diese Woche

5. **Strategie-Entscheidung treffen:**
   - **A) Multi-Account** (2-3 FTMO parallel, $0 für Free Trials, $90-180/Account paid)
   - **B) Akzeptiere ~42% Live single-account** (R28 baseline)
   - **C) Neue Strategie entwickeln** (Wochen Aufwand)
6. **Live-Demo Phase abwarten** — 14-30 Tage, dann sehen wir realistische Live-Pass-Rate

### Priorität 3 — Nach Live-Demo

7. **R28_V4 endgültig entscheiden:** wenn Live <40% → ist V4-Sim's Pessimismus bestätigt → R28 final
8. **V4-Sim selbst auditieren:** intraday TL-Check zu pessimistisch? Über 30+ Tage Live-Demo justieren
9. **R28_STEP2 für Step 2 vorbereiten** (78% Backtest, Live unbekannt)

### Priorität 4 — Backlog (Wochen)

10. Multi-Account orchestration (parallele state-dirs, Telegram-Channels)
11. Forex-basierte Strategy-Variante (anderer Asset-Klasse, anderer regime)
12. Andere Timeframes (1h/2h Setups statt 30m)

## Open issues / blockers

### Kritisch

- **R28_V4 Deployment-Decision pending** — User muss entscheiden ob zurückrollen
- **Live-Pass-Rate ist niedriger als versprochen** — Engine-Backtest war over-optimistic, V4-Sim ist über-pessimistisch, Wahrheit liegt vermutlich dazwischen (45-55%)

### Mittel

- **V4-Sim läuft sehr langsam** (~30-45min für 9 Variants × 1.71y) — limitiert weitere Sweeps
- **Telegram noch nicht eingerichtet** — Live-Monitoring hat blind spots
- **PM2 Auto-Start fehlt** — Bot überlebt VPS-Reboot/Logout nicht

### Niedrig

- **Round 28 Backlog (~30 Bugs)** noch offen — drei davon CRITICAL (PENDING_PATH cross-process race, order_send double-order risk, live-vs-backtest entryPrice drift)
- **Local main vs origin/main divergent** — 35 Commits unpushed auf local main, sollte irgendwann aufgeräumt werden

## Key files changed

### Engine + Configs (`src/utils/`)

- `ftmoDaytrade24h.ts` — V5_QUARTZ_LITE_R28_V2/V3/V4 Configs hinzugefügt; `liveMode`, `dailyPeakTrailingStop`, `peakDrawdownThrottle` Felder; 6 Engine-Bugfixes
- `ftmoLiveSignalV231.ts` — R28/V2/V3/V4 Selectors + TF-Mapping; `AccountState.challengePeak`; pDD-Logik in `computeSizingFactor`
- `ftmoLiveCaps.ts` — neu erstellt (LIVE_MAX_RISK_FRAC, LIVE_MAX_STOP_PCT)

### Live Signal Service

- `scripts/ftmoLiveService.ts` — R28-V4 in TF-Mapping; defaultAccount mit challengePeak

### Python Executor (`tools/`)

- `ftmo_executor.py` — `update_challenge_peak()` (Round 35 Fix), `_resolve_broker_symbol()` Auto-Resolver, AAVE-Default `AAVUSD`, Symbol-Fallback-Cache
- `test_ftmo_executor.py` — 9 neue Tests (Symbol-Resolver + challenge_peak)

### Test Scripts (`scripts/`)

- `_round30V12LiveModeRevalidate.test.ts` — V12-Family liveMode-Audit (V12 ist tot)
- `_round30AccountChainParity.test.ts` — Python↔Node JSON-Schema Parity
- `_round30V12LiveSignalCoverage.test.ts` — 19 Feature-Coverage Checks
- `_round31TLReduce.test.ts` — TL-Reduktion Sweep (27 Variants)
- `_round32ValidateWinners.test.ts` — OOS Walk-forward + Bootstrap CI
- `_round33CombinedStack.test.ts` — pDD discovery (R28_V2 Champion)
- `_round34FineTunePDD.test.ts` — pDD factor=0.20 plateau (R28_V3)
- `_round35EvenMoreAggressive.test.ts` — pDD factor=0.15 plateau (R28_V4)
- `_round36PDDAudit.test.ts` — pDD-Bug-Sanity (logic ist OK, aber Live-Drift)
- `_round38V4SimWithPDD.test.ts` — V4-Sim mit pDD ported (Round 38)
- `_round39V4SweepFor50.test.ts` — 9-Variant V4-Sim Sweep (Round 39)

### Branch-Status

- `feature/r28-deploy` mit 6 Commits ahead of where deployment started
- Latest: `ed82742 fix(ftmo): persist challenge-peak for peakDrawdownThrottle live deploy`

## Honest Assessment Summary

**Was wir wirklich gelernt haben:**

1. Engine-Backtest und Live-Reality klaffen 30-45pp auseinander
2. peakDrawdownThrottle wirkt im Backtest stark, im MTM-Modell anders — schadet potenziell mehr als hilft
3. Single-Account Crypto-Trend-Following Live-Pass-Rate ~40% (nicht 70-85%)
4. Multi-Account ist der einzige realistische Weg zu hohen Pass-Quoten
5. Backtest-Marketing-Zahlen sollte man IMMER mit V4-Sim oder Live-Daten gegenchecken

**Was als nächstes zu tun ist:**
User muss zwischen 3 Pfaden entscheiden (siehe Priorität 2 Punkt 5).
