import { test, expect } from '@playwright/test';
import { gotoAndWaitForApp } from './helpers';

test.describe('Navigation', () => {
  test('should load the dashboard page', async ({ page }) => {
    await gotoAndWaitForApp(page, '/');
    const heading = page.locator('.dashboard-title, .dashboard-empty-title').first();
    await expect(heading).toBeVisible({ timeout: 15000 });
    const text = (await heading.textContent())?.trim();
    expect(text === 'Dashboard' || text === 'No Trades Yet').toBeTruthy();
  });

  test('should navigate to the Trades page via sidebar', async ({ page }) => {
    await gotoAndWaitForApp(page, '/');
    await page.getByRole('link', { name: 'Trades', exact: true }).click();
    await expect(page).toHaveURL('/trades');
    await expect(page.getByRole('heading', { name: 'Trade History' })).toBeVisible();
  });

  test('should navigate to the Analytics page via sidebar', async ({ page }) => {
    await gotoAndWaitForApp(page, '/');
    await page.getByRole('link', { name: 'Analytics' }).click();
    await expect(page).toHaveURL('/analytics', { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible({ timeout: 15000 });
  });

  test('should navigate to the AI Insights page via sidebar', async ({ page }) => {
    await gotoAndWaitForApp(page, '/');
    await page.getByRole('link', { name: 'AI Insights' }).click();
    await expect(page).toHaveURL('/insights');
    await expect(page.getByRole('heading', { name: 'AI Insights' })).toBeVisible();
  });

  test('should navigate to the Calculator page via sidebar', async ({ page }) => {
    await gotoAndWaitForApp(page, '/');
    await page.getByRole('link', { name: 'Calculator' }).click();
    await expect(page).toHaveURL('/calculator');
    await expect(page.getByRole('heading', { name: 'Risk Calculator' })).toBeVisible();
  });

  test('should navigate to the Import page via sidebar', async ({ page }) => {
    await gotoAndWaitForApp(page, '/');
    await page.getByRole('link', { name: 'Import', exact: true }).click();
    await expect(page).toHaveURL('/import');
    await expect(page.getByRole('heading', { name: 'Import & Export' })).toBeVisible();
  });
});
