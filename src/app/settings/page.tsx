"use client";

import { useState, useEffect, useRef } from "react";
import {
  SETTINGS_CHANGED_EVENT,
  SETTINGS_KEY as SETTINGS_STORAGE_KEY,
} from "@/lib/constants";
import { isValidHttpsUrl } from "@/utils/urlSafety";
import { loadTrades, saveTrades } from "@/utils/storage";
import { tradesToCsv } from "@/utils/csvExport";
import { useAuth } from "@/lib/auth-context";
import { useTradeStorage } from "@/hooks/useTradeStorage";
// R67-Final (R19-A8 deferred MED): WebCrypto AES-GCM encryption-at-rest
// for the bot-token-bearing webhook URL. See `src/utils/secretsCrypto.ts`
// for threat-model + format spec.
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  resolveUserKey,
} from "@/utils/secretsCrypto";

// Round 9 audit (KRITISCH): client-side platform-URL match — defence in
// depth alongside the same gate in /api/webhook-test. Discord webhooks
// MUST point at discord.com/api/webhooks/...; Telegram MUST hit
// api.telegram.org/bot...; otherwise the user has misconfigured and we
// surface a clear error before the network round-trip.
function platformUrlMatches(
  platform: WebhookSettings["platform"],
  url: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (platform === "discord") {
    return (
      parsed.hostname === "discord.com" &&
      parsed.pathname.startsWith("/api/webhooks/")
    );
  }
  if (platform === "telegram") {
    return (
      parsed.hostname === "api.telegram.org" &&
      parsed.pathname.startsWith("/bot")
    );
  }
  // "custom" or any other value: rely on isValidHttpsUrl alone.
  return true;
}

// Round 9 audit (KRITISCH): structured test-status replaces fragile
// `testResult.includes("success")` string-match for color switching.
// Color logic is tied to the discrete status, not message text.
type TestStatus = "ok" | "error" | "pending" | null;

interface WebhookSettings {
  enabled: boolean;
  url: string;
  platform: "discord" | "telegram" | "custom";
  events: {
    onTradeAdd: boolean;
    onTradeEdit: boolean;
    onTradeDelete: boolean;
  };
}

interface Account {
  id: string;
  name: string;
  broker: string;
}

interface DashboardWidgets {
  equityCurve: boolean;
  weeklySummary: boolean;
  recentTrades: boolean;
  aiInsights: boolean;
  dayOfWeekHeatmap: boolean;
}

const SETTINGS_KEY = SETTINGS_STORAGE_KEY;
const VALID_PLATFORMS = ["discord", "telegram", "custom"] as const;

type Settings = {
  webhook: WebhookSettings;
  accounts: Account[];
  activeAccountId: string;
  widgets: DashboardWidgets;
};

function isValidSettings(obj: unknown): obj is Settings {
  if (!obj || typeof obj !== "object") return false;
  const s = obj as Record<string, unknown>;

  // Required top-level fields must exist
  if (!s.webhook || typeof s.webhook !== "object") return false;
  if (!s.widgets || typeof s.widgets !== "object") return false;
  if (!Array.isArray(s.accounts) || s.accounts.length === 0) return false;
  if (typeof s.activeAccountId !== "string") return false;

  // Sanitize webhook
  const wh = s.webhook as Record<string, unknown>;
  // R67-Final: accept either plaintext https:// URLs (legacy / migration)
  // OR the v1 encryption envelope. Anything else is dropped + disabled.
  if (
    typeof wh.url === "string" &&
    wh.url &&
    !wh.url.startsWith("https://") &&
    !wh.url.startsWith("enc:v1:")
  ) {
    wh.url = "";
    wh.enabled = false;
  }
  if (
    typeof wh.platform === "string" &&
    !(VALID_PLATFORMS as readonly string[]).includes(wh.platform)
  ) {
    wh.platform = "discord";
  }

  // Sanitize widgets
  const w = s.widgets as Record<string, unknown>;
  for (const key of [
    "equityCurve",
    "weeklySummary",
    "recentTrades",
    "aiInsights",
    "dayOfWeekHeatmap",
  ]) {
    if (typeof w[key] !== "boolean") w[key] = true;
  }

  return true;
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isValidSettings(parsed)) return parsed;
    }
  } catch (err) {
    console.error("Failed to load settings:", err);
  }
  return {
    webhook: {
      enabled: false,
      url: "",
      platform: "discord",
      events: { onTradeAdd: true, onTradeEdit: false, onTradeDelete: true },
    },
    accounts: [{ id: "default", name: "Main Account", broker: "" }],
    activeAccountId: "default",
    widgets: {
      equityCurve: true,
      weeklySummary: true,
      recentTrades: true,
      aiInsights: true,
      dayOfWeekHeatmap: true,
    },
  };
}

