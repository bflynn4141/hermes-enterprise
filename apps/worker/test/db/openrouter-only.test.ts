// "Only the OpenRouter key can be used, nothing else" (decisions R12, R13).
//
// Five routes ask the same question and this file asks it of all five, against
// the real database and the real Hono app: install a key, verify or rotate one,
// list the catalog, choose a session's model, choose the workspace default, and
// create a run. The sixth test is the other half of the rule — a workspace
// whose default is a model it can no longer run is moved onto one it can, which
// is what stops the composer refusing a turn with advice about a provider the
// Settings screen no longer offers.
//
// `ALLOWED_PROVIDERS: 'openrouter'` is set explicitly on every env here. The
// shared db harness allows every provider on purpose (see its comment), so a
// test that did not say this would be asserting the harness rather than the
// rule.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PROVIDER_NOT_ALLOWED_COPY } from '@hermes/shared';
import type { Tx } from '../../src/db/client.js';
import { addProviderKey, setKeyStatus } from '../../src/keys/store.js';
import { promoteDefaultModel, PREFERRED_DEFAULT_MODEL_ID } from '../../src/keys/default-model.js';
import { syncOpenRouterForKey } from '../../src/keys/catalog-sync.js';
import { loadCatalog, loadCatalogPage } from '../../src/model/catalog.js';
import { openRouterFixtureFetch } from '../../src/model/openrouter-dev.js';
import { syncOpenRouterCatalog } from '../../src/model/openrouter-catalog.js';
import { OPENROUTER_FIXTURE_MODELS } from '../../src/model/openrouter-dev.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const ALLOWED = ['openrouter'];

function kek(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 29 + i * 11) % 256;
  return Buffer.from(bytes).toString('base64');
}
const KEK = { KEK_V1: kek(5) };

/** An env that offers OpenRouter and nothing else, which is every deployment. */
const openRouterOnly = (extra: Record<string, string> = {}) =>
  makeEnv({ ALLOWED_PROVIDERS: 'openrouter', ...KEK, ...extra } as never).env;

const NOT_A_KEY = ['sk', 'or', 'v1', 'NOTAREALOPENROUTERKEY000'].join('-');

