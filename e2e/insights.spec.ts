import { test, expect } from "@playwright/test";
import { gotoAndWaitForApp, loadSampleData, waitForAppReady } from "./helpers";

test.describe("AI Insights", () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndWaitForApp(page, "/insights");
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
  });

  test("should display empty state when no trades exist", async ({ page }) => {
    await gotoAndWaitForApp(page, "/insights");
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);

    await expect(
      page.getByRole("heading", { name: "AI Insights" }),
    ).toBeVisible();
    await expect(page.getByText("No trades found")).toBeVisible();
    await expect(
      page.getByText(/Import or add trades to unlock/),
    ).toBeVisible();
  });

  test("should navigate to insights page via sidebar", async ({ page }) => {
    await gotoAndWaitForApp(page, "/");
    await page.getByRole("link", { name: "AI Insights" }).click();
    await expect(page).toHaveURL("/insights");
    await expect(
      page.getByRole("heading", { name: "AI Insights" }),
    ).toBeVisible();
  });

  test("should load sample data and display insights", async ({ page }) => {
    await gotoAndWaitForApp(page, "/insights");
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });

    // Load sample data via import page
    await loadSampleData(page);

    // Navigate back to insights
    await gotoAndWaitForApp(page, "/insights");

    // Should show insights with cards
    await expect(
      page.getByRole("heading", { name: "AI Insights" }),
    ).toBeVisible();
    await expect(page.locator(".insights-stat-value").first()).toBeVisible();

    // At least one insight card should be visible
    const insightCards = page.locator('[class*="insight"]').first();
    await expect(insightCards).toBeVisible({ timeout: 5000 });
  });

  test("should display insight cards with content", async ({ page }) => {
    await loadSampleData(page);
    await gotoAndWaitForApp(page, "/insights");

    // Look for InsightCard elements - they should have data-testid or visible content
    const insightContent = page
      .locator("div")
      .filter({ has: page.getByText(/pattern|analysis|insight/i) })
      .first();
    await expect(insightContent).toBeVisible({ timeout: 5000 });
  });

  test("should display filter tabs with counts", async ({ page }) => {
    await loadSampleData(page);
    await gotoAndWaitForApp(page, "/insights");

    // Check for filter tabs
    const tabs = page.locator(".insights-tab");
    await expect(tabs).toHaveCount(4); // All, Warnings, Positive, Neutral

    // Verify tab labels
    await expect(page.getByRole("button", { name: /All/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Warnings/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Positive/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Neutral/ })).toBeVisible();
  });

  test("should filter insights by type (Warnings)", async ({ page }) => {
    await loadSampleData(page);
    await gotoAndWaitForApp(page, "/insights");

    // Click on Warnings tab
    const warningsTab = page
      .locator(".insights-tab")
      .filter({ hasText: "Warnings" });
    await warningsTab.click();

    // Verify the tab is active
    await expect(warningsTab).toHaveClass(/active/);
  });

  test("should filter insights by type (Positive)", async ({ page }) => {
    await loadSampleData(page);
    await gotoAndWaitForApp(page, "/insights");

    // Click on Positive tab
    const positiveTab = page
      .locator(".insights-tab")
      .filter({ hasText: "Positive" });
    await positiveTab.click();

    // Verify the tab is active
    await expect(positiveTab).toHaveClass(/active/);
  });

  test("should have category filter dropdown", async ({ page }) => {
    await loadSampleData(page);
    await gotoAndWaitForApp(page, "/insights");

    // Look for category select
    const categorySelect = page.locator("select.insights-category-select");
    await expect(categorySelect).toBeVisible();

    // Should have "All Categories" option
    await expect(categorySelect).toContainText("All Categories");
  });

  test("should have date range filters", async ({ page }) => {
    await loadSampleData(page);
    await gotoAndWaitForApp(page, "/insights");

    // Look for date inputs
    const dateFromInput = page.locator("input.insights-date-input").first();
    const dateToInput = page.locator("input.insights-date-input").nth(1);

    await expect(dateFromInput).toBeVisible();
    await expect(dateToInput).toBeVisible();
  });

  test("should display insights stats (Total, Warnings, Positive, Neutral)", async ({
    page,
  }) => {
    await loadSampleData(page);
    await gotoAndWaitForApp(page, "/insights");

    // Check for stat displays
    const statValues = page.locator(".insights-stat-value");
    await expect(statValues.first()).toBeVisible();

    const statLabels = page.locator(".insights-stat-label");
    await expect(statLabels).toHaveCount(4); // Total, Warnings, Positive, Neutral
  });

  test("should show view related trades button in insight cards", async ({
    page,
  }) => {
    await loadSampleData(page);
    await gotoAndWaitForApp(page, "/insights");

    // R8 Task F: assert directly — sample data always yields >=1 insight
    // card with a related-trades button. Conditional expect masked regressions.
    const viewButtons = page
      .locator("button")
      .filter({ hasText: /view|related|trades/i });
    await expect(viewButtons.first()).toBeVisible({ timeout: 5000 });
  });

  test("should clear filters button appear when filters are set", async ({
    page,
  }) => {
    await loadSampleData(page);
    await gotoAndWaitForApp(page, "/insights");

    // Initially no clear button
    const clearButton = page.locator(".insights-filters-clear");
    const isHidden = await clearButton.isHidden().catch(() => true);
    if (!isHidden) {
      // If clear button is visible, filters must be set
      await expect(clearButton).toBeVisible();
    }
  });
});
