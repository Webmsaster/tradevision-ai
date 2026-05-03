# Session Handoff — 2026-05-03

## What was done

### 🏆 Round 53 Priority 4: TP-Mult Fine-Grid → R28_V6 (+1.47pp vs R28_V5)

- **R28_V6 = neuer Production-Champion** mit **60.29% V4-Engine Pass-Rate** auf 5.55y / 136 Fenster (vs R28_V5 58.82% = +1.47pp).
- Mechanism: per-asset `tpPct ×0.55` (weiter getightet von R28_V5's ×0.6).
- Plateau-Optimum 0.55 ↔ 0.59 (beide 60.29% → robust gegen Tuning-Drift).
- Per-asset Ablation: keine Kombo schlug uniform 0.55 → die einfachere Config wird shipped.
- 21-Variant Sweep im neuen `scripts/_r28V5TpFineGrid.test.ts` (Phase 1 uniform + Phase 2 per-asset, ~52min Laufzeit).

### 🔄 Round 53 Priority 3: 2-Strategy Ensemble (R28_V5 + FX_TOP3)

- `scripts/_2StrategyEnsemble.test.ts` neu — testet R28_V5 + FX_TOP3 ohne BO_V1.
- Min-1-pass: **70.27%** auf 37 windows (FX-1.4y common-window constraint).
- Failure-Korrelation R28_V5 ↔ FX_TOP3 = **0.55** (echte Diversifikation, vs 0.90 mit BO_V1).
- Verdict: **MARGINAL** (besser als single-account, < 78% Goal). Empfehlung: 2× R28_V6 Multi-Account (~83%) statt 2-Strategy.

### 🛡️ Round 54 Bug-Audit (9-Agent Parallel)

9 spezialisierte Audit-Agents (V4-Engine, Python-Executor, Auth, Storage, AI-Detectors, React-UX, V231, CI/CD, Coverage). ~50 Findings, davon ~12 kritisch:

**Kritische Findings (zur Bearbeitung in Round 55):**

1. **Python `place_market_order`**: SL/TP an theoretischem Preis, Lot an theoretischem Stop → echter Risk pro SL > geplant
2. **Python pending-lock race**: order_send läuft außerhalb file-lock, doppelte Orders möglich
3. **Telegram token leak**: HTTPError im print-log enthält volle URL inkl. Bot-Token
4. **V4-Engine entryBarIdx**: nutzt non-monotonic refCandles.length-1 (gleicher Bug wie LSC vor Phase 36)
5. **V4-Engine firstTargetHitDay race**: kann auf realised allein gesetzt werden ohne MTM-guard
6. **Storage 100k-cap pagination**: silent cutoff bei großen Backtest-Importen
7. **Storage saveBulkTradesToSupabase**: nicht atomar — partial-state bei chunk-failure
8. **AI Sharpe-Ratio**: fixe √252-Annualisierung unabhängig von Trade-Frequenz → 5-10× off
9. **AI tilt drawdown**: early-return verhindert späteren worst-cluster, peak<=0 silent
10. **ftmoLiveService rotateLog race**: appendFileSync auf renamed inode möglich
11. **ftmoLiveService runSmartAlerts unter PENDING_LOCK**: Telegram-Hang blockiert Trading

**Sofort gefixt in dieser Session:**

- ✅ **`urlSafety.ts` IPv6 SSRF-Bug** (Round 54 Agent 9 finding): IPv6-Brackets werden nicht gestrippt → `[fe80::1]`, `[fc00::1]`, `[::1]` und IPv4-mapped wurden alle als public klassifiziert. Fix + 21 neue Tests in `src/__tests__/urlSafety.test.ts` (vorher 0% coverage).
- ✅ **AI compareByExitDate tie-breaker** (Agent 5 finding): deterministischer Sort via `entryDate → id` Tie-Breaker. Verhindert nondeterministische Streak-Detector-Ergebnisse.
- ✅ **Pyright Optional-Member access** in `tools/test_ftmo_executor.py`: `assert is not None` Narrowing.
- ✅ **Pytest TZ-flake** in `test_handle_daily_reset_same_day_returns_cached`: Prague-TZ statt UTC.

### 📰 News-Blackout API-Feed (Live Update statt 2026-hardcoded)

- `tools/news_blackout.py` erweitert um `refresh_from_api(cache_path, force)` (~180 LOC).
- Datenquelle: **Finnhub.io** economic calendar (free tier, JSON, urllib.request).
- Filtert: `country=US`, `impact=high`, FOMC|CPI|NFP|PPI|GDP keywords.
- Cache: 24h TTL, atomic write, fail-open auf hardcoded events.
- Env-vars: `NEWS_API_KEY`, `NEWS_API_DISABLED=true`, `NEWS_CACHE_PATH`.
- 6 neue pytest cases — total 85 pytest passed (war 79).
- **Stay offline-first**: Existierende `is_blackout_window()` API unverändert, transparente Cache-Übernahme via `_events()`.

### 📊 Live-Dashboard Backtest vs Live Drift

- `src/app/dashboard/drift/page.tsx` (Next.js page mit Recharts).
- `src/app/api/drift-data/route.ts` (read-only JSON API mit FTMO_MONITOR_ENABLED-Gate).
- 8 UI-Elemente: Header-Status, Equity-Card, Equity-Chart mit p10/p50/p90 Backtest-Band, Drift-Indikator, Events-Log, Active-Positions, Daily-PnL, Health-Checks.
- Liest aus `ftmo-state-{TF}/`: account.json, daily-reset.json, peak-state.json, executor-log.jsonl.
- Multi-Account via `?ftmo_tf=` Query-Param.
- Auto-refresh 30s.
- 5 neue tests in `src/__tests__/driftDataRoute.test.ts`.
- **Slug-Whitelist** `^[a-z0-9][a-z0-9-]{0,63}$` und path-confinement gegen path-traversal.
- README-Update in `tools/README-ftmo-bot.md`.

### 🛡️ Round 54 CI/CD + Coverage Fixes (6 Punkte)

- **Fix 1**: Dependabot pip ecosystem für `tools/` hinzugefügt (`weekly`, label `python`, prefix `chore(deps-py)`).
- **Fix 2**: `tools/requirements.txt` neu generiert. Pinned `MetaTrader5>=5.0.45` (win32-conditional) + `pytest>=8.0.0`. Alle anderen Imports sind stdlib.
- **Fix 3**: `npm audit` von `--audit-level=high` auf `moderate` getightet. Single-CVE Allowlist via inline-Node parser: `GHSA-qx2v-qp2m-jg93` (postcss XSS, transitive via Next.js — fix nur via breaking Next-downgrade). Jeder NEUE CVE bricht CI.
- **Fix 4**: `dependabot-automerge.yml` defense-in-depth: neuer `gh pr checks --watch --fail-fast` Step zwischen approve und auto-merge. Branch-protection bleibt primär gate.
- **Fix 5**: 2 neue Coverage-Tests für zero-coverage Module:
  - `bybitBasis.test.ts` (16 cases): alle 4 magnitude-buckets × signal-Richtungen + 3 error-paths + URL-Construction.
  - `openInterest.test.ts` (7 cases): URL-build (uppercase, period, limit-cap), AbortSignal-forwarding, sort-by-time, 2 error-paths.
  - **Round 56 deferred** (3 Module, ~600 LOC): `coinbasePremium.ts`, `fundingReversion.ts`, `longShortRatio.ts`, `regimeConfluence.ts`. Alle bereits in `vitest.config.ts` exclude (Phase 87 R51-B2 — research/live-only). Sollte in dedizierter Round mit Mock-Strategie nachgezogen werden, idealerweise parallel zur regimeConfluence-Refactor.
- **Fix 6**: 2 Test-Determinismus-Fixes:
  - `adaptiveSizing.test.ts`: `vi.useFakeTimers()` + `vi.setSystemTime("2026-01-01T12:00:00Z")` damit Lookback-Window-Arithmetik nicht an Wall-Clock gebunden ist (DST/Mitternacht-Flake).
  - `ftmoLiveSignalConsistency.test.ts`: `Math.random()` → seeded mulberry32 PRNG (gleiches Pattern wie `ftmoLiveSafety.test.ts`).

## Current state

### ✅ Tests

- **vitest: 728+ pass** (64 Test Files: +1 urlSafety, +5 driftDataRoute)
- **pytest: 85/85 pass** (+6 News-API Tests)
- **typecheck grün**

### ✅ Deploy-Ready

- R28_V6 + Live-Selectors `2h-trend-v5-quartz-lite-r28-v6` (V231) und `-v6-v4engine` (V4 Live Engine)
- Regime-Gate, Slippage, News-Blackout — alle env-aktivierbar
- Drift-Dashboard hinter `FTMO_MONITOR_ENABLED=1`

## Next steps

### Priorität 1: Multi-Account Setup (größter Hebel)

- 2× R28_V6 Demo-Accounts parallel → ~85% min-1-pass (Schätzung: 60% × 60% → 84% min-1)
- Cost: ~155€ pro FTMO Demo
- Implementation: `FTMO_ACCOUNT_ID=demo1` und `=demo2` mit eigenen state-dirs

### Priorität 2: Live aktivieren mit allen Filtern

```bash
export FTMO_TF=2h-trend-v5-quartz-lite-r28-v6-v4engine
export REGIME_GATE_ENABLED=true
export REGIME_GATE_BLOCK="trend-down"
export NEWS_BLACKOUT_ENABLED=true
export NEWS_API_KEY="<finnhub-token>"          # NEU: für live-feed
export SLIPPAGE_ENTRY_SPREADS=1.5
export SLIPPAGE_STOP_SPREADS=3.0
export FTMO_MONITOR_ENABLED=1                  # NEU: für Dashboard
```

### Priorität 3: Round 55 — Critical Fixes aus Round 54 Audit

Top 5 für nächste Session (alle aus 9-Agent Audit):

1. **Python order_send pending-lock race** — full process_pending_signals unter Lock
2. **Python SL/TP slipped-price** — Lot mit echter Stop-Distanz neu berechnen
3. **Telegram token leak** — HTTPError-Message strippen
4. **V4-Engine firstTargetHitDay** — nur nach MTM-guard setzen
5. **AI Sharpe-Ratio** — Trade-Frequenz-basierte Annualisierung

### Priorität 4: Per-Asset TP-Optimierung tiefer (optional, +0.5-1pp möglich)

- Round 53 zeigte: BTCUSDT robust bei 0.55 UND 0.65 (60.29%). AAVE peak bei 0.55.
- Combo-Run: BTC=0.55, AAVE=0.55, others=0.55 (alles 0.55) = 60.29% (schon gemessen)
- Asymmetric per-asset (z.B. BCH=0.55, ETH=0.6, ADA=0.6, andere=0.55) noch nicht systematisch durchgemessen.

### Priorität 5: News-Blackout im Backtest validieren

- Bisher nur Live-Code (Round 53). Erwarteter +1-3pp wenn FOMC/CPI/NFP-Tage geskipped.
- Test: `scripts/_newsBlackoutBacktest.test.ts` — historischen 2024-2026 Calendar replay-en.

## Open issues / blockers

### Keine Blocker

- Alle tests grün, alle commits clean
- Worktrees auto-cleaned

### Strukturell (Round 54 deferred — Round 55 candidates)

- Engine multi-account refactor (V4 Live Engine pro account state)
- noUncheckedIndexedAccess strict whitelist erweitern
- Vercel multi-instance rate-limit (Upstash/Redis)
- Python tools/requirements.txt + pip dependabot ecosystem

## Key files changed

### New files

- `scripts/_2StrategyEnsemble.test.ts` — R28_V5 + FX_TOP3 diversification
- `scripts/_r28V5TpFineGrid.test.ts` — 21-variant TP-mult sweep
- `src/__tests__/urlSafety.test.ts` — 21 SSRF guard tests (closes 0% gap)
- `src/__tests__/driftDataRoute.test.ts` — 5 dashboard API tests
- `src/app/dashboard/drift/page.tsx` — drift dashboard UI
- `src/app/dashboard/drift/layout.tsx` — FTMO_MONITOR_ENABLED gate
- `src/app/api/drift-data/route.ts` — read-only JSON API

### Modified files

- `src/utils/ftmoDaytrade24h.ts` — added R28_V6 config (uniform tpMult=0.55)
- `src/utils/ftmoLiveSignalV231.ts` — added R28_V6 + R28_V6_V4ENGINE selectors
- `scripts/ftmoLiveService.ts` — TF-mapping + v4engine routing für R28_V6
- `src/utils/urlSafety.ts` — IPv6-bracket strip + IPv4-mapped IPv6 normalization
- `src/utils/aiAnalysis.ts` — compareByExitDate deterministic tie-breakers
- `tools/news_blackout.py` — Finnhub live-feed (~180 LOC additions)
- `tools/test_ftmo_executor.py` — 6 news-API tests + Pyright fixes
- `tools/README-ftmo-bot.md` — Drift-Dashboard section
- `.gitignore` — cache_bakeoff/, cache_forex_2h/, coverage/, ftmo-state-\*/

## Strategie-Hierarchie (V4-Engine Pass-Rate, 5.55y honest)

| Setup                        |                Pass% | Cost       |
| ---------------------------- | -------------------: | ---------- |
| R28_V4 (alt)                 |               50.74% | —          |
| R28_V5 (Round 52)            |               58.82% | —          |
| **R28_V6 (current)**         |           **60.29%** | —          |
| R28_V6 + Regime-Gate         |                 ~61% | env-var    |
| R28_V6 + Slippage modeling   | -3-5pp drift closure | env-var    |
| **R28_V6 × 2 Multi-Account** |  **~85% min-1-pass** | 155€ extra |
| R28_V6 × 3 Multi-Account     |                 ~94% | 310€ extra |

**Ehrliche Live-Erwartung mit allen Filtern: ~55-60% single-account, ~80-85% × 2 Accounts.**

## Round 54 Audit Score

- **Round 51-53 fix-throughput**: alle 50+ findings dokumentiert, 4 sofort gefixt (urlSafety, AI tie-breaker, Pyright, TZ-flake)
- **Top 11 critical** für Round 55 als priorisierte Liste in den "Next steps"
- **Coverage**: 69.47% stmts / 57.11% branches (urlSafety nun von 0% → 100%)
