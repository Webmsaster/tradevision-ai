-- Phase 96 (Codex audit): two related fixes for the trades table.
--
-- Bug 1 (KRITISCH) — invalid CHECK constraint with subquery.
--   schema.sql (pre-Phase-96) and migration_phase58_constraints.sql both
--   defined a CHECK on `tags` whose predicate contained
--     `coalesce((select max(length(t)) from unnest(tags) t), 0) <= 64`
--   PostgreSQL forbids subqueries inside CHECK constraints (SQLSTATE
--   0A000 / "cannot use subquery in check constraint"). The result:
--     • on a fresh deploy of schema.sql the CREATE TABLE statement
--       failed wholesale, so the table was never created;
--     • on the phase58 migration the offending ALTER TABLE block was
--       silently swallowed by the `exception when duplicate_object`
--       wrapper because the raised error was not actually
--       `duplicate_object`, so no constraint was registered.
--   In both cases the cardinality cap (`cardinality(tags) <= 32`) was
--   also lost because the whole CHECK was rejected as one unit.
--
--   Fix: drop the malformed CHECK if it somehow exists, install a
--   scalar-only CHECK for the cardinality cap, and move the per-element
--   length validation into a BEFORE INSERT/UPDATE trigger.
--
-- Bug 2 (MITTEL) — phase58 migration weakened the hardened update trigger.
--   schema.sql defines `update_updated_at()` to freeze `id`,
--   `user_id`, and `created_at` on UPDATE (R67 audit hardening to stop
--   PostgREST PATCH from rewriting the PK or stealing row ownership).
--   migration_phase58_constraints.sql:79 redefines the same function
--   with only `updated_at` / `created_at` freezing — wiping out the id
--   and user_id locks. On any prod DB where phase58 ran AFTER schema.sql,
--   PostgREST clients can currently rewrite id and user_id via PATCH.
--
--   Fix: re-install the hardened version of `update_updated_at()`.
--
-- This migration is idempotent and safe to re-run.

-- ────────────────────────────────────────────────────────────────────────
-- 1. Drop the malformed tags CHECK if it was somehow registered (e.g. on
--    a Postgres fork that tolerates the subquery, or via a hand-edit).
-- ────────────────────────────────────────────────────────────────────────
alter table trades drop constraint if exists trades_tags_length;

-- ────────────────────────────────────────────────────────────────────────
-- 2. The original inline CHECK in `create table` may also exist as an
--    anonymous constraint. Postgres auto-names it `trades_tags_check`
--    when no name is given. Drop that too if present.
-- ────────────────────────────────────────────────────────────────────────
alter table trades drop constraint if exists trades_tags_check;

-- ────────────────────────────────────────────────────────────────────────
-- 3. Re-register the scalar-only cardinality cap.
-- ────────────────────────────────────────────────────────────────────────
do $$
begin
  alter table trades add constraint trades_tags_cardinality
    check (cardinality(tags) <= 32);
exception when duplicate_object then null; end $$;

-- ────────────────────────────────────────────────────────────────────────
-- 4. Per-element length validation via BEFORE INSERT/UPDATE trigger.
--    Mirrors the original ≤64-char cap but lives outside the CHECK
--    expression tree so the subquery restriction does not apply.
-- ────────────────────────────────────────────────────────────────────────
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

-- ────────────────────────────────────────────────────────────────────────
-- 5. Re-install the hardened `update_updated_at()` from schema.sql.
--    R67 audit lock: freeze id, user_id, created_at on UPDATE so
--    PostgREST PATCH cannot rewrite the PK or steal row ownership.
--    The phase58 migration accidentally replaced this with a weaker
--    variant that only froze created_at.
-- ────────────────────────────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  -- R67 audit hardening — restored after phase58 weakened it.
  new.id = old.id;
  new.user_id = old.user_id;
  new.created_at = old.created_at;
  return new;
end;
$$ language plpgsql;

-- Ensure the trigger is wired (idempotent — `drop trigger if exists` +
-- `create trigger` is the safe form on PG ≤ 13 since there is no
-- `create or replace trigger`).
drop trigger if exists trades_updated_at on trades;
create trigger trades_updated_at
  before update on trades
  for each row
  execute function update_updated_at();
