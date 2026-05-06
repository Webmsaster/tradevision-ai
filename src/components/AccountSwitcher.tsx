"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SETTINGS_CHANGED_EVENT, SETTINGS_KEY } from "@/lib/constants";

interface Account {
  id: string;
  name: string;
  broker: string;
}

interface SettingsShape {
  accounts?: Account[];
  activeAccountId?: string;
  [key: string]: unknown;
}

function readSettings(): SettingsShape | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SettingsShape;
  } catch {
    return null;
  }
}

export default function AccountSwitcher() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeId, setActiveId] = useState<string>("default");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const loadFromStorage = useCallback(() => {
    const s = readSettings();
    if (!s?.accounts || s.accounts.length === 0) return;
    setAccounts(s.accounts);
    // Phase 78: length>0 guarded above.
    setActiveId(s.activeAccountId || s.accounts[0]!.id);
  }, []);

  useEffect(() => {
    loadFromStorage();
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.accounts) {
        setAccounts(detail.accounts);
      } else {
        // Fallback: third-party dispatchers may omit accounts in detail.
        loadFromStorage();
      }
      if (detail?.activeAccountId) setActiveId(detail.activeAccountId);
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, handler);
    window.addEventListener("storage", loadFromStorage);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, handler);
      window.removeEventListener("storage", loadFromStorage);
    };
  }, [loadFromStorage]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const handleSelect = useCallback((id: string) => {
    const s = readSettings();
    if (!s) return;
    const next = { ...s, activeAccountId: id };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      return;
    }
    setActiveId(id);
    setOpen(false);
    window.dispatchEvent(
      new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: next }),
    );
  }, []);

  if (accounts.length < 2) return null;

  // Phase 78: length >= 2 guarded above.
  const activeAccount = accounts.find((a) => a.id === activeId) || accounts[0]!;

  return (
    <div className="account-switcher" ref={rootRef}>
      <button
        className="account-switcher-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Switch active account"
      >
        <span className="account-switcher-label">Account</span>
        <span className="account-switcher-name">{activeAccount.name}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <ul className="account-switcher-menu" role="listbox">
          {accounts.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                role="option"
                aria-selected={a.id === activeId}
                className={`account-switcher-item${a.id === activeId ? " active" : ""}`}
                onClick={() => handleSelect(a.id)}
              >
                <span className="account-switcher-item-name">{a.name}</span>
                {a.broker && (
                  <span className="account-switcher-item-broker">
                    {a.broker}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
