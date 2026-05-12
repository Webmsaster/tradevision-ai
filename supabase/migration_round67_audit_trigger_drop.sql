-- Round 67 audit (Round 5): drop the DB-level un-tombstone trigger.
--
-- R67-r3 added `trades_protect_audit_before_update` to block any UPDATE
-- that flips `deleted_at` from NOT NULL back to NULL. R67-r2 had loosened
-- the RLS UPDATE policy so UPSERT-resolve-to-UPDATE works on tombstoned
-- rows (needed for CSV/JSON re-import of a previously-deleted trade).
--
-- Together these caused a silent-failure bug: the UPSERT "succeeds" (no
-- error returned by PostgREST) but the row stays tombstoned because the
-- trigger blocks the deleted_at→NULL flip, and the SELECT-policy then
-- hides the row from the UI. From the user's perspective, re-importing
-- a deleted trade does nothing.
--
-- Fix: drop the trigger. Audit-trail protection now lives entirely in
-- the application layer — `deleteTradeFromSupabase` filters
-- `.is("deleted_at", null)` on its UPDATE WHERE clause, so a double-
-- delete is a no-op and tombstones cannot be silently rewritten by the
-- delete path. The explicit re-import path (in `saveBulkTradesToSupabase`
-- after a successful UPSERT) is the only sanctioned un-tombstone route.

drop trigger if exists trades_protect_audit_before_update on trades;
drop function if exists trades_protect_audit_trail();
