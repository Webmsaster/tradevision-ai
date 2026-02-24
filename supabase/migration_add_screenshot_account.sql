-- Migration: Add screenshot_url and account_id columns to trades table
-- Run this in your Supabase SQL Editor if you already have the trades table

alter table trades add column if not exists screenshot_url text;
alter table trades add column if not exists account_id text not null default 'default';

-- Index for account filtering
create index if not exists idx_trades_account on trades(user_id, account_id);
