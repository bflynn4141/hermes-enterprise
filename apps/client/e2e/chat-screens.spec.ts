// The screenshots for `qa/chat/`: the Markdown subset, in the transcript.
//
// This one runs against the **mock** bundle rather than the live stack, and the
// reason is worth stating: the scripted provider writes one fixed sentence with
// no structure in it, so the only two ways to photograph the renderer inside
// the product are a real provider call — which costs money and needs a verified
// key — or a fixture that says it is a fixture. `?reply=markdown` is the second
// (decision C39, and the mock fixture table in the README).
import { test } from '@playwright/test';

test('chat · a reply that uses the Markdown subset', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.goto('/?reply=markdown');
  await page.getByText('Four requests are ready').first().waitFor();
  await page.waitForTimeout(600);
  // The transcript opens at the bottom; the heading, the table and the list are
  // above it, so this one is taken from the top of the reply.
  await page.evaluate(() => {
    document.querySelector('.pane-iris .scroll')!.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  await page.locator('.pane-iris').screenshot({ path: 'qa/chat/03-markdown-reply.png' });
  await page.evaluate(() => {
    const el = document.querySelector('.pane-iris .scroll')!;
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(200);
  await page.locator('.pane-iris').screenshot({ path: 'qa/chat/04-markdown-reply-tail.png' });
});

test('chat · the same reply at an 800 px pane', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto('/?reply=markdown');
  await page.getByText('Four requests are ready').first().waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'qa/chat/05-markdown-narrow.png' });
});
