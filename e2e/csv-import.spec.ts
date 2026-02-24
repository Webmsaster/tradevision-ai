import { test, expect } from '@playwright/test';

test.describe('CSV Import & Sample Data', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage before each test
    await page.goto('/import');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForLoadState('networkidle');
  });

  test('should display the Import & Export page with sections', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Import & Export' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Import from CSV' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Import from JSON Backup' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Export Data' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sample Data' })).toBeVisible();
  });

  test('should load sample data and show success notification', async ({ page }) => {
    // Click "Load Sample Data" button
    await page.getByRole('button', { name: 'Load Sample Data' }).click();

    // A success notification should appear
    await expect(page.getByText(/Loaded.*sample/i)).toBeVisible({ timeout: 10000 });

    // The "Sample data loaded" text should appear
    await expect(page.getByText('Sample data loaded')).toBeVisible({ timeout: 10000 });
  });

  test('should show trade count after loading sample data', async ({ page }) => {
    await page.getByRole('button', { name: 'Load Sample Data' }).click();

    // Wait for the data to load
    await expect(page.getByText('Sample data loaded')).toBeVisible({ timeout: 10000 });

    // The trade count display should show more than 0 trades
    const tradeCountText = page.locator('text=/You have \\d+ trade/');
    await expect(tradeCountText).toBeVisible({ timeout: 10000 });
  });
});
