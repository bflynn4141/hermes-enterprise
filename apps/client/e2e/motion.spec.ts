// The three moments that move: a receipt arriving, an Inbox row arriving, and
// the badge that counts it. Each is asserted by the animation the stylesheet
// actually attaches, then asserted absent under `prefers-reduced-motion`.
// The screenshots in `qa/motion-*.png` are the review artefacts.
import { expect, test, type Page } from '@playwright/test';

// The desktop layout: with the Iris panel open, the 1280 default leaves the app
// pane under its container breakpoint and the Inbox shows one column, so a
// deep-linked request replaces the list instead of selecting a row in it.
test.use({ viewport: { width: 1680, height: 1000 } });

const shot = (name: string) => ({ path: `qa/motion-${name}.png` });
const animationName = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((element) => getComputedStyle(element).animationName);

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message Iris' }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

test('a receipt that arrives settles in, the new Inbox row slides in, and the count bumps', async ({ page }) => {
  await page.goto('/?turn=proposes_request');
  // The Inbox is open *before* the run, so the row has somewhere to arrive.
  await page.getByRole('button', { name: /^Inbox/ }).click();
  const list = page.getByRole('list', { name: 'Requests needing review' });
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await expect(list.locator('[data-highlight]')).toHaveCount(0);

  await send(page, 'Screen the newest applicant');

  // The badge went up by one while the page was open. In-page waits: a 600 ms
  // window can fall between two Node-side polls.
  await page.waitForSelector('.sidebar[data-bump]', { state: 'attached' });

  // The reply that carries the receipt is the one that arrived; the seeded
  // reply above it did not move.
  const freshCard = page.locator('.msg-iris[data-fresh] .chat-card.static');
  await expect(freshCard.first()).toBeVisible();
  expect(await animationName(page, '.msg-iris[data-fresh] .chat-card.static')).toContain('receipt-settle');
  // The mock replays the seeded run id and never confirms the question, so
  // the reply collapses into the history above it; bring the card into view.
  await freshCard.first().scrollIntoViewIfNeeded();
  await page.screenshot(shot('fresh-receipt'));

  // The row the run created.
  const row = list.getByRole('listitem').filter({ hasText: 'Priya Natarajan' });
  await expect(row).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(5);
  await page.screenshot(shot('new-inbox-row'));

  // And the bump is one-shot.
  await page.waitForSelector('.sidebar[data-bump]', { state: 'detached' });

  // A receipt's Open request deep-links the row, and the bar rises once.
  await page.locator('.msg-iris .chat-card.static').filter({ hasText: 'Priya Natarajan' }).getByRole('button').click();
  await page.waitForSelector('.inbox-item[data-highlight]', { state: 'attached' });
  await expect(row).toHaveAttribute('aria-current', 'true');
  await page.waitForSelector('.inbox-item[data-highlight]', { state: 'detached' });
  // A plain click on another row selects without the mark.
  await list.getByRole('listitem').filter({ hasText: 'Leah Martinez' }).click();
  await expect(list.locator('[aria-current="true"]')).toHaveCount(1);
  await expect(list.locator('[data-highlight]')).toHaveCount(0);
});

test('an old session does not animate its receipts on load', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.chat-card.static').first()).toBeVisible();
  await expect(page.locator('.msg-iris[data-fresh]')).toHaveCount(0);
  expect(await animationName(page, '.chat-card.static')).toBe('none');
});

test('an empty conversation offers starters that fill the composer without sending', async ({ page }) => {
  await page.goto('/?data=empty');
  const welcome = page.locator('.chat-welcome');
  await expect(welcome.getByText('What do you need help with?')).toBeVisible();
  const chips = welcome.getByRole('button');
  await expect(chips).toHaveCount(3);
  await page.screenshot(shot('empty-chat-chips'));

  await chips.filter({ hasText: 'Summarize what you did this week' }).click();
  const input = page.getByRole('textbox', { name: 'Message Iris' });
  await expect(input).toHaveValue('Summarize what you did this week');
  await expect(input).toBeFocused();
  await expect(welcome).toBeVisible();
  await expect(page.locator('.msg-user')).toHaveCount(0);
});

test('a waiting run breathes its halo and keeps Stop', async ({ page }) => {
  await page.goto('/?turn=waiting');
  await send(page, 'Review the newest partner application');
  const halo = page.locator('.status-bar .iris-motion[data-state="waiting"] .halo');
  await expect(halo).toBeVisible();
  expect(await halo.evaluate((element) => getComputedStyle(element).animationName)).toBe('glow');
  await expect(page.getByRole('button', { name: 'Stop work' })).toBeVisible();
});

test.describe('prefers-reduced-motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('nothing animates', async ({ page }) => {
    await page.goto('/?turn=proposes_request');
    await page.getByRole('button', { name: /^Inbox/ }).click();
    const list = page.getByRole('list', { name: 'Requests needing review' });
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await send(page, 'Screen the newest applicant');

    const row = list.getByRole('listitem').filter({ hasText: 'Priya Natarajan' });
    await expect(row).toBeVisible();
    // Motion's `initial` is skipped under reduced motion: no transform and full opacity from the first frame.
    expect(await row.evaluate((element) => [getComputedStyle(element).transform, getComputedStyle(element).opacity])).toEqual(['none', '1']);

    const card = page.locator('.msg-iris .chat-card.static').filter({ hasText: 'Priya Natarajan' });
    await expect(card).toBeVisible();
    expect(await card.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
    expect(await page.locator('.sidebar').evaluate((element) => getComputedStyle(element.querySelector('.sidebar-row > .tabular-nums')!).animationName)).toBe('none');

    await card.getByRole('button').click();
    await expect(row).toHaveAttribute('aria-current', 'true');
    expect(await row.evaluate((element) => getComputedStyle(element, '::before').animationName)).toBe('none');
  });
});
