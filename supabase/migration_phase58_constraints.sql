-- Phase 58 (Round 47): constraints + indexes for existing deployments.
-- Run AFTER updating schema.sql for new deploys; this script is the
-- in-place migration for production DBs already populated.
--
-- Phase 82 (Round 51): replaced `add constraint if not exists` with
-- exception-handler do-blocks. PostgreSQL does NOT support `IF NOT
-- EXISTS` on `ADD CONSTRAINT` for CHECK constraints — the original
-- script would fail wholesale on a re-run (`42710 duplicate_object`)
-- and on first run if any existing row violated the predicate (no
-- `NOT VALID` split). The wrapper makes each block idempotent and
-- skips with a NOTICE when the constraint already exists.

do $$
begin
  alter table trades add constraint trades_entry_price_positive check (entry_price > 0);
exception when duplicate_object then null; end $$;
do $$
begin
  alter table trades add constraint trades_exit_price_positive check (exit_price > 0);
exception when duplicate_object then null; end $$;
do $$
begin
  alter table trades add constraint trades_quantity_positive check (quantity > 0);
exception when duplicate_object then null; end $$;
do $$
begin
  alter table trades add constraint trades_fees_nonneg check (fees >= 0);
exception when duplicate_object then null; end $$;
do $$
begin
  alter table trades add constraint trades_leverage_positive check (leverage > 0);
exception when duplicate_object then null; end $$;

-- 2. Length-caps on text columns to prevent DoS / TOAST bloat.
do $$
begin
  alter table trades add constraint trades_pair_length check (length(pair) <= 64);
exception when duplicate_object then null; end $$;
do $$
begin
  alter table trades add constraint trades_notes_length check (length(notes) <= 5000);
exception when duplicate_object then null; end $$;
do $$
begin
  alter table trades add constraint trades_tags_length check (
    cardinality(tags) <= 32 and
    coalesce((select max(length(t)) from unnest(tags) t), 0) <= 64
  );
exception when duplicate_object then null; end $$;
do $$
begin
  alter table trades add constraint trades_strategy_length check (strategy is null or length(strategy) <= 128);
exception when duplicate_object then null; end $$;
do $$
begin
  alter table trades add constraint trades_setup_type_length check (setup_type is null or length(setup_type) <= 64);
exception when duplicate_object then null; end $$;
do $$
begin
  alter table trades add constraint trades_timeframe_length check (timeframe is null or length(timeframe) <= 16);
exception when duplicate_object then null; end $$;
do $$
begin
  alter table trades add constraint trades_screenshot_url_length check (screenshot_url is null or length(screenshot_url) <= 3000000);
exception when duplicate_object then null; end $$;
do $$
begin
  alter table trades add constraint trades_account_id_length check (length(account_id) <= 64);
exception when duplicate_object then null; end $$;

-- 3. New composite index for account-scoped exit-date sort.
create index if not exists idx_trades_account_exit
  on trades(user_id, account_id, exit_date desc);

-- 4. Drop unused pair index (filter happens client-side).
drop index if exists idx_trades_pair;

-- 5. Phase 69 (R45-DB-M6): freeze created_at on update.
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  new.created_at = old.created_at;
  return new;
end;
$$ language plpgsql;

-- Phase 82 (Round 51 R51-DB-C2): the function above replaces the existing
-- one in-place, but on a fresh deployment of THIS migration (without
-- prior schema.sql trigger) there's no trigger wired to it. Recreate
-- it idempotently. `drop trigger if exists` + `create trigger` is
-- the safe form (no `create or replace trigger` in PG ≤ 13).
drop trigger if exists trades_updated_at on trades;
create trigger trades_updated_at
  before update on trades
  for each row
  execute function update_updated_at();