async function asTenant<T>(fx: Fixture, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    try {
      const result = await fn(c as unknown as Tx);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

/** A key row for a provider this deployment no longer offers. */
async function addLegacyKey(fx: Fixture, provider: string): Promise<string> {
  return asTenant(fx, async (tx) => {
    const key = await addProviderKey(tx, KEK, {
      workspaceId: fx.workspaceId,
      provider,
      label: 'Legacy',
      plaintext: `sk-legacy-${provider}-00000000`,
      addedBy: fx.adminId,
    });
    await setKeyStatus(tx, fx.workspaceId, key.id, 'verified', ['deepseek-flash']);
    return key.id;
  });
}

async function newSession(fx: Fixture, modelId: string): Promise<string> {
  const id = randomUUID();
  await asTenant(fx, async (tx) => {
    await tx.query(
      `INSERT INTO sessions (id, workspace_id, owner_id, title, mode, model_id)
       VALUES ($1, $2, $3, 'Allowed providers', 'work', $4)`,
      [id, fx.workspaceId, fx.adminId, modelId],
    );
  });
  return id;
}

const refusal = async (response: Response): Promise<{ status: number; reason: string; error: string }> => {
  const body = (await response.json()) as { reason: string; error: string };
  return { status: response.status, reason: body.reason, error: body.error };
};

describe('installing a key for a provider this deployment does not offer', () => {
  it('is refused before the key is stored, with one sentence', async () => {
    const fx = await seedWorkspace();
    const env = openRouterOnly();
    for (const provider of ['deepseek', 'anthropic', 'openai']) {
      const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/provider-keys`, {
        method: 'POST',
        body: { provider, label: 'Nope', key: 'sk-something-that-is-long-enough' },
      });
      expect(await refusal(response)).toEqual({
        status: 422,
        reason: 'provider_not_allowed',
        error: PROVIDER_NOT_ALLOWED_COPY,
      });
    }

    // Nothing was written: the refusal is ahead of the store, so a rejected
    // provider never leaves a row somebody has to notice and remove.
    const rows = await asTenant(fx, (tx) =>
      tx.query<{ count: string }>('SELECT count(*)::text AS count FROM workspace_provider_keys WHERE workspace_id = $1', [
        fx.workspaceId,
      ]),
    );
    expect(rows.rows[0]?.count).toBe('0');
  });

  it('still accepts an OpenRouter key', async () => {
    const fx = await seedWorkspace();
    const env = openRouterOnly({ MODEL_SCRIPTED: '0' });
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/provider-keys`, {
      method: 'POST',
      body: { provider: 'openrouter', label: 'OpenRouter', key: NOT_A_KEY },
    });
    // 201 whatever the probe then said: the key is stored before it is verified
    // (decision 24), and this deployment has no fixture seam, so the probe
    // fails and the row is `unverified`. What matters here is that the
    // provider check let it through.
    expect(response.status).toBe(201);
  });
});

describe('a key installed before the deployment narrowed', () => {
  it('cannot be verified or rotated, and says why', async () => {
    const fx = await seedWorkspace();
    const keyId = await addLegacyKey(fx, 'deepseek');
    const env = openRouterOnly();

    const verified = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/provider-keys/${keyId}/verify`, {
      method: 'POST',
      body: {},
    });
    expect(await refusal(verified)).toMatchObject({ status: 422, reason: 'provider_not_allowed' });

    const rotated = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/provider-keys/${keyId}/rotate`, {
      method: 'POST',
      body: { key: 'sk-a-replacement-key-000000' },
    });
    expect(await refusal(rotated)).toMatchObject({ status: 422, reason: 'provider_not_allowed' });

    // It is still listed, because a credential that exists somewhere is a thing
    // its owner should be told about; the client renders it "no longer usable".
    const listed = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/provider-keys`);
    const keys = ((await listed.json()) as { keys: { id: string; provider: string }[] }).keys;
    expect(keys.map((k) => k.id)).toContain(keyId);
  });
});

describe('the catalog a client sees', () => {
  it('drops the rows of every other provider, seeded ones included', async () => {
    const fx = await seedWorkspace();
    const env = openRouterOnly();
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/catalog?limit=200`);
    expect(response.status).toBe(200);
    const models = ((await response.json()) as { models: { model_id: string; provider: string }[] }).models;
    expect(models.length).toBeGreaterThan(0);
    for (const row of models) expect(row.provider).toBe('openrouter');
    for (const gone of ['deepseek-flash', 'claude-sonnet-4-6', 'claude-opus-4-7', 'gpt-5-5']) {
      expect(models.map((m) => m.model_id)).not.toContain(gone);
    }
  });

  it('marks rather than hides them when the caller has to explain one', async () => {
    // `loadCatalog` is what the settings route validates against: it has to be
    // able to say *why* a model it was handed cannot be the default.
    const fx = await seedWorkspace();
    const rows = await asTenant(fx, (tx) => loadCatalog(tx, fx.workspaceId, ALLOWED));
    const deepseek = rows.find((row) => row.model_id === 'deepseek-flash')!;
    expect(deepseek.enabled).toBe(false);
    expect(deepseek.disabled_code).toBe('provider_not_allowed');
    expect(deepseek.disabled_reason).toBe(PROVIDER_NOT_ALLOWED_COPY);

    // And the filter is a filter, not a marking: the paged form drops them.
    const page = await asTenant(fx, (tx) =>
      loadCatalogPage(tx, fx.workspaceId, { allowed: ALLOWED, onlyAllowed: true, limit: 200 }),
    );
    expect(page.models.every((row) => row.provider === 'openrouter')).toBe(true);
  });
});

describe('choosing a model', () => {
  it('refuses a workspace default outside the allowed providers', async () => {
    const fx = await seedWorkspace();
    const env = openRouterOnly();
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/settings`, {
      method: 'PATCH',
      body: { default_model_id: 'deepseek-flash' },
    });
    expect(await refusal(response)).toMatchObject({ status: 422, reason: 'provider_not_allowed' });
  });

  it('refuses a session model outside the allowed providers', async () => {
    const fx = await seedWorkspace();
    const sessionId = await newSession(fx, PREFERRED_DEFAULT_MODEL_ID);
    const env = openRouterOnly();
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/sessions/${sessionId}`, {
      method: 'PATCH',
      body: { model_id: 'deepseek-flash' },
    });
    expect(await refusal(response)).toMatchObject({ status: 422, reason: 'provider_not_allowed' });
  });

  it('refuses a run on a session that still names one, even scripted', async () => {
    const fx = await seedWorkspace();
    const sessionId = await newSession(fx, 'deepseek-flash');
    // `MODEL_SCRIPTED=1` skips the *key* check, and deliberately not this one:
    // rehearsing a run against a model no deployment can reach is rehearsing
    // nothing.
    const env = openRouterOnly({ MODEL_SCRIPTED: '1' });
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: { text: 'Screen the applicant.', client_turn_id: randomUUID(), attachments: [], mode: 'work' },
    });
    expect(await refusal(response)).toMatchObject({ status: 422, reason: 'provider_not_allowed' });
  });
});

