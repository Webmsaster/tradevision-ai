'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { User, SupabaseClient } from '@supabase/supabase-js';
import { createClient } from './supabase';

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
    if (supabase) {
      await supabase.auth.signOut();
    }
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
