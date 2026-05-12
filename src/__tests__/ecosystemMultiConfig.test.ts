/**
 * Smoke + edge-case tests for tools/ecosystem-multi.config.js.
 *
 * The config file is a CommonJS PM2 launcher that must NOT be required
 * directly (it has process.exit + side-effects). We re-execute it as a child
 * process for each scenario with a synthetic REPO_ROOT.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CFG_SRC = readFileSync(
  join(process.cwd(), "tools/ecosystem-multi.config.js"),
  "utf-8",
);

let tmpRoot: string;

function setupTmp(envFiles: Record<string, string>): string {
  tmpRoot = mkdtempSync(join(tmpdir(), "eco-"));
  for (const [name, body] of Object.entries(envFiles)) {
    writeFileSync(join(tmpRoot, name), body);
  }
  // Patch REPO_ROOT to tmpRoot so test is hermetic.
  const patched = CFG_SRC.replace(
    'path.resolve(__dirname, "..")',
    JSON.stringify(tmpRoot),
  );
  const cfgPath = join(tmpRoot, "ecosystem.js");
  writeFileSync(cfgPath, patched);
  return cfgPath;
}

function runConfig(cfgPath: string): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const { spawnSync } =
    require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync(
    process.execPath,
    [
      "-e",
      `const r = require(${JSON.stringify(cfgPath)}); console.log("APPS:" + r.apps.length);`,
    ],
    { encoding: "utf-8" },
  );
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot))
    rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ecosystem-multi.config.js", () => {
  it("exits 1 when no env files are present", () => {
    const cfg = setupTmp({});
    const r = runConfig(cfg);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no env files loaded");
  });

  it("partial-launch: 2 of 3 env files present", () => {
    const cfg = setupTmp({
      ".env.ftmo.demo1": "FTMO_TF=2h-trend-v5\nFTMO_ACCOUNT_ID=demo1\n",
      ".env.ftmo.titanium": "FTMO_TF=v5-titanium\nFTMO_ACCOUNT_ID=titanium\n",
    });
    const r = runConfig(cfg);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("APPS:4"); // 2 accounts × 2 procs
    expect(r.stderr).toContain("amber not found");
  });

  it("fatal-exits on state-dir collision (same FTMO_TF + FTMO_ACCOUNT_ID)", () => {
    const cfg = setupTmp({
      ".env.ftmo.demo1": "FTMO_TF=v5\nFTMO_ACCOUNT_ID=acc1\n",
      ".env.ftmo.titanium": "FTMO_TF=v5\nFTMO_ACCOUNT_ID=acc1\n",
    });
    const r = runConfig(cfg);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("state-dir collision");
  });

  it("fatal-exits when 2 accounts both set Telegram master", () => {
    const cfg = setupTmp({
      ".env.ftmo.demo1":
        "FTMO_TF=v5\nFTMO_ACCOUNT_ID=a1\nFTMO_TELEGRAM_BOT_MASTER=1\n",
      ".env.ftmo.titanium":
        "FTMO_TF=v5\nFTMO_ACCOUNT_ID=a2\nFTMO_TELEGRAM_BOT_MASTER=1\n",
    });
    const r = runConfig(cfg);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("FTMO_TELEGRAM_BOT_MASTER");
  });

  it("warns when zero accounts set Telegram master", () => {
    const cfg = setupTmp({
      ".env.ftmo.demo1": "FTMO_TF=v5\nFTMO_ACCOUNT_ID=a1\n",
    });
    const r = runConfig(cfg);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("no account has FTMO_TELEGRAM_BOT_MASTER=1");
  });

  it("skips env file missing FTMO_TF", () => {
    const cfg = setupTmp({
      ".env.ftmo.demo1": "FTMO_ACCOUNT_ID=a1\n",
      ".env.ftmo.titanium": "FTMO_TF=v5\nFTMO_ACCOUNT_ID=a2\n",
    });
    const r = runConfig(cfg);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("APPS:2");
    expect(r.stderr).toContain("missing FTMO_TF");
  });

  it("parses CRLF line endings + quoted values + inline comments", () => {
    const body = [
      "# comment",
      'FTMO_TF="v5-quoted"',
      "FTMO_ACCOUNT_ID=a1",
      "URL=https://api.x.com/?k=a=b&t=1",
      "INLINE_COMMENT=val1 # trailing",
      "",
    ].join("\r\n");
    const cfg = setupTmp({ ".env.ftmo.demo1": body });
    const r = runConfig(cfg);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("APPS:2");
    // Verify state-dir contains unquoted FTMO_TF value
    expect(existsSync(join(tmpRoot, "ftmo-state-v5-quoted-a1"))).toBe(true);
  });

  it("creates state-dir even when called twice in a row (mkdir idempotent)", () => {
    const cfg = setupTmp({
      ".env.ftmo.demo1": "FTMO_TF=v5\nFTMO_ACCOUNT_ID=a1\n",
    });
    const r1 = runConfig(cfg);
    const r2 = runConfig(cfg);
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
  });

  it("fatal-exits when state-dir path exists as a file (not directory)", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "eco-"));
    writeFileSync(
      join(tmpRoot, ".env.ftmo.demo1"),
      "FTMO_TF=v5\nFTMO_ACCOUNT_ID=a1\n",
    );
    // Plant a regular file at the would-be state-dir path
    writeFileSync(join(tmpRoot, "ftmo-state-v5-a1"), "blocker");
    const patched = CFG_SRC.replace(
      'path.resolve(__dirname, "..")',
      JSON.stringify(tmpRoot),
    );
    const cfgPath = join(tmpRoot, "ecosystem.js");
    writeFileSync(cfgPath, patched);
    const r = runConfig(cfgPath);
    expect(r.code).not.toBe(0);
  });
});
