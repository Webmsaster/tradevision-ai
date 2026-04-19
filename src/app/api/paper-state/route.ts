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

export async function GET() {
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
