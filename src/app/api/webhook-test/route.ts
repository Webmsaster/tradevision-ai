/**
 * POST /api/webhook-test — server-side webhook test endpoint.
 *
 * Round 54 (Finding #5): the previous client-side `fetch(webhook.url)`
 * in `src/app/settings/page.tsx` only string-checked the URL via
 * `isValidHttpsUrl`. That defeats DNS rebinding (`evil.com` resolves
 * to `10.0.0.1` on first lookup) and follows redirects to internal
 * hosts. We now do the request server-side with:
 *   1. `isValidHttpsUrl` string gate (re-applied here, never trust the
 *      client).
 *   2. `dns.lookup({ all: true })` — every resolved address is checked
 *      against `isPrivateHostname`.
 *   3. `redirect: "manual"` so we don't follow into private IPs after
 *      a 30x.
 *   4. 5s `AbortSignal.timeout` cap.
 *   5. Benign POST `{ test: true, timestamp }` payload (no user data).
 */
import { NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { isPrivateHostname, isValidHttpsUrl } from "@/utils/urlSafety";

const REQUEST_TIMEOUT_MS = 5_000;

interface WebhookTestRequest {
  url: string;
  platform?: "discord" | "telegram" | "custom";
}

function buildPayload(platform: string | undefined): unknown {
  const base = { test: true, timestamp: Date.now() };
  if (platform === "discord") {
    return {
      ...base,
      content: "TradeVision AI - Test notification. Your webhook is working!",
    };
  }
  if (platform === "telegram") {
    return {
      ...base,
      text: "TradeVision AI - Test notification. Your webhook is working!",
    };
  }
  return {
    ...base,
    event: "test",
    message: "TradeVision AI - Test notification.",
  };
}

export async function POST(request: Request) {
  let body: WebhookTestRequest;
  try {
    body = (await request.json()) as WebhookTestRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const url = typeof body?.url === "string" ? body.url : "";
  // Cap to avoid abuse via huge URLs in logs.
  if (url.length > 2048) {
    return NextResponse.json(
      { ok: false, error: "URL too long" },
      { status: 400 },
    );
  }

  // 1. String gate (HTTPS + literal IP/hostname not in private ranges).
  if (!isValidHttpsUrl(url)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "URL must use HTTPS and point to a public host (no private IPs / loopback).",
      },
      { status: 400 },
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Malformed URL" },
      { status: 400 },
    );
  }

  // 2. DNS resolve and re-check every address (defeats DNS rebinding
  // where the hostname currently resolves to a private IP).
  // If the hostname is already a literal IP, lookup returns it as-is
  // (still safe — isValidHttpsUrl already rejected literal private IPs).
  //
  // Round 56 (Finding #2): we capture the FIRST validated address and
  // fetch by IP below to defeat the TOCTOU window — without that, the
  // subsequent `fetch(parsed.toString())` performs a SECOND DNS lookup
  // and an attacker controlling the authoritative resolver can swap in
  // a private IP for the request itself.
  let safeIp: string | null = null;
  try {
    const addrs = await lookup(parsed.hostname, { all: true });
    for (const a of addrs) {
      if (isPrivateHostname(a.address)) {
        return NextResponse.json(
          {
            ok: false,
            error: "Hostname resolves to a private/internal IP address.",
          },
          { status: 400 },
        );
      }
    }
    if (addrs.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Hostname could not be resolved." },
        { status: 400 },
      );
    }
    safeIp = addrs[0]!.address;
  } catch (err) {
    // Round 56 (Finding #3): the previous error message echoed
    // `err.message` which on Node typically contains the failing
    // hostname (e.g. `getaddrinfo ENOTFOUND attacker.tld`). That leaks
    // the user-supplied URL host back into JSON, useful for a CSRF
    // attacker probing internal DNS records. Return a generic message
    // to the caller; the specific error is logged server-side.
    console.error("[webhook-test] DNS lookup failed:", err);
    return NextResponse.json(
      { ok: false, error: "DNS lookup failed." },
      { status: 400 },
    );
  }

  // 3+4. Send the test payload with manual redirects + tight timeout.
  //
  // Round 56 (Finding #2): rewrite the URL to use the validated IP so
  // fetch does NOT perform a second DNS lookup (TOCTOU). We preserve
  // the original hostname in the `Host` header so HTTP virtual-host
  // routing still works. For HTTPS the TLS SNI/cert verification is
  // driven by the URL hostname — fetch-by-IP would break TLS hostname
  // matching. This is an accepted trade-off: a rebinding attacker would
  // additionally need to obtain a valid certificate for the original
  // hostname (mTLS-publickey-pinning is out of scope), which is
  // implausible in the threat model this endpoint guards (operator
  // typo'd webhook URL pointing into the cloud-VPC).
  //
  // For the IPv6 case the literal must be bracketed (`https://[::1]/`).
  const isIpv6 = safeIp!.includes(":");
  const ipHost = isIpv6 ? `[${safeIp}]` : safeIp!;
  const ipUrl = new URL(parsed.toString());
  ipUrl.hostname = ipHost;
  const startedAt = Date.now();
  try {
    const resp = await fetch(ipUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Preserve the user-supplied hostname for vhost routing /
        // cert-SNI logging. The fetch impl will set the SNI from the
        // URL hostname (the IP) — see comment above.
        Host: parsed.host,
      },
      body: JSON.stringify(buildPayload(body?.platform)),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const latencyMs = Date.now() - startedAt;

    // 30x with manual mode → resp.status is 0 in fetch spec; some
    // runtimes use the actual code. Treat both as "do not follow",
    // surface to user instead of silently chasing into private IPs.
    if (
      resp.type === "opaqueredirect" ||
      (resp.status >= 300 && resp.status < 400)
    ) {
      return NextResponse.json({
        ok: false,
        status: resp.status || 302,
        latencyMs,
        error: "Webhook responded with a redirect; refusing to follow.",
      });
    }

    if (!resp.ok) {
      return NextResponse.json({
        ok: false,
        status: resp.status,
        latencyMs,
        error: `Webhook responded ${resp.status} ${resp.statusText}`,
      });
    }

    return NextResponse.json({ ok: true, status: resp.status, latencyMs });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    // Distinguish abort/timeout for clearer UX.
    if (err instanceof Error && err.name === "TimeoutError") {
      return NextResponse.json({
        ok: false,
        latencyMs,
        error: `Webhook timed out after ${REQUEST_TIMEOUT_MS}ms.`,
      });
    }
    // Round 6 audit (CRITICAL): never echo `err.message` back to the
    // client. Node fetch errors include the failing host / IP / certificate
    // path which leaks internal infrastructure to a CSRF attacker probing
    // for the AWS-metadata IP, internal cert authority names, etc. Log
    // the specific cause server-side, return a generic message.
    console.error("[webhook-test]", err);
    return NextResponse.json({
      ok: false,
      latencyMs,
      error: "Request failed",
    });
  }
}
