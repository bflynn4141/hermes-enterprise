// Partnerships + Finance: a second employee joins by invitation and becomes the
// Finance principal, against the real Worker and Postgres (`pnpm e2e:live`).
//
// This is the local half of the two-employee rehearsal. Everything here is real:
// the invitation row, the acceptance transaction, the member's own agent, the
// role bindings, and the Admin-only setup and admission routes. What it cannot
// prove locally is native readiness: admission requires both profiles to attest
// over HTTPS from a pinned Hermes runtime, and the local stack has neither. The
// scenario therefore asserts that the gate stays truthfully closed, rather than
// faking a green light (docs/PARTNER-FINANCE-WORKFLOW.md, "Rollout").
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { freshWorkspace, psql } from '../scripts/live-fixture.mjs';

const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8788';
const q = (value: string): string => `'${String(value).replace(/'/g, "''")}'`;
const rows = (sql: string): string[] => psql(sql).split('\n').filter(Boolean);
const pane = (page: Page): Locator => page.getByRole('region', { name: 'Application' });

async function asUser(browser: Browser, devUser: string): Promise<BrowserContext> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-dev-user': devUser } });
  await context.addInitScript((id) => {
    try {
      window.localStorage.setItem('hermes:dev-user', id as string);
    } catch {
      /* a context with storage disabled still has the header */
    }
  }, devUser);
  return context;
}

async function openShell(page: Page, workspaceId: string): Promise<void> {
  await page.goto(`/workspace/${workspaceId}`);
  await expect(page.getByRole('button', { name: 'Agents', exact: true }).first()).toBeVisible({ timeout: 20_000 });
}

