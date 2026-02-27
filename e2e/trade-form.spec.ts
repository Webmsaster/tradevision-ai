import { test, expect } from '@playwright/test';
import { gotoAndWaitForApp, waitForAppReady } from './helpers';

test.describe('Trade Form', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndWaitForApp(page, '/trades');
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await expect(page.getByRole('heading', { name: 'Trade History' })).toBeVisible();
  });

  test('should open the Add Trade form', async ({ page }) => {
    await page.getByRole('button', { name: '+ Add Trade' }).click();
    await expect(page.getByRole('heading', { name: 'Add New Trade' })).toBeVisible();
  });

  test('should show validation errors when submitting an empty form', async ({ page }) => {
    await page.getByRole('button', { name: '+ Add Trade' }).click();
    await expect(page.getByRole('heading', { name: 'Add New Trade' })).toBeVisible();

    await page.getByRole('button', { name: 'Add Trade', exact: true }).click();

    await expect(page.getByText('Pair is required')).toBeVisible();
    await expect(page.getByText('Valid entry price is required')).toBeVisible();
    await expect(page.getByText('Valid exit price is required')).toBeVisible();
    await expect(page.getByText('Valid quantity is required')).toBeVisible();
    await expect(page.getByText('Entry date is required')).toBeVisible();
    await expect(page.getByText('Exit date is required')).toBeVisible();
  });

  test('should add a new trade and see it in the table', async ({ page }) => {
    await page.getByRole('button', { name: '+ Add Trade' }).click();

    const modal = page.getByRole('dialog');
    await modal.getByPlaceholder('BTC/USDT').fill('ETH/USDT');

    await modal.locator('.form-group:has(.form-label:text("Entry Price")) input').fill('2000');
    await modal.locator('.form-group:has(.form-label:text("Exit Price")) input').fill('2200');
    await modal.locator('.form-group:has(.form-label:text("Quantity")) input').fill('1');

    const dateInputs = modal.locator('input[type="datetime-local"]');
    await dateInputs.first().fill('2026-01-15T10:00');
    await dateInputs.nth(1).fill('2026-01-16T14:00');

    await page.getByRole('button', { name: 'Add Trade', exact: true }).click();
    await expect(page.getByText('ETH/USDT')).toBeVisible();
  });

  test('should close the form when Cancel is clicked', async ({ page }) => {
    await page.getByRole('button', { name: '+ Add Trade' }).click();
    await expect(page.getByRole('heading', { name: 'Add New Trade' })).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Add New Trade' })).not.toBeVisible();
  });
});
