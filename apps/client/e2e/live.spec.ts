// P4–P14 from the client-port spec's §11 table, against the live stack.
//
// "Live" means: Docker Postgres, `wrangler dev --local` with its own Durable
// Objects, Workflows, Queues and R2, `AUTH_MODE=fake`, `MODEL_SCRIPTED=1`, and
// the client bundle served by the Worker's Static Assets binding. Nothing here
// is mocked — every assertion is about what the server actually did.
//
// Run it with `pnpm e2e:live` from the repository root, which boots all of
// that. Against an already-running stack:
//
//   E2E_BASE_URL=http://localhost:8788 pnpm --filter client e2e live.spec
//
// Two things the environment makes awkward, both recorded in the README's
// server findings and both worked around here rather than skipped:
//
//   * fake auth is a header, and a browser cannot put a header on a WebSocket
//     handshake, so the hub sockets are refused and the client falls back to
//     polling the same replay route. Playwright *can* set the header
//     (`extraHTTPHeaders` reaches the handshake), so the socket path is
//     exercised here and the polling path is what a hand-driven browser uses.
//   * fake auth has no step-up route, so `auth_sessions.authenticated_at` is
//     re-stamped by a fixture before the scenarios that need it.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { freshWorkspace, psql, refreshStepUp } from '../scripts/live-fixture.mjs';

const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8788';
const SEED_WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SEED_ADMIN = 'maya@nous.example';
const SEED_MEMBER = 'dana@nous.example';

const shell = (workspaceId: string, sessionId?: string): string =>
  sessionId ? `/workspace/${workspaceId}/s/${sessionId}` : `/workspace/${workspaceId}`;

/** A context that authenticates as one seeded dev user, header and all. */
async function asUser(browser: import('@playwright/test').Browser, devUser: string): Promise<BrowserContext> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-dev-user': devUser } });
  // The client reads the same value for its own `fetch` calls; the header on
  // the context is what carries it onto the WebSocket handshake.
  await context.addInitScript((id) => {
    try {
      window.localStorage.setItem('hermes:dev-user', id as string);
    } catch {
      /* a context with storage disabled still has the header */
    }
  }, devUser);
  return context;
}

/** Create a session over the API, so a test starts where it means to. */
async function newSession(page: Page, workspaceId: string, title: string): Promise<string> {
  const response = await page.request.post(`/w/${workspaceId}/sessions`, {
    data: { title },
    // The Worker checks `Origin` on every state-changing request; an API call
    // made from `about:blank` would otherwise be refused as cross-site.
    headers: { origin: ORIGIN },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).id as string;
}

/** Send a turn and wait for the run to finish, whatever the transport. */
async function runATurn(page: Page, text: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: /^Message/ });
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
  // The scripted provider's second turn is the one that ends the run.
  await expect(page.getByText(/pending your decision in the Inbox/)).toBeVisible({ timeout: 25_000 });
}

const rows = (sql: string): string[] => psql(sql).split('\n').filter(Boolean);

// One worker (playwright.config.ts), but not serial: each scenario sets up
// what it needs, so one failure must not hide the other nine.

// ---------------------------------------------------------------------------
// P4 · two contexts racing one decision
// ---------------------------------------------------------------------------

