import { Page } from '@playwright/test';

export async function waitForAppReady(page: Page) {
  await page.waitForLoadState('domcontentloaded');
}

export async function gotoAndWaitForApp(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
}
