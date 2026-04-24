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
| `utils/aiAnalysis.ts`   | 13 pattern detectors for AI insights                    |
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
- **Strategy/FTMO tests** (`scripts/ftmo*.test.ts` and `scripts/exploratory/`): Heavy backtests run via vitest. Use `FTMO_DAYTRADE_24H_CONFIG_V236` (iter236) as the production champion — V236 is the live-deployable config (ETH+BTC+SOL, 65.8% pass / 3d engine median on 5.71y FTMO-real costs). V237 adds ARB but is research-only because ARB is not available on FTMO MT5. Engine field `pauseAtTargetReached: true` is mandatory for any new FTMO backtest, and `minTradingDays: 5` (FTMO rule, not engine default 4) must be explicit.

### FTMO Bot (`tools/`)

Production-ready full-auto trading bot for FTMO Demo/Live with the iter236 strategy (`pauseAtTargetReached` + ETH+BTC+SOL).

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

## Conventions

- Functional components with named exports
- All styles in `globals.css` — no separate CSS files
- Commit messages: short, imperative, English
- Database schema in `supabase/schema.sql`
