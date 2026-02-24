import { test, expect } from '@playwright/test';

test.describe('Trade Form', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage before each test for a clean state
    await page.goto('/trades');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForLoadState('networkidle');
  });

  test('should open the Add Trade form', async ({ page }) => {
    await page.getByRole('button', { name: '+ Add Trade' }).click();
    await expect(page.getByRole('heading', { name: 'Add New Trade' })).toBeVisible();
  });

  test('should show validation errors when submitting an empty form', async ({ page }) => {
    await page.getByRole('button', { name: '+ Add Trade' }).click();
    await expect(page.getByRole('heading', { name: 'Add New Trade' })).toBeVisible();

    // Click the submit button inside the modal (exact match to avoid ambiguity)
    await page.getByRole('button', { name: 'Add Trade', exact: true }).click();

    // Validation error messages should appear
    await expect(page.getByText('Pair is required')).toBeVisible();
    await expect(page.getByText('Valid entry price is required')).toBeVisible();
    await expect(page.getByText('Valid exit price is required')).toBeVisible();
    await expect(page.getByText('Valid quantity is required')).toBeVisible();
    await expect(page.getByText('Entry date is required')).toBeVisible();
    await expect(page.getByText('Exit date is required')).toBeVisible();
  });

  test('should add a new trade and see it in the table', async ({ page }) => {
    await page.getByRole('button', { name: '+ Add Trade' }).click();

    // Fill in the required fields
    await page.getByPlaceholder('BTC/USDT').fill('ETH/USDT');

    // Direction defaults to "Long", so no change needed

    // Entry Price - target by placeholder within the modal
    const modal = page.locator('.modal-content');
    const priceInputs = modal.locator('input[placeholder="0.00"]');
    await priceInputs.nth(0).fill('2000'); // Entry Price
    await priceInputs.nth(1).fill('2200'); // Exit Price
    await priceInputs.nth(2).fill('1');    // Quantity

    // Entry Date
    const dateInputs = modal.locator('input[type="datetime-local"]');
    await dateInputs.first().fill('2026-01-15T10:00');

    // Exit Date
    await dateInputs.nth(1).fill('2026-01-16T14:00');

    // Submit the form (exact match)
    await page.getByRole('button', { name: 'Add Trade', exact: true }).click();

    // Verify the trade appears in the table
    await expect(page.getByText('ETH/USDT')).toBeVisible();
  });

  test('should close the form when Cancel is clicked', async ({ page }) => {
    await page.getByRole('button', { name: '+ Add Trade' }).click();
    await expect(page.getByRole('heading', { name: 'Add New Trade' })).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Add New Trade' })).not.toBeVisible();
  });
});
