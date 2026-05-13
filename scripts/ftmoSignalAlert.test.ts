/**
 * FTMO Signal Alert — the live signal checker you run on each 4h bar close.
 *
 * Usage:
 *   node ./node_modules/vitest/vitest.mjs run \
 *        --config vitest.scripts.config.ts \
 *        scripts/ftmoSignalAlert.test.ts --reporter=verbose
 *
 * Crontab example (every 4h at 5 min past the hour, to catch the closed bar):
 *   5 0,4,8,12,16,20 * * * cd /path/to/project && \
 *     node ./node_modules/vitest/vitest.mjs run \
 *          --config vitest.scripts.config.ts \
 *          scripts/ftmoSignalAlert.test.ts > /tmp/ftmo-alert.log 2>&1
 *
 * Optional env vars for push notifications:
 *   TELEGRAM_BOT_TOKEN  — get from @BotFather
 *   TELEGRAM_CHAT_ID    — your chat ID (message @userinfobot)
 *
 * If both set, alerts are pushed to Telegram. Otherwise only logged to stdout
 * and appended to `signal-alerts.log`.
 */
import { describe, it, expect } from "vitest";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  loadForexFactoryNews,
  filterNewsEvents,
} from "../src/utils/forexFactoryNews";
import { detectLiveSignal, renderAlert } from "../src/utils/ftmoSignalDetector";
import { redactToken as sharedRedactToken } from "../src/utils/telegramRedact";

const LOG_PATH = "signal-alerts.log";
const STATE_PATH = "signal-alerts.state.json";

interface SignalState {
  lastAlertedBarCloseTime: number;
}

function defaultState(): SignalState {
  return { lastAlertedBarCloseTime: 0 };
}

function loadState(path: string = STATE_PATH): SignalState {
  if (!existsSync(path)) return defaultState();
  // Round 54 Fix #6: corruption-recovery. SIGTERM during the previous
  // (non-atomic) write could leave a 0-byte / half-written JSON file —
  // log it and start fresh rather than crashing the cron job.
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SignalState;
  } catch (e) {
    console.error(
      `[signal-alert] state file corrupt (${path}); starting fresh:`,
      e,
    );
    return defaultState();
  }
}
// Round 54 Fix #6: atomic write — temp + fsync + rename. SIGTERM during a
// plain writeFileSync could otherwise produce a 0-byte / half-flushed state
// file, breaking the next cron run's dedup. Mirrors writeJSON() in
// ftmoLiveService.ts.
function saveState(s: SignalState, path: string = STATE_PATH) {
  const tmp = `${path}.tmp.${process.pid}`;
  // R5 deferred-fix: clean up tmp file on any failure (write, fsync,
  // rename). Without this a crashed/interrupted run could leave orphaned
  // .tmp.<pid> files next to STATE_PATH, gradually polluting cwd.
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(s, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore — tmp may not exist if openSync threw before creation */
    }
    throw e;
  }
}

// R1-A1 audit fix: redact token from any error/message returned by fetch.
// Without this, DNS / TLS / Cloudflare errors can echo back the request URL
// containing the bot token straight into stderr or log files.
// R3-A1 audit fix: also redact URL-encoded / re-formatted token shapes via
// regex — proxies sometimes percent-encode `:` or wrap the token in `bot…`.
// Pattern `<8-12 digit bot-id>:<>=20 url-safe chars>` matches every Telegram
// token regardless of surrounding chars.
// R4-A1 audit fix: logic extracted into `src/utils/telegramRedact.ts` so a
// unit test (telegramRedact.test.ts) can verify the behaviour without
// running the heavy cron-job test.
function redactToken(s: string, token: string): string {
  return sharedRedactToken(s, token);
}

// R1-A1 audit fix: per-account env lookup, mirrors driftTelegram.ts.
// Multi-account setups (R57) expect TELEGRAM_BOT_TOKEN_<ACCOUNT_ID>.
function envFor(base: string): string | undefined {
  const acc = process.env.FTMO_ACCOUNT_ID;
  if (acc) {
    const v = process.env[`${base}_${acc.toUpperCase()}`];
    if (v) return v;
  }
  return process.env[base];
}

