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
--
-- ⚠️ Phase 96 (Codex audit) — TWO BUGS IN THIS FILE were superseded.
-- The `trades_tags_length` CHECK below (with a subquery on unnest) is
-- INVALID SQL — PostgreSQL forbids subqueries inside CHECK constraints
-- (SQLSTATE 0A000). The exception handler around it swallows the real
-- error silently, so on fresh runs no tag cap is enforced at all.
-- The `update_updated_at()` redefinition further down also weakens the
-- hardened R67 trigger (drops the id/user_id freeze).
-- Run `migration_phase96_fix_check_and_trigger.sql` AFTER this file
-- (or instead of it on a fresh DB) to install the correct enforcement.

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
-- Phase 96 (Codex audit): the original `trades_tags_length` CHECK below
-- contained a subquery (`select max(length(t)) from unnest(tags) t`)
-- which PostgreSQL rejects with 0A000. The exception handler caught the
-- wrong error class, so it was silently dropped on every run and no tag
-- cap was ever enforced. Cardinality + per-element length enforcement
-- moved to `migration_phase96_fix_check_and_trigger.sql` (scalar CHECK
-- + BEFORE INSERT/UPDATE trigger). This block is intentionally a no-op.
--
-- ORIGINAL (kept for reference, do NOT re-enable):
--   alter table trades add constraint trades_tags_length check (
--     cardinality(tags) <= 32 and
--     coalesce((select max(length(t)) from unnest(tags) t), 0) <= 64
--   );
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
--    Phase 96 (Codex audit): also re-establish the R67 hardening that
--    freezes id and user_id. Earlier revisions of this migration only
--    froze updated_at/created_at and inadvertently dropped the R67
--    id/user_id locks when re-run after schema.sql.
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  -- R67 audit hardening (restored Phase 96): freeze id and user_id so a
  -- PostgREST PATCH cannot rewrite the PK or steal the row's owner.
  new.id = old.id;
  new.user_id = old.user_id;
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
