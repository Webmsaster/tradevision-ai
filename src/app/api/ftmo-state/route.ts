/**
 * GET /api/ftmo-state — returns all FTMO bot state JSON files bundled.
 *
 * Reads from FTMO_STATE_DIR (or ./ftmo-state by default). Used by the
 * /ftmo-monitor dashboard page.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";

function getStateDir() {
  return process.env.FTMO_STATE_DIR ?? join(process.cwd(), "ftmo-state");
}

function readJson(name: string, fallback: unknown) {
  const p = join(getStateDir(), name);
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonl(name: string, maxEntries = 100): unknown[] {
  const p = join(getStateDir(), name);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, "utf8").trim().split("\n");
    return lines
      .slice(-maxEntries)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function GET() {
  const account = readJson("account.json", {});
  const status = readJson("service-status.json", {});
  const pending = readJson("pending-signals.json", { signals: [] });
  const executed = readJson("executed-signals.json", { executions: [] });
  const openPos = readJson("open-positions.json", { positions: [] });
  const dailyReset = readJson("daily-reset.json", {});
  const controls = readJson("bot-controls.json", {
    paused: false,
    killRequested: false,
  });
  const lastCheck = readJson("last-check.json", {});
  const signalLog = readJsonl("signal-log.jsonl", 50);
  const executorLog = readJsonl("executor-log.jsonl", 50);

  return NextResponse.json({
    account,
    status,
    pending,
    executed,
    openPos,
    dailyReset,
    controls,
    lastCheck,
    signalLog,
    executorLog,
    stateDir: getStateDir(),
    generatedAt: new Date().toISOString(),
  });
}
