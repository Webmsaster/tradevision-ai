"use client";

import { createContext, useContext, useEffect, useState } from "react";
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
      const client = await createClient();

      if (!mounted) return;
      setSupabase(client);

      if (!client) {
        setIsLoading(false);
        return;
      }

      // Get initial session
      const {
        data: { user: initialUser },
      } = await client.auth.getUser();

      if (!mounted) return;
      setUser(initialUser ?? null);
      setIsLoading(false);

      // Listen for auth changes
      const {
        data: { subscription },
      } = client.auth.onAuthStateChange((_event, session) => {
        setUser(session?.user ?? null);
      });
      unsubscribe = () => subscription.unsubscribe();
    }

    initAuth();

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  const signOut = async () => {
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
      } catch (e) {
        console.error("[auth] failed to clear storage on signOut:", e);
      }
    }
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, supabase, isLoading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
