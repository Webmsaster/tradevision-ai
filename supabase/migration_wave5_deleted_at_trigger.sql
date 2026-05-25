-- 2026-05-25 Wave5 KRIT FIX (security audit): trades.deleted_at must be
-- append-only from authenticated clients. The R67 UPDATE policy only checks
-- `auth.uid() = user_id` for both USING and WITH CHECK — a PostgREST PATCH
-- client can freely set/clear `deleted_at` (resurrect soft-deleted rows or
-- back-date deletions). Comments claimed app-side enforcement in storage.ts
-- but the DB had no defense.
--
-- This trigger enforces:
--   - NULL → timestamp transition: ALLOW (legitimate soft-delete)
--   - timestamp → NULL transition: BLOCK (resurrection — must use service_role)
--   - timestamp → different timestamp: BLOCK (back-dating manipulation)
--   - service_role bypasses entirely (admin operations)

create or replace function trades_guard_deleted_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  jwt_role text;
begin
  -- service_role bypasses all guards (legitimate admin ops)
  jwt_role := nullif(current_setting('request.jwt.claim.role', true), '');
  if jwt_role = 'service_role' then
    return new;
  end if;

  -- Only inspect when deleted_at actually changed
  if new.deleted_at is distinct from old.deleted_at then
    -- Block resurrection
    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'trades.deleted_at resurrection denied (use service_role)'
        using errcode = '42501';
    end if;
    -- Block back-dating / re-tombstoning
    if old.deleted_at is not null and new.deleted_at is not null then
      raise exception 'trades.deleted_at re-tombstoning denied'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trades_guard_deleted_at on trades;
create trigger trades_guard_deleted_at
  before update on trades
  for each row
  execute function trades_guard_deleted_at();

comment on function trades_guard_deleted_at() is
  'Wave5 KRIT fix: enforces deleted_at as append-only for authenticated clients. '
  'service_role bypasses for legitimate admin operations.';
