// The M5a client scenarios: the tabs that got routes, and the flows that got
// them second.
//
// Everything here runs against the same live stack as `live.spec.ts` — Docker
// Postgres, the migrations, `wrangler dev --local` with `AUTH_MODE=fake` and
// `MODEL_SCRIPTED=1` — and drives the real UI rather than the routes. Where a
// scenario needs a row the scripted provider cannot produce (an instruction
// proposal, a run parked on a context key), the row is inserted with `psql`
// and the *client's* behaviour is what is asserted: the read, the write, and
// what the screen says afterwards.
//
// Six scenarios, in the order the deliverable lists them:
//   M1  a run, then its trace detail: steps, the tool call, its arguments
//   M2  an instruction proposal, accepted by an Admin, refused to a Member
//   M3  a context field answered from the Context tab, which resumes a run
//   M4  usage after a run: the totals and the server's own disclaimer
//   M5  create-workspace and accept-invite, through the stepper
//   M6  workspace delete and undelete, with the confirmation and the step-up
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { freshWorkspace, psql, refreshStepUp } from '../scripts/live-fixture.mjs';

const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8788';
const q = (value: string): string => `'${String(value).replace(/'/g, "''")}'`;
const rows = (sql: string): string[] => psql(sql).split('\n').filter(Boolean);
/**
 * The right-hand app pane.
 *
 * Almost every string this suite asserts also exists in the sidebar's session
 * list or in the transcript — a session called "M4 usage" is a row in three
 * places — so an unscoped `getByText` is a strict-mode violation rather than a
 * failure worth reading. Scope first, assert second.
 */
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

/** Open the shell and wait for the composer's ready line. */
async function openShell(page: Page, workspaceId: string): Promise<void> {
  await page.goto(`/workspace/${workspaceId}`);
  await expect(page.getByRole('button', { name: 'Agents', exact: true }).first()).toBeVisible({ timeout: 20_000 });
}

/**
 * Workspace controls moved out of Settings and under the Admin entry (PR92,
 * then grouped in PR95 and PR96): a group tab strip, then a page index for the
 * group, then the page. Personal Settings kept only what belongs to the person.
 */
async function openAdminPage(page: Page, group: 'Organization' | 'Agents' | 'Connections' | 'Intelligence', item: string): Promise<void> {
  await page.getByRole('button', { name: 'Admin', exact: true }).first().click();
  const app = pane(page);
  await app.getByRole('tab', { name: group }).click();
  await app.getByRole('navigation', { name: `${group} settings pages` }).getByRole('button', { name: item, exact: true }).click();
}

/** A turn through the real route, so the run is a real run. */
async function runTurn(page: Page, workspaceId: string, title: string): Promise<string> {
  const session = await page.request.post(`/w/${workspaceId}/sessions`, {
    data: { title, mode: 'work' },
    headers: { origin: ORIGIN },
  });
  expect(session.status(), await session.text()).toBeLessThan(300);
  const sessionId = (await session.json()).id as string;
  const turn = await page.request.post(`/w/${workspaceId}/sessions/${sessionId}/turns`, {
    // No `model_id`: the session carries the workspace default, which is an
    // Nous Portal id from the seed onwards (decision R13).
    data: { text: 'Screen the applicant.', client_turn_id: randomUUID(), attachments: [], mode: 'work', effort: null },
    headers: { origin: ORIGIN },
  });
  expect(turn.status(), await turn.text()).toBeLessThan(300);
  return sessionId;
}

