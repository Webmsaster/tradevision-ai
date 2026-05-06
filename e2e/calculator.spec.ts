import { test, expect } from "@playwright/test";
import { gotoAndWaitForApp } from "./helpers";

test.describe("Risk Calculator", () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndWaitForApp(page, "/calculator");
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Risk Calculator" }),
    ).toBeVisible();
  });

  test("should display the calculator page with form and results", async ({
    page,
  }) => {
    await expect(
      page.getByRole("heading", { name: "Risk Calculator" }),
    ).toBeVisible();
    await expect(page.getByText("Position Parameters")).toBeVisible();
    await expect(
      page.getByText("Position Size", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Max Loss", { exact: true })).toBeVisible();
  });

  test("should calculate position size when fields are filled", async ({
    page,
  }) => {
    await page.getByLabel("Entry Price ($)").fill("50000");
    await page.getByLabel("Stop Loss Price ($)").fill("49000");

    const maxLossCard = page.locator(
      '.stat-card:has(.stat-label:text("Max Loss"))',
    );
    await expect(maxLossCard.locator(".stat-value")).toContainText("100.00", {
      timeout: 5000,
    });

    const positionSizeCard = page.locator(
      '.stat-card:has(.stat-label:text("Position Size"))',
    );
    await expect(positionSizeCard.locator(".stat-value")).toContainText(/\d/);
  });

  test("should update results when take profit is added", async ({ page }) => {
    await page.getByLabel("Entry Price ($)").fill("50000");
    await page.getByLabel("Stop Loss Price ($)").fill("49000");
    await page.getByLabel(/Take Profit Price/).fill("52000");

    await expect(page.getByText(/1 : \d/)).toBeVisible({ timeout: 5000 });
  });

  test("should update risk amount when a preset is clicked", async ({
    page,
  }) => {
    await page.getByLabel("Entry Price ($)").fill("50000");
    await page.getByLabel("Stop Loss Price ($)").fill("49000");

    await page.getByRole("button", { name: "2%" }).click();

    const maxLossCard = page.locator(
      '.stat-card:has(.stat-label:text("Max Loss"))',
    );
    await expect(maxLossCard.locator(".stat-value")).toContainText("200.00", {
      timeout: 5000,
    });
  });
});