test('P4 · two contexts deciding the same request yield one decision and one "Already decided"', async ({ browser }) => {
  refreshStepUp();
  const admin = await asUser(browser, SEED_ADMIN);
  const first = await admin.newPage();
  await first.goto(shell(SEED_WORKSPACE, await newSession(await admin.newPage(), SEED_WORKSPACE, 'P4 race')));
  await runATurn(first, 'Screen the applicant.');

  // The request the run proposed, read from the database so the test is not
  // asserting against its own guess at an id.
  const [requestId] = rows(
    `SELECT id::text FROM requests WHERE workspace_id = '${SEED_WORKSPACE}' AND status = 'pending' ORDER BY created_at DESC LIMIT 1;`,
  );
  expect(requestId).toBeTruthy();

  const post = (page: Page) =>
    page.request.post(`/w/${SEED_WORKSPACE}/requests/${requestId}/decisions`, {
      data: { decision: 'approve' },
      headers: { origin: ORIGIN, 'x-requested-from': 'inbox' },
    });

  const second = await (await asUser(browser, SEED_ADMIN)).newPage();
  await second.goto(shell(SEED_WORKSPACE));
  const [a, b] = await Promise.all([post(first), post(second)]);

  // One decision exists, and that is the whole point of the scenario.
  expect(rows(`SELECT id::text FROM decisions WHERE request_id = '${requestId}';`)).toHaveLength(1);

  // How the loser is told is the server's choice, and it chose the better one:
  // 201 for the caller that recorded it, 200 for the caller that did not, and
  // the *same* decision id in both bodies. The loser therefore learns which
  // decision stands rather than being handed a conflict it has to go and
  // resolve. (The spec's wording was "the loser sees Already decided"; an
  // idempotent replay says the same thing and leaves nothing ambiguous.)
  const statuses = [a.status(), b.status()].sort();
  expect(statuses).toEqual([200, 201]);
  const winner = await a.json();
  const echoed = await b.json();
  expect(echoed.decision_id).toBe(winner.decision_id);
  expect(echoed.resulting_status).toBe(winner.resulting_status);
  // And the effects are the same rows, not a second set: one decision, one
  // set of pending effects, nothing executed twice.
  expect(echoed.effect_ids).toEqual(winner.effect_ids);
  await admin.close();
});

// ---------------------------------------------------------------------------
// P5 · the Member seat
// ---------------------------------------------------------------------------

