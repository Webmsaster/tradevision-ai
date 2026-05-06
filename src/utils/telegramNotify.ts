/**
 * Minimal Telegram Bot notifier — no dependencies, uses fetch.
 *
 * Setup:
 *   1. Talk to @BotFather on Telegram → /newbot → get TOKEN
 *   2. Send any message to your bot → open https://api.telegram.org/bot<TOKEN>/getUpdates
 *      → copy "chat":{"id": NNNN} → that's your CHAT_ID
 *   3. Set env vars:
 *        TELEGRAM_BOT_TOKEN=<token>
 *        TELEGRAM_CHAT_ID=<chat id>
 *
 * Multi-account (Round 57, 2026-05-03):
 *   When running 2+ FTMO bots in parallel, each can use its own bot/chat by
 *   setting `FTMO_ACCOUNT_ID=<id>` and providing
 *     TELEGRAM_BOT_TOKEN_<id>
 *     TELEGRAM_CHAT_ID_<id>
 *   The bare `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are used as a fallback
 *   so a shared chat keeps working. Outgoing messages are auto-prefixed with
 *   `[acct:<id>] ` so a shared chat stays unambiguous.
 *
 * Usage:
 *   import { tgSend } from "@/utils/telegramNotify";
 *   await tgSend("🚨 Signal: SHORT ETH @ $3456");
 */

const MAX_MSG_LEN = 4000; // Telegram limit is 4096, leave buffer

// R67-r3 (2026-05-06): port `tools/telegram_notify.py` hardening to TS.
// - Redact bot tokens before any console.error
// - 401/404 → permanent suppression (invalid token / blocked bot — needs restart)
// - 429/5xx → 60-second cooldown (avoid ban-spam during rate-limit / outage)
// - Skip the actual fetch when we're inside a suppression window
const TOKEN_REDACT_RE = /\/bot\d+:[A-Za-z0-9_-]+/g;
const SUPPRESSION_COOLDOWN_MS = 60_000;
const PERMANENT = Number.POSITIVE_INFINITY;
// R67-r4 (2026-05-06): expanding cooldown for 401/404 instead of permanent
// suppression. A transient bot-token glitch (e.g. BotFather propagation,
// proxy 404) used to silence the bot until process restart. Now we back
// off 5min → 10min → 20min → … capped at 24h, and clear on first success.
const AUTH_FAIL_BASE_MS = 5 * 60_000;
const AUTH_FAIL_CAP_MS = 24 * 60 * 60_000;

let suppressUntilTs = 0;
let suppressLogged = false;
let consecutiveAuthFailures = 0;

function redactToken(s: string): string {
  return s.replace(TOKEN_REDACT_RE, "/bot<REDACTED>");
}

function enterSuppression(ms: number, reason: string): void {
  suppressUntilTs = ms === PERMANENT ? PERMANENT : Date.now() + ms;
  if (!suppressLogged) {
    if (suppressUntilTs === PERMANENT) {
      console.error(`[telegram] permanently suppressed: ${reason}`);
    } else {
      console.error(
        `[telegram] suppressed until ${suppressUntilTs.toFixed(0)} (${reason})`,
      );
    }
    suppressLogged = true;
  }
}

function clearSuppression(): void {
  suppressUntilTs = 0;
  suppressLogged = false;
}

/** Test hook — reset suppression state between vitest runs. */
export function __resetTelegramSuppression(): void {
  clearSuppression();
  consecutiveAuthFailures = 0;
}

/**
 * Force-clear the suppression state from outside (supervisor / admin
 * endpoint after the operator has confirmed the token is valid again).
 * Unlike `__resetTelegramSuppression` this is a public API — exported with
 * a `__` prefix to keep callers honest about the recovery intent.
 *
 * R67-r4: pairs with the new expanding-cooldown logic so an operator does
 * not have to wait the full 24h cap after rotating a bot token.
 */
export function __forceClearTelegramSuppression(): void {
  clearSuppression();
  consecutiveAuthFailures = 0;
}

export interface TelegramConfig {
  token?: string;
  chatId?: string;
}

/**
 * Resolve `TELEGRAM_<base>_<FTMO_ACCOUNT_ID>` first, fall back to
 * `TELEGRAM_<base>`. Returns undefined when neither is set.
 *
 * The account id is sanitised — only `[A-Za-z0-9_]` survive so a stray
 * dash/space/slash in FTMO_ACCOUNT_ID can't poison env-var lookup.
 */
function resolveAccountEnv(base: string): string | undefined {
  const acct = (process.env.FTMO_ACCOUNT_ID ?? "").trim();
  if (acct) {
    const safe = acct.replace(/[^A-Za-z0-9_]/g, "_");
    const perAcct = process.env[`TELEGRAM_${base}_${safe}`];
    if (perAcct) return perAcct;
  }
  return process.env[`TELEGRAM_${base}`] ?? undefined;
}

