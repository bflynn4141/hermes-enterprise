// The `qa/chat/` screenshots that need the live stack: the scroll model and the
// run surface's order, photographed against `wrangler dev` and the scripted
// provider at an 800 px pane, which is the width the defects were reported at.
import { expect, test, type Page } from '@playwright/test';

const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8788';
const SEED_WORKSPACE = '11111111-1111-4111-8111-111111111111';

async function open(browser: import('@playwright/test').Browser, title: string): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-dev-user': 'maya@nous.example' }, viewport: { width: 1180, height: 900 } });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('hermes:dev-user', 'maya@nous.example');
    } catch {
      /* the header still carries it */
    }
  });
  const page = await context.newPage();
  const response = await page.request.post(`/w/${SEED_WORKSPACE}/sessions`, { data: { title }, headers: { origin: ORIGIN } });
  const id = (await response.json()).id as string;
  await page.goto(`/workspace/${SEED_WORKSPACE}/s/${id}`);
  await expect(page.getByRole('textbox', { name: /^Message/ })).toBeVisible();
  return page;
}

test('chat · the send-scroll and the run surface, live', async ({ browser }) => {
  const page = await open(browser, 'qa · chat scroll');
  await page.getByRole('textbox', { name: /^Message/ }).fill('Screen the applicant.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.pane-iris .msg-user')).toHaveCount(1);
  await page.waitForTimeout(250);
  // The question at the top of the transcript, the reply arriving beneath it.
  await page.screenshot({ path: 'qa/chat/01-after-send.png' });

  await expect(page.getByText(/pending your decision in the Inbox/)).toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(800);
  // Activity above the answer, collapsed to "Done · N steps".
  await page.screenshot({ path: 'qa/chat/02-activity-above-answer.png' });
});
