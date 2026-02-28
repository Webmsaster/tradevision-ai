# TradeVision AI

AI-powered trading journal and performance analyzer that helps traders identify patterns, track performance, and improve their edge through data-driven insights.

## Features

- **Dashboard** - KPIs, equity curve, recent trades, top AI insights at a glance
- **Trade Management** - Add, edit, delete trades with full metadata (strategy, emotion, confidence, setup type)
- **AI Insights** - 13 pattern detectors identify behaviors like revenge trading, tilt, overtrading, and positive habits
- **Analytics** - Deep dive charts: performance by pair, day, hour, PnL distribution, win/loss breakdown
- **Import/Export** - CSV and JSON import/export with merge/replace restore modes, pre-loaded sample data for demo
- **Risk Calculator** - Position sizing, risk-reward ratio, and liquidation price calculator
- **Auth** - Supabase authentication with localStorage fallback (works offline)
- **Dark/Light Theme** - Full theme support via CSS variables

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router) |
| UI | React 19, Custom CSS |
| Database | Supabase (PostgreSQL) |
| Charts | Recharts |
| Auth | Supabase SSR + localStorage fallback |
| Language | TypeScript (strict) |

## Getting Started

### Prerequisites
- Node.js 18+
- npm

### Installation

```bash
git clone <repo-url>
cd ai-trading-journal
npm install
```

### Environment Setup (optional)

Copy the example env file and add your Supabase credentials:

```bash
cp .env.local.example .env.local
```

> **Note:** The app works fully without Supabase - trades are stored in localStorage.

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Production Build

```bash
npm run build
npm start
```

## Release Flow

Releases are now automated with `release-please`:

1. Open a PR with a semantic title, for example:
   - `feat: add monthly performance benchmark`
   - `fix: prevent duplicate trade import`
   - `perf: lazy-load analytics chart module`
2. Merge the PR into `main`.
3. `release-please` creates or updates a Release PR with:
   - version bump in `package.json`
   - `CHANGELOG.md` updates
4. Merge the Release PR to publish:
   - a Git tag
   - a GitHub Release

Common semantic types: `feat`, `fix`, `perf`, `refactor`, `docs`, `chore`, `ci`, `test`, `build`.

## Security Automation

- `Dependabot` checks npm and GitHub Actions dependencies weekly and opens update PRs.
- CI runs `npm audit --omit=dev --audit-level=high` and fails on high/critical production vulnerabilities.
- Dependabot patch/minor updates are auto-approved and auto-merged after required checks pass.

## Production Smoke Checks

- Workflow: `.github/workflows/prod-smoke.yml`
- Runs daily at `06:15 UTC` and can be triggered manually via `workflow_dispatch`.
- Executes Playwright smoke checks against production for:
  - login flow
  - add trade flow
  - import sample data flow
  - analytics page load
- Optional repo variable: `PROD_SMOKE_BASE_URL` (defaults to `https://tradevision-ai-bay.vercel.app`).
- Optional failure alerts (configure one or more via repository secrets):
  - Slack: `SLACK_WEBHOOK_URL`
  - Discord: `DISCORD_WEBHOOK_URL`
  - Email (SMTP): `SMTP_SERVER`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMOKE_ALERT_EMAIL_TO`, `SMOKE_ALERT_EMAIL_FROM`

## Recovery

- Recovery runbook: [`RECOVERY.md`](./RECOVERY.md)
- JSON backup restore supports:
  - `Merge` mode (keeps existing trades and imports missing IDs)
  - `Replace` mode (overwrites existing dataset after confirmation)

## Database Setup (optional)

1. Create a [Supabase](https://supabase.com) project
2. Run `supabase/schema.sql` in the SQL Editor
3. Add your credentials to `.env.local`

The schema includes:
- `trades` table with full RLS (Row Level Security)
- Indexes for performant queries
- Auto-updating `updated_at` timestamps

## AI Insights

The AI engine runs 13 pattern detectors client-side:

| Pattern | Type | What it detects |
|---------|------|----------------|
| Revenge Trading | Warning | Increased position size after consecutive losses |
| Tilt Detection | Warning | Poor performance after significant drawdown |
| Overtrading | Warning | Too many trades per day with low win rate |
| Loss Aversion | Warning | Average losses significantly exceed average wins |
| Overleverage | Warning | Leverage increases after winning streaks |
| Holding Losers | Warning | Losing trades held much longer than winners |
| Time Patterns | Warning | Specific hours with consistently poor performance |
| Weekend Trading | Warning | Significantly worse weekend performance |
| Pair Switching | Warning | Excessive switching between trading pairs |
| Declining Performance | Warning | Recent performance worse than earlier period |
| Consistent Pair | Positive | Strong edge on specific trading pairs |
| Good Risk Management | Positive | Healthy profit factor and controlled losses |
| Improving Performance | Positive | Recent performance better than earlier period |

## Project Structure

```
src/
|-- app/                 # Next.js pages (App Router)
|   |-- page.tsx         # Dashboard
|   |-- trades/          # Trade history & management
|   |-- import/          # CSV/JSON import & export
|   |-- insights/        # AI pattern insights
|   |-- analytics/       # Deep analytics & charts
|   |-- calculator/      # Risk calculator
|   `-- login/           # Authentication
|-- components/          # Reusable React components
|-- lib/                 # Supabase clients & auth context
|-- utils/               # Business logic & helpers
|-- types/               # TypeScript interfaces
`-- data/                # Sample trade data
```

## License

Private project.
