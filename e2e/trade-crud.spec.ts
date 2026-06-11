import { test, expect } from "@playwright/test";
import {
  gotoAndWaitForApp,
  waitForAppReady,
  createTestTrade,
  canonicalPair,
} from "./helpers";

test.describe("Trade CRUD", () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndWaitForApp(page, "/trades");
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);
    await expect(
      page.getByRole("heading", { name: "Trade History" }),
    ).toBeVisible();
  });

  test("should create a trade and show it in the table", async ({ page }) => {
    const pair = await createTestTrade(page, "SOL/USDT");
    await expect(page.getByText(pair)).toBeVisible();
  });

  test("should edit a trade", async ({ page }) => {
    const pair = await createTestTrade(page, "EDIT/USDT");
    await expect(page.getByText(pair)).toBeVisible();

    await page.locator('button[title="Edit trade"]').first().click();

    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();

    const pairInput = modal.getByPlaceholder("BTC/USDT");
    await pairInput.clear();
    await pairInput.fill("EDITED/USDT");

    await page.getByRole("button", { name: "Update Trade" }).click();
    await expect(page.getByText(canonicalPair("EDITED/USDT"))).toBeVisible();
    await expect(page.getByText(pair)).not.toBeVisible();
  });

  test("should delete a trade with confirmation dialog", async ({ page }) => {
    const pair = await createTestTrade(page, "DEL/USDT");
    await expect(page.getByText(pair)).toBeVisible();

    await page.locator('button[title="Delete trade"]').first().click();

    // Confirm dialog should appear
    await expect(
      page.getByText("Are you sure you want to delete this trade?"),
    ).toBeVisible();
    // `exact: true`: the row's "Delete trade" button also matches a substring
    // "Delete", so scope to the confirm dialog's exact "Delete" label.
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    // Undo toast should appear, trade should be gone
    await expect(page.getByText("Trade deleted")).toBeVisible();
    await expect(page.getByText(pair)).not.toBeVisible();
  });

  test("should undo a deleted trade", async ({ page }) => {
    const pair = await createTestTrade(page, "UNDO/USDT");
    await expect(page.getByText(pair)).toBeVisible();

    await page.locator('button[title="Delete trade"]').first().click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    await expect(page.getByText("Trade deleted")).toBeVisible();
    await expect(page.getByText(pair)).not.toBeVisible();

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText(pair)).toBeVisible();
  });

  test("should persist trades after page reload", async ({ page }) => {
    const pair = await createTestTrade(page, "PERSIST/USDT");
    await expect(page.getByText(pair)).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);
    await expect(page.getByText(pair)).toBeVisible();
  });
});
