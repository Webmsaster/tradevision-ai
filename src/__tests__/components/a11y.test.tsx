/**
 * Round 58 — Accessibility regression suite.
 *
 * Guards Lighthouse a11y findings that pushed the score from ~75 → 95+:
 *   - skip-to-content link is the first focusable element of <body>, has
 *     href="#main-content" and the correct WCAG label
 *   - <main> has id=main-content (skip-link target)
 *   - TradeTable renders <caption className="sr-only"> + scope="col"
 *     headers + aria-label on icon-only Edit/Delete buttons
 *
 * Round 59: layout.tsx checks were converted from source-text grep to
 * React-element-tree traversal so behavior is asserted, not literal source
 * code. CSS-rule grep tests for globals.css were removed — they only
 * verified that text strings existed, not that the rules took effect; that
 * coverage belongs in Lighthouse / Playwright e2e.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import TradeTable from "@/components/TradeTable";
import { Trade } from "@/types/trade";

// next/font/google is a build-time loader; in vitest we stub it so
// RootLayout can import safely. The font's `className` is never asserted.
vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "stub-inter-font" }),
}));

// Lazy import after mock so the mock is applied before module evaluation.
const { default: RootLayout } = await import("@/app/layout");

const sampleTrade: Trade = {
  id: "t1",
  pair: "BTC/USDT",
  direction: "long",
  entryPrice: 40000,
  exitPrice: 42000,
  quantity: 1,
  entryDate: "2026-01-01T10:00:00.000Z",
  exitDate: "2026-01-02T10:00:00.000Z",
  pnl: 2000,
  pnlPercent: 5,
  fees: 10,
  leverage: 2,
  notes: "",
  tags: [],
};

/**
 * RootLayout renders <html><body> directly which can't be mounted in jsdom
 * (it conflicts with the document already in memory). Calling RootLayout
 * as a function gives us the React element tree, which we traverse to
 * assert structural a11y invariants — same regression guard, no DOM mount.
 */
function findElement(
  node: React.ReactNode,
  predicate: (el: React.ReactElement) => boolean,
): React.ReactElement | null {
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  const props = node.props as { children?: React.ReactNode } | undefined;
  const children = props?.children;
  if (!children) return null;
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    const found = findElement(c, predicate);
    if (found) return found;
  }
  return null;
}

function findFirstBodyChild(node: React.ReactNode): React.ReactElement | null {
  const body = findElement(
    node,
    (el) => typeof el.type === "string" && el.type === "body",
  );
  if (!body) return null;
  const props = body.props as { children?: React.ReactNode } | undefined;
  const children = props?.children;
  const list = Array.isArray(children) ? children : children ? [children] : [];
  for (const c of list) {
    if (React.isValidElement(c)) return c;
  }
  return null;
}

// Round 60: RootLayout became async (awaits next/headers for CSP nonce).
// Mock headers() so the layout resolves synchronously enough to be awaited
// at top-level of the test module.
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k === "x-nonce" ? "test-nonce" : null),
  }),
}));

const tree = (await RootLayout({
  children: React.createElement("div"),
})) as React.ReactElement;

describe("a11y — RootLayout skip-link structure (WCAG 2.4.1)", () => {
  it("first body child is the skip-to-content link", () => {
    const first = findFirstBodyChild(tree);
    expect(first).not.toBeNull();
    expect(first?.type).toBe("a");
    const props = first?.props as
      | { href?: string; className?: string; children?: React.ReactNode }
      | undefined;
    expect(props?.href).toBe("#main-content");
    expect(props?.className).toContain("skip-link");
  });

  it("skip-link text describes the action for screen readers", () => {
    const first = findFirstBodyChild(tree);
    const props = first?.props as { children?: React.ReactNode } | undefined;
    const text = String(props?.children ?? "");
    expect(text.toLowerCase()).toContain("skip to main content");
  });

  it("<main> has id=main-content so the skip-link can target it", () => {
    const main = findElement(
      tree,
      (el) => typeof el.type === "string" && el.type === "main",
    );
    expect(main).not.toBeNull();
    const props = main?.props as { id?: string } | undefined;
    expect(props?.id).toBe("main-content");
  });
});

describe("a11y — TradeTable", () => {
  it("renders sr-only <caption> describing the table", () => {
    const { container } = render(<TradeTable trades={[sampleTrade]} />);
    const caption = container.querySelector("caption");
    expect(caption).not.toBeNull();
    expect(caption?.className).toContain("sr-only");
    expect(caption?.textContent).toMatch(/sortable/i);
  });

  it("all column headers have scope=col", () => {
    const { container } = render(<TradeTable trades={[sampleTrade]} />);
    const headers = Array.from(container.querySelectorAll("th"));
    expect(headers.length).toBeGreaterThan(0);
    for (const th of headers) {
      expect(th.getAttribute("scope")).toBe("col");
    }
  });

  it("Edit + Delete icon buttons expose aria-label with the trade pair", () => {
    render(
      <TradeTable
        trades={[sampleTrade]}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /edit trade BTC\/USDT/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /delete trade BTC\/USDT/i }),
    ).toBeInTheDocument();
  });
});
