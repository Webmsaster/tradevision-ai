/**
 * PM2 ecosystem config for Phase-Adaptive Stack-4 (97.28% OOS GA winner).
 *
 * 2026-05-25 Production Deploy (4 accounts × phase-switch supervisor):
 *
 *   Account A: SHORTS_AGG P1 → SHORTS_AGG P2   (symmetric ok)
 *   Account B: AMBER (ext24) P1 → TOPAZ P2
 *   Account C: AMBER-risk06 P1 → AMBER-SHORTS_ONLY P2
 *   Account D: SHORTS_ONLY (ext24) P1 → AMBER-risk06 P2
 *
 * Stack-4 OR-aggregation (TRUE-SEQUENTIAL, walk-forward TEST):
 *   GA Winner (seeds 1337+2024 converged): 97.28% OOS
 *   Mean across 10 GA seeds: 93.75% (range [90.94%, 97.28%])
 *   Live-realistic ~85-90% effective → ~3.5/4 cycles funded
 *
 * Each account runs `tools/phase_switch_supervisor.py` which:
 *   1. Spawns ftmo_executor.py with FTMO_TF=$FTMO_TF_P1 for Phase 1
 *   2. Polls equity-history.jsonl, on P1-target hit → SIGTERM executor
 *   3. Archives P1 state-dir → state-backups/<ACCT>-P1-<ts>/
 *   4. Spawns new executor with FTMO_TF=$FTMO_TF_P2 for Phase 2
 *
 * Required env files (4): .env.ftmo.account-A, account-B, account-C, account-D.
 * Each must define:
 *   FTMO_ACCOUNT_ID, FTMO_TF_P1, FTMO_TF_P2,
 *   FTMO_LOGIN, FTMO_PASSWORD, FTMO_SERVER (MT5),
 *   TELEGRAM_BOT_TOKEN_<id>, TELEGRAM_CHAT_ID_<id>.
 *
 * Usage:
 *   pm2 start tools/ecosystem.phase_adaptive4stack.config.js
 *   pm2 logs phase-A    # tail Account-A supervisor log
 *   pm2 save
 *
 * Stop all:
 *   pm2 stop phase-A phase-B phase-C phase-D
 *
 * Source: docs/PHASE_ADAPTIVE_STACK4_DEPLOY_PLAN.md
 */
const path = require("path");
const fs = require("fs");

const REPO_ROOT = path.resolve(__dirname, "..");

function loadEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) {
    console.warn(
      `[pm2-pa4stack] WARNING: ${filePath} not found — skipping account`,
    );
    return null;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let val = trimmed.slice(eq + 1).trim();
    const isDQ = val.startsWith('"') && val.endsWith('"') && val.length >= 2;
    const isSQ = val.startsWith("'") && val.endsWith("'") && val.length >= 2;
    if (isDQ || isSQ) {
      val = val.slice(1, -1);
    } else {
      const hashIdx = val.indexOf(" #");
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    env[key] = val;
  }
  return env;
}

function buildSupervisor(envFile, accountLabel) {
  const env = loadEnvFile(envFile);
  if (!env) return [];
  if (!env.FTMO_TF_P1 || !env.FTMO_TF_P2) {
    console.warn(`[pm2-pa4stack] ${envFile} missing FTMO_TF_P1/P2 — skipping`);
    return [];
  }
  const accountId = env.FTMO_ACCOUNT_ID || accountLabel;
  const supervisorStateDir = path.resolve(
    REPO_ROOT,
    `ftmo-state-supervisor-${accountId}`,
  );
  try {
    fs.mkdirSync(supervisorStateDir, { recursive: true });
  } catch (err) {
    if (err && err.code !== "EEXIST") throw err;
  }

  return [
    {
      name: `phase-${accountLabel}`,
      cwd: REPO_ROOT,
      script: "python",
      args: "-u tools/phase_switch_supervisor.py",
      interpreter: "none",
      env: {
        ...env,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 10000,
      max_memory_restart: "1G",
      // AUDIT FIX WARNUNG: stop_exit_codes prevents PM2 restart-loop when
      // supervisor exits idempotently with status=FAILED/FUNDED (codes 0/4).
      // Without this PM2 would restart 50× over 500s burning logs.
      stop_exit_codes: [0, 4],
      out_file: path.join(supervisorStateDir, "pm2-supervisor.out.log"),
      error_file: path.join(supervisorStateDir, "pm2-supervisor.err.log"),
      time: true,
    },
  ];
}

const apps = [
  ...buildSupervisor(path.join(REPO_ROOT, ".env.ftmo.account-A"), "A"),
  ...buildSupervisor(path.join(REPO_ROOT, ".env.ftmo.account-B"), "B"),
  ...buildSupervisor(path.join(REPO_ROOT, ".env.ftmo.account-C"), "C"),
  ...buildSupervisor(path.join(REPO_ROOT, ".env.ftmo.account-D"), "D"),
];

if (apps.length === 0) {
  console.error(
    "[pm2-pa4stack] FATAL: no env files loaded. Copy .env.ftmo.account-A.example → .env.ftmo.account-A (etc.) and fill in.",
  );
  process.exit(1);
}

// AUDIT FIX KRIT (2026-05-25 post-deploy audit): Telegram-master count
// validation. Telegram getUpdates is a long-poll exclusive — two masters
// trip 409 Conflict → no /pause, /kill bot-controls work during live trades.
// Mirror of ecosystem.4stack.config.js:193-201 validator pattern.
const masters = apps
  .filter((a) => {
    const v = a.env.FTMO_TELEGRAM_BOT_MASTER;
    return v === "1" || v === "true";
  })
  .map((a) => a.name);
if (masters.length > 1) {
  console.error(
    `[pm2-pa4stack] FATAL: ${masters.length} accounts have FTMO_TELEGRAM_BOT_MASTER=1 (${masters.join(", ")}). ` +
      `Only ONE account may be the Telegram master (getUpdates long-poll exclusivity). ` +
      `Set FTMO_TELEGRAM_BOT_MASTER=0 in all but one .env file.`,
  );
  process.exit(4);
}
if (masters.length === 0) {
  console.warn(
    "[pm2-pa4stack] WARNING: 0 accounts have FTMO_TELEGRAM_BOT_MASTER=1. " +
      "No /pause, /kill, /status bot-controls will be available. " +
      "Recommended: set FTMO_TELEGRAM_BOT_MASTER=1 on Account A.",
  );
}

console.log(
  `[pm2-pa4stack] Launching ${apps.length} phase-adaptive supervisor(s): ` +
    apps.map((a) => a.name).join(", "),
);

module.exports = { apps };
