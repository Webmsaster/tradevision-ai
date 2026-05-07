/**
 * R67-Final (2026-05-07): tests for the Sentry-compatible facade.
 *
 * We assert:
 *   1. Telegram tokens are redacted in error.message and error.stack
 *      before they leave the process.
 *   2. JWT-shaped strings are redacted.
 *   3. Bearer auth headers are redacted.
 *   4. captureException + captureMessage produce the right payload shape
 *      (so a future swap to @sentry/nextjs is a no-op for call-sites).
 *   5. captureException is a no-throw on garbage input.
 */

import { describe, it, expect } from "vitest";
import {
  captureException,
  captureMessage,
  __testInternals,
} from "../lib/errorReporter";

const { buildExceptionPayload, buildMessagePayload, redactSensitive } =
  __testInternals;

describe("errorReporter — redactSensitive", () => {
  it("strips Telegram bot token from a URL", () => {
    const input =
      "fetch failed: https://api.telegram.org/bot1234567890:AABBCCDD-Token_xyz/sendMessage";
    const out = redactSensitive(input);
    expect(out).not.toContain("1234567890:AABBCCDD-Token_xyz");
    expect(out).toContain("/bot<REDACTED>");
  });

  it("redacts Bearer auth headers", () => {
    const out = redactSensitive(
      "Auth: Bearer eyJhbGciOiJIUzI1NiJ9.payloadherewithlotsofcharsxxxxxxxxxxxxxxx",
    );
    // Bearer regex should hit first; whatever wins, the token must be gone.
    expect(out).not.toContain(
      "eyJhbGciOiJIUzI1NiJ9.payloadherewithlotsofcharsxxxxxxxxxxxxxxx",
    );
  });

  it("redacts JWT-shaped strings standalone", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.signaturepartsxxxxxxxxxxxxxxx";
    const out = redactSensitive(`Token leaked: ${jwt}`);
    expect(out).toContain("<REDACTED_JWT>");
    expect(out).not.toContain(jwt);
  });

  it("returns empty string unchanged", () => {
    expect(redactSensitive("")).toBe("");
  });
});

describe("errorReporter — buildExceptionPayload", () => {
  it("preserves error name + redacts message", () => {
    const err = new Error(
      "boom https://api.telegram.org/bot999:SECRET/x — fail",
    );
    err.name = "BoomError";
    const p = buildExceptionPayload(err, { source: "test" });
    expect(p.type).toBe("exception");
    expect(p.level).toBe("error");
    expect(p.name).toBe("BoomError");
    expect(p.message).toContain("/bot<REDACTED>");
    expect(p.message).not.toContain("999:SECRET");
    expect(p.source).toBe("test");
  });

  it("redacts stack traces", () => {
    const err = new Error("normal");
    err.stack =
      "Error\n  at https://api.telegram.org/bot1:LEAK/foo\n  at Module._compile";
    const p = buildExceptionPayload(err, undefined);
    expect(p.stack).toBeDefined();
    expect(p.stack).not.toContain("1:LEAK");
    expect(p.stack).toContain("/bot<REDACTED>");
  });

  it("wraps non-Error inputs", () => {
    const p = buildExceptionPayload("string error", undefined);
    expect(p.type).toBe("exception");
    expect(p.message).toBe("string error");
  });

  it("respects ctx tags + extra", () => {
    const p = buildExceptionPayload(new Error("x"), {
      tags: { route: "/foo" },
      extra: { trades: 12 },
      source: "TestComponent",
    });
    expect(p.tags).toEqual({ route: "/foo" });
    expect(p.extra).toEqual({ trades: 12 });
    expect(p.source).toBe("TestComponent");
  });
});

describe("errorReporter — buildMessagePayload", () => {
  it("uses the given level", () => {
    const p = buildMessagePayload("hello", "warning", undefined);
    expect(p.type).toBe("message");
    expect(p.level).toBe("warning");
    expect(p.message).toBe("hello");
  });

  it("redacts the message body", () => {
    const p = buildMessagePayload(
      "talked to https://api.telegram.org/bot987654321:LeAkY-Token_xyz/getMe",
      "info",
      undefined,
    );
    expect(p.message).not.toContain("987654321:LeAkY-Token_xyz");
    expect(p.message).toContain("/bot<REDACTED>");
  });
});

describe("errorReporter — public API never throws", () => {
  it("captureException tolerates garbage", () => {
    expect(() => captureException(undefined)).not.toThrow();
    expect(() => captureException(null)).not.toThrow();
    expect(() => captureException(42)).not.toThrow();
    expect(() => captureException({ weird: true })).not.toThrow();
  });

  it("captureMessage tolerates empty strings", () => {
    expect(() => captureMessage("")).not.toThrow();
    expect(() => captureMessage("ok", "debug")).not.toThrow();
  });
});