async function sendTelegram(msg: string): Promise<boolean> {
  const token = envFor("TELEGRAM_BOT_TOKEN");
  const chatId = envFor("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return false;
  // R1-A1 audit fix: 429 backoff + 401/404 fail-loud, mirrors the Python
  // telegram_notify.py path called out in MEMORY.md ("Telegram secure
  // (token-leak hardened, 401/404 exit, 429 backoff)"). TS path had no
  // retry / backoff at all; a single 429 silently dropped the alert.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: msg,
            parse_mode: "HTML",
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (res.ok) return true;
      // R3-A1 audit fix: read body once and redact for terminal/5xx paths.
      const bodyText = redactToken(await res.text().catch(() => ""), token);
      // 401 = bad token, 404 = bad chat — both terminal; do not retry.
      if (res.status === 401 || res.status === 404) {
        console.error(
          `[signal-alert] Telegram terminal error ${res.status} — check TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID: ${bodyText.slice(0, 200)}`,
        );
        return false;
      }
      if (res.status === 429) {
        // R3-A1 audit fix #6: Retry-After can be NaN (empty / non-numeric /
        // HTTP-date format we don't parse). Guard with Number.isFinite and
        // clamp to [100ms, 60s] so a malformed header can't yield a 0ms
        // hot-loop or a multi-day NaN-derived sleep.
        const retryAfterHdr = res.headers.get("retry-after");
        const parsed = retryAfterHdr ? Number(retryAfterHdr) : NaN;
        const headerMs =
          Number.isFinite(parsed) && parsed >= 0 ? parsed * 1000 : NaN;
        const fallbackMs = 2000 * (attempt + 1);
        const wait = Math.min(
          Math.max(Number.isFinite(headerMs) ? headerMs : fallbackMs, 100),
          60_000,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      // 5xx → exponential backoff and retry
      if (res.status >= 500 && res.status < 600) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return false;
    } catch (e) {
      const msgText = e instanceof Error ? e.message : String(e);
      console.error(
        `[signal-alert] Telegram send error: ${redactToken(msgText, token)}`,
      );
      // Network / abort error — retry once with backoff.
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return false;
}

// R3-A1 audit fix #8: orphan .tmp.<pid> sweep. saveState() writes to
// `${path}.tmp.${pid}` then renames; a SIGKILL between openSync and rename
// (or before the catch-block unlink runs) leaves the temp file behind.
// On each startup we delete any `*.tmp.*` next to STATE_PATH older than 1h
// — long enough that the current run's in-flight tmp file is never touched.
function sweepOrphanTmpFiles(dir: string = ".") {
  try {
    const cutoffMs = Date.now() - 60 * 60 * 1000; // 1h ago
    const tmpRe = /\.tmp\.[0-9A-Za-z]+$/;
    for (const f of readdirSync(dir)) {
      if (!tmpRe.test(f)) continue;
      const full = resolve(dir, f);
      try {
        const st = statSync(full);
        if (st.isFile() && st.mtimeMs < cutoffMs) {
          unlinkSync(full);
        }
      } catch {
        /* race or perm-denied — best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

describe("ftmo signal alert", { timeout: 60_000 }, () => {
  it("checks for live signal + optional telegram push", async () => {
    sweepOrphanTmpFiles(".");
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });

    let news: Awaited<ReturnType<typeof loadForexFactoryNews>> = [];
    try {
      news = filterNewsEvents(await loadForexFactoryNews(), {
        impacts: ["High"],
        currencies: ["USD", "EUR", "GBP"],
      });
    } catch {
      // FF can rate-limit; proceed without news filter
    }

    const alert = detectLiveSignal(eth, btc, news);
    const rendered = renderAlert(alert);
    console.log(rendered);

    // R1-A1 audit fix: account-scoped log path. Multiple FTMO_ACCOUNT_ID
    // processes used to share `signal-alerts.log` → interleaved >PIPE_BUF
    // writes plus duplicate-state-file collisions. Each account now writes
    // to its own log (and state/lock — see below).
    // R3-A1 audit fix #2: sanitize FTMO_ACCOUNT_ID before using as a path
    // segment — `"acc/1"` (slash) caused ENOENT, `"acc 1"` (space) made the
    // path quoting brittle in cron shells, `.` (dot) collided with the log
    // extension. Allowlist [A-Za-z0-9_-] only.
    // R3-A1 audit fix #3: replace ALL dots in the account suffix (not just
    // the first) so `acc.demo.1` doesn't leak partial dots into the log
    // basename.
    const rawAcc = process.env.FTMO_ACCOUNT_ID;
    const safeAcc = rawAcc ? rawAcc.replace(/[^A-Za-z0-9_-]/g, "_") : "";
    const accSuffix = safeAcc ? `.${safeAcc}` : "";
    const logPath = `${LOG_PATH}${accSuffix ? accSuffix.replace(/\./g, "-") : ""}`;
    const statePath = `${STATE_PATH}${accSuffix}`;

    // R67-r12 audit fix: rotate signal-alerts.log when it crosses 5 MB.
    // Cron runs every 4h ≈ 6×/day; renderAlert() output ~500 B per run plus
    // occasional multi-line signals → on a multi-year deploy the file grew
    // unbounded. Mirrors the rotate-on-write pattern used by
    // tools/ftmo_executor.py:_rotate_jsonl_if_needed().
    try {
      const SIZE_LIMIT_BYTES = 5 * 1024 * 1024;
      if (existsSync(logPath) && statSync(logPath).size > SIZE_LIMIT_BYTES) {
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .replace(/Z$/, "");
        renameSync(logPath, `${logPath}.${stamp}.rot`);
      }
      // R3-A1 audit fix #5: TTL — keep only the newest 10 `.rot` archives
      // and delete the rest. Without this, the rotation block from above
      // accumulates archive files indefinitely (one per overflow → ~once
      // per multi-month period, but still unbounded).
      const ROT_KEEP = 10;
      const absLog = resolve(logPath);
      const logDir = dirname(absLog) || ".";
      const logBase = basename(absLog);
      const rotPrefix = `${logBase}.`;
      const rotEntries = readdirSync(logDir)
        .filter((f) => f.startsWith(rotPrefix) && f.endsWith(".rot"))
        .map((f) => {
          const full = resolve(logDir, f);
          let mtime = 0;
          try {
            mtime = statSync(full).mtimeMs;
          } catch {
            /* race with another cleaner — skip */
          }
          return { full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime); // newest first
      for (const entry of rotEntries.slice(ROT_KEEP)) {
        try {
          unlinkSync(entry.full);
        } catch {
          /* best-effort */
        }
      }
    } catch (e) {
      // Rotation is best-effort — never block the alert log on FS issues.
      console.warn("[signal-alert] log rotation failed:", e);
    }

    // Log every run
    appendFileSync(logPath, `\n${"=".repeat(60)}\n${rendered}\n`, "utf8");

    // Telegram push only on NEW signal (not duplicate)
    if (alert.hasSignal) {
      // R67-r4 audit: PID-file lock around the load/sendTG/save sequence so
      // two overlapping cron-runs (slow Binance fetch leaves prev still
      // sending Telegram) don't both push the same alert. The previous code
      // had a 200-2000ms TOCTOU window between loadState and saveState.
      // R1-A1 audit: lock-path is now account-scoped + uses O_EXCL (`wx`)
      // to close the existsSync→writeFileSync TOCTOU race. Two cron-jobs
      // starting in the same millisecond used to both see "no lock" and
      // both push.
      const LOCK_PATH = `signal-alerts.lock${accSuffix}`;
      const haveLock = (() => {
        try {
          // Best-effort stale-lock cleanup before the exclusive create.
          if (existsSync(LOCK_PATH)) {
            const raw = readFileSync(LOCK_PATH, "utf8").trim();
            const pid = parseInt(raw, 10);
            if (Number.isFinite(pid) && pid > 0) {
              try {
                process.kill(pid, 0);
                return false; // alive → previous instance still running
              } catch {
                /* stale → unlink and fall through */
              }
            }
            try {
              unlinkSync(LOCK_PATH);
            } catch {
              /* race with another cleaner — fine */
            }
          }
          // O_EXCL: only one process can create the file. EEXIST → another
          // process won the race.
          const fd = openSync(LOCK_PATH, "wx");
          try {
            writeSync(fd, String(process.pid));
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          return true;
        } catch {
          // EEXIST from O_EXCL → another instance won. Skip rather than
          // double-push.
          return false;
        }
      })();
      if (!haveLock) {
        console.log(
          "\n⏭ Previous signal-alert run still active (lockfile); skipping push",
        );
      } else {
        try {
          const state = loadState(statePath);
          // R1-A1 audit fix: staleness guard. Without this a cron that was
          // paused for >1 bar (machine reboot, network outage) would push
          // a multi-hour-old signal as soon as it caught up. We refuse to
          // alert on bars whose close is older than 2 × bar-interval.
          // 4h bar (per crontab in file header) → 8h staleness window.
          const BAR_MS = 4 * 60 * 60 * 1000;
          const ageMs = Date.now() - alert.signalBarClose;
          const isStale = ageMs > 2 * BAR_MS;
          if (isStale) {
            console.log(
              `\n⏭ Signal bar is stale (${(ageMs / 3_600_000).toFixed(1)}h old); skipping push`,
            );
            // Still advance state so we don't re-push when fresh data arrives.
            saveState(
              { lastAlertedBarCloseTime: alert.signalBarClose },
              statePath,
            );
          } else if (alert.signalBarClose > state.lastAlertedBarCloseTime) {
            // 2026-05-13 Codex Round 7 #B20 FIX: save state BEFORE Telegram
            // push. If saveState throws (disk full, EROFS), we miss this
            // alert but won't double-push next cron. If sendTelegram fails
            // AFTER state-save, we log loudly but accept the missed alert.
            // Trades a one-off "missed alert" for "no duplicate pushes" —
            // the safer failure mode for FTMO live trading.
            saveState(
              { lastAlertedBarCloseTime: alert.signalBarClose },
              statePath,
            );
            const pushed = await sendTelegram(rendered);
            if (pushed) {
              console.log("\n📲 Pushed to Telegram");
            } else {
              console.log(
                "\n📲 (Telegram not configured OR push failed; state already advanced — alert lost",
              );
              console.log(
                "  set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env to enable Telegram)",
              );
            }
          } else {
            console.log(
              `\n⏭ Signal for this bar already alerted (${new Date(alert.signalBarClose).toISOString()})`,
            );
          }
        } finally {
          try {
            unlinkSync(LOCK_PATH);
          } catch {
            /* ignore */
          }
        }
      }
    }

    expect(true).toBe(true);
  });
});
