/**
 * Tests for `src/lib/userFtmoAccounts.ts` — multi-tenant user → slug mapping.
 *
 * Covers:
 *   - Happy path: a user mapped to one slug → canUserReadSlug returns true,
 *     getAllowedSlugsForUser returns the slug.
 *   - RLS denial path: when Supabase returns an error (e.g. RLS rejected the
 *     SELECT for a foreign user_id) the helper fails CLOSED.
 *   - Non-existent slug path: a user mapped to slug A asking about slug B.
 *   - Empty userId / malformed slug: defensive short-circuit before any DB
 *     round-trip.
 *   - Missing migration (table 42P01): fails CLOSED so single-owner VPS keeps
 *     working via the admin-email FAST path.
 */
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAllowedSlugsForUser,
  canUserReadSlug,
} from "@/lib/userFtmoAccounts";

// ---------------------------------------------------------------------------
// Mock builder — minimal Supabase client that fakes the full chain
// `from("user_ftmo_accounts").select("tf_slug").eq(...).eq(...).limit(...)`.
// Stores the recorded `eq()` filters so tests can simulate RLS behaviour
// (RLS just shows zero rows that don't match `auth.uid() = user_id`).
// ---------------------------------------------------------------------------

interface MockOpts {
  // Rows the table contains. Helper applies `.eq()` filters in-memory.
  rows?: Array<{ user_id: string; tf_slug: string }>;
  // If set, the query resolves with this error and no data (RLS denial,
  // missing-table, network blip). The helper must fail CLOSED.
  error?: { message: string; code?: string };
  // If true, the .from() call throws synchronously (catches the catch path).
  throwOnFrom?: boolean;
}