describe('the default a workspace lands on after its key verifies', () => {
  it('moves an unusable default onto Sonnet 5 and carries the sessions with it', async () => {
    const fx = await seedWorkspace();
    const stale = await newSession(fx, 'deepseek-flash');
    const archived = await newSession(fx, 'deepseek-flash');
    await asTenant(fx, async (tx) => {
      await tx.query(`UPDATE workspace_settings SET default_model_id = 'deepseek-flash' WHERE workspace_id = $1`, [
        fx.workspaceId,
      ]);
      await tx.query(`UPDATE sessions SET archived = true WHERE id = $1`, [archived]);
    });

    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await syncOpenRouterCatalog(c as unknown as Tx, OPENROUTER_FIXTURE_MODELS);
      await c.query('COMMIT');
    });

    const promoted = await asTenant(fx, (tx) => promoteDefaultModel(tx, fx.workspaceId, ALLOWED));
    expect(promoted).toMatchObject({ from: 'deepseek-flash', to: PREFERRED_DEFAULT_MODEL_ID });

    const after = await asTenant(fx, async (tx) => {
      const settings = await tx.query<{ default_model_id: string; default_effort: string | null }>(
        'SELECT default_model_id, default_effort FROM workspace_settings WHERE workspace_id = $1',
        [fx.workspaceId],
      );
      const sessions = await tx.query<{ id: string; model_id: string }>(
        'SELECT id, model_id FROM sessions WHERE workspace_id = $1',
        [fx.workspaceId],
      );
      const events = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM events WHERE workspace_id = $1 AND kind = 'settings.changed'`,
        [fx.workspaceId],
      );
      return { settings: settings.rows[0]!, sessions: sessions.rows, events: events.rows[0]!.count };
    });

    expect(after.settings.default_model_id).toBe(PREFERRED_DEFAULT_MODEL_ID);
    // Sonnet through OpenRouter takes low/medium/high and not `max`: an effort
    // the adapter cannot map is a 400 on the first turn (decision 26).
    expect(['low', 'medium', 'high']).toContain(after.settings.default_effort);
    expect(after.sessions.find((row) => row.id === stale)?.model_id).toBe(PREFERRED_DEFAULT_MODEL_ID);
    // Archived sessions are left alone: nobody is going to run one, and
    // rewriting them would edit history to no purpose.
    expect(after.sessions.find((row) => row.id === archived)?.model_id).toBe('deepseek-flash');
    expect(Number(after.events)).toBe(1);
  });

  it('leaves a default that is already usable alone, on every later sync', async () => {
    const fx = await seedWorkspace();
    const keyId = await asTenant(fx, async (tx) => {
      const key = await addProviderKey(tx, KEK, {
        workspaceId: fx.workspaceId,
        provider: 'openrouter',
        label: 'OpenRouter',
        plaintext: NOT_A_KEY,
        addedBy: fx.adminId,
      });
      await setKeyStatus(tx, fx.workspaceId, key.id, 'verified', []);
      return key.id;
    });

    // The real sync path, fixture-fetched: it writes the rows, records the
    // count and runs the promotion in one transaction.
    const runner = <T,>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
      withClient('app', async (c) => {
        await c.query('BEGIN');
        await setTenant(c, fx.workspaceId, fx.adminId);
        try {
          const result = await fn(c as unknown as Tx);
          await c.query('COMMIT');
          return result;
        } catch (error) {
          await c.query('ROLLBACK');
          throw error;
        }
      });

    const credential = { provider: 'openrouter', apiKey: NOT_A_KEY, keyId };
    const first = await syncOpenRouterForKey(runner, { fetch: openRouterFixtureFetch }, fx.workspaceId, keyId, credential, ALLOWED);
    expect(first).not.toBeNull();

    // An Admin who then chooses Gemini keeps Gemini: a sync is not a reason to
    // overrule somebody's choice.
    await asTenant(fx, (tx) =>
      tx.query(`UPDATE workspace_settings SET default_model_id = $2 WHERE workspace_id = $1`, [
        fx.workspaceId,
        'openrouter:google/gemini-3-flash',
      ]),
    );
    await syncOpenRouterForKey(runner, { fetch: openRouterFixtureFetch }, fx.workspaceId, keyId, credential, ALLOWED);

    const held = await asTenant(fx, (tx) =>
      tx.query<{ default_model_id: string }>('SELECT default_model_id FROM workspace_settings WHERE workspace_id = $1', [
        fx.workspaceId,
      ]),
    );
    expect(held.rows[0]?.default_model_id).toBe('openrouter:google/gemini-3-flash');
  });
});
