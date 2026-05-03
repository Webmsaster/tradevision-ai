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
