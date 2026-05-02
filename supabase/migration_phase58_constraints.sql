-- Phase 58 (Round 47): constraints + indexes for existing deployments.
-- Run AFTER updating schema.sql for new deploys; this script is the
-- in-place migration for production DBs already populated.
--
-- Safe to run multiple times (all statements idempotent or guarded).

-- 1. Positivity / range CHECKs on numeric columns.
alter table trades
  add constraint if not exists trades_entry_price_positive
  check (entry_price > 0);
alter table trades
  add constraint if not exists trades_exit_price_positive
  check (exit_price > 0);
alter table trades
  add constraint if not exists trades_quantity_positive
  check (quantity > 0);
alter table trades
  add constraint if not exists trades_fees_nonneg
  check (fees >= 0);
alter table trades
  add constraint if not exists trades_leverage_positive
  check (leverage > 0);

-- 2. Length-caps on text columns to prevent DoS / TOAST bloat.
alter table trades
  add constraint if not exists trades_pair_length
  check (length(pair) <= 64);
alter table trades
  add constraint if not exists trades_notes_length
  check (length(notes) <= 5000);
alter table trades
  add constraint if not exists trades_tags_length
  check (
    cardinality(tags) <= 32 and
    coalesce((select max(length(t)) from unnest(tags) t), 0) <= 64
  );
alter table trades
  add constraint if not exists trades_strategy_length
  check (strategy is null or length(strategy) <= 128);
alter table trades
  add constraint if not exists trades_setup_type_length
  check (setup_type is null or length(setup_type) <= 64);
alter table trades
  add constraint if not exists trades_timeframe_length
  check (timeframe is null or length(timeframe) <= 16);
alter table trades
  add constraint if not exists trades_screenshot_url_length
  check (screenshot_url is null or length(screenshot_url) <= 3000000);
alter table trades
  add constraint if not exists trades_account_id_length
  check (length(account_id) <= 64);

-- 3. New composite index for account-scoped exit-date sort.
create index if not exists idx_trades_account_exit
  on trades(user_id, account_id, exit_date desc);

-- 4. Drop unused pair index (filter happens client-side).
drop index if exists idx_trades_pair;
