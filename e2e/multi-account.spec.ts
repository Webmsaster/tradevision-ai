import { test, expect } from "@playwright/test";
import { gotoAndWaitForApp, waitForAppReady } from "./helpers";

test.describe("Multi-Account Management", () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndWaitForApp(page, "/settings");
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("should display Trading Accounts section", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: "Trading Accounts" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "+ Add Account" }),
    ).toBeVisible();
  });

  test("should have default account on initial load", async ({ page }) => {
    const accountRows = page.locator(".settings-account-row");
    await expect(accountRows).toHaveCount(1);
    await expect(
      page.locator('input[aria-label="Account name"]').first(),
    ).toHaveValue("Main Account");
  });

  test("should add a new account with name and broker", async ({ page }) => {
    // Add new account
    await page.getByRole("button", { name: "+ Add Account" }).click();
    const accountRows = page.locator(".settings-account-row");
    await expect(accountRows).toHaveCount(2);

    // Fill in second account details
    const nameInputs = page.locator('input[aria-label="Account name"]');
    const brokerInputs = page.locator('input[aria-label="Broker name"]');

    await nameInputs.nth(1).fill("Trading Desk 2");
    await brokerInputs.nth(1).fill("Binance");

    // Save settings
    await page.getByRole("button", { name: "Save Settings" }).click();
    await expect(page.getByText("Settings saved!")).toBeVisible();

    // Verify the new account is saved
    await expect(nameInputs.nth(1)).toHaveValue("Trading Desk 2");
    await expect(brokerInputs.nth(1)).toHaveValue("Binance");
  });

  test("should switch active account via radio button", async ({ page }) => {
    // Add new account first
    await page.getByRole("button", { name: "+ Add Account" }).click();
    const nameInputs = page.locator('input[aria-label="Account name"]');
    await nameInputs.nth(1).fill("Secondary Account");

    // Get radio buttons
    const radioButtons = page.locator('input[name="activeAccount"]');

    // Initially first account should be active
    await expect(radioButtons.nth(0)).toBeChecked();
    await expect(radioButtons.nth(1)).not.toBeChecked();

    // Click second radio button to make it active
    await radioButtons.nth(1).click();
    await expect(radioButtons.nth(0)).not.toBeChecked();
    await expect(radioButtons.nth(1)).toBeChecked();

    // Save and reload
    await page.getByRole("button", { name: "Save Settings" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);

    // Verify second account is still active after reload
    const reloadedRadios = page.locator('input[name="activeAccount"]');
    await expect(reloadedRadios.nth(1)).toBeChecked();
  });

  test("should persist accounts after page reload", async ({ page }) => {
    // Create two accounts
    await page.getByRole("button", { name: "+ Add Account" }).click();
    const nameInputs = page.locator('input[aria-label="Account name"]');
    const brokerInputs = page.locator('input[aria-label="Broker name"]');

    await nameInputs.nth(0).fill("Account A");
    await brokerInputs.nth(0).fill("Kraken");
    await nameInputs.nth(1).fill("Account B");
    await brokerInputs.nth(1).fill("Coinbase");

    // Save settings
    await page.getByRole("button", { name: "Save Settings" }).click();
    await expect(page.getByText("Settings saved!")).toBeVisible();

    // Reload page
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);

    // Verify accounts persist
    const reloadedNames = page.locator('input[aria-label="Account name"]');
    await expect(reloadedNames.nth(0)).toHaveValue("Account A");
    await expect(reloadedNames.nth(1)).toHaveValue("Account B");

    const reloadedBrokers = page.locator('input[aria-label="Broker name"]');
    await expect(reloadedBrokers.nth(0)).toHaveValue("Kraken");
    await expect(reloadedBrokers.nth(1)).toHaveValue("Coinbase");
  });

  test("should remove account when multiple accounts exist", async ({
    page,
  }) => {
    // Create two accounts
    await page.getByRole("button", { name: "+ Add Account" }).click();
    const nameInputs = page.locator('input[aria-label="Account name"]');
    await nameInputs.nth(1).fill("Account to Remove");

    let accountRows = page.locator(".settings-account-row");
    await expect(accountRows).toHaveCount(2);

    // Remove the second account
    const removeButtons = page.locator('button:has-text("Remove")');
    await removeButtons.nth(0).click();

    // Verify only one account remains
    accountRows = page.locator(".settings-account-row");
    await expect(accountRows).toHaveCount(1);

    // Save and verify persistence
    await page.getByRole("button", { name: "Save Settings" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);

    const reloadedRows = page.locator(".settings-account-row");
    await expect(reloadedRows).toHaveCount(1);
  });

  test("should not show Remove button when only one account exists", async ({
    page,
  }) => {
    const removeButtons = page.locator('button:has-text("Remove")');
    await expect(removeButtons).toHaveCount(0);
  });

  test("should set different account as active when removing current active", async ({
    page,
  }) => {
    // Create two accounts
    await page.getByRole("button", { name: "+ Add Account" }).click();
    const nameInputs = page.locator('input[aria-label="Account name"]');
    await nameInputs.nth(1).fill("Account to Remove");

    // Set second account as active
    const radioButtons = page.locator('input[name="activeAccount"]');
    await radioButtons.nth(1).click();
    await expect(radioButtons.nth(1)).toBeChecked();

    // Remove the active account
    const removeButtons = page.locator('button:has-text("Remove")');
    await removeButtons.nth(0).click();

    // Verify first account is now active (fallback)
    const remainingRadios = page.locator('input[name="activeAccount"]');
    await expect(remainingRadios.nth(0)).toBeChecked();
  });
});
