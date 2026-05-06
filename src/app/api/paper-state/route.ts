/**
 * GET /api/paper-state — serves the persisted paper-trade state JSON.
 *
 * Reads ~/.tradevision-ai/paper-trades.json from the server's home dir. If
 * running on Vercel/serverless, this will be empty (the dev server + cron
 * live on your local machine). For local dev only.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { NextResponse } from "next/server";
import { requireFtmoMonitorAuth } from "@/lib/ftmoMonitorAuth";

// R67 audit: file-size cap to prevent JSON-DoS on a corrupted/manipulated file
const MAX_FILE_BYTES = 5_000_000;

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
  // R67 audit fix: require Supabase session (mirrors drift-data R57 hardening)
  const auth = await requireFtmoMonitorAuth();
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
    // R67 audit: cap file-read at 5MB to prevent JSON-DoS on a manipulated file
    const sz = statSync(STATE_FILE).size;
    if (sz > MAX_FILE_BYTES) {
      console.error("[paper-state] file too large:", sz);
      return NextResponse.json(
        { error: "state file too large", openPositions: [], closedTrades: [] },
        { status: 500 },
      );
    }
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return NextResponse.json({ ...state, error: null });
  } catch (err) {
    // Round 54 (Finding #1): mirror /api/ftmo-preview pattern (Phase 33
    // R45-API-6) — never echo `(err as Error).message` to the client.
    // ENOENT/EACCES messages from node:fs leak the absolute server path
    // (`/home/<user>/.tradevision-ai/...`), which is information
    // disclosure (CWE-209). Log internally, return generic 500.
    console.error("[paper-state]", err);
    return NextResponse.json(
      { error: "Internal error", openPositions: [], closedTrades: [] },
      { status: 500 },
    );
  }
}
