# TradeVision AI - Project Instructions

## Overview
AI-powered trading journal & performance analyzer built with Next.js 15, React 19, and Supabase.

## Tech Stack
- **Framework:** Next.js 15 (App Router)
- **UI:** React 19, Custom CSS with CSS variables (dark/light theme)
- **Database:** Supabase (PostgreSQL with RLS)
- **Charts:** Recharts
- **Auth:** Supabase SSR Auth with localStorage fallback
- **Language:** TypeScript (strict mode)

## Project Structure
```
src/
  app/           # Pages (dashboard, trades, import, insights, analytics, calculator, login)
  components/    # React components (Sidebar, TradeForm, TradeTable, Charts, etc.)
  lib/           # Supabase clients & auth context
  utils/         # Calculations, AI analysis, CSV parser, storage
  types/         # TypeScript interfaces
  data/          # Sample trade data
supabase/        # Database schema (schema.sql)
```

## Key Architecture Decisions
- **Dual storage:** Supabase for authenticated users, localStorage as fallback (works without backend)
- **Client-side AI:** All 13 pattern detectors run in the browser (no API calls needed)
- **Tailwind v4 + CSS variables:** All styles consolidated in `globals.css`, Tailwind utilities available via `@theme` tokens

## Development
```bash
npm run dev     # Start dev server
npm run build   # Production build
npm run test    # Run tests (vitest)
```

## Database
- Schema is in `supabase/schema.sql`
- RLS policies ensure user data isolation
- Run schema in Supabase SQL Editor to set up

## Conventions
- Functional components with named exports
- Trade calculations in `utils/calculations.ts`
- AI insights logic in `utils/aiAnalysis.ts`
- All styles in `src/app/globals.css` — use Tailwind utilities for new code