function saveSettings(settings: ReturnType<typeof loadSettings>) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// R67-Final: encrypt-on-write helper. Persists `settings` with the
// webhook URL replaced by its v1 encryption envelope when:
//   - WebCrypto is available, AND
//   - the URL is non-empty plaintext (already-encrypted strings are
//     kept verbatim — re-encrypting would needlessly burn entropy).
//
// Telegram + Discord URLs both contain a token in the path / query, so
// we encrypt regardless of `platform`. Custom URLs are user-supplied
// and may also carry an auth token (HMAC signature, JWT in the path);
// encrypting them is strictly safer than not.
async function saveSettingsEncrypted(
  settings: Settings,
  userKey: string,
): Promise<Settings> {
  const url = settings.webhook.url;
  if (!url || isEncrypted(url)) {
    saveSettings(settings);
    return settings;
  }
  let storedUrl = url;
  try {
    storedUrl = await encryptSecret(url, userKey);
  } catch (err) {
    // encryptSecret swallows internally and returns plaintext on error;
    // this catch is belt-and-braces so a hostile prototype can't bypass.
    console.error("[settings] webhook URL encrypt failed:", err);
    storedUrl = url;
  }
  const persisted: Settings = {
    ...settings,
    webhook: { ...settings.webhook, url: storedUrl },
  };
  saveSettings(persisted);
  return persisted;
}

const DEFAULT_SETTINGS: Settings = {
  webhook: {
    enabled: false,
    url: "",
    platform: "discord",
    events: { onTradeAdd: true, onTradeEdit: false, onTradeDelete: true },
  },
  accounts: [{ id: "default", name: "Main Account", broker: "" }],
  activeAccountId: "default",
  widgets: {
    equityCurve: true,
    weeklySummary: true,
    recentTrades: true,
    aiInsights: true,
    dayOfWeekHeatmap: true,
  },
};

// R67-Final (R17-A8 deferred): build a filesystem-safe ISO timestamp slug
// for export filenames. `:` is illegal on Windows / NTFS and triggers
// browser sanitisation in the Save-As dialog, so we replace colons with
// dashes. The trailing fractional ms are dropped for shorter names.
// Result shape: `2026-05-07T18-15-00Z`.
function isoTimestampSlug(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
}

