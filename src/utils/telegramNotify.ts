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
 * Usage:
 *   import { tgSend } from "@/utils/telegramNotify";
 *   await tgSend("🚨 Signal: SHORT ETH @ $3456");
 */

const MAX_MSG_LEN = 4000; // Telegram limit is 4096, leave buffer

export interface TelegramConfig {
  token?: string;
  chatId?: string;
}

/**
 * Read Telegram config from env vars.
 * Returns undefined if not configured (caller should treat as no-op).
 */
export function readTelegramConfig(): TelegramConfig | undefined {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
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
  // BUGFIX 2026-04-28 (Round 18): HTML-tag-aware truncation.
  // Naive slice() could split mid-tag (<co|de>) which Telegram rejects with
  // 400 "can't parse entities". Truncate at the last safe spot (before any
  // open tag whose closing partner would be lost), then close all open tags.
  const body =
    text.length > MAX_MSG_LEN ? safeTruncateHtml(text, MAX_MSG_LEN - 20) : text;
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
      const t = await resp.text();
      console.error(`[telegram] HTTP ${resp.status}: ${t}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[telegram] send error:`, e);
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
    const tag = m[1].toLowerCase();
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
