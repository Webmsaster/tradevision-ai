import { test, expect } from '@playwright/test';
import { gotoAndWaitForApp, waitForAppReady } from './helpers';

test.describe('CSV Import & Sample Data', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndWaitForApp(page, '/import');
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await expect(page.getByRole('heading', { name: 'Import & Export' })).toBeVisible();
  });

  test('should display the Import & Export page with sections', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Import from CSV' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Import from JSON Backup' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Export Data' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sample Data' })).toBeVisible();
  });

  test('should load sample data and show success notification', async ({ page }) => {
    await page.getByRole('button', { name: 'Load Sample Data' }).click();

    const successNotice = page.locator('.import-notification.success');
    await expect(successNotice).toContainText(/Loaded\s+\d+\s+sample\s+trade/i, { timeout: 10000 });
    await expect(page.getByText('Sample data loaded')).toBeVisible({ timeout: 10000 });
  });

  test('should show trade count after loading sample data', async ({ page }) => {
    await page.getByRole('button', { name: 'Load Sample Data' }).click();

    await expect(page.getByText('Sample data loaded')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.import-trade-count strong')).not.toHaveText('0', { timeout: 10000 });
  });
});
