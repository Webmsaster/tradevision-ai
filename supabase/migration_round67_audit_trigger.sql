-- R67 audit (Round 3): DB-level audit-trail protection trigger.
--
-- Background: R67-r2 reverted the RLS UPDATE policy to
-- `using (auth.uid() = user_id)` (without the `deleted_at is null`
-- guard) so UPSERT-resolve-to-UPDATE on tombstoned rows succeeds for
-- CSV/JSON re-imports. That fix is correct for the import path, but it
-- opens a hole: any direct PostgREST PATCH can now flip
-- `deleted_at` from NOT NULL back to NULL, silently un-tombstoning a
-- soft-deleted trade and breaking the audit trail.
--
-- This trigger closes that hole at the database level. Re-tombstoning
-- (NULL → NOT NULL) and normal UPSERT (NULL → NULL with other column
-- changes) still pass through unchanged.

create or replace function trades_protect_audit_trail()
returns trigger language plpgsql as $$
begin
  if old.deleted_at is not null and new.deleted_at is null then
    raise exception 'cannot un-tombstone a soft-deleted trade (use admin tooling)';
  end if;
  return new;
end$$;

drop trigger if exists trades_protect_audit_before_update on trades;
create trigger trades_protect_audit_before_update
  before update on trades
  for each row execute function trades_protect_audit_trail();
