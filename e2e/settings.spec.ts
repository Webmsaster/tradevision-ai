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
    // Look for settings link - might be in a menu or gear icon
    const settingsLink = page
      .locator("a, button")
      .filter({ hasText: /settings/i })
      .first();
    if (await settingsLink.isVisible()) {
      await settingsLink.click();
      await expect(page).toHaveURL(/\/settings/);
    }
  });

  test.fixme("should toggle dashboard widget and persist state", async ({
    page,
  }) => {
    // R8 Task H: was test.skip — converted to test.fixme so the failing
    // app-bug is tracked, not silently hidden. Bug claim: settings
    // validation (settings/page.tsx) resets unchecked boolean widgets to
    // `true` on reload. Re-investigate before re-enabling.
    // Verify it's initially checked
    const weeklySummaryLabel = page
      .locator("label")
      .filter({ hasText: "Weekly Summary" });
    const weeklySummaryCheckbox = weeklySummaryLabel.locator(
      'input[type="checkbox"]',
    );
    const isChecked = await weeklySummaryCheckbox.isChecked();

    // Toggle the checkbox
    await weeklySummaryCheckbox.click();
    const afterToggle = await weeklySummaryCheckbox.isChecked();
    expect(afterToggle).not.toBe(isChecked);

    // Save settings
    await page.getByRole("button", { name: "Save Settings" }).click();
    await expect(page.getByText("Settings saved!")).toBeVisible();

    // Reload and verify persistence
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);

    const reloadedWeeklySummaryLabel = page
      .locator("label")
      .filter({ hasText: "Weekly Summary" });
    const reloadedCheckbox = reloadedWeeklySummaryLabel.locator(
      'input[type="checkbox"]',
    );
    const reloadedState = await reloadedCheckbox.isChecked();
    expect(reloadedState).toBe(afterToggle);
  });

  test.fixme("should toggle all dashboard widgets", async ({ page }) => {
    // R8 Task H: see test.fixme above — same pending bug.
    const widgetLabels = [
      "Equity Curve",
      "Weekly Summary",
      "Recent Trades",
      "AI Insights",
    ];
    const initialStates: boolean[] = [];

    // Get initial states of dashboard widget checkboxes
    for (const label of widgetLabels) {
      const checkbox = page
        .locator("label")
        .filter({ hasText: label })
        .locator('input[type="checkbox"]');
      initialStates.push(await checkbox.isChecked());
    }

    // Toggle all 4 widgets
    for (const label of widgetLabels) {
      const checkbox = page
        .locator("label")
        .filter({ hasText: label })
        .locator('input[type="checkbox"]');
      await checkbox.click();
    }

    // Save
    await page.getByRole("button", { name: "Save Settings" }).click();
    await expect(page.getByText("Settings saved!")).toBeVisible();

    // Reload and verify all are toggled
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppReady(page);

    for (let i = 0; i < widgetLabels.length; i++) {
      const label = widgetLabels[i];
      const checkbox = page
        .locator("label")
        .filter({ hasText: label })
        .locator('input[type="checkbox"]');
      const reloadedState = await checkbox.isChecked();
      expect(reloadedState).toBe(!initialStates[i]);
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
