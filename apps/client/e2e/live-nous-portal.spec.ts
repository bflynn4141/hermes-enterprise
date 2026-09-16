// The Nous Portal scenario, end to end, with no network and no key.
//
// What it proves, in one pass through the real UI against the real Worker:
//
//   1. Settings > Provider keys offers Nous Portal, and adding a key verifies it.
//      The key is a string this file invents; `NOUS_PORTAL_FIXTURE=1` makes the
//      Worker answer the minimal `/chat/completions` verification and `/models`
//      from the built-in fixture instead of the network (see
//      `model/nous-dev.ts`, and the
//      README's Nous Portal section). The seam is refused outside
//      `ENVIRONMENT=development`, which is why this scenario cannot exist in
//      staging and why there is no key in this repository.
//   2. The row then says how many models were synced and when, and offers
//      "Sync models".
//   3. The synced rows reach the chat's model menu, grouped by vendor, priced,
//      searchable, with the tool-less one greyed and explained.
//   4. Picking one sets the session's model, and a run still goes through the
//      scripted provider — `MODEL_SCRIPTED=1` means no Nous Portal call is made
//      by a turn either.
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { freshWorkspace, psql, refreshStepUp } from '../scripts/live-fixture.mjs';

const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8788';

/** Not a key. Twenty characters of nothing, which is all the route requires. */
const FAKE_KEY = ['nous', 'fixture', '0'.repeat(24)].join('-');

async function asUser(browser: Browser, devUser: string): Promise<BrowserContext> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-dev-user': devUser } });
  await context.addInitScript((id) => {
    try {
      window.localStorage.setItem('hermes:dev-user', id as string);
    } catch {
      /* the header still identifies the user */
    }
  }, devUser);
  return context;
}

const pane = (page: Page) => page.getByRole('region', { name: 'Application' });

