import { chromium } from 'playwright';

const DEFAULT_BASE_URL = 'https://tradevision-ai-bay.vercel.app';
const baseUrl = (process.env.SMOKE_BASE_URL || DEFAULT_BASE_URL).trim();
const failureScreenshotPath =
  process.env.SMOKE_FAILURE_SCREENSHOT || 'artifacts/prod-smoke-failure.png';

function url(pathname) {
  return new URL(pathname, baseUrl).toString();
}

async function runStep(name, fn) {
  console.log(`STEP START: ${name}`);
  await fn();
  console.log(`STEP PASS:  ${name}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(`Running production smoke check against ${baseUrl}`);

    await runStep('Login page + continue without account', async () => {
      await page.goto(url('/login'), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.getByRole('heading', { name: /TradeVision AI/i }).first().waitFor({
        state: 'visible',
        timeout: 20000,
      });

      const continueBtn = page.getByRole('button', { name: /Continue without account/i });
      if (await continueBtn.count()) {
        await continueBtn.first().click();
        await page.waitForURL((nextUrl) => nextUrl.pathname === '/', { timeout: 20000 });
      }
    });

    await runStep('Trades page + add trade', async () => {
      await page.goto(url('/trades'), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Trade History' }).waitFor({
        state: 'visible',
        timeout: 20000,
      });

      await page.getByRole('button', { name: '+ Add Trade' }).click();

      const modal = page.getByRole('dialog');
      await modal.getByPlaceholder('BTC/USDT').fill('ETH/USDT');
      await modal
        .locator('.form-group:has(.form-label:text("Entry Price")) input')
        .fill('2000');
      await modal
        .locator('.form-group:has(.form-label:text("Exit Price")) input')
        .fill('2200');
      await modal
        .locator('.form-group:has(.form-label:text("Quantity")) input')
        .fill('1');

      const dateInputs = modal.locator('input[type="datetime-local"]');
      await dateInputs.first().fill('2026-02-28T10:00');
      await dateInputs.nth(1).fill('2026-02-28T14:00');

      await page.getByRole('button', { name: 'Add Trade', exact: true }).click();
      await page.getByText('ETH/USDT').first().waitFor({ state: 'visible', timeout: 20000 });
    });

    await runStep('Import page + load sample data', async () => {
      await page.goto(url('/import'), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.getByRole('heading', { name: 'Import & Export' }).waitFor({
        state: 'visible',
        timeout: 20000,
      });
      await page.getByRole('button', { name: 'Load Sample Data' }).click();
      await page.getByText('Sample data loaded').first().waitFor({
        state: 'visible',
        timeout: 20000,
      });
    });

    await runStep('Analytics page loads', async () => {
      await page.goto(url('/analytics'), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.getByRole('heading', { name: 'Analytics' }).waitFor({
        state: 'visible',
        timeout: 20000,
      });
    });

    console.log('SMOKE_OK: login/trades/import/analytics');
  } catch (error) {
    try {
      await page.screenshot({ path: failureScreenshotPath, fullPage: true });
      console.error(`Failure screenshot saved to ${failureScreenshotPath}`);
    } catch (screenshotError) {
      console.error('Could not capture failure screenshot:', screenshotError);
    }

    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error('SMOKE_FAILED:', error?.message || error);
  process.exit(1);
});