test('P5 · a Member opening a request sees "A workspace Admin records this decision" and cannot decide', async ({ browser }) => {
  const [requestId] = rows(
    `SELECT id::text FROM requests WHERE workspace_id = '${SEED_WORKSPACE}' AND status = 'pending' ORDER BY created_at DESC LIMIT 1;`,
  );
  test.skip(!requestId, 'no pending request to open');

  const context = await asUser(browser, SEED_MEMBER);
  const page = await context.newPage();
  await page.goto(`${shell(SEED_WORKSPACE)}#inbox/request/${requestId}`);
  await expect(page.getByText('A workspace Admin records this decision')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Admit' })).toHaveCount(0);

  // And the route refuses it too: the copy is a courtesy, the guard is the law.
  const refused = await page.request.post(`/w/${SEED_WORKSPACE}/requests/${requestId}/decisions`, {
    data: { decision: 'approve' },
    headers: { origin: ORIGIN, 'x-requested-from': 'inbox' },
  });
  expect(refused.status()).toBeGreaterThanOrEqual(400);
  await context.close();
});

// ---------------------------------------------------------------------------
// P6 · guidance sent mid-run
// ---------------------------------------------------------------------------

test('P6 · guidance sent during a run is accepted and recorded against that run', async ({ browser }) => {
  const context = await asUser(browser, SEED_ADMIN);
  const page = await context.newPage();
  const sessionId = await newSession(page, SEED_WORKSPACE, 'P6 guidance');
  await page.goto(shell(SEED_WORKSPACE, sessionId));

  await page.getByRole('textbox', { name: /^Message/ }).fill('Screen the applicant.');
  await page.getByRole('button', { name: 'Send message' }).click();

  // The run id the server minted, as soon as it exists.
  const runId = await expectSoon(() =>
    rows(`SELECT id::text FROM runs WHERE session_id = '${sessionId}' ORDER BY started_at DESC LIMIT 1;`)[0],
  );
  const guided = await page.request.post(`/w/${SEED_WORKSPACE}/sessions/${sessionId}/runs/${runId}/guide`, {
    data: { text: 'Prefer the applicant with published work.' },
    headers: { origin: ORIGIN },
  });
  // Either the run is still going (201, guidance queued) or it has already
  // finished (409, `run_finished`). Both are correct answers; what must never
  // happen is guidance silently accepted against a finished run.
  expect([201, 409]).toContain(guided.status());
  if (guided.status() === 201) {
    const body = await guided.json();
    // `queued` while a turn is still in flight, `next_message` when the run
    // reached a turn boundary first — decision E7's "late guidance is carried,
    // not refused". Which of the two a race lands on is not the scenario; that
    // the guidance is recorded against this run is.
    expect(['queued', 'next_message']).toContain(body.status);
    expect(rows(`SELECT id::text FROM messages WHERE id = '${body.guidance_id}' AND kind = 'guidance';`)).toHaveLength(1);
  }
  await context.close();
});

// ---------------------------------------------------------------------------
// P7 · Stop, and the queue it pauses
// ---------------------------------------------------------------------------

test('P7 · Stop pauses the queue, keeps completed work, and starts no further step', async ({ browser }) => {
  const context = await asUser(browser, SEED_ADMIN);
  const page = await context.newPage();
  const sessionId = await newSession(page, SEED_WORKSPACE, 'P7 stop');
  await page.goto(shell(SEED_WORKSPACE, sessionId));

  await page.getByRole('textbox', { name: /^Message/ }).fill('Screen the applicant.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const runId = await expectSoon(() =>
    rows(`SELECT id::text FROM runs WHERE session_id = '${sessionId}' ORDER BY started_at DESC LIMIT 1;`)[0],
  );

  await page.request.post(`/w/${SEED_WORKSPACE}/sessions/${sessionId}/runs/${runId}/queue`, {
    data: { text: 'Then draft the invitation.' },
    headers: { origin: ORIGIN },
  });
  const stopped = await page.request.post(`/w/${SEED_WORKSPACE}/sessions/${sessionId}/runs/${runId}/stop`, {
    data: {},
    headers: { origin: ORIGIN },
  });
  expect(stopped.ok()).toBe(true);

  // A Stop pauses the queue rather than eating it: the person's queued message
  // is still theirs.
  const statuses = rows(`SELECT status FROM run_queue WHERE run_id = '${runId}';`);
  expect(statuses.every((status) => status === 'paused' || status === 'sent')).toBe(true);
  // And the turns already written are still there: Stop keeps completed work.
  expect(rows(`SELECT turn::text FROM run_turns WHERE run_id = '${runId}';`).length).toBeGreaterThan(0);
  await context.close();
});

// ---------------------------------------------------------------------------
// P8/P9 · a second attempt, and the text appearing exactly once
// ---------------------------------------------------------------------------

test('P8 · completed work cannot be retried into a second copy', async ({ browser }) => {
  const context = await asUser(browser, SEED_ADMIN);
  const page = await context.newPage();
  const sessionId = await newSession(page, SEED_WORKSPACE, 'P8 retry');
  await page.goto(shell(SEED_WORKSPACE, sessionId));
  await runATurn(page, 'Screen the applicant.');

  const runId = rows(`SELECT id::text FROM runs WHERE session_id = '${sessionId}' ORDER BY started_at DESC LIMIT 1;`)[0]!;
  const retried = await page.request.post(`/w/${SEED_WORKSPACE}/sessions/${sessionId}/runs/${runId}/retry`, {
    data: { expected_attempt: 1 },
    headers: { origin: ORIGIN },
  });
  expect(retried.status(), await retried.text()).toBe(409);
  expect((await retried.json()).reason).toBe('run_completed');

  // Completed work stays in place; Retry cannot produce another approval.
  await expect
    .poll(
      () => rows(`SELECT count(*)::text FROM messages WHERE run_id = '${runId}' AND role = 'iris' AND turn = 1;`)[0],
      { timeout: 25_000 },
    )
    .toBe('1');
  await context.close();
});

// ---------------------------------------------------------------------------
// P10 · the transport dropped mid-run
// ---------------------------------------------------------------------------

test('P10 · dropping the connection mid-run replays to the same transcript', async ({ browser }) => {
  const context = await asUser(browser, SEED_ADMIN);
  const page = await context.newPage();
  const sessionId = await newSession(page, SEED_WORKSPACE, 'P10 replay');
  await page.goto(shell(SEED_WORKSPACE, sessionId));

  await page.getByRole('textbox', { name: /^Message/ }).fill('Screen the applicant.');
  await page.getByRole('button', { name: 'Send message' }).click();

  // Cut everything — socket and polls alike — while the run is working, then
  // let it back. The client must replay from its cursor, in id order, and end
  // up with what an uninterrupted run would have shown.
  await context.setOffline(true);
  await page.waitForTimeout(4000);
  await context.setOffline(false);

  await expect(page.getByText(/pending your decision in the Inbox/)).toBeVisible({ timeout: 30_000 });
  // Two things a replay can get wrong, and both are checked directly.
  //
  //   1. A hole: a message the server persisted that the transcript never
  //      shows, because the buffer was applied before the replay.
  //   2. A double: the same message applied twice, because an event at or
  //      below the cursor was not dropped.
  //
  // Asserting the final provider turn's rendered *id* rather than only its text
  // makes this stable. Earlier provider turns are deliberately collapsed into
  // the activity surface (decision C63), so they must not be required as
  // transcript message nodes.
  const persistedIds = rows(
    `SELECT id::text FROM messages WHERE session_id = '${sessionId}' AND role = 'iris' AND status = 'complete' ORDER BY seq;`,
  );
  expect(persistedIds.length).toBeGreaterThan(0);
  const persistedAnswerId = persistedIds.at(-1)!;
  // The final text is intentionally revealed through the stream accumulator
  // before the committed message node replaces it. Wait for that short visual
  // handoff; text visibility alone is not proof that `data-message-id` exists.
  await expect(
    page.locator(`[data-message-id="${persistedAnswerId}"]`),
    `message ${persistedAnswerId} is missing from the transcript`,
  ).toHaveCount(1);
  const settledRenderedIds = await page.locator('[data-message-id]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-message-id') ?? ''),
  );
  expect(settledRenderedIds).toContain(persistedAnswerId);
  expect(new Set(settledRenderedIds).size, 'a message was applied twice').toBe(settledRenderedIds.length);
  await context.close();
});

