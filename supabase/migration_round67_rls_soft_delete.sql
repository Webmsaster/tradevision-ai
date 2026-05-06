-- Round 67 audit (Bug-Fix Round): tighten RLS to filter soft-deleted rows.
--
-- The R55 (Phase 95) soft-delete migration added the `deleted_at` column +
-- application-side filtering in storage.ts. The RLS SELECT/UPDATE policies
-- were NOT updated to enforce `deleted_at IS NULL`, leaving direct-client
-- access (Supabase Studio, PostgREST without storage-wrapper, custom REST
-- consumer) able to read tombstoned rows including PII (notes, screenshot_url).
--
-- Idempotent: drop+create pattern with `if exists`.

-- SELECT: hide tombstones from the API surface entirely.
drop policy if exists "Users can view their own trades" on trades;
create policy "Users can view their own trades"
  on trades for select
  using (auth.uid() = user_id and deleted_at is null);

-- UPDATE: prevent re-tombstoning a row that's already soft-deleted (would
-- overwrite the deleted_at timestamp + audit-trail).
drop policy if exists "Users can update their own trades" on trades;
create policy "Users can update their own trades"
  on trades for update
  using (auth.uid() = user_id and deleted_at is null)
  with check (auth.uid() = user_id);

-- INSERT/DELETE policies unchanged: INSERT correctly only checks user_id,
-- and the application uses soft-delete via UPDATE (not DELETE) so the
-- DELETE policy is rarely exercised but kept for cleanup admin paths.

-- Trigger hardening: also freeze id and user_id on UPDATE (originally only
-- created_at was frozen). Prevents accidental PK collision or user_id
-- rewriting via PostgREST PATCH on a row the user owns.
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  new.id = old.id;
  new.user_id = old.user_id;
  new.created_at = old.created_at;
  return new;
end;
$$ language plpgsql;
