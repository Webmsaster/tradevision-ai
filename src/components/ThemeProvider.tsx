"use client";
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useRef,
  ReactNode,
} from "react";
import { useAuth } from "@/lib/auth-context";

type Theme = "dark" | "light";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: "dark",
  toggleTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

// R5/R6 deferred-fix: extracted so the logout-reset effect can use the
// SAME default-resolution path as initial mount. Reads the system / saved
// preference but ignores the live DOM attribute (which still holds the
// previous user's theme at the moment we want to clear it).
function readSystemPreference(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const saved = localStorage.getItem("tradevision-theme");
    if (saved === "dark" || saved === "light") return saved;
    if (window.matchMedia?.("(prefers-color-scheme: light)").matches)
      return "light";
  } catch {
    // ignore — Privacy-Mode/Safari-ITP may throw on localStorage access
  }
  return "dark";
}

// Round 60 audit: read initial theme synchronously from the DOM attribute
// set by the inline script in `layout.tsx` (head). That script runs BEFORE
// first paint to prevent dark→light FOUC for light-theme users. If the
// inline script failed (sandboxed iframe, CSP-stripped), fall back to
// localStorage / prefers-color-scheme.
function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const fromDom = document.documentElement.getAttribute("data-theme");
    if (fromDom === "dark" || fromDom === "light") return fromDom;
  } catch {
    // ignore
  }
  return readSystemPreference();
}

export default function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const { user } = useAuth();
  const prevUserRef = useRef<string | null>(user?.id ?? null);

  useEffect(() => {
    try {
      document.documentElement.setAttribute("data-theme", theme);
      localStorage.setItem("tradevision-theme", theme);
    } catch {
      // ignore — Privacy-Mode/Safari-ITP/quota
    }
  }, [theme]);

  // R5/R6 deferred-fix: theme leaked across logout because the React state
  // outlived the auth session. Detect the logged-in → logged-out edge and
  // reset to the default (system preference) so the next user sees a clean
  // slate instead of the previous user's dark/light choice.
  // R67-r8 audit fix: readSystemPreference reads localStorage which still
  // holds the prev user's theme (R6's signOut clears it but theme-persist
  // effect ran AFTER, re-writing it). Clear localStorage FIRST, then read
  // pure system preference (matchMedia only).
  useEffect(() => {
    const currId = user?.id ?? null;
    if (prevUserRef.current && !currId) {
      // logout transition
      try {
        localStorage.removeItem("tradevision-theme");
      } catch {
        /* ignore — Safari-ITP/quota */
      }
      const sysLight =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-color-scheme: light)").matches;
      setTheme(sysLight ? "light" : "dark");
    }
    prevUserRef.current = currId;
  }, [user]);

  // useMemo prevents re-render storms on every parent render: without this,
  // every consumer of useTheme() would re-render whenever ThemeProvider
  // itself re-rendered, even if `theme` was unchanged.
  const value = useMemo(
    () => ({
      theme,
      toggleTheme: () =>
        setTheme((prev) => (prev === "dark" ? "light" : "dark")),
    }),
    [theme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
