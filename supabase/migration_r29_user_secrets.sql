-- Round 29 (R19-A8 deferred close-out): server-side encrypted secrets vault.
--
-- Background: R19-A8 audit flagged that the Telegram-bot token + webhook
-- URLs were stored in plaintext localStorage. Anyone with browser-debug
-- access (XSS, malicious extension, shoulder-surfer) could read the raw
-- token. The interim mitigation was a client-side AES-GCM offline-key
-- (see `src/utils/offlineKey.ts`) — better than plaintext, but the key
-- itself lives in localStorage too, so it's defence-in-depth, not a vault.
--
-- This migration adds a true server-side vault: encrypted ciphertext is
-- written by the API route handler, NEVER returned to the client in raw
-- form, and decrypted only on the server before being used (e.g. when
-- the bot fires a webhook from a server-side cron). The client only ever
-- sees a "configured: yes/no" indicator + an opaque marker; the raw
-- token never crosses the network after the initial PUT.
--
-- =====================================================================
-- DEPLOY
-- =====================================================================
--   1. Apply with `npx supabase db push` (CLI) or paste into Supabase
--      Studio's SQL editor and run.
--   2. Generate a 32-byte hex key:   `openssl rand -hex 32`
--   3. Set `SECRETS_VAULT_KEY=<hex>` on the server (Vercel env var,
--      "Production" + "Preview" scopes; never expose to client).
--   4. Without `SECRETS_VAULT_KEY` the vault is read-only/disabled and
--      writes return 503 — clients fall back to the existing client-side
--      AES-GCM offline-key path.
--
-- The encryption key is intentionally NOT stored in the database. If the
-- DB is breached, the ciphertext is useless without the env-var key
-- (defence-in-depth). Rotating the key requires re-encrypting all rows
-- with the previous key first; that tooling is out of scope for this
-- scaffold.
-- =====================================================================

-- Idempotent: this migration is safe to re-apply.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------
-- user_secrets — encrypted key/value vault, scoped per user.
-- ---------------------------------------------------------------------
-- Layout:
--   user_id    : owner; FK to auth.users with cascade delete so a user
--                deletion wipes their secrets atomically.
--   key        : namespace string (e.g. 'webhook.url', 'telegram.token').
--                Length-capped to 64 chars (no abuse via huge keys).
--   value      : base64-encoded AES-GCM ciphertext blob; the format is
--                <12-byte-iv><ciphertext><16-byte-tag>, base64url-decoded
--                by the server. Length-capped at 16 KiB to bound the
--                damage if a buggy client tries to store a megabyte blob.
--   updated_at : last write; useful for "last-rotated" UI hints.
--
-- Composite PK (user_id, key) enforces "one value per key per user" so
-- re-uploads UPSERT cleanly without duplicates.

create table if not exists user_secrets (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (length(key) > 0 and length(key) <= 64),
  value text not null check (length(value) > 0 and length(value) <= 16384),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Lookup index for the common "load all secrets for current user" query
-- (the API GET handler issues `select * from user_secrets where user_id = auth.uid()`).
-- The composite PK already covers (user_id, key) reads, but a leading-
-- only `user_id` index is cheaper for the unbounded scan that GET uses.
create index if not exists idx_user_secrets_user_id on user_secrets(user_id);

-- ---------------------------------------------------------------------
-- Row Level Security: only the row owner can read/write.
-- ---------------------------------------------------------------------
-- Every policy is namespaced to `auth.uid() = user_id`. The service-role
-- key bypasses RLS as usual — but the server crypto key is not in the
-- DB, so even a service-role leak does not yield plaintext secrets.

alter table user_secrets enable row level security;

drop policy if exists "Users can read their own secrets" on user_secrets;
create policy "Users can read their own secrets"
  on user_secrets for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own secrets" on user_secrets;
create policy "Users can insert their own secrets"
  on user_secrets for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own secrets" on user_secrets;
create policy "Users can update their own secrets"
  on user_secrets for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own secrets" on user_secrets;
create policy "Users can delete their own secrets"
  on user_secrets for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- updated_at maintenance + ownership freeze on UPDATE.
-- ---------------------------------------------------------------------
-- Mirrors the trades-table pattern: PostgREST PATCH must not be able to
-- rewrite user_id (steal-the-row) or backdate updated_at.

create or replace function user_secrets_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  -- Freeze ownership + key on UPDATE. PostgREST PATCH could otherwise
  -- rewrite user_id (steal another tenant's row if RLS were
  -- misconfigured) or alter the key portion of the composite PK.
  new.user_id = old.user_id;
  new.key = old.key;
  return new;
end;
$$;

drop trigger if exists user_secrets_updated_at on user_secrets;
create trigger user_secrets_updated_at
  before update on user_secrets
  for each row execute function user_secrets_touch_updated_at();
