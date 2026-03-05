import { test, expect } from '@playwright/test';
import { gotoAndWaitForApp, waitForAppReady, loadSampleData } from './helpers';

test.describe('Import & Cross-Page Verification', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndWaitForApp(page, '/import');
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
  });

  test('should show sample trades on the Trades page after import', async ({ page }) => {
    await loadSampleData(page);

    await page.getByRole('link', { name: 'Trades', exact: true }).click();
    await expect(page).toHaveURL('/trades');
    await expect(page.getByRole('heading', { name: 'Trade History' })).toBeVisible();

    // Should show a non-zero trade count
    const summary = page.locator('.trades-summary');
    await expect(summary).toBeVisible({ timeout: 10000 });
    await expect(summary).not.toContainText('Showing 0 of 0');
  });

  test('should display analytics after importing sample data', async ({ page }) => {
    await loadSampleData(page);

    await page.getByRole('link', { name: 'Analytics' }).click();
    await expect(page).toHaveURL('/analytics', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible({ timeout: 15000 });

    // At least one stat card or chart should be visible
    const content = page.locator('.analytics-grid, .stat-card, .glass-card').first();
    await expect(content).toBeVisible({ timeout: 10000 });
  });

  test('should generate AI insights after importing sample data', async ({ page }) => {
    await loadSampleData(page);

    await page.getByRole('link', { name: 'AI Insights' }).click();
    await expect(page).toHaveURL('/insights');
    await expect(page.getByRole('heading', { name: 'AI Insights' })).toBeVisible();

    // Insights should be generated (look for insight cards or pattern results)
    const insightContent = page.locator('.insight-card, .glass-card, .insights-grid').first();
    await expect(insightContent).toBeVisible({ timeout: 15000 });
  });

  test('should show report data after importing sample data', async ({ page }) => {
    await loadSampleData(page);

    await page.getByRole('link', { name: 'Report' }).click();
    await expect(page).toHaveURL('/report');

    // Report page should show content (not empty)
    const reportContent = page.locator('.report-page').first();
    await expect(reportContent).toBeVisible({ timeout: 10000 });
    // Verify actual report content is shown (not the empty state)
    await expect(page.getByRole('heading', { name: /Performance Report/ })).toBeVisible();
  });
});
