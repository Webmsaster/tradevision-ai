import { test, expect } from "@playwright/test";
import { gotoAndWaitForApp } from "./helpers";

test.describe("Login Flow", () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndWaitForApp(page, "/login");
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
  });

  test('should show "Authentication not configured" when Supabase is missing', async ({
    page,
  }) => {
    await gotoAndWaitForApp(page, "/login");
    await expect(page.getByText("Authentication not configured")).toBeVisible();
  });

  test("should display setup instructions", async ({ page }) => {
    await gotoAndWaitForApp(page, "/login");
    await expect(page.getByText("Create a Supabase project")).toBeVisible();
    await expect(page.getByText(".env.local", { exact: true })).toBeVisible();
  });

  test('should navigate to dashboard via "Continue without account"', async ({
    page,
  }) => {
    await gotoAndWaitForApp(page, "/login");
    await page
      .getByRole("button", { name: "Continue without account" })
      .click();
    await expect(page).toHaveURL("/", { timeout: 10000 });
  });

  test("should allow normal navigation after continuing without account", async ({
    page,
  }) => {
    await gotoAndWaitForApp(page, "/login");
    await page
      .getByRole("button", { name: "Continue without account" })
      .click();
    await expect(page).toHaveURL("/", { timeout: 10000 });

    await page.getByRole("link", { name: "Trades", exact: true }).click();
    await expect(page).toHaveURL("/trades");
    await expect(
      page.getByRole("heading", { name: "Trade History" }),
    ).toBeVisible();
  });
});