test.describe('Nous Portal, added through Settings and picked in the composer', () => {
  test('R1 verifies a key, syncs the model list, and offers it in the model menu', async ({ browser }) => {
    const fixture = freshWorkspace('Nous Portal live');
    refreshStepUp();

    const context = await asUser(browser, fixture.adminId);
    const page = await context.newPage();
    await page.goto(`/workspace/${fixture.workspaceId}`);
    await expect(page.getByRole('button', { name: 'Agents', exact: true }).first()).toBeVisible({ timeout: 20_000 });

    // --- 1. add the key through the real route the Settings dialog calls -----
    // Driven through `page.request` rather than the dialog because the dialog's
    // step-up redirect is `live-m5a.spec.ts`'s scenario, not this one; what is
    // being proved here is the sync and the menu.
    refreshStepUp();
    const added = await page.request.post(`/w/${fixture.workspaceId}/provider-keys`, {
      data: { provider: 'nous_portal', label: 'Nous Portal', key: FAKE_KEY },
      headers: { origin: ORIGIN },
    });
    expect(added.status(), await added.text()).toBe(201);
    const body = (await added.json()) as { key: { id: string; status: string }; verification: { status: string } };
    expect(body.verification.status).toBe('verified');

    // --- 2. the sync wrote catalog rows, and the key row counts them --------
    const synced = psql(
      `SELECT count(*) FROM catalog WHERE provider = 'nous_portal' AND source = 'provider_list' AND disabled_reason IS NULL`,
    );
    expect(Number(synced)).toBeGreaterThanOrEqual(4);

    const keys = await page.request.get(`/w/${fixture.workspaceId}/provider-keys`);
    const keyRow = ((await keys.json()) as { keys: { provider: string; synced_model_count: number | null; models_synced_at: string | null }[] }).keys.find(
      (k) => k.provider === 'nous_portal',
    )!;
    expect(keyRow.synced_model_count).toBeGreaterThanOrEqual(4);
    expect(keyRow.models_synced_at).not.toBeNull();

    // --- 3. the catalog route pages and searches ----------------------------
    const search = await page.request.get(`/w/${fixture.workspaceId}/catalog?q=llama&limit=10`);
    const searched = (await search.json()) as { models: { model_id: string; enabled: boolean; disabled_reason: string | null; supports_tools: boolean }[] };
    const llama = searched.models.find((m) => m.model_id.includes('llama'))!;
    // Listed, and greyed with the reason — the run engine needs tool calling.
    expect(llama.supports_tools).toBe(false);
    expect(llama.enabled).toBe(false);
    expect(llama.disabled_reason).toContain('tool calling');

    // --- 4. the model menu shows them, grouped and priced -------------------
    // A fresh workspace has no session, and the composer belongs to one.
    const created = await page.request.post(`/w/${fixture.workspaceId}/sessions`, {
      data: { title: 'Pick a model', mode: 'ask' },
      headers: { origin: ORIGIN },
    });
    expect(created.status(), await created.text()).toBeLessThan(300);
    const sessionId = ((await created.json()) as { id: string }).id;

    await page.goto(`/workspace/${fixture.workspaceId}/s/${sessionId}`);
    const composer = page.getByRole('textbox', { name: /^Message / });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /^Model: / }).click();

    const menu = page.getByRole('dialog', { name: 'Model' });
    await expect(menu).toBeVisible();
    await expect(menu.getByText('anthropic', { exact: true })).toBeVisible();

    await menu.getByRole('textbox', { name: 'Search models' }).fill('gemini');
    const gemini = menu.getByRole('menuitemradio', { name: /Gemini/ });
    await expect(gemini).toBeVisible();
    // The price line is the catalog's, per million, marked as an estimate.
    await expect(menu.getByText(/\/M est\./).first()).toBeVisible();

    await gemini.click();
    await expect(page.getByRole('button', { name: /^Model: .*Gemini/ })).toBeVisible();

    // The session now names a Nous Portal model, by the `nous:` id.
    await expect
      .poll(() => psql(`SELECT model_id FROM sessions WHERE id = '${sessionId}'`), { timeout: 10_000 })
      .toContain('nous:');

    await context.close();
  });

  test('R3 a fresh workspace lands on Sonnet 5 and can take a turn without picking a model', async ({ browser }) => {
    // The scenario this milestone is about (decisions R12, R13). A workspace
    // that has never been used starts on `nous:anthropic/claude-sonnet-5`
    // — a placeholder row migration 0024 wrote, disabled until a key exists —
    // and the person's first action is to paste their Nous Portal key. What must
    // not then happen is a composer refusing the first message with advice
    // about a provider Settings no longer offers.
    const fixture = freshWorkspace('Nous Portal default');
    refreshStepUp();
    const context = await asUser(browser, fixture.adminId);
    const page = await context.newPage();
    await page.goto(`/workspace/${fixture.workspaceId}`);
    await expect(page.getByRole('button', { name: 'Agents', exact: true }).first()).toBeVisible({ timeout: 20_000 });

    // Before the key: the default is already the Nous Portal id, and the model
    // menu says what to do rather than showing a DeepSeek row nobody can pick.
    expect(psql(`SELECT default_model_id FROM workspace_settings WHERE workspace_id = '${fixture.workspaceId}'`)).toBe(
      'nous:anthropic/claude-sonnet-5',
    );
    // And now the harder half: a workspace created *before* this deployment
    // narrowed to Nous Portal, whose default is a DeepSeek row the product no
    // longer offers. Verifying the key is what moves it (decision R13).
    psql(`UPDATE workspace_settings SET default_model_id = 'deepseek-flash' WHERE workspace_id = '${fixture.workspaceId}'`);

    const before = await page.request.get(`/w/${fixture.workspaceId}/catalog?limit=200`);
    const beforeRows = ((await before.json()) as { models: { provider: string; enabled: boolean }[] }).models;
    expect(beforeRows.length).toBeGreaterThan(0);
    expect(beforeRows.every((row) => row.provider === 'nous_portal')).toBe(true);
    expect(beforeRows.every((row) => row.enabled === false)).toBe(true);

    refreshStepUp();
    const added = await page.request.post(`/w/${fixture.workspaceId}/provider-keys`, {
      data: { provider: 'nous_portal', label: 'Nous Portal', key: FAKE_KEY },
      headers: { origin: ORIGIN },
    });
    expect(added.status(), await added.text()).toBe(201);

    // The default has moved off DeepSeek and onto Sonnet 5, which is now a real
    // row with a real price.
    expect(psql(`SELECT default_model_id FROM workspace_settings WHERE workspace_id = '${fixture.workspaceId}'`)).toBe(
      'nous:anthropic/claude-sonnet-5',
    );
    const sonnet = await page.request.get(`/w/${fixture.workspaceId}/catalog?q=sonnet-5&limit=10`);
    const row = ((await sonnet.json()) as { models: { model_id: string; enabled: boolean; source: string }[] }).models.find(
      (model) => model.model_id === 'nous:anthropic/claude-sonnet-5',
    )!;
    expect(row.enabled).toBe(true);
    expect(row.source).toBe('provider_list');

    // A session inherits it, and a turn runs without anybody opening the menu.
    const created = await page.request.post(`/w/${fixture.workspaceId}/sessions`, {
      data: { title: 'First message', mode: 'work' },
      headers: { origin: ORIGIN },
    });
    expect(created.status(), await created.text()).toBeLessThan(300);
    const session = (await created.json()) as { id: string; model_id: string };
    expect(session.model_id).toBe('nous:anthropic/claude-sonnet-5');

    const turn = await page.request.post(`/w/${fixture.workspaceId}/sessions/${session.id}/turns`, {
      data: { text: 'Screen the applicant.', client_turn_id: randomUUID(), attachments: [], mode: 'work' },
      headers: { origin: ORIGIN },
    });
    // Not 409 "Add a deepseek key in Settings to start", which is the failure
    // this whole scenario exists to prove is gone.
    expect(turn.status(), await turn.text()).toBeLessThan(300);

    await context.close();
  });

  test('R2 removes the key, and the synced rows go back to "add a key"', async ({ browser }) => {
    const fixture = freshWorkspace('Nous Portal removal');
    refreshStepUp();
    const context = await asUser(browser, fixture.adminId);
    const page = await context.newPage();
    await page.goto(`/workspace/${fixture.workspaceId}`);
    await expect(page.getByRole('button', { name: 'Agents', exact: true }).first()).toBeVisible({ timeout: 20_000 });

    refreshStepUp();
    const added = await page.request.post(`/w/${fixture.workspaceId}/provider-keys`, {
      data: { provider: 'nous_portal', label: 'Nous Portal', key: FAKE_KEY },
      headers: { origin: ORIGIN },
    });
    expect(added.status(), await added.text()).toBe(201);
    const keyId = ((await added.json()) as { key: { id: string } }).key.id;

    const offered = async (): Promise<boolean> => {
      const response = await page.request.get(`/w/${fixture.workspaceId}/catalog?provider=nous_portal&limit=10`);
      const models = ((await response.json()) as { models: { enabled: boolean }[] }).models;
      return models.some((m) => m.enabled);
    };
    expect(await offered()).toBe(true);

    refreshStepUp();
    const removed = await page.request.delete(`/w/${fixture.workspaceId}/provider-keys/${keyId}`, {
      headers: { origin: ORIGIN },
    });
    expect(removed.status(), await removed.text()).toBeLessThan(300);

    // The rows stay in the catalog — they are global, and another workspace may
    // hold a key — but this workspace is back to the empty state with an action.
    expect(await offered()).toBe(false);
    const response = await page.request.get(`/w/${fixture.workspaceId}/catalog?provider=nous_portal&limit=10`);
    const first = ((await response.json()) as { models: { disabled_code: string; disabled_reason: string }[] }).models[0]!;
    expect(first.disabled_code).toBe('no_key');
    expect(first.disabled_reason).toContain('Settings');

    await context.close();
  });
});
