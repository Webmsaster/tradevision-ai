"use client";
/**
 * Phase 68 (R45-UI-M1): single MutationObserver-backed hook for the
 * profit/loss CSS-variable colors.
 *
 * The dashboard mounts 3+ chart components simultaneously (EquityCurve,
 * PerformanceChart, etc.). Each one used to register its own
 * MutationObserver on document.documentElement listening for `data-theme`
 * changes — 3+ observers all firing on every theme toggle.
 *
 * This hook reads + tracks the same CSS variables once per render-tree;
 * consumers subscribe to a single shared observer via React state.
 */
import { useEffect, useState } from "react";

export interface ThemeColors {
  green: string;
  red: string;
}

const DEFAULT_COLORS: ThemeColors = { green: "#00ff88", red: "#ff4757" };

function readColors(): ThemeColors {
  if (typeof window === "undefined") return DEFAULT_COLORS;
  const style = getComputedStyle(document.documentElement);
  const green =
    style.getPropertyValue("--profit").trim() || DEFAULT_COLORS.green;
  const red = style.getPropertyValue("--loss").trim() || DEFAULT_COLORS.red;
  return { green, red };
}

// Module-level shared subscriber set so all consumers share ONE observer.
const subscribers = new Set<(c: ThemeColors) => void>();
let observer: MutationObserver | null = null;

function ensureObserver() {
  if (observer || typeof window === "undefined") return;
  observer = new MutationObserver(() => {
    const next = readColors();
    for (const fn of subscribers) fn(next);
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

export function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(DEFAULT_COLORS);

  useEffect(() => {
    setColors(readColors());
    ensureObserver();
    subscribers.add(setColors);
    return () => {
      subscribers.delete(setColors);
      // Tear down observer when no consumers remain — avoids leaking
      // it across HMR reloads in dev.
      if (subscribers.size === 0 && observer) {
        observer.disconnect();
        observer = null;
      }
    };
  }, []);

  return colors;
}
