-- Round 29 (R14-A7 multi-tenant follow-up): user → FTMO state-dir mapping.
--
-- Apply with `npx supabase db push`. Single-owner VPS deploys can ignore this
-- migration — `FTMO_ADMIN_EMAIL` already covers them. This table is only
-- consulted as a SECOND chance after the admin-email check fails, so a missing
-- table or empty rows never breaks the existing single-owner flow.
--
-- Background: `/api/drift-data?ftmo_tf=<slug>` previously gated arbitrary-slug
-- reads via `FTMO_ADMIN_EMAIL` only. That works for a self-hosted single-owner
-- VPS but not for a hypothetical SaaS deploy where multiple users share the
-- monitor URL and each owns one or more state-dirs. This migration adds the
-- explicit user→slug mapping the SaaS path needs.
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS or DROP-then-CREATE,
-- safe to re-run.
--
-- Out of scope (not in this migration):
--   - Client UI for managing the mapping (SaaS-product decision; deferred).
--   - Audit-trail / change-log (Postgres logical replication is enough for now).
--   - Soft-delete of mappings (can just hard-delete; cheap to reinsert).

create table if not exists user_ftmo_accounts (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Mirrors `TF_SLUG_RE` in src/app/api/drift-data/route.ts:
  --   ^[a-z0-9][a-z0-9-]{0,63}$
  -- Plus a generic length-cap so a malicious INSERT can't bloat the row.
  tf_slug text not null check (
    length(tf_slug) between 1 and 64
    and tf_slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'
  ),
  account_label text check (account_label is null or length(account_label) <= 64),
  created_at timestamptz not null default now(),
  primary key (user_id, tf_slug)
);

-- Slug-auth lookup uses (user_id, tf_slug) — the PRIMARY KEY already covers
-- this with a btree index on (user_id, tf_slug). Adding (user_id) explicitly
-- for the "list all my mappings" path; redundant only if PostgreSQL ever
-- starts using PK leftmost-prefix scans for it (it does, but the explicit
-- index is cheap and documents intent).
create index if not exists idx_user_ftmo_accounts_user_id
  on user_ftmo_accounts(user_id);

-- Row Level Security: each user can only see/insert/delete their own rows.
alter table user_ftmo_accounts enable row level security;

drop policy if exists "Users can view their own ftmo account mappings" on user_ftmo_accounts;
create policy "Users can view their own ftmo account mappings"
  on user_ftmo_accounts for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own ftmo account mappings" on user_ftmo_accounts;
create policy "Users can insert their own ftmo account mappings"
  on user_ftmo_accounts for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own ftmo account mappings" on user_ftmo_accounts;
create policy "Users can delete their own ftmo account mappings"
  on user_ftmo_accounts for delete
  using (auth.uid() = user_id);

-- UPDATE intentionally NOT allowed: account_label is set on insert and then
-- immutable. Renaming = delete + insert (cheap; PK is composite). Locking
-- this down keeps the audit story simple — every (user_id, tf_slug) row is
-- write-once.
drop policy if exists "Users can update their own ftmo account mappings" on user_ftmo_accounts;
-- Deliberately no CREATE POLICY for UPDATE.
