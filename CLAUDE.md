# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

TradeVision AI — an AI-powered trading journal & performance analyzer. Next.js 15 App Router, React 19, Supabase, TypeScript (strict).

## Commands

```bash
npm run dev          # Start dev server (localhost:3000)
npm run build        # Production build (needs NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY env vars, or placeholders)
npm run test         # Run unit tests (vitest)
npm run test:watch   # Vitest in watch mode
npm run typecheck    # TypeScript check (tsc --noEmit)
npm run test:e2e     # Playwright E2E tests (requires `npx playwright install chromium` first)
npm run test:e2e:ui  # Playwright with UI
```

Run a single unit test file:

```bash
node ./node_modules/vitest/vitest.mjs run src/__tests__/calculations.test.ts
```

**Path quirk:** The `&` in the project directory name breaks `npm run` and `npx` on some shells. All `package.json` scripts already use `node ./node_modules/...` directly as a workaround. When running tools manually, use the same pattern.

## Architecture

### Dual Storage System

The app works with or without Supabase. `src/utils/storage.ts` abstracts this:

- **Authenticated users:** CRUD goes through Supabase (PostgreSQL with RLS)
- **No auth / no env vars:** Falls back to `localStorage`
- `src/lib/supabase.ts` returns `null` if env vars are missing — the app gracefully degrades

The `AuthProvider` (`src/lib/auth-context.tsx`) wraps the entire app and exposes `user`, `supabase`, and `isLoading` via React context.

### DB Field Mapping

The `Trade` interface uses camelCase (`entryPrice`, `exitPrice`, `pnlPercent`), but the Supabase `trades` table uses snake_case (`entry_price`, `exit_price`, `pnl_percent`). Conversion happens in `storage.ts` via `dbToTrade()` / `tradeToDb()`.

### Client-Side AI Engine

All 17 pattern detectors run in the browser with no API calls. Logic is in `src/utils/aiAnalysis.ts`. Each detector is exported as `detect*(trades: Trade[]): AIInsight | null` and receives the full trade array. New detectors must follow the same signature so the dashboard auto-discovers them.

### Styling

- Single stylesheet: `src/app/globals.css` (Tailwind v4 + CSS custom properties)
- Tailwind `@theme` block maps CSS variables to design tokens (`bg-profit`, `text-txt`, `bg-surface`, etc.)
- Dark theme is default (`:root`), light theme via `[data-theme="light"]`
- Use Tailwind utility classes for new code

### App Shell

`src/app/layout.tsx` composes the global providers: `AuthProvider` → `ThemeProvider` → `ErrorBoundary` → `Sidebar` + `<main>`. All pages are client components (`'use client'`).

### Key Modules

| Module                  | Purpose                                                 |
| ----------------------- | ------------------------------------------------------- |
| `utils/calculations.ts` | Trade statistics (win rate, PF, Sharpe, drawdown, etc.) |
| `utils/aiAnalysis.ts`   | 17 pattern detectors for AI insights                    |
| `utils/csvParser.ts`    | CSV import with column mapping                          |
| `utils/storage.ts`      | Dual storage abstraction (Supabase + localStorage)      |
| `utils/formatters.ts`   | Number/date formatting helpers                          |
| `types/trade.ts`        | Core interfaces: `Trade`, `TradeStats`, `AIInsight`     |
| `lib/auth-context.tsx`  | Auth provider with Supabase + fallback                  |
| `lib/constants.ts`      | Event names and localStorage keys for settings          |

### Testing

