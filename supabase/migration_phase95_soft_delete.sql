-- Phase 95 (Round 54): soft-delete migration for the `trades` table.
-- Project convention (CLAUDE.md) is soft-delete with `deleted_at is null`
-- read filter. This migration is idempotent and safe to re-run.
--
-- Usage: run this AFTER updating to schema.sql v2026-05-03 (which already
-- declares `deleted_at`) on production databases populated under the old
-- hard-delete schema. Until this migration runs, the storage client falls
-- back to hard-delete (best-effort backwards compatibility).

-- 1. Add the soft-delete column. `if not exists` is supported on ADD
--    COLUMN since Postgres 9.6 — safe to re-run.
alter table trades
  add column if not exists deleted_at timestamptz;

-- 2. Partial index for the "active row" read path. WHERE-clause keeps the
--    index small (excludes tombstoned rows entirely).
create index if not exists idx_trades_user_active
  on trades(user_id, exit_date desc)
  where deleted_at is null;

-- 3. (Optional, manual) — to permanently purge soft-deleted rows older
--    than 30 days, run:
--    delete from trades where deleted_at < now() - interval '30 days';
--    Not part of this migration so the operator decides retention.
