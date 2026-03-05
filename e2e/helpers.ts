import { Page, expect } from '@playwright/test';

export async function waitForAppReady(page: Page) {
  await page.waitForLoadState('domcontentloaded');
}

export async function gotoAndWaitForApp(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
}

/** Navigate to /import and load sample data, wait for success notification */
export async function loadSampleData(page: Page) {
  await gotoAndWaitForApp(page, '/import');
  await expect(page.getByRole('heading', { name: 'Import & Export' })).toBeVisible();
  await page.getByRole('button', { name: 'Load Sample Data' }).click();
  await expect(page.getByText('Sample data loaded')).toBeVisible({ timeout: 10000 });
}

/** Open the Add Trade form, fill fields, and submit */
export async function createTestTrade(page: Page, pair: string = 'TEST/USDT') {
  await page.getByRole('button', { name: '+ Add Trade' }).click();

  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();

  await modal.getByPlaceholder('BTC/USDT').fill(pair);
  await modal.locator('.form-group:has(.form-label:text("Entry Price")) input').fill('100');
  await modal.locator('.form-group:has(.form-label:text("Exit Price")) input').fill('110');
  await modal.locator('.form-group:has(.form-label:text("Quantity")) input').fill('10');

  const dateInputs = modal.locator('input[type="datetime-local"]');
  await dateInputs.first().fill('2026-01-10T09:00');
  await dateInputs.nth(1).fill('2026-01-10T15:00');

  await page.getByRole('button', { name: 'Add Trade', exact: true }).click();
  await expect(page.getByText(pair)).toBeVisible({ timeout: 5000 });
}