- **Unit tests** (`src/__tests__/`): Vitest + jsdom, tests for calculations, AI analysis, CSV parser, storage
- **E2E tests** (`e2e/`): Playwright against dev server — navigation, trade CRUD, CSV import, calculator, login flow
- E2E helpers in `e2e/helpers.ts` (`loadSampleData`, `createTestTrade`, `gotoAndWaitForApp`)
- **Strategy/FTMO tests** (`scripts/ftmo*.test.ts` and `scripts/exploratory/`): Heavy backtests run via vitest.
  - **⚠️ 2026-05-12 RE-BASELINE (extended sister-config sweep):** Prior champion claims were inflated by (1) stale 2026-05-05 cache + (2) inverted `--phantom-suppress` flag semantics. Honest fresh Rust baselines (NO `--phantom-suppress`, all from same engine commit `21d3b79`):
    - R28_V6_PASSLOCK step=14d/136w: **41.18%** (cache 55.88%, -14.70pp)
    - R28_V6 baseline step=14d/136w: **38.97%** (cache 56.62%, -17.65pp) — no PASSLOCK
    - V5_TITANIUM_PASSLOCK step=1d/1740w: **49.54%** (cache 58.24%, -8.70pp)
    - V5_TITANIUM step=1d/1740w: **42.99%** (cache 58.24%, -15.25pp) — no PASSLOCK
    - V5_TITANIUM step=3d/580w: **42.24%** (cache 58.16%, -15.92pp)
    - V5_AMBER_PASSLOCK step=1d/1002w: **55.79%** (cache 62.83%, -7.04pp) ← **strongest single-account**
    - V5_AMBER step=1d/1002w: **43.91%** (cache 62.83%, -18.92pp) — no PASSLOCK
    - V5_AMBER step=3d/334w: **43.11%** (cross-check)
    - V5_OBSIDIAN_PASSLOCK step=3d/334w: **54.19%** (cache unknown; 15 assets full basket)
    - V5_TOPAZ_PASSLOCK step=3d/334w: **50.90%** (cache 63.86%, -12.96pp)
    - V5_TOPAZ step=3d/334w: **39.82%** (cache 63.86%, -24.04pp) — no PASSLOCK
    - V5_RUBIN — NOT in Rust templates.rs; cache 64.40% unverifiable until ported
    - V5_PLATINUM — NOT in Rust templates.rs; cache 58.46% unverifiable until ported
    - **Family pattern confirmed:** PASSLOCK = +6 to +12pp uplift over base config; no PASSLOCK variant > 44%. Single-account ceiling ≈ 56% (AMBER_PASSLOCK).
  - **🏆 Active Single-Account Champion (2026-05-12 honest, post-sister-sweep): `V5_AMBER_PASSLOCK`** (`FTMO_TF=2h-trend-v5-amber-passlock`). **Honest pass-rate 55.79% step=1d** (Rust binary, no phantom-suppress, fresh engine `21d3b79`). Runner-ups: V5_OBSIDIAN_PASSLOCK 54.19% step=3d, V5_TOPAZ_PASSLOCK 50.90% step=3d, V5_TITANIUM_PASSLOCK 49.54% step=1d. Multi-account 3-strategy stack (AMBER + OBSIDIAN + TITANIUM all PASSLOCK): 1 − (1−0.558)(1−0.542)(1−0.495) ≈ **90% min-1-pass** (OBSIDIAN replaces R28_V6 41.18% for stronger uplift). Lower-bound stack (AMBER + TITANIUM + R28_V6 PASSLOCK): ~87%. Mechanism: `closeAllOnTargetReached` flag eliminates give_back. Live deploy: `tools/PASSLOCK_DEPLOY_RUNBOOK.md`. Detail in memory `project_session_2026_05_12_65pct_hunt.md`.
  - **🐛 Critical engine-flag warning:** Do NOT pass `--phantom-suppress` to ftmo-sweep — it deflates pass-rate by ~23pp on PASSLOCK configs. The flag's claimed "+7pp inflation correction" turned out inverted on this signal class. Comment fixed in commit `<pending>`.
  - **❌ DEBUNKED — `V12_30M_OPT_STOCK`** (2026-05-08): claimed 77.14% but R29 10-round audit exposed BUG-MAGIC. With FTMO-realistic `liveCaps {maxStopPct:0.05, maxRiskFrac:0.4}` gave 0/140 pass-rate (ATR×48 stops capped → effRisk=0). Cache was 3-asset (SOL silently dropped by `_r29GenericShard.ts`). Walk-forward Q1=54% / Q4=89% (+34pp recency bias). DO NOT DEPLOY. Same failure-mode as archived V5_ONYX. Full audit detail in `MEMORY.md`.
  - **Prev: R28_V6** (`FTMO_TF=2h-trend-v5-quartz-lite-r28-v6-v4engine`): 56.62% V4-Engine, walk-forward drift -0.63pp = robust. Per-asset tpPct ×0.55, plateau 0.55-0.59. Superseded by PASSLOCK.
  - **Sister champions (2026-05-12 fresh Rust re-baseline, sweep set #2 — supersedes earlier today's pre-sister-sweep numbers):**
    - **`V5_RUBIN`** (`FTMO_TF=2h-trend-v5-rubin`): cache claim 64.40% step=3d. **Not yet ported to Rust** — engine selector unavailable; verify by porting `v5_rubin()` template before deploying.
    - **`V5_TOPAZ`** (`FTMO_TF=2h-trend-v5-topaz`): cache claim 63.86% step=3d. Fresh Rust 2026-05-12: **39.82% step=3d/334w** (-24.04pp from cache).
    - **`V5_TOPAZ_PASSLOCK`** (`FTMO_TF=2h-trend-v5-topaz-passlock`): no cache. Fresh Rust 2026-05-12: **50.90% step=3d/334w** — +11.08pp uplift from PASSLOCK on TOPAZ.
    - **`V5_OBSIDIAN_PASSLOCK`** (`FTMO_TF=2h-trend-v5-obsidian-passlock`): no cache claim. Fresh Rust 2026-05-12: **54.19% step=3d/334w** — runner-up champion candidate.
    - **`V5_AMBER`** (`FTMO_TF=2h-trend-v5-amber`): cache claim 62.83% step=1d. Fresh Rust 2026-05-12: **43.91% step=1d/1002w / 43.11% step=3d/334w** (-19pp from cache).
    - All 30m timeframe, live caps {maxStopPct: 0.05, maxRiskFrac: 0.4}.
  - **Sister: V5_TITANIUM** (14 assets): cache claim 58.24% step=1d. Fresh Rust 2026-05-12 (sweep set #2): **42.99% step=1d/1740w / 42.24% step=3d/580w** (-15-16pp from cache).
  - **Progression** (⚠️ pre-audit numbers, all need re-validation): V5 (48.96%) → V5_PRO 53% → V5_GOLD 55% → V5_DIAMOND 56.5% → V5_PLATINUM 58.5% → V5_TITANIUM 58.2% (30m) → V5_OBSIDIAN 60.6% → V5_ZIRKON 61.6% → V5_AMBER 62.8%. **+15.93pp step=1d / +19.73pp winrate / TL -94%** vs V5 baseline.
  - **Sister config: V5_PLATINUM 2h** (`FTMO_TF=2h-trend-v5-platinum`). 14 cryptos same basket, 2h-tuned per-asset TP. ⚠️ Cache: 58.46% step=3d / 54.13% step=1d / TL 0.60% — pending fresh re-run.
  - V5 family alt variants (cache-era): V5_HIWIN (49.85%/wr 64.60% TP=4%), V5_FASTMAX (49.85%/wr 62% TP=6%), V5 legacy (48.96%/wr 62% TP=7%).
  - **Legacy: `FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5`** (selected via `FTMO_TF=2h-trend-v5` env). 9 cryptos on 2h, 47-49% cached pass-rate.
  - **Step 2 config: `FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_STEP2`** (selected via `FTMO_TF=2h-trend-v5-step2`). Tuned for 5% target / 60d.
  - ⚠️ Top backtest configs (post-bugfix re-validated 2026-04-28, **PRE-2026-05-12 cache-audit**): V12_30M_OPT 97.99% (1.71y), V12_TURBO 96.48%, V261_2H_OPT 95.98% (5.6y), V261 4h 94.17%. V12_30M_OPT_STOCK separately debunked 2026-05-08 (BUG-MAGIC). Other claims need fresh re-validation post-2026-05-12 cache audit.
  - Engine fields `pauseAtTargetReached: true` + `atrStop` + `liveCaps {maxStopPct: 0.05, maxRiskFrac: 0.4}` are mandatory for FTMO-realistic backtests. `minTradingDays: 4` (real FTMO 2-Step rule).

### FTMO Bot (`tools/`)

Production-ready full-auto trading bot for FTMO Demo/Live. Default live config (Round 60) = `R28_V6_PASSLOCK` (`FTMO_TF=2h-trend-v5-r28-v6-passlock`), but new champion **V5_AMBER_PASSLOCK** (`FTMO_TF=2h-trend-v5-amber-passlock`) at 55.79% step=1d may supersede after live validation. After 60 audit/optimization rounds: SIGTERM cleanup, per-FTMO_TF state-dirs, atomic cross-process writes, signal-staleness check, daily-loss active-close, Telegram secure (token-leak hardened, 401/404 exit, 429 backoff), all V12 engine features (PTP, chandelier, breakEven, timeExit) implemented in live executor, R60 `closeAllOnTargetReached` Pass-Lock.

⚠️ **2026-05-12 audit corrected baselines:** Memory's 55-65% claims were stale-cache + inverted-phantom-suppress inflated. Honest fresh Rust pass-rates (no phantom-suppress): R28_V6_PASSLOCK 41.18% / V5_TITANIUM_PASSLOCK 49.54% / V5_AMBER_PASSLOCK 55.79%. Multi-account 3-strategy stack min-1-pass: **~87%** (close to memory's claimed 91%, but the per-account rates are 7-15pp lower than cache claimed).

- `ftmo_executor.py` — Python MT5 executor (Windows side)
- `mock_mt5.py` — Mock for unit tests on Linux
- `telegram_notify.py` — Telegram alerts
- `ftmo_kill.py` — Emergency kill switch
- `install-windows.ps1` — One-shot installer
- Signal source: `scripts/ftmoSignalAlert.test.ts` polls Binance every 4h, writes to `signal-alerts.log`
- See `tools/README-ftmo-bot.md` and project memory `project_ftmo_auto_bot.md`.

### Path Alias

`@/*` maps to `./src/*` (configured in `tsconfig.json`).

## CI/CD

- **CI** (`.github/workflows/ci.yml`): security audit → unit tests → build → Lighthouse → E2E
- **Release:** Automated via `release-please` — semantic PR titles (`feat:`, `fix:`, etc.) trigger version bumps and changelog
- **Dependabot:** Weekly npm + GitHub Actions dependency updates with auto-merge for patch/minor
- **Prod smoke** (`.github/workflows/prod-smoke.yml`): Daily Playwright checks against production

## Historical / Superseded

- **❌ ARCHIVED — `V5_ONYX`** (`FTMO_TF=2h-trend-v5-onyx`, 2026-04-29) — superseded by R28_V6_PASSLOCK champion (2026-05-04). Claimed 70.11% step=3d but audit found MAJOR overfit/recency-bias confounders. Engine bugs fixed (finishPausedPass off-by-one, MCT selection-bias) but config not promoted. Re-validation never completed. Do not deploy. Use R28_V6_PASSLOCK or V5_TITANIUM instead.

## Conventions

- Functional components with named exports
- All styles in `globals.css` — no separate CSS files
- Commit messages: short, imperative, English
- Database schema in `supabase/schema.sql`
