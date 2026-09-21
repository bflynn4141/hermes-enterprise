import { expect, test, type Page } from '@playwright/test';

type MockRequest = { path: string; method: string };

async function recordMockRequests(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const requests: MockRequest[] = [];
    Object.defineProperty(window, '__hermesAgentlessRequests', { value: requests });
    window.addEventListener('hermes:mock-request', (event) => {
      requests.push((event as CustomEvent<MockRequest>).detail);
    });
  });
}

async function requests(page: Page): Promise<MockRequest[]> {
  return page.evaluate(() => (window as unknown as { __hermesAgentlessRequests: MockRequest[] }).__hermesAgentlessRequests);
}

test('an agentless reviewer can use Inbox and explicitly read old session history without a live target', async ({ page }) => {
  await recordMockRequests(page);
  await page.goto('/?seat=member&agent=none#agents/overview');
  const app = page.getByRole('region', { name: 'Application' });

  await expect(app.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#inbox\/list$/);
  await expect(page.getByRole('button', { name: 'Agents', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: /conversation$/ })).toHaveCount(0);
  await expect(app.getByRole('button', { name: /Open Iris|Follow Iris/ })).toHaveCount(0);

  await app.getByRole('tab', { name: 'Rules' }).click();
  await expect(app.getByText('Manual review', { exact: true })).toBeVisible();
  await expect(app.getByText('Payment')).toBeVisible();
  await expect(app.getByRole('textbox')).toHaveCount(0);
  await app.getByRole('tab', { name: 'Needs review' }).click();

  await app.getByRole('listitem').filter({ hasText: 'Leah Martinez' }).click();
  await expect(app.getByText('A workspace Admin records this decision')).toBeVisible();

  const beforeHistory = await requests(page);
  expect(beforeHistory.some((request) => request.path.includes('/agents/'))).toBe(false);
  expect(beforeHistory.some((request) => request.path.includes('/instructions'))).toBe(false);
  expect(beforeHistory.some((request) => request.path.includes('/skills'))).toBe(false);
  expect(beforeHistory.some((request) => request.path.includes('/traces'))).toBe(false);
  expect(beforeHistory.some((request) => request.path.includes('/snapshot'))).toBe(false);

  await page.getByRole('button', { name: /Partner applications/ }).first().click();
  const history = page.getByRole('region', { name: 'Session history' });
  await expect(history).toBeVisible();
  await expect(history.getByRole('log', { name: 'Historical session messages' })).toBeVisible();
  await expect(history.getByRole('textbox', { name: /Message/ })).toHaveCount(0);
  await expect(history.getByText('Read-only history. No agent is currently available for new work.')).toBeVisible();
  await expect(history.getByRole('button', { name: /Stop|Retry|Send message/ })).toHaveCount(0);

  const afterHistory = await requests(page);
  expect(afterHistory.filter((request) => request.path.includes('/snapshot'))).toHaveLength(1);
  expect(afterHistory.some((request) => request.method === 'POST' && request.path.endsWith('/sessions'))).toBe(false);
  expect(afterHistory.some((request) => request.method === 'POST' && request.path.includes('/runs'))).toBe(false);
});
