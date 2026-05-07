/**
 * Round 57 multi-account hardening (2026-05-03):
 *
 * Verify Telegram per-account env resolution works as documented:
 *   - When FTMO_ACCOUNT_ID is set, `TELEGRAM_BOT_TOKEN_<id>` /
 *     `TELEGRAM_CHAT_ID_<id>` are preferred over the bare env vars.
 *   - When the per-account vars are missing, the bare env vars are still
 *     used (legacy / single-account behaviour).
 *   - Outgoing alerts get an `[acct:<id>] ` prefix injected automatically
 *     so a shared chat with two demo accounts stays readable.
 *
 * These tests exercise readTelegramConfig + tgSend directly with a mocked
 * fetch — no network traffic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEYS = [
  "FTMO_ACCOUNT_ID",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_BOT_TOKEN_DEMO_A",
  "TELEGRAM_CHAT_ID_DEMO_A",
  "TELEGRAM_BOT_TOKEN_DEMO_B",
  "TELEGRAM_CHAT_ID_DEMO_B",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("telegramNotify per-account env resolution", () => {
  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  it("readTelegramConfig prefers per-account env when FTMO_ACCOUNT_ID is set", async () => {
    process.env.FTMO_ACCOUNT_ID = "DEMO_A";
    process.env.TELEGRAM_BOT_TOKEN = "shared-token";
    process.env.TELEGRAM_CHAT_ID = "shared-chat";
    process.env.TELEGRAM_BOT_TOKEN_DEMO_A = "per-acct-token-A";
    process.env.TELEGRAM_CHAT_ID_DEMO_A = "per-acct-chat-A";

    const { readTelegramConfig } = await import("../utils/telegramNotify");
    const cfg = readTelegramConfig();
    expect(cfg).toBeDefined();
    expect(cfg!.token).toBe("per-acct-token-A");
    expect(cfg!.chatId).toBe("per-acct-chat-A");
  });

  it("readTelegramConfig falls back to bare env when per-account vars are missing", async () => {
    process.env.FTMO_ACCOUNT_ID = "DEMO_B";
    process.env.TELEGRAM_BOT_TOKEN = "shared-token";
    process.env.TELEGRAM_CHAT_ID = "shared-chat";
    // No TELEGRAM_BOT_TOKEN_DEMO_B → fall back

    const { readTelegramConfig } = await import("../utils/telegramNotify");
    const cfg = readTelegramConfig();
    expect(cfg).toBeDefined();
    expect(cfg!.token).toBe("shared-token");
    expect(cfg!.chatId).toBe("shared-chat");
  });

  it("readTelegramConfig returns undefined when nothing is configured", async () => {
    const { readTelegramConfig } = await import("../utils/telegramNotify");
    expect(readTelegramConfig()).toBeUndefined();
  });

  it("accountPrefix returns empty string when FTMO_ACCOUNT_ID is unset", async () => {
    const { accountPrefix } = await import("../utils/telegramNotify");
    expect(accountPrefix()).toBe("");
  });

  it("accountPrefix returns [acct:<id>] when FTMO_ACCOUNT_ID is set", async () => {
    process.env.FTMO_ACCOUNT_ID = "DEMO_A";
    const { accountPrefix } = await import("../utils/telegramNotify");
    expect(accountPrefix()).toBe("[acct:DEMO_A] ");
  });

  it("tgSend prefixes outgoing message body with [acct:<id>] when set", async () => {
    process.env.FTMO_ACCOUNT_ID = "DEMO_A";
    process.env.TELEGRAM_BOT_TOKEN = "tok";
    process.env.TELEGRAM_CHAT_ID = "chat";

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { tgSend } = await import("../utils/telegramNotify");
    const ok = await tgSend("hello world");
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fc = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]!;
    const init = fc[1] as { body: string };
    const payload = JSON.parse(init.body);
    expect(payload.text).toBe("[acct:DEMO_A] hello world");
    expect(payload.chat_id).toBe("chat");
  });

  it("tgSend does not prefix when FTMO_ACCOUNT_ID is unset (single-account mode)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "tok";
    process.env.TELEGRAM_CHAT_ID = "chat";

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { tgSend } = await import("../utils/telegramNotify");
    const ok = await tgSend("hello");
    expect(ok).toBe(true);
    const fc = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]!;
    const init = fc[1] as { body: string };
    const payload = JSON.parse(init.body);
    expect(payload.text).toBe("hello");
  });

  it("startTelegramBot skips listener when FTMO_ACCOUNT_ID is set without master flag", async () => {
    process.env.FTMO_ACCOUNT_ID = "DEMO_A";
    process.env.TELEGRAM_BOT_TOKEN = "tok";
    process.env.TELEGRAM_CHAT_ID = "chat";
    delete process.env.FTMO_TELEGRAM_BOT_MASTER;

    // tgSend would be called by the listener on startup — assert it isn't,
    // proving the early return.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { startTelegramBot } = await import("../utils/telegramBot");
    await startTelegramBot({
      stateDir: "/tmp/nope-test-skip",
      challengeStartBalance: 100_000,
    });
    // No tgSend / no fetch should have been called because we returned early.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitises FTMO_ACCOUNT_ID for env-var lookup (only [A-Za-z0-9_])", async () => {
    // Spaces / dashes in the account id must not break env-var resolution.
    process.env.FTMO_ACCOUNT_ID = "demo-A 1";
    process.env["TELEGRAM_BOT_TOKEN_demo_A_1"] = "per-acct";
    process.env["TELEGRAM_CHAT_ID_demo_A_1"] = "per-chat";

    const { readTelegramConfig } = await import("../utils/telegramNotify");
    const cfg = readTelegramConfig();
    expect(cfg).toBeDefined();
    expect(cfg!.token).toBe("per-acct");
    expect(cfg!.chatId).toBe("per-chat");

    // Cleanup
    delete process.env["TELEGRAM_BOT_TOKEN_demo_A_1"];
    delete process.env["TELEGRAM_CHAT_ID_demo_A_1"];
  });
});

/**
 * R67-r17 (2026-05-07): port `tools/test_ftmo_executor.py` Telegram hardening
 * tests to the TS side. The R67-r3 hardening claim was previously unverified
 * on the TypeScript path — these tests close the gap.
 *
 * Coverage:
 *   1. redactToken strips bot token from a sendMessage URL
 *   2. redactToken redacts token in nested error messages (cause chain)
 *   3. htmlEscape escapes <script> tags to harmless entities
 *   4. htmlEscape preserves &/'/" semantics
 *   5. safeTruncateHtml closes a single open <b> tag
 *   6. safeTruncateHtml closes nested tags inner-first (<i> before <b>)
 */
