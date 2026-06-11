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
// Type-only import is erased at compile time; the runtime module is loaded
// lazily inside the handler. ftmoLiveSignalV231 resolves FTMO_TF at module
// init and throws fail-loud when it is unset (R29 R3-Bug #4) — a top-level
// import would run that guard during `next build` page-data collection,
// where no live-trading env exists, and kill every Vercel deploy.
import { type AccountState } from "@/utils/ftmoLiveSignalV231";

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
    // R29-Frontend-Audit Bug 14: the preview historically used the V231
    // detector + hardcoded 4h next-check boundary. The active live
    // executor on this branch (R28_V6_PASSLOCK / V5_AMBER_PASSLOCK) uses
    // the V4 engine on 30m bars — so the preview reports the wrong
    // next-check window and a slightly different signal universe. The
    // preview cannot drive the V4 engine without persistent state /
    // FtmoDaytrade24hConfig, so we keep V231 as the read-only
    // "preview-only" signal source but compute the next check at the
    // resolved tf boundary (not a hardcoded 4h boundary). The body now
    // carries `mode: "v231-preview"` so the UI can warn the operator
    // that this is a sanity view, not the engine state.
    const { detectLiveSignalsV231 } =
      await import("@/utils/ftmoLiveSignalV231");
    const result = detectLiveSignalsV231(eth, btc, sol, account, []);
    const body = {
      ...result,
      lastBarClose: eth[eth.length - 1]?.closeTime ?? null,
      nextCheckAt: computeNextTfBoundary(tf),
      tf,
      mode: "v231-preview",
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

// R29-Frontend-Audit Bug 14: tf-aware next-bar-boundary. Previous version
// was hardcoded for 4h candles which lied about the next signal-check
// time when FTMO_TF was set to a 30m / 1h / 2h champion config.
function computeNextTfBoundary(tf: "30m" | "1h" | "2h" | "4h"): number {
  const now = new Date();
  const minutesByTf: Record<typeof tf, number> = {
    "30m": 30,
    "1h": 60,
    "2h": 120,
    "4h": 240,
  };
  const stepMin = minutesByTf[tf];
  const nowEpochMin = Math.floor(now.getTime() / 60_000);
  // Next aligned boundary, +30s skew for clock-drift / Binance close-lag.
  const nextBoundaryMin = Math.ceil((nowEpochMin + 0.001) / stepMin) * stepMin;
  return nextBoundaryMin * 60_000 + 30_000;
}
