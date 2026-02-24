import { test, expect } from '@playwright/test';

test.describe('Risk Calculator', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/calculator');
    await page.waitForLoadState('networkidle');
  });

  test('should display the calculator page with form and results', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Risk Calculator' })).toBeVisible();
    await expect(page.getByText('Position Parameters')).toBeVisible();
    await expect(page.getByText('Position Size', { exact: true })).toBeVisible();
    await expect(page.getByText('Max Loss', { exact: true })).toBeVisible();
  });

  test('should calculate position size when fields are filled', async ({ page }) => {
    // Account Balance is pre-filled with 10000
    // Risk Per Trade defaults to 1%

    // Fill Entry Price
    const entryPriceInput = page.locator('.input-group:has(.input-label:text("Entry Price")) input');
    await entryPriceInput.fill('50000');

    // Fill Stop Loss
    const stopLossInput = page.locator('.input-group:has(.input-label:text("Stop Loss")) input');
    await stopLossInput.fill('49000');

    // The results should update automatically
    // Max Loss StatCard should show $100.00 (1% of 10000)
    const maxLossCard = page.locator('.stat-card:has(.stat-label:text("Max Loss"))');
    await expect(maxLossCard.locator('.stat-value')).toContainText('100.00', { timeout: 5000 });

    // Position Size should not show a dash anymore
    const positionSizeCard = page.locator('.stat-card:has(.stat-label:text("Position Size"))');
    await expect(positionSizeCard.locator('.stat-value')).not.toHaveText('—');
  });

  test('should update results when take profit is added', async ({ page }) => {
    // Fill Entry Price
    const entryPriceInput = page.locator('.input-group:has(.input-label:text("Entry Price")) input');
    await entryPriceInput.fill('50000');

    // Fill Stop Loss
    const stopLossInput = page.locator('.input-group:has(.input-label:text("Stop Loss")) input');
    await stopLossInput.fill('49000');

    // Fill Take Profit
    const takeProfitInput = page.locator('.input-group:has(.input-label:text("Take Profit")) input');
    await takeProfitInput.fill('52000');

    // RR ratio should appear in the format "1 : X.XX"
    await expect(page.getByText(/1 : \d/)).toBeVisible({ timeout: 5000 });
  });

  test('should update risk amount when a preset is clicked', async ({ page }) => {
    // Fill entry and stop loss first
    const entryPriceInput = page.locator('.input-group:has(.input-label:text("Entry Price")) input');
    await entryPriceInput.fill('50000');

    const stopLossInput = page.locator('.input-group:has(.input-label:text("Stop Loss")) input');
    await stopLossInput.fill('49000');

    // Click the 2% preset
    await page.getByRole('button', { name: '2%' }).click();

    // Max Loss StatCard should now show $200.00 (2% of 10000)
    const maxLossCard = page.locator('.stat-card:has(.stat-label:text("Max Loss"))');
    await expect(maxLossCard.locator('.stat-value')).toContainText('200.00', { timeout: 5000 });
  });
});
