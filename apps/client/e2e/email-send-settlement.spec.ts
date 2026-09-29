import { expect, test, type Page } from '@playwright/test';

// An approved email whose send was interrupted (Quest audit H1). Hermes never
// retries it; a reviewer checks the mailbox and settles it. The mock marks the
// pilot invitation's first send as uncertain and delivers the second.
const UNCERTAIN = '/?scenario=approvals&uncertainSend=1#inbox/list?reviewer=all';

async function approveInvitation(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(UNCERTAIN);
  const app = page.getByRole('region', { name: 'Application' });
  await app.locator('.inbox-item').filter({ hasText: /Send pilot invitation/ }).click();
  await app.getByRole('button', { name: 'Approve and send' }).click();
  const sends = app.getByRole('region', { name: 'Did the email go out?' });
  await expect(sends.getByText('Taylor Brooks may or may not have received it')).toBeVisible();
  await expect(sends.getByText(/Check the Sent folder of maya@nous\.example/)).toBeVisible();
  // The result never claims nothing went out when the provider did not answer.
  await expect(app.locator('.approval-result-track')).toContainText('may or may not have been sent');
  return { app, sends };
}

test.describe('settling an uncertain email send', () => {
  test('"It was sent" records the send without sending again', async ({ page }) => {
    const { app, sends } = await approveInvitation(page);
    await sends.getByRole('button', { name: 'It was sent' }).click();
    await expect(sends.getByText(/confirmed it was sent/)).toBeVisible();
    await expect(sends.getByRole('button', { name: 'It was sent' })).toHaveCount(0);
    await expect(app.locator('.approval-result-track').getByText('Done', { exact: true })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Approve and send' })).toHaveCount(0);
  });

  test('"It wasn\'t sent" sends nothing until the email is approved again', async ({ page }) => {
    const { app, sends } = await approveInvitation(page);
    await sends.getByRole('button', { name: 'It wasn’t sent' }).click();
    await expect(sends.getByText(/confirmed it wasn’t sent/)).toBeVisible();
    // Back to a decision: the first approval was spent on the attempt.
    await expect(app.getByRole('button', { name: 'Approve and send' })).toBeVisible();
    await expect(app.getByText('Decision and result')).toHaveCount(0);
    await app.getByRole('button', { name: 'Approve and send' }).click();
    await expect(app.locator('.approval-result-track').getByText('Done', { exact: true })).toBeVisible();
    await expect(sends.getByText(/confirmed it wasn’t sent/)).toBeVisible();
    await expect(sends.getByRole('button', { name: /It was/ })).toHaveCount(0);
  });

  test('the answer buttons fit a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { sends } = await approveInvitation(page);
    const box = await sends.getByRole('button', { name: 'It was sent' }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});
