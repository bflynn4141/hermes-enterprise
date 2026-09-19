import { expect, test } from '@playwright/test';

for (const width of [390, 900, 1280, 1680]) {
  test(`chat content fits its actual pane at window width ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.goto('/?agentSettings=1');
    const chat = page.locator('.pane-iris');
    await expect(chat).toBeVisible();
    const separator = page.getByRole('separator');
    if (width >= 1000) {
      await separator.focus();
      await page.keyboard.press('Home');
    }
    const prompt = `Check this source: https://example.test/${'long-path-segment'.repeat(60)}\n${JSON.stringify({ context: 'unbroken_value_'.repeat(80) })}`;
    await page.getByRole('textbox', { name: 'Message Iris' }).fill(prompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const bubble = chat.locator('.msg-user').filter({ hasText: 'Check this source:' });
    await expect(bubble).toBeVisible();
    const assertFits = async () => {
      expect(await bubble.evaluate((el) => {
        const pane = el.closest('.pane-iris')!.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        return rect.left >= pane.left && rect.right <= pane.right && el.scrollWidth <= el.clientWidth + 1;
      })).toBe(true);
      expect(await chat.evaluate((el) => [...el.querySelectorAll('.iris-header, .composer, .transcript, .chat-card')]
        .filter((node) => node.getBoundingClientRect().width > 0)
        .every((node) => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
    };
    await assertFits();
    if (width >= 1000) {
      await separator.focus();
      await page.keyboard.press('End');
      await assertFits();
      await separator.focus();
      await page.keyboard.press('Home');
      await assertFits();
    }
    await page.screenshot({ path: `qa/chat-responsive-${width}.png` });
  });
}

for (const width of [390, 1680]) test(`assistant Markdown fits at ${width} without widening the transcript`, async ({ page }) => {
  await page.setViewportSize({ width, height: 950 });
  await page.goto('/?reply=markdown');
  await expect(page.locator('.pane-iris .md').first()).toBeVisible();
  if (width >= 1000) {
    await page.getByRole('separator').focus();
    await page.keyboard.press('Home');
  }
  expect(await page.locator('.transcript').evaluate((el) => {
    const pane = el.closest('.pane-iris')!.getBoundingClientRect();
    return el.scrollWidth <= el.clientWidth + 1 && [...el.querySelectorAll('.msg-iris, .chat-card, .md, .md-table-wrap')]
      .every((node) => { const rect = node.getBoundingClientRect(); return rect.left >= pane.left && rect.right <= pane.right; });
  })).toBe(true);
  await page.screenshot({ path: `qa/chat-markdown-responsive-${width}.png` });
});
