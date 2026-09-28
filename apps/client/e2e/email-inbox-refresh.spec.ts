import { expect, test } from '@playwright/test';
import { expectAdminPage, openAdminPage } from './admin-nav.js';

test('role inboxes keep checking for email until the page is hidden or closed', async ({ page }) => {
  await page.addInitScript(() => {
    const requests: string[] = [];
    Object.defineProperty(window, '__emailReads', { value: requests });
    window.addEventListener('hermes:mock-request', (event) => {
      const request = (event as CustomEvent<{ path: string; method: string }>).detail;
      if (request.method === 'GET' && request.path.includes('/email/inboxes')) requests.push(request.path);
    });
  });
  await page.clock.install();
  await page.goto('/#admin/Inboxes');
  await page.getByRole('button', { name: 'Add inbox', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add inbox', exact: true }).click();
  await expect(page.getByText('No email yet. Send one to the address above to try it.')).toBeVisible();
  const reads = () => page.evaluate(() => {
    const paths = (window as unknown as { __emailReads: string[] }).__emailReads;
    return { inboxes: paths.filter((path) => path.endsWith('/inboxes')).length, messages: paths.filter((path) => path.endsWith('/messages')).length };
  });
  const before = await reads();
  // Settle each asynchronous read before advancing to the next interval.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.clock.runFor(6000);
    await expect.poll(async () => (await reads()).messages).toBeGreaterThanOrEqual(before.messages + attempt);
  }
  const after = await reads();
  expect(after.inboxes).toBeGreaterThanOrEqual(before.inboxes + 2);
  expect(after.messages).toBeGreaterThanOrEqual(before.messages + 2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(15_000);
  expect(await reads()).toEqual(after);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await reads()).messages).toBe(after.messages + 1);
  await openAdminPage(page, 'General');
  const closed = await reads();
  await page.clock.runFor(15_000);
  expect(await reads()).toEqual(closed);
});