import {
  redactToken,
  htmlEscape,
  safeTruncateHtml,
} from "../utils/telegramNotify";

describe("telegramNotify token redaction (R67-r17)", () => {
  it("redactToken strips bot token from sendMessage URL", () => {
    const url =
      "https://api.telegram.org/bot1234567:ABCdef-XYZ_123/sendMessage";
    const out = redactToken(url);
    expect(out).not.toContain("1234567:ABCdef-XYZ_123");
    expect(out).toContain("/bot<REDACTED>");
    expect(out).toBe("https://api.telegram.org/bot<REDACTED>/sendMessage");
  });

  it("redactToken redacts token in a nested error message body (cause chain)", () => {
    // Simulate an error message string assembled from a cause chain where
    // the URL with the token appears inside a longer wrapped message.
    const errMsg =
      'fetch failed: TypeError: Network request to "https://api.telegram.org/bot9876543:ZZZ-token_abc/sendMessage" timed out (cause: ECONNRESET at https://api.telegram.org/bot9876543:ZZZ-token_abc/getMe)';
    const out = redactToken(errMsg);
    expect(out).not.toContain("9876543:ZZZ-token_abc");
    // Both occurrences must be redacted (global flag).
    expect((out.match(/\/bot<REDACTED>/g) ?? []).length).toBe(2);
  });
});

describe("telegramNotify htmlEscape (R67-r17)", () => {
  it("htmlEscape escapes <script> tag to entities", () => {
    expect(htmlEscape("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("htmlEscape escapes & first so subsequent < / > remain valid entities", () => {
    // & must be escaped first or you'd double-escape downstream entities.
    expect(htmlEscape("Tom & Jerry <fight>")).toBe(
      "Tom &amp; Jerry &lt;fight&gt;",
    );
    // Telegram HTML parse-mode does not require ' or " to be escaped — it
    // accepts them literally. Document current behaviour: these pass through.
    expect(htmlEscape("she said \"hi\" and 'bye'")).toBe(
      "she said \"hi\" and 'bye'",
    );
    // & alone still becomes &amp;.
    expect(htmlEscape("a & b & c")).toBe("a &amp; b &amp; c");
  });
});

describe("telegramNotify safeTruncateHtml (R67-r17)", () => {
  it("closes a single open <b> tag at truncation point", () => {
    // Build a long string that opens <b> and gets cut off mid-content.
    const head = "<b>" + "x".repeat(200);
    const tail = "</b>";
    const full = head + tail;
    // Force truncation well before the closing </b>.
    const out = safeTruncateHtml(full, 50);
    expect(out.length).toBeLessThan(full.length);
    // Must end with the closing tag we synthesised, not a dangling open one.
    expect(out.endsWith("</b>")).toBe(true);
    // Must contain the truncation marker.
    expect(out).toContain("…(truncated)");
    // The original closing </b> never made it into the slice — but our
    // output still has exactly one </b> (the synthesised one).
    expect((out.match(/<\/b>/g) ?? []).length).toBe(1);
  });

  it("closes nested tags inner-first: </i> before </b>", () => {
    // Nested <b><i>...</i></b> truncated inside the inner content.
    const head = "<b>outer <i>" + "y".repeat(200);
    const tail = "</i></b>";
    const full = head + tail;
    const out = safeTruncateHtml(full, 60);
    expect(out.length).toBeLessThan(full.length);
    // Inner-first close order: </i> must appear before </b> in the appended
    // tail (the regex confirms positional ordering).
    const idxI = out.lastIndexOf("</i>");
    const idxB = out.lastIndexOf("</b>");
    expect(idxI).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxI).toBeLessThan(idxB);
    // And the very last chars must close the outer tag.
    expect(out.endsWith("</b>")).toBe(true);
    // Each tag synthesised exactly once.
    expect((out.match(/<\/i>/g) ?? []).length).toBe(1);
    expect((out.match(/<\/b>/g) ?? []).length).toBe(1);
  });

  it("returns input unchanged when length <= maxLen (no-op fast-path)", () => {
    const input = "<b>short message</b>";
    expect(safeTruncateHtml(input, 1000)).toBe(input);
  });
});
