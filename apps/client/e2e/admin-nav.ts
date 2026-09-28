// Admin navigation for specs. Wide panes show the page rail; the narrow side
// pane shows one "Admin pages" menu instead (docs/DESIGN.md, Admin). These
// helpers use whichever the layout rendered, so a spec states the page it
// wants rather than the width it runs at.
import { expect, type Page } from '@playwright/test';

const app = (page: Page) => page.getByRole('region', { name: 'Application' });

export async function openAdminPage(page: Page, label: string): Promise<void> {
  const rail = app(page).getByRole('navigation', { name: 'Admin settings' });
  if (await rail.isVisible()) {
    await rail.getByRole('button', { name: label, exact: true }).click();
    return;
  }
  await app(page).getByRole('button', { name: /^Admin pages/ }).click();
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
}

export async function expectAdminPage(page: Page, label: string): Promise<void> {
  const rail = app(page).getByRole('navigation', { name: 'Admin settings' });
  if (await rail.isVisible()) {
    await expect(rail.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
    return;
  }
  await expect(app(page).getByRole('button', { name: `Admin pages. Current page: ${label}` })).toBeVisible();
}
