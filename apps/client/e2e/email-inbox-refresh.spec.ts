import { expect, test } from '@playwright/test';
import { expectAdminPage, openAdminPage } from './admin-nav.js';

test('agent email keeps checking for new mail until the page is hidden or closed', async ({ page }) => {
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
  // Iris has its own address without anyone adding one (C100).
  await expect(page.getByRole('list', { name: 'Agent email' }).getByRole('button', { name: /^Copy Iris’s email address, iris-[a-z0-9]+@/u })).toBeVisible();
  await expect(page.getByText('No email yet').first()).toBeVisible();
  const reads = () => page.evaluate(() => {
    const paths = (window as unknown as { __emailReads: string[] }).__emailReads;
    const bare = paths.map((path) => path.split('?')[0]!);
    return { inboxes: bare.filter((path) => path.endsWith('/inboxes')).length, messages: bare.filter((path) => path.endsWith('/messages')).length };
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
  // Becoming visible reads again at once, for each address on the page.
  await expect.poll(async () => (await reads()).messages).toBeGreaterThan(after.messages);
  await openAdminPage(page, 'General');
  const closed = await reads();
  await page.clock.runFor(15_000);
  expect(await reads()).toEqual(closed);
});
