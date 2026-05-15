-- Migration Phase 97 — Audit Round 4 (2026-05-15) RLS hardening
--
-- Two policy bugs found by Agent #11 in the 2026-05-15 audit round (12-agent
-- bug hunt). schema.sql was edited in the same commit; this migration brings
-- already-deployed databases in line.
--
-- (1) KRIT  — Hard DELETE bypassed soft-delete convention. A REST client
--             could erase the audit trail by issuing a raw DELETE against
--             /rest/v1/trades; application-side `storage.ts` filtering was
--             the only line of defence.
-- (2) HIGH  — INSERT policy did not constrain `deleted_at` or `created_at`.
--             A client could insert "pre-tombstoned" rows (deleted_at=now())
--             that consumed storage and never appeared in the UI, or
--             backdate created_at to corrupt audit history.
--
-- Both fixes are idempotent via `drop policy if exists` / re-create.

-- (1) Block raw DELETE; soft-delete via UPDATE only. Hard purge for the
-- 30-day retention window runs server-side under the service role.
drop policy if exists "Users can delete their own trades" on trades;
drop policy if exists "Block client-side hard delete (use soft-delete UPDATE)" on trades;
create policy "Block client-side hard delete (use soft-delete UPDATE)"
  on trades for delete
  using (false);

-- (2) Tighten INSERT WITH CHECK so clients can't pre-tombstone or backdate.
drop policy if exists "Users can insert their own trades" on trades;
create policy "Users can insert their own trades"
  on trades for insert
  with check (
    auth.uid() = user_id
    and deleted_at is null
    and created_at >= now() - interval '60 seconds'
    and created_at <= now() + interval '60 seconds'
  );