function makeMockClient(opts: MockOpts): SupabaseClient {
  const rows = opts.rows ?? [];

  function buildChain(filters: Array<[string, unknown]>) {
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn((col: string, val: unknown) => {
      filters.push([col, val]);
      return chain;
    });
    chain.limit = vi.fn(() => resolveQuery(filters));
    // For the "list all my slugs" path the helper awaits the chain
    // directly after the single .eq() — so the chain itself must be
    // thenable. Using a Promise-shaped object here.
    (chain as { then?: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) => resolveQuery(filters).then(resolve, reject);
    return chain;
  }

  function resolveQuery(filters: Array<[string, unknown]>) {
    if (opts.error) {
      return Promise.resolve({ data: null, error: opts.error });
    }
    let result = rows.slice();
    for (const [col, val] of filters) {
      result = result.filter(
        (r) => (r as Record<string, unknown>)[col] === val,
      );
    }
    return Promise.resolve({
      data: result.map((r) => ({ tf_slug: r.tf_slug })),
      error: null,
    });
  }

  return {
    from: vi.fn((table: string) => {
      if (opts.throwOnFrom) throw new Error("boom");
      if (table !== "user_ftmo_accounts") {
        // The helper only ever queries this table; surface a loud failure
        // if it ever drifts.
        throw new Error(`unexpected table: ${table}`);
      }
      const filters: Array<[string, unknown]> = [];
      return {
        select: vi.fn(() => buildChain(filters)),
      };
    }),
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// canUserReadSlug
// ---------------------------------------------------------------------------

describe("canUserReadSlug", () => {
  it("returns true for a user mapped to the requested slug (happy path)", async () => {
    const client = makeMockClient({
      rows: [
        { user_id: "user-a", tf_slug: "2h-trend-v5-r28-v6-passlock-demo1" },
      ],
    });
    const ok = await canUserReadSlug(
      "user-a",
      "2h-trend-v5-r28-v6-passlock-demo1",
      client,
    );
    expect(ok).toBe(true);
  });

  it("returns false for a slug the user is NOT mapped to (non-existent)", async () => {
    const client = makeMockClient({
      rows: [{ user_id: "user-a", tf_slug: "demo1" }],
    });
    const ok = await canUserReadSlug("user-a", "demo2-other-tenant", client);
    expect(ok).toBe(false);
  });

  it("returns false when RLS denies the SELECT (fails closed)", async () => {
    // RLS denial in PostgREST surfaces as `error: { code: 'PGRST...' }`.
    // The exact code varies; the helper just looks at `error` truthiness.
    const client = makeMockClient({
      error: { message: "row-level security violation", code: "42501" },
    });
    const ok = await canUserReadSlug("user-a", "demo1", client);
    expect(ok).toBe(false);
  });

  it("returns false when the table does not exist (migration unapplied)", async () => {
    const client = makeMockClient({
      error: {
        message: 'relation "user_ftmo_accounts" does not exist',
        code: "42P01",
      },
    });
    const ok = await canUserReadSlug("user-a", "demo1", client);
    expect(ok).toBe(false);
  });

  it("returns false when .from() throws synchronously", async () => {
    const client = makeMockClient({ throwOnFrom: true });
    const ok = await canUserReadSlug("user-a", "demo1", client);
    expect(ok).toBe(false);
  });

  it("short-circuits on empty userId without a DB round-trip", async () => {
    const fromSpy = vi.fn();
    const client = { from: fromSpy } as unknown as SupabaseClient;
    const ok = await canUserReadSlug("", "demo1", client);
    expect(ok).toBe(false);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed slugs (path-traversal / uppercase / empty) without DB", async () => {
    const fromSpy = vi.fn();
    const client = { from: fromSpy } as unknown as SupabaseClient;
    const bad = ["../etc", "FOO", "x".repeat(80), "", "foo bar", "foo/bar"];
    for (const slug of bad) {
      expect(await canUserReadSlug("user-a", slug, client)).toBe(false);
    }
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("isolates tenants — user-b cannot read a slug only mapped to user-a", async () => {
    // RLS itself would prevent user-b's session from seeing user-a's row.
    // Here we simulate by storing only user-a's mapping; the .eq("user_id")
    // filter in the helper drops it for user-b.
    const client = makeMockClient({
      rows: [{ user_id: "user-a", tf_slug: "shared-slug" }],
    });
    expect(await canUserReadSlug("user-b", "shared-slug", client)).toBe(false);
    expect(await canUserReadSlug("user-a", "shared-slug", client)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getAllowedSlugsForUser
// ---------------------------------------------------------------------------

describe("getAllowedSlugsForUser", () => {
  it("returns every slug mapped to the user (happy path)", async () => {
    const client = makeMockClient({
      rows: [
        { user_id: "user-a", tf_slug: "demo1" },
        { user_id: "user-a", tf_slug: "demo2" },
        { user_id: "user-b", tf_slug: "demo3" },
      ],
    });
    const slugs = await getAllowedSlugsForUser("user-a", client);
    expect(slugs.sort()).toEqual(["demo1", "demo2"]);
  });

  it("returns [] when the user has no mappings", async () => {
    const client = makeMockClient({ rows: [] });
    const slugs = await getAllowedSlugsForUser("user-a", client);
    expect(slugs).toEqual([]);
  });

  it("returns [] when the SELECT errors (RLS / missing table)", async () => {
    const client = makeMockClient({
      error: { message: "RLS rejected", code: "42501" },
    });
    const slugs = await getAllowedSlugsForUser("user-a", client);
    expect(slugs).toEqual([]);
  });

  it("returns [] for empty userId without DB round-trip", async () => {
    const fromSpy = vi.fn();
    const client = { from: fromSpy } as unknown as SupabaseClient;
    const slugs = await getAllowedSlugsForUser("", client);
    expect(slugs).toEqual([]);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("filters out malformed slugs the DB might somehow have stored", async () => {
    // Defence-in-depth: the DB CHECK constraint enforces the regex, but if
    // a row ever slipped in (e.g. constraint added after data), don't
    // surface it back to the caller.
    const client = makeMockClient({
      rows: [
        { user_id: "user-a", tf_slug: "valid-slug" },
        { user_id: "user-a", tf_slug: "../etc" },
        { user_id: "user-a", tf_slug: "UPPER" },
      ],
    });
    const slugs = await getAllowedSlugsForUser("user-a", client);
    expect(slugs).toEqual(["valid-slug"]);
  });

  it("returns [] when .from() throws synchronously", async () => {
    const client = makeMockClient({ throwOnFrom: true });
    const slugs = await getAllowedSlugsForUser("user-a", client);
    expect(slugs).toEqual([]);
  });
});
