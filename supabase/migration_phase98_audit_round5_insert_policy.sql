-- Migration Phase 98 — Audit Round 5 (2026-05-15) INSERT-policy fix
--
-- Round-4 Phase 97 added a ±60s window on `created_at` to the trades INSERT
-- policy WITH CHECK. Round-5 Agent #12 (auth audit) flagged this as a KRIT
-- regression: it breaks bulk re-imports, JSON-export-import, multi-device
-- offline sync, and any client with NTP clock-drift >60s.
--
-- Fix: keep the "no pre-tombstoned rows" invariant, drop the ±60s window,
-- and force `created_at = now()` via a BEFORE INSERT trigger. Strictly safer:
-- the client can send any value, the server normalises it.
--
-- Idempotent.

drop policy if exists "Users can insert their own trades" on trades;
create policy "Users can insert their own trades"
  on trades for insert
  with check (
    auth.uid() = user_id
    and deleted_at is null
  );

create or replace function force_created_at_now()
returns trigger as $$
begin
  new.created_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trades_force_created_at on trades;
create trigger trades_force_created_at
  before insert on trades
  for each row
  execute function force_created_at_now();
