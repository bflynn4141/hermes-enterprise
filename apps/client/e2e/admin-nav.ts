// Admin navigation for specs. The rail (or, in the narrow pane, a row of
// section tabs) picks one of three sections; the section's pages are tabs above
// the content (docs/DESIGN.md, Admin). These helpers take the page's label, so
// a spec states the page it wants rather than the width it runs at.
import { expect, type Page } from '@playwright/test';

const app = (page: Page) => page.getByRole('region', { name: 'Application' });

const SECTIONS: Readonly<Record<string, readonly string[]>> = {
  Workspace: ['General', 'Roles', 'Approvals', 'Usage', 'Data & privacy'],
  Agents: ['Agents', 'Models', 'Capacity', 'Shared Intelligence'],
  Connections: ['Overview', 'Slack', 'Email'],
};

export const adminSectionOf = (label: string): string =>
  Object.keys(SECTIONS).find((section) => SECTIONS[section]!.includes(label)) ?? 'Workspace';

export async function openAdminSection(page: Page, section: string): Promise<void> {
  const rail = app(page).getByRole('navigation', { name: 'Admin settings' });
  if (await rail.isVisible()) await rail.getByRole('button', { name: section, exact: true }).click();
  else await app(page).getByRole('tablist', { name: 'Admin sections' }).getByRole('tab', { name: section, exact: true }).click();
}

export async function openAdminPage(page: Page, label: string): Promise<void> {
  const section = adminSectionOf(label);
  const tabs = app(page).getByRole('tablist', { name: `${section} pages` });
  if (!(await tabs.isVisible())) await openAdminSection(page, section);
  await tabs.getByRole('tab', { name: label, exact: true }).click();
}

export async function expectAdminPage(page: Page, label: string): Promise<void> {
  const tabs = app(page).getByRole('tablist', { name: `${adminSectionOf(label)} pages` });
  await expect(tabs.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
}
