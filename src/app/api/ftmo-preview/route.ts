/**
 * GET /api/ftmo-preview — live preview of what iter231 would decide RIGHT NOW.
 *
 * Fetches the freshest Binance 4h candles, reads current account state from
 * ftmo-state/account.json, and runs the live signal detector. Response is
 * cached in-memory for 30s to avoid hammering Binance on dashboard refresh.
 *
 * Gated behind FTMO_MONITOR_ENABLED=1 (same as /ftmo-monitor).
 */
import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBinanceHistory } from "@/utils/historicalData";
import { requireFtmoMonitorAuth } from "@/lib/ftmoMonitorAuth";
import {
  detectLiveSignalsV231,
  type AccountState,
} from "@/utils/ftmoLiveSignalV231";

function isEnabled() {
  return (
    process.env.FTMO_MONITOR_ENABLED === "1" ||
    process.env.FTMO_MONITOR_ENABLED === "true"
  );
}

function getStateDir() {
  return process.env.FTMO_STATE_DIR ?? join(process.cwd(), "ftmo-state");
}

function readAccount(): AccountState {
  const p = join(getStateDir(), "account.json");
  if (!existsSync(p)) {
    return { equity: 1.0, day: 0, recentPnls: [], equityAtDayStart: 1.0 };
  }
  try {
    const a = JSON.parse(readFileSync(p, "utf8"));
    return {
      equity: a.equity ?? 1.0,
      day: a.day ?? 0,
      recentPnls: a.recentPnls ?? [],
      equityAtDayStart: a.equityAtDayStart ?? 1.0,
    };
  } catch {
    return { equity: 1.0, day: 0, recentPnls: [], equityAtDayStart: 1.0 };
  }
}

// Phase 33 (API Audit Bug 1+2): per-TF cache + dynamic timeframe resolution
// from FTMO_TF env. Was hardcoded to 4h candles which is wrong for the
// V5_QUARTZ_LITE / R28 champions (30m) and V261_2H_OPT (2h) → preview
// emitted bogus signals. Cache is now keyed so a TF switch evicts the
// stale entry.
const cache = new Map<string, { ts: number; body: unknown }>();
const CACHE_MS = 30_000;

function resolvePreviewTf(): "30m" | "1h" | "2h" | "4h" {
  const v = process.env.FTMO_TF ?? "";
  if (
    v.includes("30m") ||
    v === "2h-trend-breakout-v1" ||
    v.startsWith("2h-trend-v5-quartz") ||
    v.startsWith("2h-trend-v5-titanium") ||
    v.startsWith("2h-trend-v5-obsidian")
  )
    return "30m";
  if (v === "1h" || v.endsWith("-1h") || v.includes("1h-live")) return "1h";
  if (v === "2h" || v.startsWith("2h-trend") || v.includes("2h-live"))
    return "2h";
  return "4h";
}

export async function GET() {
  if (!isEnabled()) {
    return new NextResponse("Not Found", { status: 404 });
  }
  // R67 audit fix: require Supabase session (mirrors drift-data R57 hardening)
  const auth = await requireFtmoMonitorAuth();
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const tf = resolvePreviewTf();
  const cacheKey = `${tf}:${process.env.FTMO_TF ?? "default"}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_MS) {
    return NextResponse.json(hit.body, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    // Round 56 (Fix 5): switched from Promise.all (fail-fast) to
    // Promise.allSettled. ETH+BTC are required for the V231 detector;
    // SOL is optional (the detector tolerates an empty array). A single
    // SOL transient failure used to blank the entire preview.
    const [ethRes, btcRes, solRes] = await Promise.allSettled([
      loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: tf,
        targetCount: 100,
        maxPages: 2,
      }),
      loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: tf,
        targetCount: 100,
        maxPages: 2,
      }),
      loadBinanceHistory({
        symbol: "SOLUSDT",
        timeframe: tf,
        targetCount: 100,
        maxPages: 2,
      }),
    ]);

    if (ethRes.status === "rejected" || btcRes.status === "rejected") {
      const failed = [
        ethRes.status === "rejected" ? "ETHUSDT" : null,
        btcRes.status === "rejected" ? "BTCUSDT" : null,
      ]
        .filter(Boolean)
        .join(", ");
      console.error("[ftmo-preview] required candle fetch failed:", failed);
      return NextResponse.json(
        { error: "Upstream candle fetch failed" },
        { status: 502 },
      );
    }
    const eth = ethRes.value;
    const btc = btcRes.value;
    let sol: typeof eth = [];
    if (solRes.status === "fulfilled") {
      sol = solRes.value;
    } else {
      console.warn(
        "[ftmo-preview] SOLUSDT optional fetch failed, continuing with empty array:",
        solRes.reason instanceof Error ? solRes.reason.message : solRes.reason,
      );
    }
    const account = readAccount();
    const result = detectLiveSignalsV231(eth, btc, sol, account, []);
    const body = {
      ...result,
      lastBarClose: eth[eth.length - 1]?.closeTime ?? null,
      nextCheckAt: computeNext4hBoundary(),
      tf,
    };
    cache.set(cacheKey, { ts: Date.now(), body });
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    // Phase 33 (API Audit Bug 6): don't leak internal error message to client.
    console.error("[ftmo-preview]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

function computeNext4hBoundary(): number {
  const now = new Date();
  const h = now.getUTCHours();
  const nextHour = Math.ceil((h + 0.001) / 4) * 4;
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    nextHour,
    0,
    30,
    0,
  );
}
