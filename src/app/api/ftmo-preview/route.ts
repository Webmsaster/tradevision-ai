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

// 30s in-memory cache
let cache: { ts: number; body: unknown } | null = null;
const CACHE_MS = 30_000;

export async function GET() {
  if (!isEnabled()) {
    return new NextResponse("Not Found", { status: 404 });
  }

  if (cache && Date.now() - cache.ts < CACHE_MS) {
    return NextResponse.json(cache.body);
  }

  try {
    const [eth, btc, sol] = await Promise.all([
      loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "4h",
        targetCount: 100,
        maxPages: 2,
      }),
      loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "4h",
        targetCount: 100,
        maxPages: 2,
      }),
      loadBinanceHistory({
        symbol: "SOLUSDT",
        timeframe: "4h",
        targetCount: 100,
        maxPages: 2,
      }),
    ]);
    const account = readAccount();
    const result = detectLiveSignalsV231(eth, btc, sol, account, []);
    const body = {
      ...result,
      lastBarClose: eth[eth.length - 1]?.closeTime ?? null,
      nextCheckAt: computeNext4hBoundary(),
    };
    cache = { ts: Date.now(), body };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
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
