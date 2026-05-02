/**
 * Round 54 Audit Agent 9 finding — `src/utils/urlSafety.ts` had 0%
 * test coverage despite being a security-critical SSRF/loopback guard
 * (Phase 86 / R51-S1) shared between webhook fire-path AND the
 * settings "Test webhook" handler. Without coverage any future edit
 * could silently weaken the IP-range checks.
 */
import { describe, it, expect } from "vitest";
import { isValidHttpsUrl } from "../utils/urlSafety";

describe("isValidHttpsUrl — protocol gate", () => {
  it("accepts a plain https URL with public host", () => {
    expect(isValidHttpsUrl("https://hooks.slack.com/services/abc")).toBe(true);
    expect(isValidHttpsUrl("https://example.com/webhook")).toBe(true);
  });

  it("rejects http (cleartext)", () => {
    expect(isValidHttpsUrl("http://example.com/webhook")).toBe(false);
  });

  it("rejects exotic protocols", () => {
    expect(isValidHttpsUrl("ftp://example.com/")).toBe(false);
    expect(isValidHttpsUrl("file:///etc/passwd")).toBe(false);
    expect(isValidHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isValidHttpsUrl("data:text/plain,hello")).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(isValidHttpsUrl("not-a-url")).toBe(false);
    expect(isValidHttpsUrl("")).toBe(false);
    expect(isValidHttpsUrl("https://")).toBe(false);
  });
});

describe("isValidHttpsUrl — hostname blocks (loopback)", () => {
  it("blocks localhost", () => {
    expect(isValidHttpsUrl("https://localhost/")).toBe(false);
    expect(isValidHttpsUrl("https://LOCALHOST/")).toBe(false); // case-insensitive
    expect(isValidHttpsUrl("https://localhost:8443/admin")).toBe(false);
  });

  it("blocks 0.0.0.0 wildcard", () => {
    expect(isValidHttpsUrl("https://0.0.0.0/")).toBe(false);
  });

  it("blocks 127.0.0.0/8 loopback range", () => {
    expect(isValidHttpsUrl("https://127.0.0.1/")).toBe(false);
    expect(isValidHttpsUrl("https://127.255.255.255/")).toBe(false);
    expect(isValidHttpsUrl("https://127.42.42.42/")).toBe(false);
  });

  it("blocks IPv6 loopback ::1 and ::*", () => {
    expect(isValidHttpsUrl("https://[::1]/")).toBe(false);
    expect(isValidHttpsUrl("https://[::]/")).toBe(false);
    expect(isValidHttpsUrl("https://[::ffff:127.0.0.1]/")).toBe(false);
  });
});

describe("isValidHttpsUrl — RFC 1918 private ranges", () => {
  it("blocks 10/8", () => {
    expect(isValidHttpsUrl("https://10.0.0.1/")).toBe(false);
    expect(isValidHttpsUrl("https://10.255.255.254/")).toBe(false);
  });

  it("blocks 172.16/12 (only 16-31, not 15 or 32)", () => {
    expect(isValidHttpsUrl("https://172.16.0.1/")).toBe(false);
    expect(isValidHttpsUrl("https://172.31.255.254/")).toBe(false);
    // 172.15 and 172.32 are PUBLIC
    expect(isValidHttpsUrl("https://172.15.0.1/")).toBe(true);
    expect(isValidHttpsUrl("https://172.32.0.1/")).toBe(true);
  });

  it("blocks 192.168/16", () => {
    expect(isValidHttpsUrl("https://192.168.1.1/")).toBe(false);
    expect(isValidHttpsUrl("https://192.168.255.254/")).toBe(false);
    // 192.169 is PUBLIC
    expect(isValidHttpsUrl("https://192.169.1.1/")).toBe(true);
  });
});

describe("isValidHttpsUrl — link-local / metadata / multicast", () => {
  it("blocks 169.254/16 (AWS/GCP/Azure metadata + link-local)", () => {
    expect(isValidHttpsUrl("https://169.254.169.254/latest/meta-data/")).toBe(
      false,
    );
    expect(isValidHttpsUrl("https://169.254.0.1/")).toBe(false);
    // 169.253 and 169.255 are PUBLIC (only .254 second octet matches)
    expect(isValidHttpsUrl("https://169.253.0.1/")).toBe(true);
  });

  it("blocks IPv6 link-local fe80::/10", () => {
    expect(isValidHttpsUrl("https://[fe80::1]/")).toBe(false);
  });

  it("blocks IPv6 ULA fc00::/7", () => {
    expect(isValidHttpsUrl("https://[fc00::1]/")).toBe(false);
    expect(isValidHttpsUrl("https://[fd00::1]/")).toBe(false);
  });

  it("blocks 224.0.0.0/4 multicast + 240.0.0.0/4 reserved", () => {
    expect(isValidHttpsUrl("https://224.0.0.1/")).toBe(false);
    expect(isValidHttpsUrl("https://239.255.255.255/")).toBe(false);
    expect(isValidHttpsUrl("https://240.0.0.1/")).toBe(false);
    expect(isValidHttpsUrl("https://255.255.255.255/")).toBe(false);
  });
});

describe("isValidHttpsUrl — TLD-based blocks", () => {
  it("blocks .local (mDNS)", () => {
    expect(isValidHttpsUrl("https://printer.local/")).toBe(false);
    expect(isValidHttpsUrl("https://my-mac.local/")).toBe(false);
  });

  it("blocks .internal (corp resolver convention)", () => {
    expect(isValidHttpsUrl("https://api.internal/")).toBe(false);
  });

  it("blocks .localhost suffix", () => {
    expect(isValidHttpsUrl("https://app.localhost/")).toBe(false);
  });
});

describe("isValidHttpsUrl — public hosts (positive cases)", () => {
  it("accepts well-known public ranges", () => {
    expect(isValidHttpsUrl("https://1.1.1.1/")).toBe(true); // Cloudflare
    expect(isValidHttpsUrl("https://8.8.8.8/")).toBe(true); // Google
    expect(isValidHttpsUrl("https://9.9.9.9/")).toBe(true); // Quad9
  });

  it("accepts public domains with paths/queries/ports", () => {
    expect(
      isValidHttpsUrl("https://api.example.com:443/v1/hooks?secret=abc"),
    ).toBe(true);
    expect(isValidHttpsUrl("https://hooks.zapier.com/hooks/catch/12345/")).toBe(
      true,
    );
  });

  it("accepts public IPv6", () => {
    expect(isValidHttpsUrl("https://[2606:4700:4700::1111]/")).toBe(true);
  });
});