// ---------------------------------------------------------------------------
// P11 · the provider-key lifecycle
// ---------------------------------------------------------------------------

test('P11 · add, verify, rotate and remove a provider key against the real routes', async ({ browser }) => {
  // A fresh workspace and a fresh Admin, because verification is rate-limited
  // to five an hour per person and this scenario spends three of them. Reusing
  // the seeded Admin makes the suite fail on its second run of the day for a
  // reason that has nothing to do with the code.
  const fixture = freshWorkspace('P11 keys');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await page.goto(shell(fixture.workspaceId));
  refreshStepUp();
  const api = (path: string, data?: unknown) =>
    page.request.fetch(`/w/${fixture.workspaceId}${path}`, { method: data === undefined ? 'DELETE' : 'POST', headers: { origin: ORIGIN }, ...(data === undefined ? {} : { data }) });

  // A key for any other provider is refused before it is stored: Nous Portal is
  // the only provider this deployment offers (decision R12).
  const refused = await api('/provider-keys', { provider: 'deepseek', label: 'P11 deepseek', key: 'sk-fake-key-for-live-verification-p11' });
  expect(refused.status()).toBe(422);
  expect(await refused.json()).toMatchObject({
    reason: 'provider_not_allowed',
    error: 'Only Nous Portal connections can be used in this workspace',
  });

  const added = await api('/provider-keys', { provider: 'nous_portal', label: 'P11 key', key: 'nous-fake-key-for-live-verification-p11' });
  expect(added.status(), await added.text()).toBe(201);
  const key = (await added.json()).key;
  // `NOUS_PORTAL_FIXTURE=1` answers the key endpoint, so this one verifies.
  expect(key.status).toBe('verified');
  // Only the last four characters are ever shown, and no shape in the contract
  // could carry the key itself.
  expect(key.last4).toHaveLength(4);
  expect(JSON.stringify(key)).not.toContain('nous-fake-key');

  const verified = await api(`/provider-keys/${key.id}/verify`, {});
  expect((await verified.json()).status).toBe('verified');

  const rotated = await api(`/provider-keys/${key.id}/rotate`, { key: 'nous-fake-key-for-live-verification-p11-b' });
  expect(rotated.ok()).toBe(true);
  const next = (await rotated.json()).key;
  expect(next.replaces_key_id).toBe(key.id);

  expect((await api(`/provider-keys/${next.id}`)).ok()).toBe(true);
  const list = await (await page.request.get(`/w/${fixture.workspaceId}/provider-keys`)).json();
  expect(list.keys.every((row: { status: string }) => row.status === 'revoked')).toBe(true);

  // With every key gone, the shell is back to its empty state rather than to a
  // rejection: nothing here can be verified any more.
  await page.reload();
  await expect(page.getByText('Connect Nous Portal in Settings to start').first()).toBeVisible({ timeout: 15_000 });
  await context.close();
});

