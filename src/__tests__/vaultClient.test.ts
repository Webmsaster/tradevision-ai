/**
 * vaultClient tests — server-vault client stub (R19-A8 scaffold).
 *
 * Covers all four exported functions:
 *   - getVaultStatus: every status branch (503 no_vault_key / no_supabase,
 *     503 with unparseable body, 401, 429, 500, 200, network error)
 *   - loadFromVault: key validation, hit, miss → "", non-ok / bad body /
 *     network → null fall-through
 *   - saveToVault: key+value validation, PUT payload shape, ok flag,
 *     non-ok / network → false
 *   - deleteFromVault: key validation, URL encoding, ok flag, error paths
 *
 * The vault contract is "null/false means fall back to the offline-key
 * path" — these tests pin that contract.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteFromVault,
  getVaultStatus,
  loadFromVault,
  saveToVault,
} from "@/utils/vaultClient";

type FetchMock = ReturnType<typeof vi.fn>;

function stubFetchResponse(response: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}): FetchMock {
  const mock: FetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function okJson(body: unknown): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
} {
  return { ok: true, status: 200, json: async () => body };
}

function errStatus(
  status: number,
  body?: unknown,
): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return {
    ok: false,
    status,
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getVaultStatus", () => {
  it("returns available:true on a 200 response and sends no-store + same-origin", async () => {
    const fetchMock = stubFetchResponse(okJson({ ok: true, items: [] }));
    const status = await getVaultStatus();
    expect(status).toEqual({ available: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/secrets");
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("maps 503 + reason=no_vault_key to { available:false, reason:'no_vault_key' }", async () => {
    stubFetchResponse(errStatus(503, { ok: false, reason: "no_vault_key" }));
    expect(await getVaultStatus()).toEqual({
      available: false,
      reason: "no_vault_key",
    });
  });

  it("maps 503 with any other reason to 'no_supabase'", async () => {
    stubFetchResponse(errStatus(503, { ok: false, reason: "something_else" }));
    expect(await getVaultStatus()).toEqual({
      available: false,
      reason: "no_supabase",
    });
  });

  it("treats a 503 with an unparseable JSON body as 'no_supabase'", async () => {
    // errStatus without a body makes .json() reject — the .catch(() => ({}))
    // path must swallow it.
    stubFetchResponse(errStatus(503));
    expect(await getVaultStatus()).toEqual({
      available: false,
      reason: "no_supabase",
    });
  });

  it("maps 401 to 'unauthorized'", async () => {
    stubFetchResponse(errStatus(401));
    expect(await getVaultStatus()).toEqual({
      available: false,
      reason: "unauthorized",
    });
  });

  it("maps 429 to 'rate_limited'", async () => {
    stubFetchResponse(errStatus(429));
    expect(await getVaultStatus()).toEqual({
      available: false,
      reason: "rate_limited",
    });
  });

  it("maps any other non-ok status to 'unknown'", async () => {
    stubFetchResponse(errStatus(500));
    expect(await getVaultStatus()).toEqual({
      available: false,
      reason: "unknown",
    });
  });

  it("maps a thrown fetch (offline) to 'network'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    expect(await getVaultStatus()).toEqual({
      available: false,
      reason: "network",
    });
  });
});

describe("loadFromVault", () => {
  it("returns the stored value when the key exists", async () => {
    stubFetchResponse(
      okJson({
        ok: true,
        items: [
          { key: "webhook.url", value: "https://x.test/hook", updatedAt: "t" },
          { key: "other", value: "y", updatedAt: "t" },
        ],
      }),
    );
    expect(await loadFromVault("webhook.url")).toBe("https://x.test/hook");
  });

  it("returns empty string when vault is ok but the key is absent", async () => {
    stubFetchResponse(okJson({ ok: true, items: [] }));
    expect(await loadFromVault("webhook.url")).toBe("");
  });

  it("returns null without fetching for an empty or non-string key", async () => {
    const fetchMock = stubFetchResponse(okJson({ ok: true, items: [] }));
    expect(await loadFromVault("")).toBeNull();
    expect(await loadFromVault(undefined as unknown as string)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on a non-ok response (vault unavailable)", async () => {
    stubFetchResponse(errStatus(503, { ok: false }));
    expect(await loadFromVault("webhook.url")).toBeNull();
  });

  it("returns null when the body is not ok or items is not an array", async () => {
    stubFetchResponse(okJson({ ok: false }));
    expect(await loadFromVault("webhook.url")).toBeNull();
    stubFetchResponse(okJson({ ok: true, items: "nope" }));
    expect(await loadFromVault("webhook.url")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await loadFromVault("webhook.url")).toBeNull();
  });
});

describe("saveToVault", () => {
  it("PUTs the key/value as JSON and returns true when the server acks", async () => {
    const fetchMock = stubFetchResponse(okJson({ ok: true }));
    expect(await saveToVault("webhook.url", "https://x.test/hook")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/secrets");
    expect(init).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      key: "webhook.url",
      value: "https://x.test/hook",
    });
  });

  it("returns false when the server responds ok:false", async () => {
    stubFetchResponse(okJson({ ok: false, error: "denied" }));
    expect(await saveToVault("webhook.url", "v")).toBe(false);
  });

  it("rejects empty key or value without making a request", async () => {
    const fetchMock = stubFetchResponse(okJson({ ok: true }));
    expect(await saveToVault("", "v")).toBe(false);
    expect(await saveToVault("k", "")).toBe(false);
    expect(await saveToVault(123 as unknown as string, "v")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false on a non-ok response and on network error", async () => {
    stubFetchResponse(errStatus(401));
    expect(await saveToVault("k", "v")).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await saveToVault("k", "v")).toBe(false);
  });
});

describe("deleteFromVault", () => {
  it("DELETEs with the key URL-encoded in the query string", async () => {
    const fetchMock = stubFetchResponse(okJson({ ok: true }));
    expect(await deleteFromVault("webhook url/1&2")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `/api/secrets?key=${encodeURIComponent("webhook url/1&2")}`,
    );
    expect(init).toMatchObject({ method: "DELETE" });
  });

  it("returns false when the server responds ok:false", async () => {
    stubFetchResponse(okJson({ ok: false }));
    expect(await deleteFromVault("k")).toBe(false);
  });

  it("rejects an empty key without making a request", async () => {
    const fetchMock = stubFetchResponse(okJson({ ok: true }));
    expect(await deleteFromVault("")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false on a non-ok response and on network error", async () => {
    stubFetchResponse(errStatus(500));
    expect(await deleteFromVault("k")).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await deleteFromVault("k")).toBe(false);
  });
});
