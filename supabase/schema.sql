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
  -- Phase 96 (Codex audit): the per-element length check for tags moved
  -- to a BEFORE INSERT/UPDATE trigger (see validate_trade_tags below).
  -- PostgreSQL does NOT allow subqueries (incl. `select … from unnest(...)`)
  -- inside CHECK constraints — the previous predicate
  --   `coalesce((select max(length(t)) from unnest(tags) t), 0) <= 64`
  -- raised 0A000 `cannot use subquery in check constraint` on fresh
  -- deploys, so the cardinality cap was effectively unenforced because
  -- the entire CHECK was rejected.
  tags text[] not null default '{}' check (cardinality(tags) <= 32),
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
  updated_at timestamptz not null default now(),
  -- Phase 95 (R54-STO-7): soft-delete column. Project convention
  -- (CLAUDE.md) is soft-delete with `deleted_at is null` filter.
  -- All read paths filter on `deleted_at is null`; delete paths
  -- update this column instead of issuing a DELETE.
  deleted_at timestamptz
);

-- Index for fast user queries
create index if not exists idx_trades_user_id on trades(user_id);
create index if not exists idx_trades_exit_date on trades(user_id, exit_date desc);
-- Phase 58 (R45-DB-H1): composite for the dashboard's typical filter
-- (account-scoped + sorted by exit-date). Without it a power-user with
-- many trades hits an in-memory sort after the user_id filter.
create index if not exists idx_trades_account_exit
  on trades(user_id, account_id, exit_date desc);
-- Phase 95 (R54-STO-7): partial index for the always-active soft-delete
-- filter so the read path never scans tombstoned rows.
create index if not exists idx_trades_user_active
  on trades(user_id, exit_date desc)
  where deleted_at is null;
-- Phase 58 (R45-DB-H2): drop the rarely-used pair index. Pair filtering
-- happens client-side; this index just adds write-amplification.
drop index if exists idx_trades_pair;

-- Row Level Security: users can only access their own trades
alter table trades enable row level security;

-- R67 audit fix: SELECT/UPDATE policies hide soft-deleted rows so direct-
-- client access (Supabase Studio, custom REST consumer) cannot read PII
-- from tombstoned trades or re-write deleted_at.
create policy "Users can view their own trades"
  on trades for select
  using (auth.uid() = user_id and deleted_at is null);

-- 2026-05-15 (Audit-Round-5 / Agent #12 KRIT — regression fix on Round-4):
-- Round-4 introduced a ±60s `created_at` window in the WITH CHECK predicate
-- to block back-dating, but that broke legitimate use-cases: CSV / JSON
-- re-imports that preserve original timestamps, bulk multi-device sync after
-- offline use, and any client with >60s NTP clock-drift. The fresh-row /
-- anti-tombstone invariant (deleted_at must be null at insert) stays;
-- created_at hardening moves to a BEFORE INSERT trigger that always
-- overwrites the column to now(). This is strictly safer: the client can
-- send any value and it gets normalised server-side.
create policy "Users can insert their own trades"
  on trades for insert
  with check (
    auth.uid() = user_id
    and deleted_at is null
  );

-- Force created_at = now() on INSERT regardless of what the client sent.
-- Pairs with the update_updated_at() trigger which freezes created_at on
-- UPDATE (defined further down the schema). Together: client-provided
-- created_at is silently ignored at INSERT and forbidden at UPDATE.
create or replace function force_created_at_now()
returns trigger as $$
begin
  new.created_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trades_force_created_at on trades;
create trigger trades_force_created_at
  before insert on trades
  for each row
  execute function force_created_at_now();

-- R67 audit (Round 2): UPDATE allowed on tombstoned rows too. The R67-r1
-- attempt to block re-tombstoning broke UPSERT-resolve-to-UPDATE on a
-- soft-deleted row → CSV/JSON re-imports of trades the user previously
-- deleted on another machine fail silently with PostgREST 42501. Audit-
-- protection of the deleted_at column moves to application-side logic
-- (storage.ts deleteTradeFromSupabase already checks `is deleted_at null`).
create policy "Users can update their own trades"
  on trades for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 2026-05-15 (Audit-Round-4 / Agent #11 KRIT): hard DELETE bypassed the
-- project's soft-delete convention (CLAUDE.md). A REST/Studio client could
-- erase the audit trail by issuing a raw DELETE — the application-side
-- soft-delete in `storage.ts deleteTradeFromSupabase` was a single line of
-- defence. Policy now blocks all DELETEs at the DB level; deletion is
-- exclusively `update set deleted_at = now()`. Hard purge for the 30-day
-- retention window runs server-side under the service role (e.g. `pg_cron`),
-- not from the client.
create policy "Block client-side hard delete (use soft-delete UPDATE)"
  on trades for delete
  using (false);

-- Auto-update updated_at timestamp + freeze created_at on update.
-- Phase 69 (R45-DB-M6): without `new.created_at = old.created_at`, an
-- API client (or a misbehaving migration) could rewrite created_at on
-- update, breaking auditability and any time-series analytics that
-- assumes created_at is monotonic.
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  -- R67 audit: also freeze id and user_id on UPDATE so PostgREST PATCH
  -- can't rewrite the PK or steal the row's owner.
  new.id = old.id;
  new.user_id = old.user_id;
  new.created_at = old.created_at;
  return new;
end;
$$ language plpgsql;

create trigger trades_updated_at
  before update on trades
  for each row
  execute function update_updated_at();

-- Phase 96 (Codex audit): per-element length validation for the `tags`
-- array. Moved out of the CHECK constraint because PostgreSQL forbids
-- subqueries (including `select … from unnest(arr)`) inside CHECK. The
-- BEFORE INSERT/UPDATE trigger enforces the same invariant — every tag
-- must be ≤ 64 chars — without a subquery in the expression tree.
-- The cardinality cap (≤ 32) stays as a scalar CHECK on the column.
create or replace function validate_trade_tags()
returns trigger as $$
declare
  tag text;
begin
  if new.tags is not null then
    foreach tag in array new.tags loop
      if length(tag) > 64 then
        raise exception 'tag exceeds 64-character limit: %', left(tag, 80)
          using errcode = 'check_violation';
      end if;
    end loop;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trades_validate_tags on trades;
create trigger trades_validate_tags
  before insert or update on trades
  for each row
  execute function validate_trade_tags();

-- R67 audit (Round 5): the R67-r3 DB-level un-tombstone trigger was
-- dropped because it conflicted with the R67-r2 UPSERT-resolve-to-UPDATE
-- path used for CSV/JSON re-imports of previously-deleted trades.
-- Audit-trail protection now lives in the application layer:
-- `deleteTradeFromSupabase` filters `.is("deleted_at", null)` on its
-- UPDATE WHERE clause, so tombstones cannot be silently rewritten via
-- the delete path. See migration_round67_audit_trigger_drop.sql.