test('a second employee is invited, joins, and is bound as Finance; admission stays closed until native attestation', async ({ browser }) => {
  const fixture = freshWorkspace('Partnerships + Finance');
  const admin = await asUser(browser, fixture.adminEmail);
  const adminPage = await admin.newPage();
  await openShell(adminPage, fixture.workspaceId);

  // 1. The Admin invites the Finance employee from the Members screen. Fake
  //    auth needs no WorkOS delivery, so the invitation id is the join token.
  const joinerId = randomUUID();
  const joinerEmail = `finance-${joinerId.slice(0, 8)}@nous.example`;
  psql(`INSERT INTO users (id, email, email_verified, name) VALUES (${q(joinerId)}, ${q(joinerEmail)}, true, 'Alex Rivera');`);
  await adminPage.getByRole('button', { name: 'Members', exact: true }).first().click();
  await adminPage.getByRole('button', { name: 'Invite member' }).click();
  const invite = adminPage.getByRole('dialog', { name: 'Invite member' });
  await invite.getByPlaceholder('name@example.com').fill(joinerEmail);
  await invite.getByRole('button', { name: 'Send invitation' }).click();
  await expect(invite).toBeHidden({ timeout: 15_000 });
  await adminPage.getByRole('tab', { name: 'Invitations' }).click();
  await expect(pane(adminPage).getByText(joinerEmail).first()).toBeVisible({ timeout: 15_000 });
  const token = rows(`SELECT id FROM invitations WHERE workspace_id = ${q(fixture.workspaceId)} AND email = ${q(joinerEmail)} AND status = 'pending';`)[0]!;
  expect(token).toMatch(/^[0-9a-f-]{36}$/);

  // 2. The invited employee accepts through the real join screen and lands in
  //    the workspace as a Member with their own agent.
  const joiner = await asUser(browser, joinerEmail);
  const joinerPage = await joiner.newPage();
  await joinerPage.goto(`/onboarding/join?token=${token}`);
  await joinerPage.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(joinerPage).toHaveURL(new RegExp(`/workspace/${fixture.workspaceId}`), { timeout: 25_000 });
  await expect(joinerPage.getByRole('button', { name: 'Inbox', exact: true }).first()).toBeVisible({ timeout: 20_000 });
  expect(rows(`SELECT role FROM members WHERE workspace_id = ${q(fixture.workspaceId)} AND user_id = ${q(joinerId)};`)).toEqual(['member']);
  const financeAgentId = rows(`
    SELECT ao.agent_id FROM agent_owners ao
      JOIN members m ON m.id = ao.member_id
     WHERE ao.workspace_id = ${q(fixture.workspaceId)} AND m.user_id = ${q(joinerId)}
     ORDER BY ao.created_at LIMIT 1;`)[0]!;
  expect(financeAgentId).toMatch(/^[0-9a-f-]{36}$/);
  expect(financeAgentId).not.toBe(fixture.agentId);

  // 3. The Admin binds the two employees to two distinct agents through the
  //    Library setup form. This is pure database work and needs no runtime.
  await adminPage.getByRole('button', { name: 'Library', exact: true }).first().click();
  const workflow = pane(adminPage);
  await expect(workflow.getByRole('heading', { name: 'Partnerships + Finance', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(workflow.getByText('Employee and agent not assigned')).toHaveCount(2);
  await workflow.getByRole('button', { name: 'Configure roles' }).click();
  const setup = workflow.getByRole('form', { name: 'Configure employee roles' });
  await setup.getByLabel('Partnerships employee user ID').fill(fixture.adminId);
  await setup.getByLabel('Partnerships Hermes agent ID').fill(fixture.agentId);
  await setup.getByLabel('Finance employee user ID').fill(joinerId);
  await setup.getByLabel('Finance Hermes agent ID').fill(financeAgentId);
  await setup.getByRole('button', { name: 'Save role assignments' }).click();
  await expect(workflow.getByText('Role assignments saved. Native readiness is shown above.')).toBeVisible({ timeout: 15_000 });
  await expect(workflow.getByText('Alex Rivera · Iris', { exact: true })).toBeVisible();
  await expect(workflow.getByText('Fresh Admin · Iris', { exact: true })).toBeVisible();
  await expect(workflow.getByText('Workflow disabled', { exact: true })).toBeVisible();

  // The bindings are what the server enforces from now on: a Finance
  // reviewer role on the member, and one active assignment per agent.
  expect(rows(`SELECT 'finance' = ANY(reviewer_roles) FROM members WHERE workspace_id = ${q(fixture.workspaceId)} AND user_id = ${q(joinerId)};`)).toEqual(['t']);
  expect(rows(`
    SELECT et.slug || ':' || esa.skill_key || '@' || esa.skill_version || ':' || esa.state
      FROM enterprise_skill_assignments esa
      JOIN enterprise_teams et ON et.workspace_id = esa.workspace_id AND et.id = esa.team_id
     WHERE esa.workspace_id = ${q(fixture.workspaceId)} AND esa.agent_id IN (${q(fixture.agentId)}, ${q(financeAgentId)})
     ORDER BY 1;`)).toEqual([
    'finance:partner-invoice-review@1.0.1:active',
    'partnerships:partner-program-screening@1.8.0:active',
  ]);

  // 4. Admission is a live attestation of both native profiles. The local
  //    stack has no pinned runtime behind HTTPS, so the honest outcome is a
  //    refusal in words, and the setting stays disabled.
  await workflow.getByRole('button', { name: 'Verify and enable workflow' }).click();
  await expect(workflow.getByRole('alert')).toBeVisible({ timeout: 30_000 });
  await expect(workflow.getByText('Workflow disabled', { exact: true })).toBeVisible();
  expect(rows(`SELECT admission_state FROM partner_workflow_settings WHERE workspace_id = ${q(fixture.workspaceId)};`)).toEqual(['disabled']);
  await adminPage.screenshot({ path: 'qa/live-partner-finance-admin.png', fullPage: true });

  // 5. The Finance employee sees the workflow from their own seat, scoped to
  //    Finance, and cannot rebind roles or open admission.
  await joinerPage.getByRole('button', { name: 'Library', exact: true }).first().click();
  const financeView = pane(joinerPage);
  await expect(financeView.getByRole('heading', { name: 'Partnerships + Finance', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(financeView.getByText('Finance view', { exact: true })).toBeVisible();
  await expect(financeView.getByRole('button', { name: 'Configure roles' })).toHaveCount(0);
  await expect(financeView.getByRole('button', { name: 'Verify and enable workflow' })).toHaveCount(0);
  await joinerPage.screenshot({ path: 'qa/live-partner-finance-member.png', fullPage: true });

  const forbidden = await joinerPage.request.post(`/w/${fixture.workspaceId}/partner-workflow/admission`, {
    data: { enabled: true },
    headers: { origin: ORIGIN },
  });
  expect(forbidden.status(), await forbidden.text()).toBe(403);

  await joiner.close();
  await admin.close();
});
