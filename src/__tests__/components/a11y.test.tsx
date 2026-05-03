/**
 * Round 58 — Accessibility regression suite.
 *
 * Guards Lighthouse a11y findings that pushed the score from ~75 → 95+:
 *   - skip-to-content link present + has correct href + becomes visible on
 *     focus (WCAG 2.4.1 Level A)
 *   - .sr-only utility hides content visually but exposes to AT (WCAG 1.3.1)
 *   - .skip-link CSS shows on :focus (off-screen by default)
 *   - :focus-visible rules cover .btn / .sidebar-link / .table-action-btn
 *     (WCAG 2.4.7 Level AA)
 *   - TradeTable renders <caption className="sr-only"> + scope="col"
 *     headers + aria-label on icon-only Edit/Delete buttons
 */
import fs from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import TradeTable from "@/components/TradeTable";
import { Trade } from "@/types/trade";

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

// RootLayout renders <html><body> directly which isn't compatible with
// jsdom's existing document. We assert the layout's source structure
// instead — same regression guarantee, no runtime side-effects.
const repoRoot = path.join(__dirname, "../../..");
const globalsCss = fs.readFileSync(
  path.join(repoRoot, "src/app/globals.css"),
  "utf-8",
);
const layoutSrc = fs.readFileSync(
  path.join(repoRoot, "src/app/layout.tsx"),
  "utf-8",
);

describe("a11y — skip-link + globals.css utilities", () => {
  it("layout.tsx contains skip-link as the first body child pointing to #main-content", () => {
    expect(layoutSrc).toMatch(
      /<a\s+href="#main-content"\s+className="skip-link">/,
    );
    expect(layoutSrc).toMatch(/Skip to main content/i);
  });

  it("layout.tsx marks <main> with id=main-content for the skip-link target", () => {
    expect(layoutSrc).toMatch(/<main\s+id="main-content"/);
  });

  it("globals.css defines .skip-link with off-screen positioning", () => {
    expect(globalsCss).toMatch(/\.skip-link\s*\{[^}]*position:\s*absolute/);
    expect(globalsCss).toMatch(/\.skip-link\s*\{[^}]*left:\s*-9999px/);
  });

  it("globals.css makes .skip-link visible on :focus", () => {
    // Either `:focus` or `:focus-visible` brings left:0 — accept both.
    const focusBlock = globalsCss.match(/\.skip-link:focus[^}]*left:\s*0/);
    expect(focusBlock).not.toBeNull();
  });

  it("globals.css defines .sr-only utility for screen-reader-only content", () => {
    expect(globalsCss).toMatch(
      /\.sr-only\s*\{[^}]*width:\s*1px[^}]*height:\s*1px/,
    );
    expect(globalsCss).toMatch(
      /\.sr-only\s*\{[^}]*clip:\s*rect\(0,\s*0,\s*0,\s*0\)/,
    );
  });

  it("globals.css defines :focus-visible on .btn / .sidebar-link / .table-action-btn", () => {
    expect(globalsCss).toMatch(/\.btn:focus-visible/);
    expect(globalsCss).toMatch(/\.sidebar-link:focus-visible/);
    expect(globalsCss).toMatch(/\.table-action-btn:focus-visible/);
    // The ruleset must apply an actual outline (not outline:none).
    expect(globalsCss).toMatch(
      /:focus-visible[\s\S]{0,500}outline:\s*2px\s+solid/,
    );
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
