/**
 * driftTelegram.ts — Daily wrapper around `driftMonitor.ts` that posts the
 * report to Telegram. Designed to be invoked from cron on the VPS:
 *
 *   # /etc/cron.d/ftmo-drift  (UTC)
 *   17 23 * * * flooe cd /opt/ftmo && node /opt/ftmo/node_modules/tsx/dist/cli.mjs scripts/driftTelegram.ts
 *
 * Env vars (per-account routing matches the executor's R57 convention):
 *   FTMO_STATE_DIR             — same dir the executor writes to
 *   TELEGRAM_BOT_TOKEN         — bot token (or TELEGRAM_BOT_TOKEN_<ACCOUNT_ID>)
 *   TELEGRAM_CHAT_ID           — chat id  (or TELEGRAM_CHAT_ID_<ACCOUNT_ID>)
 *   FTMO_ACCOUNT_ID            — optional, for per-account env routing
 *   DRIFT_DAYS                 — window length (default 7)
 *
 * Exit code 0 always — the cron job should never fail in a way that pages
 * the operator. Errors print to stderr.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function envFor(
  varBase: string,
  accountId: string | undefined,
): string | undefined {
  if (accountId) {
    const v = process.env[`${varBase}_${accountId.toUpperCase()}`];
    if (v) return v;
  }
  return process.env[varBase];
}

async function main() {
  const stateDir = process.env.FTMO_STATE_DIR ?? "ftmo-state-default";
  const days = parseInt(process.env.DRIFT_DAYS ?? "7", 10);
  const accountId = process.env.FTMO_ACCOUNT_ID;
  const token = envFor("TELEGRAM_BOT_TOKEN", accountId);
  const chatId = envFor("TELEGRAM_CHAT_ID", accountId);

  if (!existsSync(stateDir)) {
    console.error(`[drift-telegram] state dir not found: ${stateDir}`);
    process.exit(0);
  }

  // Run the monitor and capture markdown.
  const result = spawnSync(
    process.argv0,
    [
      "./node_modules/tsx/dist/cli.mjs",
      "scripts/driftMonitor.ts",
      "--state-dir",
      stateDir,
      "--days",
      String(days),
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    console.error(`[drift-telegram] monitor failed: ${result.stderr}`);
    process.exit(0);
  }
  const md = result.stdout.trim();
  if (!md) {
    console.error("[drift-telegram] empty report");
    process.exit(0);
  }

  // Convert Markdown to Telegram-friendly HTML (simple replacements; the
  // report uses tables which Telegram doesn't render — collapse to <pre>).
  const text = md
    // Tables → <pre> blocks
    .replace(
      /(\|[^\n]*\|\n)+/g,
      (block) =>
        `<pre>${block.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"))}</pre>\n`,
    )
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    // H1/H2
    .replace(/^# (.+)$/gm, "<b>$1</b>")
    .replace(/^## (.+)$/gm, "<b>$1</b>");

  if (!token || !chatId) {
    console.log("[drift-telegram] no Telegram creds — printing report:");
    console.log(md);
    process.exit(0);
  }

  // Telegram sendMessage has a 4096-char limit; split if needed.
  // Splitter tracks <pre>...</pre> boundaries so chunked output stays valid HTML.
  function splitChunks(text: string, max = 3800): string[] {
    const out: string[] = [];
    let buf = "";
    let inPre = false;
    for (const line of text.split("\n")) {
      if (line.includes("<pre>")) inPre = true;
      if (line.includes("</pre>")) inPre = false;
      const trimmed =
        line.length > max ? line.slice(0, max - 100) + "\u2026" : line;
      if (buf.length + trimmed.length + 1 > max) {
        out.push(inPre ? buf + "\n</pre>" : buf);
        buf = inPre ? "<pre>\n" + trimmed : trimmed;
      } else {
        buf = buf ? `${buf}\n${trimmed}` : trimmed;
      }
    }
    if (buf) out.push(buf);
    return out;
  }

  const chunks = splitChunks(text);

  for (const chunk of chunks) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        },
      );
      if (!res.ok) {
        console.error(
          `[drift-telegram] send failed: ${res.status} ${await res.text()}`,
        );
      }
    } catch (e) {
      console.error(`[drift-telegram] send error: ${e}`);
    }
  }
  console.log(`[drift-telegram] sent ${chunks.length} chunk(s) to Telegram`);
}

main().catch((e) => {
  console.error(`[drift-telegram] fatal: ${e}`);
  process.exit(0);
});
