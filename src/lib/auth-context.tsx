"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { User, SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "./supabase";

interface AuthContextValue {
  user: User | null;
  supabase: SupabaseClient | null;
  isLoading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  supabase: null,
  isLoading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | null = null;

    async function initAuth() {
      // R6 lib-utils: any thrown error in createClient/getUser left
      // isLoading=true forever, blocking the UI on a permanent loading state.
      // try/catch + finally guarantees we always release the loading flag.
      try {
        const client = await createClient();

        if (!mounted) return;
        setSupabase(client);

        if (!client) {
          return;
        }

        // Get initial session
        const {
          data: { user: initialUser },
        } = await client.auth.getUser();

        if (!mounted) return;
        setUser(initialUser ?? null);

        // Listen for auth changes — R67 audit: respect mounted flag so an
        // in-flight auth event between mounted=false and unsubscribe() can
        // not setState on an unmounted provider (StrictMode / hot-reload).
        const {
          data: { subscription },
        } = client.auth.onAuthStateChange((_event, session) => {
          if (!mounted) return;
          setUser(session?.user ?? null);
        });
        unsubscribe = () => subscription.unsubscribe();
      } catch (err) {
        console.error("[auth] initAuth failed:", err);
      } finally {
        if (mounted) setIsLoading(false);
      }
    }

    initAuth();

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  const signOut = useCallback(async () => {
    // Phase 32 (Re-Audit Storage Bug 7): only clearAllData() AFTER
    // successful Supabase signOut. Previous behavior wiped local cache
    // even on auth failure (Network glitch / 500) → user lost their
    // trades for a transient outage they couldn't recover from.
    if (supabase) {
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.error(
          "[auth] signOut failed, NOT clearing local cache:",
          error,
        );
        return;
      }
    }
    if (typeof window !== "undefined") {
      try {
        const { clearAllData } = await import("@/utils/storage");
        clearAllData();
        // Round-N audit: theme is currently persisted under a global
        // localStorage key (`tradevision-theme`) and therefore leaks
        // across sign-outs — User-A's light-mode preference would
        // otherwise greet User-B at the next session start. Drop it
        // here so the next user falls back to the default (dark or
        // prefers-color-scheme). User-scoped keys would be cleaner but
        // are too invasive for the current scope.
        try {
          localStorage.removeItem("tradevision-theme");
        } catch {
          // ignore — Privacy-Mode/Safari-ITP/quota
        }
      } catch (e) {
        console.error("[auth] failed to clear storage on signOut:", e);
      }
    }
    setUser(null);
  }, [supabase]);

  // R-Perf: memoize the context value so consumers don't re-render
  // on every AuthProvider render (each call to {} creates a new identity).
  const value = useMemo(
    () => ({ user, supabase, isLoading, signOut }),
    [user, supabase, isLoading, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
