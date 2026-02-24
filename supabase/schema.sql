-- TradeVision AI - Database Schema
-- Run this in your Supabase SQL Editor to set up the database

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Trades table
create table if not exists trades (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  pair text not null,
  direction text not null check (direction in ('long', 'short')),
  entry_price numeric not null,
  exit_price numeric not null,
  quantity numeric not null,
  entry_date timestamptz not null,
  exit_date timestamptz not null,
  pnl numeric not null default 0,
  pnl_percent numeric not null default 0,
  fees numeric not null default 0,
  leverage numeric not null default 1,
  notes text not null default '',
  tags text[] not null default '{}',
  strategy text,
  emotion text check (emotion in ('confident', 'neutral', 'fearful', 'greedy', 'fomo', 'revenge')),
  confidence integer check (confidence between 1 and 5),
  setup_type text,
  timeframe text,
  market_condition text check (market_condition in ('trending', 'ranging', 'volatile', 'calm')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for fast user queries
create index if not exists idx_trades_user_id on trades(user_id);
create index if not exists idx_trades_exit_date on trades(user_id, exit_date desc);
create index if not exists idx_trades_pair on trades(user_id, pair);

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
  using (auth.uid() = user_id);

create policy "Users can delete their own trades"
  on trades for delete
  using (auth.uid() = user_id);

-- Auto-update updated_at timestamp
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trades_updated_at
  before update on trades
  for each row
  execute function update_updated_at();