/** `[acct:<id>] ` if FTMO_ACCOUNT_ID is set, else empty string. */
export function accountPrefix(): string {
  const acct = (process.env.FTMO_ACCOUNT_ID ?? "").trim();
  return acct ? `[acct:${acct}] ` : "";
}

/**
 * Read Telegram config from env vars.
 * Returns undefined if not configured (caller should treat as no-op).
 *
 * Round 57: per-account env precedence
 *   TELEGRAM_BOT_TOKEN_<FTMO_ACCOUNT_ID> → TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID_<FTMO_ACCOUNT_ID>   → TELEGRAM_CHAT_ID
 */
export function readTelegramConfig(): TelegramConfig | undefined {
  const token = resolveAccountEnv("BOT_TOKEN");
  const chatId = resolveAccountEnv("CHAT_ID");
  if (!token || !chatId) return undefined;
  return { token, chatId };
}

/**
 * Send a plain-text message to Telegram.
 * Silent no-op if not configured. Never throws — logs to console on error.
 */
export async function tgSend(
  text: string,
  cfg?: TelegramConfig,
): Promise<boolean> {
  const conf = cfg ?? readTelegramConfig();
  if (!conf) return false;
  // Round 57: prefix multi-account messages so a shared chat stays readable.
  // Prefix counts toward the 4000-char Telegram budget so we apply it before
  // the safe-truncation step below.
  const prefixed = accountPrefix() + text;
  // BUGFIX 2026-04-28 (Round 18): HTML-tag-aware truncation.
  // Naive slice() could split mid-tag (<co|de>) which Telegram rejects with
  // 400 "can't parse entities". Truncate at the last safe spot (before any
  // open tag whose closing partner would be lost), then close all open tags.
  const body =
    prefixed.length > MAX_MSG_LEN
      ? safeTruncateHtml(prefixed, MAX_MSG_LEN - 20)
      : prefixed;
  // R67-r3: skip fetch entirely while inside a suppression window so a
  // misconfigured bot can't spam Telegram and trigger a global ban.
  if (Date.now() < suppressUntilTs) return false;
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${conf.token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: conf.chatId,
          text: body,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
    );
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      const safeBody = redactToken(t).slice(0, 200);
      const status = resp.status;
      if (status === 401 || status === 404) {
        // R67-r4: expanding cooldown 5min → 10min → 20min … capped at 24h
        // (was: permanent until restart). Recovers automatically once
        // BotFather/proxy hiccups settle, while still throttling spam.
        consecutiveAuthFailures++;
        const ms = Math.min(
          AUTH_FAIL_BASE_MS * 2 ** (consecutiveAuthFailures - 1),
          AUTH_FAIL_CAP_MS,
        );
        console.error(
          `[telegram] auth/bot error ${status} (#${consecutiveAuthFailures}, cooldown ${ms}ms): ${safeBody}`,
        );
        enterSuppression(ms, `HTTP ${status}`);
      } else if (status === 429 || (status >= 500 && status < 600)) {
        // Rate-limited or server error → 60s cooldown.
        console.error(`[telegram] backoff ${status}: ${safeBody}`);
        enterSuppression(SUPPRESSION_COOLDOWN_MS, `HTTP ${status}`);
      } else {
        console.error(`[telegram] HTTP ${status}: ${safeBody}`);
      }
      return false;
    }
    // Successful send → drop any pending suppression state.
    consecutiveAuthFailures = 0;
    clearSuppression();
    return true;
  } catch (e) {
    // Network / DNS / timeout. Redact in case the exception text contains
    // the URL (some libs format the URL into the error message).
    const msg =
      e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
    console.error(`[telegram] send error: ${redactToken(msg)}`);
    return false;
  }
}

/** Escape HTML special chars for Telegram HTML parse mode. */
export function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Truncate `text` to at most `maxLen` chars without splitting an HTML tag.
 * Closes any tags still open at the truncation point so Telegram accepts
 * the message.
 */
function safeTruncateHtml(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let cut = maxLen;
  // Pull cut point back to before any "<" that opens an unclosed tag.
  const lastOpen = text.lastIndexOf("<", cut - 1);
  const lastClose = text.lastIndexOf(">", cut - 1);
  if (lastOpen > lastClose) cut = lastOpen;
  let body = text.slice(0, cut);
  // Track which tags are still open and close them in reverse order.
  const openStack: string[] = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/)?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(body)) !== null) {
    const tag = m[1]!.toLowerCase();
    const isClose = m[0].startsWith("</");
    const isSelf = m[2] === "/";
    if (isSelf) continue;
    if (isClose) {
      const idx = openStack.lastIndexOf(tag);
      if (idx >= 0) openStack.splice(idx, 1);
    } else {
      openStack.push(tag);
    }
  }
  body += "\n…(truncated)";
  for (let i = openStack.length - 1; i >= 0; i--) {
    body += `</${openStack[i]}>`;
  }
  return body;
}
