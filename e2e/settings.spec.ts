import { test, expect } from "@playwright/test";
import { gotoAndWaitForApp, waitForAppReady } from "./helpers";

test.describe("Settings Page", () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndWaitForApp(page, "/settings");
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("should display settings page with main sections", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Dashboard Widgets" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Webhook Notifications" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Trading Accounts" }),
    ).toBeVisible();
  });

  test("should navigate to settings via sidebar", async ({ page }) => {
    await gotoAndWaitForApp(page, "/");
    // 2026-05-15 (Audit-Round-4 / Agent #8 KRIT): the old `if (visible) {…}`
    // pattern produced a ghost-pass — when the sidebar regressed and the link
    // disappeared, the whole block was skipped and the test still passed with
    // zero assertions. Now we require the link up-front so a regression fails
    // the test instead of hiding behind a no-op.
    const settingsLink = page
      .locator("a, button")
      .filter({ hasText: /settings/i })
      .first();
    await expect(settingsLink).toBeVisible({ timeout: 5000 });
    await settingsLink.click();
    await expect(page).toHaveURL(/\/settings/);
  });

  test("should toggle dashboard widget and persist state", async ({ page }) => {
    // R8 Task H / 2026-05-22: the prior "validation resets widgets to true"
    // bug claim was a false alarm — save/load preserves `false` correctly.
    // The real cause of the failure was the assertion: `await isChecked()` is
    // a ONE-SHOT read taken right after reload, before the mount effect
    // re-hydrates `settings` from localStorage (initial state is the
    // all-true DEFAULT_SETTINGS). Auto-retrying `expect(...).not.toBeChecked()`
    // waits for hydration. Widgets default to checked, so toggling = uncheck.
    const weeklySummaryCheckbox = page
      .locator("label")
      .filter({ hasText: "Weekly Summary" })
      .locator('input[type="checkbox"]');
    await expect(weeklySummaryCheckbox).toBeChecked();

    await weeklySummaryCheckbox.click();
    await expect(weeklySummaryCheckbox).not.toBeChecked();

    await page.getByRole("button", { name: "Save Settings" }).click();
    await expect(page.getByText("Settings saved!")).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);

    // Auto-retrying assertion tolerates the async re-hydration after reload.
    await expect(
      page
        .locator("label")
        .filter({ hasText: "Weekly Summary" })
        .locator('input[type="checkbox"]'),
    ).not.toBeChecked();
  });

  test("should toggle all dashboard widgets", async ({ page }) => {
    // 2026-05-22: see note above — auto-retrying assertions instead of
    // one-shot isChecked() reads. All widgets default to checked.
    const widgetLabels = [
      "Equity Curve",
      "Weekly Summary",
      "Recent Trades",
      "AI Insights",
    ];
    const checkboxFor = (label: string) =>
      page
        .locator("label")
        .filter({ hasText: label })
        .locator('input[type="checkbox"]');

    // All start checked, toggle each off.
    for (const label of widgetLabels) {
      await expect(checkboxFor(label)).toBeChecked();
      await checkboxFor(label).click();
      await expect(checkboxFor(label)).not.toBeChecked();
    }

    await page.getByRole("button", { name: "Save Settings" }).click();
    await expect(page.getByText("Settings saved!")).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);

    // After re-hydration, all four stay unchecked.
    for (const label of widgetLabels) {
      await expect(checkboxFor(label)).not.toBeChecked();
    }
  });

  test("should enable webhook notifications", async ({ page }) => {
    // Find webhook enable checkbox (after dashboard widgets, so around index 4-5)
    const allCheckboxes = page.locator('input[type="checkbox"]');
    const webhookEnableCheckbox = allCheckboxes
      .filter({
        has: page.locator("span").filter({ hasText: "Enable webhook" }),
      })
      .first();

    // Check if there's a specific checkbox for enabling webhooks
    const enableLabel = page
      .locator("label")
      .filter({ hasText: "Enable webhook notifications" });
    if (await enableLabel.isVisible()) {
      const enableCheckbox = enableLabel.locator('input[type="checkbox"]');
      const wasEnabled = await enableCheckbox.isChecked();

      if (!wasEnabled) {
        await enableCheckbox.click();
        await expect(enableCheckbox).toBeChecked();

        // Platform dropdown should now appear
        const platformSelect = page.locator("#webhook-platform");
        await expect(platformSelect).toBeVisible();
      }
    }
  });

  test("should reject invalid webhook URL (http instead of https)", async ({
    page,
  }) => {
    // Enable webhooks first
    const enableLabel = page
      .locator("label")
      .filter({ hasText: "Enable webhook notifications" });
    const enableCheckbox = enableLabel.locator('input[type="checkbox"]');

    if (!(await enableCheckbox.isChecked())) {
      await enableCheckbox.click();
      await expect(enableCheckbox).toBeChecked();
    }

    // Fill in invalid URL (http://)
    const webhookUrlInput = page.locator("#webhook-url");
    await webhookUrlInput.fill("http://example.com/webhook");

    // Try to save
    await page.getByRole("button", { name: "Save Settings" }).click();
    await page.waitForTimeout(500);

    // Reload and check that URL was cleared and enabled is false
    // (based on settings validation in page.tsx)
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);

    const reloadedEnableCheckbox = page
      .locator("label")
      .filter({ hasText: "Enable webhook notifications" })
      .locator('input[type="checkbox"]');

    // The settings validation should disable webhook if http:// was used
    // Check that webhook is disabled after validation
    const isEnabled = await reloadedEnableCheckbox.isChecked();

    // Webhook should be disabled due to http:// validation
    expect(isEnabled).toBe(false);
  });

  test("should accept valid https webhook URL", async ({ page }) => {
    // Enable webhooks
    const enableLabel = page
      .locator("label")
      .filter({ hasText: "Enable webhook notifications" });
    const enableCheckbox = enableLabel.locator('input[type="checkbox"]');

    if (!(await enableCheckbox.isChecked())) {
      await enableCheckbox.click();
    }

    // Fill in valid HTTPS URL
    const webhookUrlInput = page.locator("#webhook-url");
    await webhookUrlInput.fill("https://example.com/webhook");

    // Save
    await page.getByRole("button", { name: "Save Settings" }).click();
    await expect(page.getByText("Settings saved!")).toBeVisible();

    // Reload and verify URL persists
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);

    const reloadedUrlInput = page.locator("#webhook-url");
    const savedUrl = await reloadedUrlInput.inputValue();
    expect(savedUrl).toBe("https://example.com/webhook");
  });

  test("should display webhook platform options", async ({ page }) => {
    // Enable webhooks
    const enableLabel = page
      .locator("label")
      .filter({ hasText: "Enable webhook notifications" });
    const enableCheckbox = enableLabel.locator('input[type="checkbox"]');

    if (!(await enableCheckbox.isChecked())) {
      await enableCheckbox.click();
      await expect(enableCheckbox).toBeChecked();
    }

    // Check platform dropdown
    const platformSelect = page.locator("#webhook-platform");
    await expect(platformSelect).toBeVisible();

    // Should have Discord, Telegram, Custom options
    const options = platformSelect.locator("option");
    await expect(options).toHaveCount(3);
    await expect(platformSelect).toContainText("Discord");
    await expect(platformSelect).toContainText("Telegram");
    await expect(platformSelect).toContainText("Custom URL");
  });

  test("should change webhook platform and persist", async ({ page }) => {
    // Enable webhooks
    const enableLabel = page
      .locator("label")
      .filter({ hasText: "Enable webhook notifications" });
    const enableCheckbox = enableLabel.locator('input[type="checkbox"]');

    if (!(await enableCheckbox.isChecked())) {
      await enableCheckbox.click();
    }

    // Change platform to Telegram
    const platformSelect = page.locator("#webhook-platform");
    await platformSelect.selectOption("telegram");

    // Save
    await page.getByRole("button", { name: "Save Settings" }).click();
    await expect(page.getByText("Settings saved!")).toBeVisible();

    // Reload and verify
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);

    const reloadedSelect = page.locator("#webhook-platform");
    const selectedValue = await reloadedSelect.inputValue();
    expect(selectedValue).toBe("telegram");
  });

  test("should save button work correctly", async ({ page }) => {
    // Modify a setting
    const checkboxes = page.locator('input[type="checkbox"]');
    await checkboxes.nth(0).click();

    // Click save
    await page.getByRole("button", { name: "Save Settings" }).click();

    // Success message should appear
    await expect(page.getByText("Settings saved!")).toBeVisible();

    // R8 Task E: assert disappearance via auto-retrying expect — was a
    // flaky waitForTimeout(2500) + .catch swallow.
    const message = page.getByText("Settings saved!");
    await expect(message).toBeHidden({ timeout: 5000 });
  });
});
