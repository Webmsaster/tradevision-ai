-- TradeVision AI - Database Schema
-- Run this in your Supabase SQL Editor to set up the database

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Trades table
create table if not exists trades (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  pair text not null check (length(pair) <= 64),
  direction text not null check (direction in ('long', 'short')),
  -- Phase 58 (R45-DB-Skipped-1): positivity checks. Without these a
  -- malformed CSV import or a buggy client could insert negative prices
  -- / zero quantity, breaking every downstream calculation.
  entry_price numeric not null check (entry_price > 0),
  exit_price numeric not null check (exit_price > 0),
  quantity numeric not null check (quantity > 0),
  entry_date timestamptz not null,
  exit_date timestamptz not null,
  pnl numeric not null default 0,
  pnl_percent numeric not null default 0,
  fees numeric not null default 0 check (fees >= 0),
  leverage numeric not null default 1 check (leverage > 0),
  -- Phase 58 (R45-DB-H4): notes/tags length-cap. text type is otherwise
  -- unbounded → DoS / TOAST-bloat vector if a client posts megabytes.
  notes text not null default '' check (length(notes) <= 5000),
  tags text[] not null default '{}' check (
    cardinality(tags) <= 32 and
    coalesce((select max(length(t)) from unnest(tags) t), 0) <= 64
  ),
  strategy text check (strategy is null or length(strategy) <= 128),
  emotion text check (emotion in ('confident', 'neutral', 'fearful', 'greedy', 'fomo', 'revenge')),
  confidence integer check (confidence between 1 and 5),
  setup_type text check (setup_type is null or length(setup_type) <= 64),
  timeframe text check (timeframe is null or length(timeframe) <= 16),
  market_condition text check (market_condition in ('trending', 'ranging', 'volatile', 'calm')),
  -- Phase 58 (R45-DB-M2): screenshot_url cap. validateScreenshot caps at
  -- ~2 MB but the DB had no second-line defence.
  screenshot_url text check (screenshot_url is null or length(screenshot_url) <= 3000000),
  account_id text not null default 'default' check (length(account_id) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for fast user queries
create index if not exists idx_trades_user_id on trades(user_id);
create index if not exists idx_trades_exit_date on trades(user_id, exit_date desc);
-- Phase 58 (R45-DB-H1): composite for the dashboard's typical filter
-- (account-scoped + sorted by exit-date). Without it a power-user with
-- many trades hits an in-memory sort after the user_id filter.
create index if not exists idx_trades_account_exit
  on trades(user_id, account_id, exit_date desc);
-- Phase 58 (R45-DB-H2): drop the rarely-used pair index. Pair filtering
-- happens client-side; this index just adds write-amplification.
drop index if exists idx_trades_pair;

-- Row Level Security: users can only access their own trades
alter table trades enable row level security;

create policy "Users can view their own trades"
  on trades for select
  using (auth.uid() = user_id);

create policy "Users can insert their own trades"
  on trades for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own trades"
  on trades for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own trades"
  on trades for delete
  using (auth.uid() = user_id);

-- Auto-update updated_at timestamp + freeze created_at on update.
-- Phase 69 (R45-DB-M6): without `new.created_at = old.created_at`, an
-- API client (or a misbehaving migration) could rewrite created_at on
-- update, breaking auditability and any time-series analytics that
-- assumes created_at is monotonic.
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  new.created_at = old.created_at;
  return new;
end;
$$ language plpgsql;

create trigger trades_updated_at
  before update on trades
  for each row
  execute function update_updated_at();