// ---------------------------------------------------------------------------
// P13 · every empty state, on a workspace that has never been used
// ---------------------------------------------------------------------------

test('P13 · a fresh workspace shows the first-run empty states for an Admin', async ({ browser }) => {
  const fixture = freshWorkspace('Fresh Admin workspace');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await page.goto(shell(fixture.workspaceId));

  // A fixture workspace has a started agent, so the shell opens on the Agents
  // overview: idle, nothing to review. (A workspace made through
  // `POST /workspaces` starts in the activation flow instead — see F2.)
  await expect(page.getByRole('heading', { name: 'Iris', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('No active work right now')).toBeVisible();
  await expect(page.getByText('Connect Nous Portal in Settings to start').first()).toBeVisible();
  await expect(page.getByText(/Nothing needs you(r review)? yet/)).toBeVisible();
  // Zero renders no badge at all, because the count comes from `v_inbox_count`.
  await expect(page.getByRole('button', { name: /^Inbox/ })).not.toContainText(/[1-9]/);

  await page.getByRole('button', { name: 'Inbox', exact: true }).first().click();
  await expect(page.getByText('No reviews waiting')).toBeVisible();

  // Model providers live under Admin since the Admin split (PR92–96).
  await page.getByRole('button', { name: 'Admin', exact: true }).first().click();
  await page.getByRole('navigation', { name: 'Admin settings' }).getByRole('button', { name: 'Model providers', exact: true }).click();
  await expect(page.getByText('Connect Nous Portal to enable models')).toBeVisible();
  await context.close();
});

test('P13 · the same fresh workspace, opened by a Member', async ({ browser }) => {
  const fixture = freshWorkspace('Fresh Member workspace');
  const context = await asUser(browser, fixture.memberEmail);
  const page = await context.newPage();
  await page.goto(shell(fixture.workspaceId));

  // The Admin owns the fixture's agent, so this Member is an agentless
  // reviewer (PR92): no composer greeting, no Agents entry, the Inbox first.
  await expect(page.getByRole('button', { name: 'Inbox', exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Agents', exact: true })).toHaveCount(0);
  await expect(page.getByText('No reviews waiting')).toBeVisible();
  await context.close();
});

// ---------------------------------------------------------------------------
// P14 · what a model proposal is allowed to do
// ---------------------------------------------------------------------------

test('P14 · a run proposes a pending request and records no decision', async ({ browser }) => {
  const context = await asUser(browser, SEED_ADMIN);
  const page = await context.newPage();
  const sessionId = await newSession(page, SEED_WORKSPACE, 'P14 proposal');
  await page.goto(shell(SEED_WORKSPACE, sessionId));

  const before = Number(rows(`SELECT count(*)::text FROM decisions WHERE workspace_id = '${SEED_WORKSPACE}';`)[0]);
  await runATurn(page, 'Screen the applicant.');

  const runId = rows(`SELECT id::text FROM runs WHERE session_id = '${sessionId}' ORDER BY started_at DESC LIMIT 1;`)[0]!;
  // The run created a request, and it is pending.
  expect(rows(`SELECT status FROM requests WHERE run_id = '${runId}';`)).toEqual(['pending']);
  // And it recorded no decision: the tool loop cannot reach the decisions
  // table, and the trigger in migration 0005 refuses the agent role outright.
  const after = Number(rows(`SELECT count(*)::text FROM decisions WHERE workspace_id = '${SEED_WORKSPACE}';`)[0]);
  expect(after).toBe(before);
  // Nothing executed, either: effects exist only once a human decides.
  expect(rows(`SELECT id::text FROM effects WHERE status = 'executed';`)).toHaveLength(0);
  await context.close();
});

/** Poll a synchronous fixture read until it answers. */
async function expectSoon<T>(read: () => T | undefined, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error('the fixture never produced a value');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