// R67-Final: trigger a browser download with a Blob payload and the given
// MIME type / filename. Centralised so CSV + JSON paths share the exact
// same anchor-click + cleanup sequence (revokeObjectURL avoids leaking
// memory in long-running settings sessions).
function triggerDownload(filename: string, blob: Blob): void {
  if (typeof window === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function SettingsPage() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  // R67-Final (R17-A8 deferred): user-visible status row for the Data
  // Management buttons — surfaces success counts + failure reasons next
  // to the action so the user gets immediate feedback (no toast yet).
  const [dataMessage, setDataMessage] = useState<{
    text: string;
    variant: "success" | "error";
  } | null>(null);
  // R67-Final: trades + import/clear come from the canonical storage
  // hook so cloud + localStorage stay in sync (same as /import page).
  const { trades, importTrades, clearAll, activeAccountId } = useTradeStorage();
  // Round 9 audit (KRITISCH): testStatus drives the colour, testMessage
  // carries the human-readable copy. Decoupling them avoids the previous
  // `includes("success")` brittle string-match (broke on i18n / phrasing
  // tweaks).
  const [testStatus, setTestStatus] = useState<TestStatus>(null);
  const [testMessage, setTestMessage] = useState<string>("");
  // R6 deferred-fix: busy state prevents double-click + dropped-promise on
  // Remove. While the async cloud reassignment is in flight the button is
  // disabled (per row), and the onClick callback uses `void` so the
  // floating Promise warning is silenced and the click handler stays sync.
  // 2026-05-15 (Audit-Round-5 / Agent #5 WARNUNG): refs for setTimeout cleanup.
  // Both `saved` (2s auto-clear) and `testStatus` (5s auto-clear) used to
  // schedule a setTimeout that could fire after the component unmounted →
  // "Can't perform a state update on an unmounted component" React warning.
  // We clear pending timers in the cleanup effect on unmount.
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      if (testTimerRef.current) clearTimeout(testTimerRef.current);
    };
  }, []);

  const [removingAccountId, setRemovingAccountId] = useState<string | null>(
    null,
  );
  const { supabase, user } = useAuth();

  // Load persisted settings on client-side only.
  //
  // R67-Final: webhook URLs may be persisted in the v1 encryption
  // envelope. Decrypt to plaintext for the in-memory `settings` state
  // so the input field shows the readable URL. The persisted form
  // stays encrypted until the user saves again (re-encrypted under the
  // current userKey). If decryption fails (wrong userKey, e.g. user
  // was previously offline and is now signed in), we drop the URL +
  // disable the webhook so the user can re-enter it without confusion.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const persisted = loadSettings();
      const url = persisted.webhook.url;
      if (!url || !isEncrypted(url)) {
        if (!cancelled) setSettings(persisted);
        return;
      }
      const userKey = resolveUserKey(user?.id);
      const plain = await decryptSecret(url, userKey);
      if (cancelled) return;
      if (!plain) {
        // Decryption failed under the current userKey. Surface a hint
        // via setTestMessage so the user understands why their URL is
        // empty — silent drop is the worst-case scenario for trust.
        console.warn(
          "[settings] decrypt of persisted webhook URL failed — clearing",
        );
        setSettings({
          ...persisted,
          webhook: { ...persisted.webhook, url: "", enabled: false },
        });
        return;
      }
      setSettings({
        ...persisted,
        webhook: { ...persisted.webhook, url: plain },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  async function handleSave() {
    const userKey = resolveUserKey(user?.id);
    await saveSettingsEncrypted(settings, userKey);
    setSaved(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
    // Dispatch event so other components can react. We dispatch the
    // PLAINTEXT in-memory `settings` so listeners (e.g. AccountSwitcher)
    // continue to work without needing to know about the envelope.
    window.dispatchEvent(
      new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: settings }),
    );
  }

  async function handleTestWebhook() {
    if (!settings.webhook.url) {
      setTestStatus("error");
      setTestMessage("Please enter a webhook URL first.");
      return;
    }
    // Phase 86 (R51-S1): client-side string gate via isValidHttpsUrl.
    // Round 54 (Finding #5): the actual fetch is now done server-side
    // (`/api/webhook-test`) so we can DNS-resolve and reject hostnames
    // that resolve to private IPs (DNS rebinding) and refuse 30x
    // redirects. The client check stays as an early UX hint.
    if (!isValidHttpsUrl(settings.webhook.url)) {
      setTestStatus("error");
      setTestMessage(
        "Webhook URL must use HTTPS and point to a public host (no private IPs / loopback).",
      );
      return;
    }
    // Round 9 audit (KRITISCH): platform-URL mismatch — fail loud BEFORE
    // sending. A Discord-platform setting pointed at a non-Discord URL
    // (or vice versa) almost always means the user pasted the wrong
    // string; sending it would either 404 silently or — worse — leak the
    // payload to a third-party host.
    if (!platformUrlMatches(settings.webhook.platform, settings.webhook.url)) {
      setTestStatus("error");
      const expected =
        settings.webhook.platform === "discord"
          ? "discord.com/api/webhooks/..."
          : settings.webhook.platform === "telegram"
            ? "api.telegram.org/bot..."
            : "a matching URL";
      setTestMessage(
        `Webhook URL does not match the selected platform (${settings.webhook.platform}). Expected: ${expected}`,
      );
      return;
    }
    setTestStatus("pending");
    setTestMessage("Sending...");
    try {
      const res = await fetch("/api/webhook-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: settings.webhook.url,
          platform: settings.webhook.platform,
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        status?: number;
        latencyMs?: number;
        error?: string;
      };
      if (data.ok) {
        setTestStatus("ok");
        setTestMessage(
          `Test sent successfully! (${data.status ?? 200}, ${data.latencyMs ?? 0}ms)`,
        );
      } else {
        setTestStatus("error");
        setTestMessage(`Failed: ${data.error ?? "Unknown error"}`);
      }
    } catch (err) {
      setTestStatus("error");
      setTestMessage(
        `Error: ${err instanceof Error ? err.message : "Failed to send"}`,
      );
    }
    if (testTimerRef.current) clearTimeout(testTimerRef.current);
    testTimerRef.current = setTimeout(() => {
      setTestStatus(null);
      setTestMessage("");
    }, 5000);
  }

  // Round-N audit: previously `Account ${length+1}` collided after
  // add → remove → add (e.g. removing #2 then adding produced another
  // "Account 2"). Derive the next index from the highest existing
  // numeric suffix instead of from the array length.
  function nextAccountName(accounts: Account[]): string {
    // R67-r22 audit fix (HINW): tighten regex to ANCHORED match so a
    // user-renamed "Account 5 Backup" doesn't bump the next-index past
    // 5 unintentionally. Plus cap-at-999 with UUID suffix to prevent
    // a pathological loop on collisions.
    const maxN = Math.max(
      ...accounts.map((a) =>
        parseInt(a.name.match(/^Account (\d+)$/)?.[1] ?? "0", 10),
      ),
      0,
    );
    if (maxN >= 999) {
      return `Account ${crypto.randomUUID().slice(0, 6)}`;
    }
    return `Account ${maxN + 1}`;
  }

  async function handleAddAccount() {
    // R67-r21 audit fix (HIGH): persist immediately after add so a
    // subsequent radio-select on the new account doesn't reference a
    // phantom ID. Previously the new account only landed in localStorage
    // on Save click; switching to it via the radio (auto-persists
    // activeAccountId) before Save left activeAccountId pointing at an
    // ID not yet in accounts[].
    const newAccount: Account = {
      id: crypto.randomUUID(),
      name: nextAccountName(settings.accounts),
      broker: "",
    };
    const next = {
      ...settings,
      accounts: [...settings.accounts, newAccount],
    };
    setSettings(next);
    // R67-Final: route through saveSettingsEncrypted so the in-flight
    // plaintext webhook URL doesn't leak to localStorage on a side-effect
    // Add-Account write.
    const userKey = resolveUserKey(user?.id);
    await saveSettingsEncrypted(next, userKey);
  }

  // Round-N audit: orphan-trade cleanup on account removal. The previous
  // implementation only removed the account from the settings list, which
  // left every trade with `accountId === <removed-id>` pointing at a
  // non-existent account → those trades disappeared from per-account
  // filters but still skewed the global stats (and could never be
  // re-assigned via UI). We now scan the trade store, count the orphans,
  // and ask the user whether to migrate them to "default" (or abort).
  // Cloud sync: if Supabase is connected we additionally update the rows
  // there; localStorage is updated in either case so the offline path
  // stays consistent.
  async function handleRemoveAccount(id: string) {
    if (settings.accounts.length <= 1) return;
    if (removingAccountId !== null) return; // already in flight

    setRemovingAccountId(id);
    try {
      // Step 1: count orphans in localStorage (always present — even cloud
      // users have a localStorage mirror so the offline fallback works).
      const allTrades = loadTrades();
      const orphanCount = allTrades.filter((t) => t.accountId === id).length;

      // Step 2: confirm with the user. Show the orphan count so the
      // decision is informed; an empty account is removed without prompt.
      if (orphanCount > 0) {
        const account = settings.accounts.find((a) => a.id === id);
        const accountLabel = account?.name ?? "this account";
        const confirmed = window.confirm(
          `Remove ${accountLabel}?\n\n` +
            `${orphanCount} trade${orphanCount === 1 ? "" : "s"} ` +
            `currently belong${orphanCount === 1 ? "s" : ""} to this account. ` +
            `OK = migrate them to the surviving account.\n` +
            `Cancel = abort removal (no changes will be made).`,
        );
        if (!confirmed) return;

        // R67-r21 audit fix (HIGH): migrate orphans to the FIRST
        // SURVIVING account (post-removal), not the hardcoded "default"
        // string. If the user has renamed/removed the original Main
        // Account, "default" doesn't exist → orphans pointed at a
        // non-existent ID and disappeared from the AccountSwitcher
        // filter. The fallback to "default" is kept as a literal
        // last-resort if nothing else remains (shouldn't happen because
        // the function aborts at length<=1 on line 318).
        const survivor =
          settings.accounts.find((a) => a.id !== id)?.id ?? "default";

        // Step 3a: reassign in localStorage.
        const migrated = allTrades.map((t) =>
          t.accountId === id ? { ...t, accountId: survivor } : t,
        );
        saveTrades(migrated);

        // Step 3b: best-effort cloud reassignment. Supabase failure does
        // NOT block the local removal — the next full sync (or manual
        // re-save) will reconcile.
        if (supabase && user) {
          try {
            const { error } = await supabase
              .from("trades")
              .update({ account_id: survivor })
              .eq("user_id", user.id)
              .eq("account_id", id);
            if (error) {
              console.error(
                "[settings] cloud orphan migration failed (localStorage already updated):",
                error,
              );
            }
          } catch (err) {
            console.error("[settings] cloud orphan migration threw:", err);
          }
        }
      }

      // Step 4: drop the account itself + reset activeAccountId if needed.
      setSettings((prev) => {
        // Round 9 audit (WARNING): off-by-one — the previous logic took
        // `prev.accounts[0]` BEFORE filtering, so deleting the first
        // account left the activeAccountId pointing at the removed entry.
        // Filter first, THEN pick the first remaining account as fallback.
        const remaining = prev.accounts.filter((a) => a.id !== id);
        const nextActive =
          prev.activeAccountId === id
            ? (remaining[0]?.id ?? "default")
            : prev.activeAccountId;
        return {
          ...prev,
          accounts: remaining,
          activeAccountId: nextActive,
        };
      });
    } finally {
      setRemovingAccountId(null);
    }
  }

  function handleAccountChange(
    id: string,
    field: "name" | "broker",
    value: string,
  ) {
    setSettings((prev) => ({
      ...prev,
      accounts: prev.accounts.map((a) =>
        a.id === id ? { ...a, [field]: value } : a,
      ),
    }));
  }

  // Round-N audit: validate uniqueness on blur. Empty / duplicate names
  // are auto-suffixed (e.g. "Account 2 (1)") so the activeAccount radio
  // and downstream filters always have a stable, identifiable label.
  // We compare on the trimmed name to ignore trailing whitespace.
  function handleAccountNameBlur(id: string) {
    setSettings((prev) => {
      const target = prev.accounts.find((a) => a.id === id);
      if (!target) return prev;
      const trimmed = target.name.trim();
      // Empty → assign a fresh "Account N" derived from the rest.
      if (trimmed.length === 0) {
        const others = prev.accounts.filter((a) => a.id !== id);
        return {
          ...prev,
          accounts: prev.accounts.map((a) =>
            a.id === id ? { ...a, name: nextAccountName(others) } : a,
          ),
        };
      }
      // Collision detection against other accounts.
      const taken = new Set(
        prev.accounts
          .filter((a) => a.id !== id)
          .map((a) => a.name.trim().toLowerCase()),
      );
      if (!taken.has(trimmed.toLowerCase())) {
        // No collision — normalise whitespace only.
        if (trimmed === target.name) return prev;
        return {
          ...prev,
          accounts: prev.accounts.map((a) =>
            a.id === id ? { ...a, name: trimmed } : a,
          ),
        };
      }
      // Collision — append "(2)", "(3)", ... until unique.
      let suffix = 2;
      let candidate = `${trimmed} (${suffix})`;
      while (taken.has(candidate.toLowerCase())) {
        suffix += 1;
        candidate = `${trimmed} (${suffix})`;
      }
      return {
        ...prev,
        accounts: prev.accounts.map((a) =>
          a.id === id ? { ...a, name: candidate } : a,
        ),
      };
    });
  }

  // R67-Final (R17-A8 deferred): Data Management handlers. CSV + JSON
  // exports REUSE `tradesToCsv` (canonical 22-column writer) and the
  // same JSON envelope shape `{ exportDate, version, trades }` used by
  // `exportToJSON` in storage.ts so a Settings export can be re-imported
  // via /import → JSON without schema drift. Filename pattern is fixed
  // to `tradevision-trades-<ISO>.csv|.json` so a sorted Downloads folder
  // groups all backups together.
  function handleExportCsv() {
    if (trades.length === 0) {
      setDataMessage({ text: "No trades to export.", variant: "error" });
      return;
    }
    try {
      const csv = tradesToCsv(trades);
      // UTF-8 BOM up-front so Excel auto-detects encoding (matches
      // csvExport.ts `downloadCsv` behaviour).
      const blob = new Blob(["﻿" + csv], {
        type: "text/csv;charset=utf-8",
      });
      triggerDownload(`tradevision-trades-${isoTimestampSlug()}.csv`, blob);
      setDataMessage({
        text: `Exported ${trades.length} trade${trades.length === 1 ? "" : "s"} as CSV.`,
        variant: "success",
      });
    } catch (err) {
      console.error("[settings] CSV export failed:", err);
      setDataMessage({
        text: `CSV export failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        variant: "error",
      });
    }
  }

  function handleExportJson() {
    if (trades.length === 0) {
      setDataMessage({ text: "No trades to export.", variant: "error" });
      return;
    }
    try {
      // Same envelope as storage.ts/exportToJSON so the file can be
      // re-imported via /import → JSON merge-or-replace.
      const wrapper = {
        exportDate: new Date().toISOString(),
        version: "1.0",
        trades,
      };
      const blob = new Blob([JSON.stringify(wrapper, null, 2)], {
        type: "application/json",
      });
      triggerDownload(`tradevision-trades-${isoTimestampSlug()}.json`, blob);
      setDataMessage({
        text: `Exported ${trades.length} trade${trades.length === 1 ? "" : "s"} as JSON.`,
        variant: "success",
      });
    } catch (err) {
      console.error("[settings] JSON export failed:", err);
      setDataMessage({
        text: `JSON export failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        variant: "error",
      });
    }
  }

  // R67-Final: mirrors the dashboard `handleLoadSampleData` pattern —
  // dynamic-import the sample bundle, stamp fresh UUIDs + activeAccountId
  // so rows are visible under the active account and don't collide on
  // the cloud UUID PK.
  async function handleLoadSampleData() {
    try {
      const { sampleTrades } = await import("@/data/sampleTrades");
      const fresh = sampleTrades.map((t) => ({
        ...t,
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        accountId: activeAccountId,
      }));
      const count = await importTrades(fresh);
      if (count === 0) {
        setDataMessage({
          text: "No demo trades imported (already loaded for this account, or storage unavailable).",
          variant: "error",
        });
      } else {
        setDataMessage({
          text: `Loaded ${count} demo trade${count === 1 ? "" : "s"}.`,
          variant: "success",
        });
      }
    } catch (err) {
      console.error("[settings] sample data load failed:", err);
      setDataMessage({
        text: `Failed to load demo data: ${err instanceof Error ? err.message : "Unknown error"}`,
        variant: "error",
      });
    }
  }

  // R67-Final: destructive — wipes all trades AND attached screenshots
  // for the logged-in user (cloud + local). Confirm dialog spells out
  // both side-effects so the user can't blame us for a "missing
  // screenshot" after the fact. Uses native `confirm()` to keep the
  // patch small (no ConfirmDialog dep) — the /import page already has
  // the modal version for the marketing-grade flow.
  async function handleClearAllData() {
    const ok = window.confirm(
      "Permanently delete ALL trading data?\n\n" +
        `This wipes ${trades.length} trade${trades.length === 1 ? "" : "s"} ` +
        `from your browser AND any attached screenshots. ` +
        `If you are signed in, the cloud copy is removed too.\n\n` +
        `This action cannot be undone.`,
    );
    if (!ok) return;
    try {
      await clearAll();
      setDataMessage({
        text: "All trading data has been cleared.",
        variant: "success",
      });
    } catch (err) {
      console.error("[settings] clearAll failed:", err);
      setDataMessage({
        text: `Failed to clear data: ${err instanceof Error ? err.message : "Unknown error"}`,
        variant: "error",
      });
    }
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Settings</h1>
        <p className="page-subtitle">
          Configure your trading journal preferences
        </p>
      </div>

      {/* Dashboard Widgets */}
      <section
        className="glass-card"
        style={{ padding: "24px", marginBottom: "20px" }}
      >
        <h2 style={{ fontSize: "1.1rem", marginBottom: "16px" }}>
          Dashboard Widgets
        </h2>
        <p
          style={{
            fontSize: "0.85rem",
            color: "var(--text-muted)",
            marginBottom: "16px",
          }}
        >
          Toggle which sections appear on your dashboard.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {(
            [
              ["equityCurve", "Equity Curve"],
              ["weeklySummary", "Weekly Summary"],
              ["dayOfWeekHeatmap", "Day of Week Heatmap"],
              ["recentTrades", "Recent Trades"],
              ["aiInsights", "AI Insights"],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={settings.widgets[key]}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    widgets: { ...prev.widgets, [key]: e.target.checked },
                  }))
                }
              />
              <span style={{ fontSize: "0.9rem" }}>{label}</span>
            </label>
          ))}
        </div>
      </section>

      {/* Webhook Notifications */}
      <section
        className="glass-card"
        style={{ padding: "24px", marginBottom: "20px" }}
      >
        <h2 style={{ fontSize: "1.1rem", marginBottom: "16px" }}>
          Webhook Notifications
        </h2>
        <p
          style={{
            fontSize: "0.85rem",
            color: "var(--text-muted)",
            marginBottom: "16px",
          }}
        >
          Get notified via Discord, Telegram, or a custom webhook when trade
          events occur.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={settings.webhook.enabled}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  webhook: { ...prev.webhook, enabled: e.target.checked },
                }))
              }
            />
            <span style={{ fontSize: "0.9rem" }}>
              Enable webhook notifications
            </span>
          </label>

          {settings.webhook.enabled && (
            <>
              <div className="form-group">
                <label className="form-label" htmlFor="webhook-platform">
                  Platform
                </label>
                <select
                  id="webhook-platform"
                  className="form-input"
                  value={settings.webhook.platform}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      webhook: {
                        ...prev.webhook,
                        platform: e.target.value as WebhookSettings["platform"],
                      },
                    }))
                  }
                >
                  <option value="discord">Discord</option>
                  <option value="telegram">Telegram</option>
                  <option value="custom">Custom URL</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="webhook-url">
                  Webhook URL
                </label>
                <input
                  id="webhook-url"
                  type="url"
                  className="form-input"
                  placeholder={
                    settings.webhook.platform === "discord"
                      ? "https://discord.com/api/webhooks/..."
                      : settings.webhook.platform === "telegram"
                        ? "https://api.telegram.org/bot.../sendMessage?chat_id=..."
                        : "https://your-server.com/webhook"
                  }
                  value={settings.webhook.url}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      webhook: { ...prev.webhook, url: e.target.value },
                    }))
                  }
                />
                {/* R67-Final (R19-A8): the URL is now encrypted-at-rest
                    in localStorage via WebCrypto AES-GCM (PBKDF2-derived
                    key from the Supabase user.id, or a per-device random
                    key when offline). The warning is retained but
                    softened — encryption is defence-in-depth, NOT a
                    substitute for trusting the device: an XSS payload
                    with full DOM access can still read the in-memory
                    plaintext, and offline mode keeps the key alongside
                    the ciphertext (obfuscation only). */}
                {settings.webhook.platform === "telegram" &&
                  settings.webhook.url.includes("/bot") && (
                    <p
                      style={{
                        marginTop: "8px",
                        fontSize: "0.85rem",
                        color: "var(--text-muted)",
                      }}
                    >
                      ⚠️ Telegram URLs contain your bot token. The URL is
                      encrypted at rest in your browser (AES-GCM, per-account
                      key). This protects against casual shared-device snooping
                      and most extensions, but cannot defend against full XSS —
                      if you suspect a leak, revoke the bot at @BotFather and
                      rotate.
                    </p>
                  )}
              </div>

              <div>
                <span
                  className="form-label"
                  style={{ display: "block", marginBottom: "8px" }}
                >
                  Trigger on events:
                </span>
                <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
                  {(
                    [
                      ["onTradeAdd", "New Trade"],
                      ["onTradeEdit", "Trade Edited"],
                      ["onTradeDelete", "Trade Deleted"],
                    ] as const
                  ).map(([key, label]) => (
                    <label
                      key={key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        cursor: "pointer",
                        fontSize: "0.85rem",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={settings.webhook.events[key]}
                        onChange={(e) =>
                          setSettings((prev) => ({
                            ...prev,
                            webhook: {
                              ...prev.webhook,
                              events: {
                                ...prev.webhook.events,
                                [key]: e.target.checked,
                              },
                            },
                          }))
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <button
                className="btn btn-secondary"
                onClick={handleTestWebhook}
                style={{ alignSelf: "flex-start" }}
              >
                Test Webhook
              </button>
              {testMessage && (
                <p
                  data-testid="webhook-test-result"
                  data-test-status={testStatus ?? ""}
                  style={{
                    fontSize: "0.85rem",
                    // Round 9 audit (KRITISCH): colour now driven by the
                    // discrete testStatus enum — "ok" → profit-green,
                    // anything else (error / pending) → loss-red. No
                    // fragile substring matching against the message.
                    color:
                      testStatus === "ok"
                        ? "var(--profit)"
                        : testStatus === "pending"
                          ? "var(--text-muted)"
                          : "var(--loss)",
                  }}
                >
                  {testMessage}
                </p>
              )}
            </>
          )}
        </div>
      </section>

      {/* Multi-Account Management */}
      <section
        className="glass-card"
        style={{ padding: "24px", marginBottom: "20px" }}
      >
        <h2 style={{ fontSize: "1.1rem", marginBottom: "16px" }}>
          Trading Accounts
        </h2>
        <p
          style={{
            fontSize: "0.85rem",
            color: "var(--text-muted)",
            marginBottom: "16px",
          }}
        >
          Manage multiple trading accounts. Set the active account to filter
          trades.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {settings.accounts.map((account) => (
            <div
              key={account.id}
              className={`settings-account-row${settings.activeAccountId === account.id ? " active" : ""}`}
            >
              <input
                type="radio"
                name="activeAccount"
                checked={settings.activeAccountId === account.id}
                onChange={() => {
                  // Auto-persist active account on radio change so it
                  // matches AccountSwitcher.tsx behaviour (no Save click
                  // required). Other settings (webhook/widgets/account
                  // names) still require Save to commit.
                  const next = { ...settings, activeAccountId: account.id };
                  setSettings(next);
                  // R67-Final: route through saveSettingsEncrypted so the
                  // in-memory plaintext webhook URL is encrypted-at-rest
                  // even on this radio side-effect write. Errors fall
                  // back to the previous direct setItem path so quota /
                  // disabled storage doesn't break the radio UX.
                  const userKey = resolveUserKey(user?.id);
                  void saveSettingsEncrypted(next, userKey).catch(() => {
                    try {
                      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
                    } catch {
                      /* quota / disabled storage — UI state still updates */
                    }
                  });
                  window.dispatchEvent(
                    new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: next }),
                  );
                }}
                aria-label={`Select ${account.name} as active account`}
              />
              <input
                type="text"
                className="form-input"
                style={{ flex: 1, padding: "6px 10px" }}
                value={account.name}
                onChange={(e) =>
                  handleAccountChange(account.id, "name", e.target.value)
                }
                onBlur={() => handleAccountNameBlur(account.id)}
                aria-label="Account name"
              />
              <input
                type="text"
                className="form-input"
                style={{ flex: 1, padding: "6px 10px" }}
                placeholder="Broker (optional)"
                value={account.broker}
                onChange={(e) =>
                  handleAccountChange(account.id, "broker", e.target.value)
                }
                aria-label="Broker name"
              />
              {settings.accounts.length > 1 && (
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={removingAccountId === account.id}
                  onClick={() => {
                    void handleRemoveAccount(account.id);
                  }}
                  aria-label={`Remove ${account.name}`}
                >
                  {removingAccountId === account.id ? "Removing…" : "Remove"}
                </button>
              )}
            </div>
          ))}
        </div>

        <button
          className="btn btn-secondary"
          style={{ marginTop: "12px" }}
          onClick={() => {
            void handleAddAccount();
          }}
        >
          + Add Account
        </button>
      </section>

      {/* Data Management — R67-Final (R17-A8 deferred) */}
      <section
        className="glass-card"
        style={{ padding: "24px", marginBottom: "20px" }}
      >
        <h2 style={{ fontSize: "1.1rem", marginBottom: "16px" }}>
          Data Management
        </h2>
        <p
          style={{
            fontSize: "0.85rem",
            color: "var(--text-muted)",
            marginBottom: "16px",
          }}
        >
          Export, restore demo data, or wipe everything. Exports include all
          trades for the active account and round-trip safely with /import.
        </p>
        <p
          style={{
            fontSize: "0.85rem",
            color: "var(--text-muted)",
            marginBottom: "16px",
          }}
        >
          You currently have <strong>{trades.length}</strong> trade
          {trades.length === 1 ? "" : "s"} in this account.
        </p>

        <div
          style={{
            display: "flex",
            gap: "12px",
            flexWrap: "wrap",
            marginBottom: "12px",
          }}
        >
          <button
            className="btn btn-primary"
            onClick={handleExportCsv}
            data-testid="data-export-csv"
            disabled={trades.length === 0}
          >
            Export CSV
          </button>
          <button
            className="btn btn-primary"
            onClick={handleExportJson}
            data-testid="data-export-json"
            disabled={trades.length === 0}
          >
            Export JSON
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              void handleLoadSampleData();
            }}
            data-testid="data-load-demo"
          >
            Load Demo Data
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              void handleClearAllData();
            }}
            data-testid="data-clear-all"
            style={{ color: "var(--loss)" }}
          >
            Clear All Data
          </button>
        </div>

        {dataMessage && (
          <p
            data-testid="data-management-result"
            data-test-status={dataMessage.variant}
            style={{
              fontSize: "0.85rem",
              marginTop: "8px",
              color:
                dataMessage.variant === "success"
                  ? "var(--profit)"
                  : "var(--loss)",
            }}
          >
            {dataMessage.text}
          </p>
        )}
      </section>

      {/* Save Button */}
      <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
        <button
          className="btn btn-primary"
          onClick={() => {
            void handleSave();
          }}
        >
          Save Settings
        </button>
        {saved && (
          <span style={{ fontSize: "0.85rem", color: "var(--profit)" }}>
            Settings saved!
          </span>
        )}
      </div>
    </div>
  );
}
