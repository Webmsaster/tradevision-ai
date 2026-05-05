"use client";
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  ReactNode,
} from "react";

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
    const saved = localStorage.getItem("tradevision-theme");
    if (saved === "dark" || saved === "light") return saved;
    if (window.matchMedia?.("(prefers-color-scheme: light)").matches)
      return "light";
  } catch {
    // ignore — Privacy-Mode/Safari-ITP may throw on localStorage access
  }
  return "dark";
}

export default function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    try {
      document.documentElement.setAttribute("data-theme", theme);
      localStorage.setItem("tradevision-theme", theme);
    } catch {
      // ignore — Privacy-Mode/Safari-ITP/quota
    }
  }, [theme]);

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
