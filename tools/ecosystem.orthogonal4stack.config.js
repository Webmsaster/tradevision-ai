/**
 * PM2 ecosystem config for the Orthogonal 4-Stack FTMO Bot.
 *
 * 2026-05-23 Production Deploy (4 accounts × signal+executor pair):
 *
 *   Account 1: V5_AMBER_MAX_PASSLOCK        + Basket-18 + BNB 18/50 → 32.90% combined-funded (TRUE-SEQUENTIAL)
 *   Account 5: V5_AMBER_MAX_PASSLOCK_BIDIR  + Basket-18 + BNB 18/50 → 29.79% combined-funded
 *   Account 4: V5_AMBER_MAX_MR_PASSLOCK     + Basket-18 + BNB 18/50 → 16.15% combined-funded
 *   Account 2: V5_RUBIN_PASSLOCK            + Basket-18 + BNB 18/50 → 29.29% combined-funded
 *
 * 4-Stack OR-aggregation (per-window min-1-funded, n=997 valid windows):
 *   AMBER + BIDIR + MR + RUBIN = 57.17%   (+5.21pp over the orthogonal 3-stack 51.96%)
 *
 * Why RUBIN adds value despite high AMBER↔RUBIN correlation:
 *   AMBER  <-> BIDIR  +0.300
 *   AMBER  <-> MR     +0.081
 *   AMBER  <-> RUBIN  +0.600  (HIGH — same trend-family)
 *   BIDIR  <-> MR     +0.209
 *   BIDIR  <-> RUBIN  +0.174
 *   MR     <-> RUBIN  +0.041  (NEAR-ORTHOGONAL — RUBIN's secret weapon)
 *
 *   RUBIN passes windows that MR (+0.041 corr) and BIDIR (+0.174 corr) miss,
 *   even though it overlaps heavily with AMBER. The cross-class diversification
 *   with MR is what drives the +5.21pp uplift.
 *
 *   Independence-bound OR: 72.07%   Achieved: 57.17%   Efficiency: 79.3%
 *
 * Cross-signal-class diversification:
 *   AMBER  = trend-long  (invertDirection + disableShort=true)
 *   BIDIR  = trend long+short (disableShort=false on every asset)
 *   MR     = mean-revert (RSI 14, oversold=25/overbought=75)
 *   RUBIN  = trend-long with V5_RUBIN basket/tp params (different per-asset edges)
 *
 * Distinct from legacy ecosystem.4stack.config.js (AMBER+RUBIN+TITANIUM+MR @ 84.93%
 * pre-Codex measure, since debunked to ~75% live then ~46% true-sequential). This
 * 4-stack is FRESH 2026-05-23 measurement, post-Codex post-BNB-18/50 patch, on
 * 997 evaluable windows with TRUE-SEQUENTIAL (P2 starts at i+final_day_of_P1)
 * combined-funded math.
 *
 * Usage:
 *   # Fill in MT5 logins + Telegram tokens in:
 *   #   .env.ftmo.account-1 (AMBER), .env.ftmo.account-2 (RUBIN),
 *   #   .env.ftmo.account-4 (MR),    .env.ftmo.account-5 (BIDIR)
 *   pm2 start tools/ecosystem.orthogonal4stack.config.js
 *   pm2 save
 *
 * Stop all 4:
 *   pm2 stop ftmo-signal-amber-max ftmo-executor-amber-max \
 *            ftmo-signal-rubin     ftmo-executor-rubin     \
 *            ftmo-signal-amber-mr  ftmo-executor-amber-mr  \
 *            ftmo-signal-bidir     ftmo-executor-bidir
 *
 * Pre-deploy ready: TF_DISPATCH wired (commit 1b99975), BNB cross-asset baked
 * into 4 CFGs (commit 698444c). No outstanding engine work.
 */
const path = require("path");
const fs = require("fs");

const REPO_ROOT = path.resolve(__dirname, "..");

function loadEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) {
    console.warn(
      `[pm2-4stack-orth] WARNING: ${filePath} not found — skipping account`,
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

const seenStateDirs = new Map();

function buildAppPair(envFile, accountLabel) {
  const env = loadEnvFile(envFile);
  if (!env) return [];
  const tf = env.FTMO_TF;
  const accountId = env.FTMO_ACCOUNT_ID || "default";
  if (!tf) {
    console.warn(`[pm2-4stack-orth] ${envFile} missing FTMO_TF — skipping`);
    return [];
  }
  const stateDir = env.FTMO_STATE_DIR
    ? path.resolve(REPO_ROOT, env.FTMO_STATE_DIR)
    : path.resolve(REPO_ROOT, `ftmo-state-${tf}-${accountId}`);
  if (seenStateDirs.has(stateDir)) {
    console.error(
      `[pm2-4stack-orth] FATAL: state-dir collision — ${envFile} resolves to the same FTMO_STATE_DIR as ${seenStateDirs.get(stateDir)}.\n` +
        `         Both have FTMO_TF=${tf} + FTMO_ACCOUNT_ID=${accountId}. Set a unique FTMO_ACCOUNT_ID per env file.`,
    );
    process.exit(2);
  }
  seenStateDirs.set(stateDir, envFile);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch (err) {
    if (err && err.code !== "EEXIST") throw err;
  }

  const sharedEnv = {
    ...env,
    FTMO_STATE_DIR: stateDir,
  };

  return [
    {
      name: `ftmo-signal-${accountLabel}`,
      cwd: REPO_ROOT,
      script: "node_modules/tsx/dist/cli.mjs",
      args: "scripts/ftmoLiveService.ts",
      env: sharedEnv,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: "500M",
      out_file: path.join(stateDir, "pm2-signal.out.log"),
      error_file: path.join(stateDir, "pm2-signal.err.log"),
      time: true,
    },
    {
      name: `ftmo-executor-${accountLabel}`,
      cwd: REPO_ROOT,
      script: "python",
      args: "-u tools/ftmo_executor.py",
      interpreter: "none",
      env: {
        ...sharedEnv,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        FTMO_ETH_SYMBOL: "ETHUSD",
        FTMO_BTC_SYMBOL: "BTCUSD",
        FTMO_SOL_SYMBOL: "SOLUSD",
        FTMO_BCH_SYMBOL: "BCHUSD",
        FTMO_LTC_SYMBOL: "LTCUSD",
        FTMO_LINK_SYMBOL: "LNKUSD",
        FTMO_BNB_SYMBOL: "BNBUSD",
        FTMO_ADA_SYMBOL: "ADAUSD",
        FTMO_DOGE_SYMBOL: "DOGEUSD",
        FTMO_AVAX_SYMBOL: "AVAUSD",
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 10000,
      max_memory_restart: "300M",
      out_file: path.join(stateDir, "pm2-executor.out.log"),
      error_file: path.join(stateDir, "pm2-executor.err.log"),
      time: true,
    },
  ];
}

const apps = [
  ...buildAppPair(path.join(REPO_ROOT, ".env.ftmo.account-1"), "amber-max"),
  ...buildAppPair(path.join(REPO_ROOT, ".env.ftmo.account-2"), "rubin"),
  ...buildAppPair(path.join(REPO_ROOT, ".env.ftmo.account-4"), "amber-mr"),
  ...buildAppPair(path.join(REPO_ROOT, ".env.ftmo.account-5"), "bidir"),
];

if (apps.length === 0) {
  console.error(
    "[pm2-4stack-orth] FATAL: no env files loaded. Copy .env.ftmo.account-{1,2,4,5}.example → .env.ftmo.account-{1,2,4,5} and fill in.",
  );
  process.exit(1);
}

const masters = apps
  .filter((a) => a.name.startsWith("ftmo-signal-"))
  .filter((a) => {
    const v = a.env.FTMO_TELEGRAM_BOT_MASTER;
    return v === "1" || v === "true";
  })
  .map((a) => a.name.replace("ftmo-signal-", ""));
if (masters.length > 1) {
  console.error(
    `[pm2-4stack-orth] FATAL: ${masters.length} accounts have FTMO_TELEGRAM_BOT_MASTER=1 (${masters.join(", ")}).`,
  );
  process.exit(4);
}

console.log(
  `[pm2-4stack-orth] Launching ${apps.length / 2} account(s): ` +
    apps
      .filter((a) => a.name.startsWith("ftmo-signal-"))
      .map((a) => a.name.replace("ftmo-signal-", ""))
      .join(", "),
);

module.exports = { apps };
