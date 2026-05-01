/**
 * GET /api/paper-state — serves the persisted paper-trade state JSON.
 *
 * Reads ~/.tradevision-ai/paper-trades.json from the server's home dir. If
 * running on Vercel/serverless, this will be empty (the dev server + cron
 * live on your local machine). For local dev only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { NextResponse } from "next/server";

const STATE_FILE = join(homedir(), ".tradevision-ai", "paper-trades.json");

// Phase 12 (CRITICAL Auth Bug 5): gate behind FTMO_MONITOR_ENABLED, same
// pattern as /api/ftmo-state and /api/ftmo-preview. Without this, anonymous
// callers on Vercel-prod could read arbitrary user-home paper-trade JSON.
function isEnabled() {
  return (
    process.env.FTMO_MONITOR_ENABLED === "1" ||
    process.env.FTMO_MONITOR_ENABLED === "true"
  );
}

export async function GET() {
  if (!isEnabled()) {
    return new NextResponse("Not Found", { status: 404 });
  }
  if (!existsSync(STATE_FILE)) {
    return NextResponse.json({
      openPositions: [],
      closedTrades: [],
      lastTickAt: null,
      error:
        "No state file yet. Run `npm run paper:tick` at least once to create ~/.tradevision-ai/paper-trades.json.",
    });
  }
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return NextResponse.json({ ...state, error: null });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, openPositions: [], closedTrades: [] },
      { status: 500 },
    );
  }
}
