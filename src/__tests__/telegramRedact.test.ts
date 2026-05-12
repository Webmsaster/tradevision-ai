/**
 * R4-A1 audit test: verify the sender-side token-redaction logic shared by
 * `scripts/ftmoSignalAlert.test.ts` and `scripts/driftTelegram.ts`.
 *
 * Coverage:
 *   1. Literal token substring redaction (known token leak path).
 *   2. Regex redaction for token-shaped strings (proxy-encoded / wrapped
 *      `bot…<token>` URL leaks where the literal `token` arg is unknown).
 *   3. Idempotent on already-redacted output.
 *   4. Empty / nullish inputs short-circuit safely.
 *   5. Multiple occurrences in one string are all redacted.
 */
import { describe, it, expect } from "vitest";
import { redactToken } from "@/utils/telegramRedact";

describe("telegramRedact.redactToken (R4-A1)", () => {
  it("redacts a known literal token", () => {
    const token = "1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ012345";
    const out = redactToken(`fetch failed: bot${token}/sendMessage`, token);
    expect(out).not.toContain(token);
    expect(out).toContain("***");
  });

  it("redacts an unknown token via regex (proxy-encoded leak)", () => {
    // Token shape: 8-12 digits : ≥20 url-safe chars. Caller passes no
    // explicit `token` arg — only the regex layer should catch this.
    const msg =
      "Cloudflare error: 525 SSL handshake failed at https://api.telegram.org/bot987654321:Y_random-token-payload-zz/getMe";
    const out = redactToken(msg);
    expect(out).not.toContain("987654321:Y_random-token-payload-zz");
    expect(out).toContain("***");
  });

  it("redacts multiple distinct tokens in one message", () => {
    // Cause-chain style: same token echoed twice, plus a different stale
    // token from an old retry surfacing in the same trace.
    const t1 = "111111111:aaaaaaaaaaaaaaaaaaaaaaaaa";
    const t2 = "222222222:bbbbbbbbbbbbbbbbbbbbbbbbb";
    const msg = `outer (cause: bot${t1}/sendMessage) inner: bot${t2}/getMe and again bot${t1}/getUpdates`;
    const out = redactToken(msg);
    expect(out).not.toContain(t1);
    expect(out).not.toContain(t2);
    // Three redaction markers — one per token occurrence.
    expect((out.match(/\*\*\*/g) ?? []).length).toBe(3);
  });

  it("is idempotent on already-redacted output", () => {
    const once = redactToken("leak: 333333333:cccccccccccccccccccccccccc oops");
    const twice = redactToken(once);
    expect(twice).toBe(once);
    expect(twice).not.toContain("333333333:");
  });

  it("handles empty / falsy input safely", () => {
    expect(redactToken("", "anytoken")).toBe("");
    // Cast-via-any to mirror real-world fetch error paths that may yield
    // undefined/null; redactToken must not throw.
    expect(redactToken(null as unknown as string, "tok")).toBe(
      null as unknown as string,
    );
  });

  it("does NOT redact short / non-token-shaped digit-strings", () => {
    // 7-digit prefix or <20-char suffix → not a Telegram-bot token → keep.
    const msg = "user_id: 1234567:abc HTTP 429: too many requests";
    const out = redactToken(msg);
    expect(out).toBe(msg);
  });
});