/** Poll the run until it is no longer working. The engine is a Workflow. */
async function settle(page: Page, workspaceId: string, sessionId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/w/${workspaceId}/traces?session=${sessionId}`);
        const body = await response.json();
        return body.items[0]?.status ?? 'none';
      },
      { timeout: 45_000, intervals: [500] },
    )
    .not.toBe('working');
}

// ---------------------------------------------------------------------------
// M1 · a trace, opened after a run
// ---------------------------------------------------------------------------

test('M1 · the trace detail shows the run\'s steps, its tool call and the arguments', async ({ browser }) => {
  const fixture = freshWorkspace('Trace detail');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await openShell(page, fixture.workspaceId);

  const sessionId = await runTurn(page, fixture.workspaceId, 'M1 trace');
  await settle(page, fixture.workspaceId, sessionId);

  await page.reload();
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click();
  await page.getByRole('tab', { name: 'Traces' }).click();
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await page.getByRole('button', { name: 'Open →' }).first().click();

  // The detail, not the list row. The two are the same entity kind and the
  // list fills half of it, so this is also the regression test for the forced
  // refetch: without it the pane said "This run called no tools" for a run
  // that called one.
  const app = pane(page);
  // The detail heading is the session, the runtime and the mode; the model
  // sits on the fact line beneath it.
  await expect(app.getByRole('heading', { name: /M1 trace · .* · work/ })).toBeVisible({ timeout: 15_000 });
  await expect(app.getByText('nous:anthropic/claude-sonnet-5').first()).toBeVisible();
  await expect(app.getByText('Steps', { exact: true })).toBeVisible();
  await expect(app.getByText('propose_request').first()).toBeVisible();

  await app.getByRole('button', { name: 'Show arguments and result' }).first().click();
  await expect(app.getByText('propose_request.arguments.json')).toBeVisible();
  await expect(app.getByText('propose_request.result.json')).toBeVisible();
  // The result envelope, as the model saw it.
  await expect(app.getByText('"awaiting"').first()).toBeVisible();

  // And nothing on this screen advances the run.
  await expect(app.getByText('Opening a trace never advances a run or decides anything.', { exact: false })).toBeVisible();
  await context.close();
});

// ---------------------------------------------------------------------------
// M2 · an instruction proposal, reviewed
// ---------------------------------------------------------------------------

function proposeInstruction(fixture: ReturnType<typeof freshWorkspace>, body: string): string {
  const id = randomUUID();
  psql(`
    BEGIN;
    SELECT set_config('app.workspace_id', ${q(fixture.workspaceId)}, true);
    SELECT set_config('app.user_id', ${q(fixture.adminId)}, true);
    INSERT INTO instruction_versions (id, workspace_id, agent_id, body, status, proposed_by)
      VALUES (${q(id)}, ${q(fixture.workspaceId)}, ${q(fixture.agentId)}, ${q(body)}, 'proposed', ${q(fixture.adminId)});
    COMMIT;
  `);
  return id;
}

test('M2 · an Admin accepts a proposed instruction; a Member cannot', async ({ browser }) => {
  const fixture = freshWorkspace('Instruction review');
  const proposalId = proposeInstruction(fixture, 'Lead every review with the evidence gaps.');

  // The Member first. The fixture's agent is owned by the Admin, so since the
  // private-agent boundaries (PR92) this Member is an agentless reviewer: the
  // shell opens on the Inbox with no Agents entry at all, and the accept route
  // refuses them whatever the client shows.
  const memberContext = await asUser(browser, fixture.memberEmail);
  const memberPage = await memberContext.newPage();
  await memberPage.goto(`/workspace/${fixture.workspaceId}`);
  await expect(memberPage.getByRole('button', { name: 'Inbox', exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(memberPage.getByRole('button', { name: 'Agents', exact: true })).toHaveCount(0);
  const refused = await memberPage.request.post(`/w/${fixture.workspaceId}/instructions/${proposalId}/accept`, {
    data: {},
    headers: { origin: ORIGIN, 'x-requested-from': 'skills' },
  });
  expect(refused.status(), await refused.text()).toBe(403);
  expect(rows(`SELECT status FROM instruction_versions WHERE id = ${q(proposalId)};`)).toEqual(['proposed']);
  await memberContext.close();

  // The Admin: the DiffTable is there, and so are Accept and Discard.
  const adminContext = await asUser(browser, fixture.adminEmail);
  const adminPage = await adminContext.newPage();
  await openShell(adminPage, fixture.workspaceId);
  await adminPage.getByRole('button', { name: 'Agents', exact: true }).first().click();
  await adminPage.getByRole('tab', { name: 'Skills' }).click();
  const adminApp = pane(adminPage);
  await expect(adminApp.getByRole('heading', { name: 'Suggested instruction change' })).toBeVisible();
  await expect(adminApp.getByText('written by Fresh Admin', { exact: false })).toBeVisible();

  await adminApp.getByRole('button', { name: 'Accept for future runs' }).click();
  // The row moved, in the database, and the screen re-read the list rather
  // than assuming: the tab now says "Current".
  await expect
    .poll(() => rows(`SELECT status FROM instruction_versions WHERE id = ${q(proposalId)};`)[0], { timeout: 10_000 })
    .toBe('saved');
  await expect(adminApp.getByRole('heading', { name: 'Suggested instruction change' })).toHaveCount(0, { timeout: 10_000 });
  await expect(adminApp.getByText('Lead every review with the evidence gaps.').first()).toBeVisible();

  // A second accept is a 409 the client explains rather than a silent move.
  // `X-Requested-From: skills` is what the client sends now: saving a proposal
  // rewrites the standing system prompt, and the route asks which screen issued
  // it for the same reason the decision route does (security review O3).
  const again = await adminPage.request.post(`/w/${fixture.workspaceId}/instructions/${proposalId}/accept`, {
    data: {},
    headers: { origin: ORIGIN, 'x-requested-from': 'skills' },
  });
  expect(again.status()).toBe(409);
  expect((await again.json()).reason).toBe('already_saved');

  // And without it the route refuses, whoever is asking.
  const elsewhere = await adminPage.request.post(`/w/${fixture.workspaceId}/instructions/${proposalId}/accept`, {
    data: {},
    headers: { origin: ORIGIN },
  });
  expect(elsewhere.status()).toBe(403);
  expect((await elsewhere.json()).reason).toBe('wrong_surface');
  await adminContext.close();
});

// ---------------------------------------------------------------------------
// M3 · the human write that resumes a waiting run
// ---------------------------------------------------------------------------

test('M3 · answering the destination from the Context tab writes it and unparks the run', async ({ browser }) => {
  const fixture = freshWorkspace('Context resume');
  const sessionId = randomUUID();
  const runId = randomUUID();
  // A run parked on `destination`, and the empty field it is parked on. The
  // scripted provider has no `ask_for_context` scenario (a server finding), so
  // the two rows the engine would have written are written here; everything
  // after this point is the client and the real PATCH route.
  psql(`
    BEGIN;
    SELECT set_config('app.workspace_id', ${q(fixture.workspaceId)}, true);
    SELECT set_config('app.user_id', ${q(fixture.adminId)}, true);
    INSERT INTO sessions (id, workspace_id, title, mode, model_id, owner_id)
      VALUES (${q(sessionId)}, ${q(fixture.workspaceId)}, 'M3 waiting', 'work', 'nous:anthropic/claude-sonnet-5', ${q(fixture.adminId)});
    INSERT INTO runs (id, workspace_id, session_id, status, waiting_for, waiting_label, model_id, client_turn_id, mode)
      VALUES (${q(runId)}, ${q(fixture.workspaceId)}, ${q(sessionId)}, 'waiting', 'destination', 'Feedback destination', 'nous:anthropic/claude-sonnet-5', ${q(randomUUID())}, 'work');
    INSERT INTO agent_context_fields (workspace_id, agent_id, key, value, scope, run_id)
      VALUES (${q(fixture.workspaceId)}, ${q(fixture.agentId)}, 'destination', NULL, 'reply', ${q(runId)});
    COMMIT;
  `);

  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await openShell(page, fixture.workspaceId);

  // The overview says a reply is paused, and offers the way to unpause it.
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click();
  const app = pane(page);
  await expect(app.getByText('Missing · A reply is paused').first()).toBeVisible({ timeout: 15_000 });
  await app.getByRole('button', { name: 'Add context' }).first().click();

  // The destination form from the demo, against the real PATCH.
  await expect(app.getByRole('heading', { name: 'Feedback destination' })).toBeVisible();
  const field = app.getByPlaceholder('Add a channel, email or link…');
  await field.fill('not a destination');
  await expect(app.getByRole('button', { name: 'Save & resume' })).toBeDisabled();
  await field.fill('#partner-feedback');
  await app.getByRole('button', { name: 'Save & resume' }).click();
  // The form is gone once the answer is in: the pane re-reads the field list
  // from the server, the destination is no longer missing, and what is left is
  // the saved value. The transient "Saved" tick is not asserted — it is an
  // acknowledgement of a state the screen is already showing.
  await expect(app.getByText('#partner-feedback').first()).toBeVisible({ timeout: 10_000 });
  await expect(app.getByRole('button', { name: 'Save & resume' })).toHaveCount(0);

  // The row is written, with its scope, and the run was the one told about it.
  await expect
    .poll(() => rows(`SELECT value FROM agent_context_fields WHERE workspace_id = ${q(fixture.workspaceId)} AND key = 'destination';`)[0], { timeout: 10_000 })
    .toBe('#partner-feedback');
  expect(rows(`SELECT scope FROM agent_context_fields WHERE workspace_id = ${q(fixture.workspaceId)} AND key = 'destination';`)[0]).toBe('reply');
  // `context.set` is the audit row the write appends.
  expect(rows(`SELECT count(*) FROM events WHERE workspace_id = ${q(fixture.workspaceId)} AND kind = 'context.set';`)[0]).toBe('1');

  // And the pane stops saying a reply is paused.
  await app.getByRole('tab', { name: 'Overview' }).click();
  await expect(app.getByText('#partner-feedback').first()).toBeVisible({ timeout: 10_000 });
  await expect(app.getByText('Missing · A reply is paused')).toHaveCount(0);
  await context.close();
});

// ---------------------------------------------------------------------------
// M4 · usage, after a run
// ---------------------------------------------------------------------------

test('M4 · Settings → Usage shows the run\'s tokens and the server\'s disclaimer', async ({ browser }) => {
  const fixture = freshWorkspace('Usage after a run');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await openShell(page, fixture.workspaceId);

  const sessionId = await runTurn(page, fixture.workspaceId, 'M4 usage');
  await settle(page, fixture.workspaceId, sessionId);

  await page.reload();
  await openAdminPage(page, 'Organization', 'Usage');

  // The disclaimer is the server's sentence, rendered beside the total rather
  // than in a footnote. It is asserted verbatim because a client that
  // paraphrased it would be making a claim we cannot stand behind.
  const app = pane(page);
  await expect(
    app.getByText('Estimated, billed by your provider. These figures are our arithmetic over published prices; your provider invoices your own key and is the authority.'),
  ).toBeVisible({ timeout: 20_000 });
  await expect(app.getByText('Tokens', { exact: true })).toBeVisible();

  // The number is the run's, not zero: this is the regression test for the
  // shape mismatch that used to make every usage call a `contract_violation`.
  const total = Number((await page.request.get(`/w/${fixture.workspaceId}/usage?range=7d`).then((r) => r.json())).totals.total_tokens);
  expect(total).toBeGreaterThan(0);
  await expect(app.getByText(total.toLocaleString(), { exact: true }).first()).toBeVisible();

  // By session and by key are the same report, regrouped client-side.
  await app.getByRole('tab', { name: 'By session' }).click();
  await expect(app.getByText('M4 usage').first()).toBeVisible();
  await context.close();
});

// ---------------------------------------------------------------------------
// M5 · onboarding, through the real routes
// ---------------------------------------------------------------------------

test('M5 · create-workspace and accept-invite, driven from the stepper', async ({ browser }) => {
  // A fresh Admin: `POST /workspaces` is three a day per person, and reusing
  // the seeded one makes the suite fail on its fourth run of the day for a
  // reason that has nothing to do with the code.
  const creator = freshWorkspace('Creator seat');
  const context = await asUser(browser, creator.adminEmail);
  const page = await context.newPage();

  await page.goto('/onboarding/create');
  const name = `Stepper ${new Date().toISOString().slice(11, 19)}`;
  await page.getByPlaceholder('e.g. Partner Program').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Add context' }).click();
  await page.getByRole('button', { name: 'Set approvals' }).click();
  await page.getByRole('button', { name: 'Create workspace' }).click();

  // It lands on the shell of the workspace it made, at `/workspace/:ws`.
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}/, { timeout: 25_000 });
  // The creator lands on the activation flow: Iris introduces herself, and
  // the first step of the setup is on screen.
  await expect(page.getByRole('region', { name: 'Activation with Iris' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Your organization has assigned you Iris.', { exact: false })).toBeVisible();
  const createdId = new URL(page.url()).pathname.split('/')[2]!;
  expect(rows(`SELECT role FROM members WHERE workspace_id = ${q(createdId)};`)).toEqual(['admin']);

  // Now an invitation into it, accepted through `/onboarding/join`.
  const joinerId = randomUUID();
  const joinerEmail = `joiner-${joinerId.slice(0, 8)}@nous.example`;
  psql(`INSERT INTO users (id, email, email_verified, name) VALUES (${q(joinerId)}, ${q(joinerEmail)}, true, 'Jo Iner');`);
  const invited = await page.request.post(`/w/${createdId}/invitations`, {
    data: { email: joinerEmail, role: 'member' },
    headers: { origin: ORIGIN },
  });
  expect(invited.status(), await invited.text()).toBe(201);
  const token = (await invited.json()).id as string;
  await context.close();

  const joiner = await asUser(browser, joinerEmail);
  const joinerPage = await joiner.newPage();

  // A forwarded link does not admit whoever opens it. The creator opening the
  // same token is refused, in the words the screen is meant to use.
  const wrongSeat = await asUser(browser, creator.adminEmail);
  const wrongPage = await wrongSeat.newPage();
  await wrongPage.goto(`/onboarding/join?token=${token}`);
  await wrongPage.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(wrongPage.getByText('This invitation was sent to a different address', { exact: false })).toBeVisible({ timeout: 15_000 });
  await wrongSeat.close();

  await joinerPage.goto(`/onboarding/join?token=${token}`);
  // No "Signed in as" line here: `GET /auth/session` answers 404 for somebody
  // who is in no workspace yet, which is exactly who this screen is for, and
  // the client renders the accept without the reassurance rather than
  // inventing an address it was not told.
  await expect(joinerPage.getByRole('button', { name: 'Accept invitation' })).toBeVisible({ timeout: 15_000 });
  await joinerPage.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(joinerPage).toHaveURL(new RegExp(`/workspace/${createdId}`), { timeout: 25_000 });
  await expect(joinerPage.getByRole('button', { name: 'Inbox', exact: true }).first()).toBeVisible({ timeout: 20_000 });
  expect(rows(`SELECT role FROM members WHERE workspace_id = ${q(createdId)} AND user_id = ${q(joinerId)};`)).toEqual(['member']);

  // And the picker at the root path now has that workspace on it.
  await joinerPage.goto('/');
  await expect(joinerPage.getByRole('heading', { name: 'Your workspaces' })).toBeVisible({ timeout: 15_000 });
  await expect(joinerPage.getByText(name).first()).toBeVisible();
  await joiner.close();
});

// ---------------------------------------------------------------------------
// M6 · delete and undelete
// ---------------------------------------------------------------------------

test('M6 · an Admin schedules the workspace for deletion and then cancels it', async ({ browser }) => {
  const fixture = freshWorkspace('Doomed workspace');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await openShell(page, fixture.workspaceId);

  // The five-minute step-up window: re-stamped here so the scenario is about
  // the screen rather than about how long the suite has been running.
  refreshStepUp();

  await openAdminPage(page, 'Organization', 'Workspace details');
  const app = pane(page);
  await app.getByRole('button', { name: 'Delete workspace…' }).click();

  // The confirmation is the workspace's own name, typed.
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  await page.getByPlaceholder(fixture.name).fill(fixture.name);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  // Scheduled, and the immediate half is immediate: sessions read-only.
  await expect(app.getByText('Scheduled for deletion')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => rows(`SELECT deletion_requested_at IS NOT NULL FROM workspaces WHERE id = ${q(fixture.workspaceId)};`)[0], { timeout: 10_000 })
    .toBe('t');
  expect(rows(`SELECT count(*) FROM events WHERE workspace_id = ${q(fixture.workspaceId)} AND kind = 'workspace.deletion_scheduled';`)[0]).toBe('1');
  // The honest sentence, the server's, about when erasure is actually complete.
  await expect(app.getByText('Erasure is therefore complete 30 days after you ask', { exact: false })).toBeVisible();

  // And the cancel, which is on the same screen and not in a runbook.
  await app.getByRole('button', { name: 'Cancel deletion' }).click();
  await page.getByRole('button', { name: 'Cancel deletion' }).last().click();
  await expect(app.getByRole('button', { name: 'Delete workspace…' })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => rows(`SELECT deletion_requested_at IS NULL FROM workspaces WHERE id = ${q(fixture.workspaceId)};`)[0], { timeout: 10_000 })
    .toBe('t');
  expect(rows(`SELECT count(*) FROM events WHERE workspace_id = ${q(fixture.workspaceId)} AND kind = 'workspace.deletion_cancelled';`)[0]).toBe('1');
  await context.close();
});

// ---------------------------------------------------------------------------
// M7 · the empty states, re-verified on the tabs that now have routes
// ---------------------------------------------------------------------------

/**
 * Every screen of a workspace nobody has used yet, both seats.
 *
 * `live.spec.ts` P13 already sweeps the shell, the Inbox and Provider keys.
 * This is the rest: the four Agent tabs, History, Members, the Library and the
 * three Settings tabs that read routes which did not exist when P13 was
 * written. The point is not that they are empty — it is that each of them says
 * what is empty and why, rather than rendering nothing or "Not available yet".
 */
async function sweepEmptyStates(page: Page): Promise<void> {
  const app = pane(page);

  await page.getByRole('button', { name: 'Agents', exact: true }).first().click();
  // Two honest sentences, depending on whether the workspace has an automated
  // partner check: neither says anything needs a person yet.
  await expect(app.getByText(/Nothing needs you(r review)? yet/)).toBeVisible({ timeout: 15_000 });

  await app.getByRole('tab', { name: 'Context' }).click();
  await expect(app.getByText('No sources yet')).toBeVisible();

  await app.getByRole('tab', { name: 'Skills' }).click();
  await expect(app.getByText('No standing instructions saved yet')).toBeVisible();
  await expect(app.getByText('No skills assigned yet.')).toBeVisible();

  await app.getByRole('tab', { name: 'Traces' }).click();
  await expect(app.getByText('No runs yet.')).toBeVisible();

  await page.getByRole('button', { name: 'History', exact: true }).first().click();
  await expect(app.getByText('No decisions yet').first()).toBeVisible();

  await page.getByRole('button', { name: 'Members', exact: true }).first().click();
  // Two rows, because `freshWorkspace` seeds an Admin and a Member — the
  // empty state that matters on this screen is the invitations tab.
  await app.getByRole('tab', { name: 'Invitations' }).click();
  await expect(app.getByText('No open invitations')).toBeVisible();

  await page.getByRole('button', { name: 'Library', exact: true }).first().click();
  await expect(app.getByText('No shared skills yet')).toBeVisible();
  await app.getByRole('tab', { name: 'Documents' }).click();
  await expect(app.getByText('No documents created yet.')).toBeVisible();
  // Connections now report the real, unconfigured state of each source.
  await app.getByRole('tab', { name: 'Connections' }).click();
  await expect(app.getByText('Read-only Gmail is not configured')).toBeVisible();
  await expect(app.getByText('Outbound sender is not connected')).toBeVisible();

  await openAdminPage(page, 'Organization', 'Usage');
  await expect(app.getByText('No usage yet')).toBeVisible({ timeout: 15_000 });

  await openAdminPage(page, 'Agents', 'Agent defaults');
  // Not an empty state: the Nous Portal rows are there — the default's row is
  // written by migration 0016 — and each says *why* it cannot be chosen. That
  // is the honest shape: "no models" would be wrong, and a silent list of
  // disabled rows would be worse. Only Nous Portal rows are listed, because the
  // others are not offered by this deployment at all (decision R12).
  await expect(app.getByRole('menuitemradio', { name: /Catalog sync required/ })).toBeDisabled();
  await expect(app.getByText('Daily token cap')).toBeVisible();

  await openAdminPage(page, 'Organization', 'Data & privacy');
  await expect(app.getByText('No provider is configured, so no prompt text leaves this workspace.')).toBeVisible({ timeout: 15_000 });
  // The retention facts are the server's and are there with or without a key.
  await expect(app.getByText('Database point-in-time history')).toBeVisible();
  await expect(app.getByText('Erasure is therefore complete 30 days after you ask', { exact: false })).toBeVisible();

  await openAdminPage(page, 'Organization', 'Workspace details');
  await expect(app.getByRole('button', { name: 'Delete workspace…' })).toBeVisible();
}

/**
 * The Member seat in a fixture workspace is an agentless reviewer (PR92): the
 * Admin owns the only agent, so there is no Agents entry, no session composer
 * and no Admin entry. What is left is the review side of the product.
 */
async function sweepMemberEmptyStates(page: Page): Promise<void> {
  const app = pane(page);
  await expect(page.getByRole('button', { name: 'Agents', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Admin', exact: true })).toHaveCount(0);

  await expect(app.getByText('No reviews waiting')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'History', exact: true }).first().click();
  await expect(app.getByText('No decisions yet').first()).toBeVisible();

  await page.getByRole('button', { name: 'Members', exact: true }).first().click();
  await expect(app.getByText("Read-only. Roles and removals are an Admin's.")).toBeVisible();
  await expect(app.getByRole('button', { name: 'Invite member' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Library', exact: true }).first().click();
  await app.getByRole('tab', { name: 'Documents' }).click();
  await expect(app.getByText('No documents created yet.')).toBeVisible();

  // Personal settings only: nothing here decides anything for the workspace.
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await expect(app.getByRole('tab', { name: 'Notifications' })).toBeVisible();
  await expect(app.getByRole('tab', { name: 'Organization' })).toHaveCount(0);
  await expect(app.getByRole('tab', { name: 'Provider keys' })).toHaveCount(0);
  await expect(app.getByRole('button', { name: 'Delete workspace…' })).toHaveCount(0);
}

test('M7 · every empty state on a fresh workspace, for an Admin', async ({ browser }) => {
  const fixture = freshWorkspace('Empty Admin sweep');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await openShell(page, fixture.workspaceId);
  await expect(page.getByText('Connect Nous Portal in Settings to start').first()).toBeVisible();
  await sweepEmptyStates(page);
  await context.close();
});

test('M7 · every empty state on a fresh workspace, for a Member', async ({ browser }) => {
  const fixture = freshWorkspace('Empty Member sweep');
  const context = await asUser(browser, fixture.memberEmail);
  const page = await context.newPage();
  await page.goto(`/workspace/${fixture.workspaceId}`);
  await expect(page.getByRole('button', { name: 'Inbox', exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await sweepMemberEmptyStates(page);
  await context.close();
});

// ---------------------------------------------------------------------------
// M8 · signed out, and reconnecting
// ---------------------------------------------------------------------------

test('M8 · a 401 mid-session shows "Signed out" and keeps the draft', async ({ browser }) => {
  const fixture = freshWorkspace('Signed out');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await openShell(page, fixture.workspaceId);

  // A session, because the composer belongs to one: a fresh workspace has no
  // session and therefore nothing to type into.
  const session = await page.request.post(`/w/${fixture.workspaceId}/sessions`, {
    data: { title: 'M8 signed out', mode: 'work' },
    headers: { origin: ORIGIN },
  });
  const sessionId = (await session.json()).id as string;
  await page.goto(`/workspace/${fixture.workspaceId}/s/${sessionId}`);
  await page.getByRole('textbox', { name: /^Message/ }).fill('a half-typed reply');

  // Every request from here on is a 401 that is not a step-up, which is the
  // shape of an expired session. The banner is the blocking one, and it says
  // where the draft went, because that is the question somebody actually has.
  await page.route('**/w/**', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'sign in again', reason: 'unauthenticated' }) }),
  );
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(page.getByText('Signed out. Sign in again to continue — your draft is saved.')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Message/ })).toHaveValue('a half-typed reply');
  await context.close();
});

test('M8 · losing the connection shows "Reconnecting…" and it clears on its own', async ({ browser }) => {
  // Deliberately slow. The socket's silence timer is 60 seconds (`SILENCE_MS`)
  // and an offline tab in Chromium does not always get a close event, so this
  // is the real latency of noticing — shortening it here would be testing a
  // number the product does not use.
  test.setTimeout(180_000);
  const fixture = freshWorkspace('Reconnecting');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await openShell(page, fixture.workspaceId);

  await context.setOffline(true);
  await expect(page.getByText('Reconnecting…')).toBeVisible({ timeout: 90_000 });
  await context.setOffline(false);
  await expect(page.getByText('Reconnecting…')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText('What do you need help with?')).toBeVisible();
  await context.close();
});
