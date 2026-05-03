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
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `DNS lookup failed: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 400 },
    );
  }

  // 3+4. Send the test payload with manual redirects + tight timeout.
  const startedAt = Date.now();
  try {
    const resp = await fetch(parsed.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const msg = err instanceof Error ? err.message : "Request failed";
    // Distinguish abort/timeout for clearer UX.
    if (err instanceof Error && err.name === "TimeoutError") {
      return NextResponse.json({
        ok: false,
        latencyMs,
        error: `Webhook timed out after ${REQUEST_TIMEOUT_MS}ms.`,
      });
    }
    return NextResponse.json({ ok: false, latencyMs, error: msg });
  }
}
