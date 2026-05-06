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
  - **🏆 Current Champion (2026-05-04, Round 60): `R28_V6_PASSLOCK`** (`FTMO_TF=2h-trend-v5-r28-v6-passlock`). **63.24% V4-Engine full-sweep / 64.77% preliminary** on 9-crypto basket, 5.55y / 136 windows. +6.62 to +8.15pp vs R28_V6 baseline (56.62%). Mechanism: `closeAllOnTargetReached` flag forces all positions closed at first target-hit, eliminating Day-30-force-close drag-down. give_back 0% (eliminated). Live deploy: see `tools/PASSLOCK_DEPLOY_RUNBOOK.md`. Multi-account 3-Strategy (PASSLOCK+TITANIUM+AMBER) ≈ 94% min-1-pass.
  - **Prev: R28_V6** (`FTMO_TF=2h-trend-v5-quartz-lite-r28-v6-v4engine`): 56.62% V4-Engine, walk-forward TRAIN 55.56% / TEST 54.93% (drift -0.63pp = robust). Per-asset tpPct ×0.55, plateau 0.55-0.59. Superseded by PASSLOCK.
  - **Sister champions:**
    - **`V5_RUBIN`** (`FTMO_TF=2h-trend-v5-rubin`): 64.40% step=3d / wr 86.72% / TL 0 (14 assets, smaller basket)
    - **`V5_TOPAZ`** (`FTMO_TF=2h-trend-v5-topaz`): 63.86% step=3d / wr 86.45% / TL 0 (14 assets, V5_QUARTZ minus RUNE)
    - **`V5_AMBER`** (`FTMO_TF=2h-trend-v5-amber`): **62.83% step=1d** / 61.14% step=3d / wr 81.74% / TL 2 — best step=1d anchor (high-N robust)
    - All 30m timeframe, 3.04y / 1103 windows step=1d / 368 windows step=3d, live caps {maxStopPct: 0.05, maxRiskFrac: 0.4}.
  - **Sister: V5_TITANIUM** (14 assets, 5.52y/1985w long-history sample): 58.24% step=1d / 58.16% step=3d / wr 75.76% / TL 0.25%. Use when longer-history validation matters more than the +2.32pp ARB boost.
  - **Progression:** V5 (48.96%) → V5_PRO 53% → V5_GOLD 55% → V5_DIAMOND 56.5% → V5_PLATINUM 58.5% → V5_TITANIUM 58.2% (30m) → V5_OBSIDIAN 60.6% → V5_ZIRKON 61.6% → V5_AMBER 62.8%. **+15.93pp step=1d / +19.73pp winrate / TL -94%** vs V5 baseline.
  - **Sister config: V5_PLATINUM 2h** (`FTMO_TF=2h-trend-v5-platinum`). 14 cryptos same basket, 2h-tuned per-asset TP. **58.46% step=3d / 54.13% step=1d / TL 0.60%**. Higher peak on 3d-anchor but less robust on 1d. Progression V5 → V5_PRO → V5_GOLD → V5_DIAMOND → V5_PLATINUM → V5_TITANIUM. **+9.50pp pass / -89% TL** vs V5 baseline.
  - V5 family alt variants: V5_HIWIN (49.85%/wr 64.60% TP=4%), V5_FASTMAX (49.85%/wr 62% TP=6%), V5 legacy (48.96%/wr 62% TP=7%).
  - **Legacy: `FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5`** (selected via `FTMO_TF=2h-trend-v5` env). 9 cryptos on 2h, 47-49% pass-rate (V5_PLATINUM supersedes).
  - **Step 2 config: `FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_STEP2`** (selected via `FTMO_TF=2h-trend-v5-step2`). Tuned for 5% target / 60d.
  - Top backtest configs (post-bugfix re-validated 2026-04-28): V12_30M_OPT 97.99% (1.71y), V12_TURBO 96.48%, V261_2H_OPT 95.98% (5.6y), V261 4h 94.17%. V12 family is fully live-deployable as of round 11 fix (PTP/chandelier/breakEven/timeExit implemented in Python executor).
  - Engine fields `pauseAtTargetReached: true` + `atrStop` + `liveCaps {maxStopPct: 0.05, maxRiskFrac: 0.4}` are mandatory for FTMO-realistic backtests. `minTradingDays: 4` (real FTMO 2-Step rule).

### FTMO Bot (`tools/`)

Production-ready full-auto trading bot for FTMO Demo/Live. Default live config (Round 60) = `R28_V6_PASSLOCK` (`FTMO_TF=2h-trend-v5-r28-v6-passlock`). After 60 audit/optimization rounds: SIGTERM cleanup, per-FTMO_TF state-dirs, atomic cross-process writes, signal-staleness check, daily-loss active-close, Telegram secure (token-leak hardened, 401/404 exit, 429 backoff), all V12 engine features (PTP, chandelier, breakEven, timeExit) implemented in live executor, R60 `closeAllOnTargetReached` Pass-Lock.

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
