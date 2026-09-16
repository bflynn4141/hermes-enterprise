// OpenRouter against the real database.
//
// What only exists once there is a Postgres underneath: that the sync writes
// rows through the SECURITY DEFINER function rather than a table grant, that
// running it twice writes the same thing, that a seeded row cannot be
// overwritten by a sync no matter what the payload says, that a synced row is
// offered only to a workspace holding a verified OpenRouter key, and that the
// catalog route's search and paging actually narrow the query rather than the
// response.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CATALOG_SEED } from '@hermes/shared';
import type { Tx } from '../../src/db/client.js';
import { addProviderKey, recordModelSync, listProviderKeys, setKeyStatus } from '../../src/keys/store.js';
import { needsProbeModel } from '../../src/keys/reverify.js';
import { probeKey, recordVerification } from '../../src/keys/verify.js';
import { loadCatalog, loadCatalogPage, loadModel } from '../../src/model/catalog.js';
import { normaliseModels, syncOpenRouterCatalog } from '../../src/model/openrouter-catalog.js';
import { OPENROUTER_FIXTURE_MODELS, openRouterFixtureFetch } from '../../src/model/openrouter-dev.js';
import { OpenRouterProvider } from '../../src/model/openrouter.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

function kek(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 23 + i * 7) % 256;
  return Buffer.from(bytes).toString('base64');
}
const ENV = { KEK_V1: kek(3) };

const OR_KEY = ['sk', 'or', 'v1', 'NOTAREALOPENROUTERKEY000'].join('-');

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

/** The same, as the `app` role: the role the route actually runs under. */
async function asApp<T>(fx: Fixture, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withClient('app', async (c) => {
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

async function addVerifiedOpenRouterKey(fx: Fixture): Promise<string> {
  return asTenant(fx, async (tx) => {
    const key = await addProviderKey(tx, ENV, {
      workspaceId: fx.workspaceId,
      provider: 'openrouter',
      label: 'OpenRouter',
      plaintext: OR_KEY,
      addedBy: fx.adminId,
    });
    await setKeyStatus(tx, fx.workspaceId, key.id, 'verified', []);
    return key.id;
  });
}

describe('the openrouter provider value', () => {
  it('is accepted by the key table’s CHECK', async () => {
    const fx = await seedWorkspace();
    const keyId = await addVerifiedOpenRouterKey(fx);
    const keys = await asTenant(fx, (tx) => listProviderKeys(tx, fx.workspaceId));
    expect(keys.find((k) => k.id === keyId)?.provider).toBe('openrouter');
  });

  it('needs no catalog row to verify against, unlike every other provider', async () => {
    // The first OpenRouter key in a deployment is added when the catalog holds
    // no OpenRouter row at all — the rows arrive from the sync that this very
    // verification triggers — so requiring a probe model would make that key
    // permanently unverifiable. `nous_portal` is the control: it has no adapter
    // and no rows either, and it still requires one.
    expect(needsProbeModel('openrouter')).toBe(false);
    expect(needsProbeModel('anthropic')).toBe(true);
    expect(needsProbeModel('deepseek')).toBe(true);
    expect(needsProbeModel('openai')).toBe(true);
  });
});

describe('syncing the OpenRouter model list', () => {
  it('writes rows as the app role, which has only SELECT on the table', async () => {
    const fx = await seedWorkspace();
    // A direct write is refused: the grant is SELECT, and 0015 did not widen it.
    await expect(
      asApp(fx, (tx) =>
        tx.query("INSERT INTO catalog (model_id, provider, label, transport, pricing_per_million, pricing_verified_on) VALUES ('x','openrouter','x','openrouter_chat','{}'::jsonb, now())"),
      ),
    ).rejects.toThrow();

    const result = await asApp(fx, (tx) => syncOpenRouterCatalog(tx, OPENROUTER_FIXTURE_MODELS));
    // Five of the seven fixture entries are usable. The image-only endpoint and
    // the one with no prompt price are skipped; the tool-less one is written,
    // because a model you can see and cannot pick is better than an absence.
    expect(result.written).toBe(5);
    expect(result.skipped).toBe(2);
  });

  it('is idempotent: a second sync of the same list leaves the same rows', async () => {
    const fx = await seedWorkspace();
    await asApp(fx, (tx) => syncOpenRouterCatalog(tx, OPENROUTER_FIXTURE_MODELS));
    const first = await asTenant(fx, (tx) => loadCatalogPage(tx, fx.workspaceId, { provider: 'openrouter', limit: 200 }));
    await asApp(fx, (tx) => syncOpenRouterCatalog(tx, OPENROUTER_FIXTURE_MODELS));
    const second = await asTenant(fx, (tx) => loadCatalogPage(tx, fx.workspaceId, { provider: 'openrouter', limit: 200 }));
    expect(second.models).toEqual(first.models);
  });

  it('refuses a fixture-sized response instead of retiring a live catalog', async () => {
    const fx = await seedWorkspace();
    const liveSized = {
      data: Array.from({ length: 30 }, (_, index) => ({
        id: `safety/model-${index}`,
        name: `Safety model ${index}`,
        context_length: 16_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000002' },
        supported_parameters: ['tools'],
      })),
    };

    await withClient('app', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      try {
        await syncOpenRouterCatalog(client as unknown as Tx, liveSized);
        await expect(syncOpenRouterCatalog(client as unknown as Tx, OPENROUTER_FIXTURE_MODELS)).rejects.toThrow(
          'refusing suspicious OpenRouter catalog shrink from 30 to 5 models',
        );
        const result = await client.query<{ active: string }>(
          `SELECT count(*)::text AS active
             FROM catalog
            WHERE provider = 'openrouter'
              AND model_id LIKE 'openrouter:safety/%'
              AND disabled_reason IS NULL`,
        );
        expect(result.rows[0]?.active).toBe('30');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  it('refuses an empty response instead of retiring any catalog row', async () => {
    const fx = await seedWorkspace();
    await expect(asApp(fx, (tx) => syncOpenRouterCatalog(tx, { data: [] }))).rejects.toThrow(
      'refusing to replace the OpenRouter catalog with an empty response',
    );
  });

  it('computes the price per million from the per-token strings', async () => {
    const fx = await seedWorkspace();
    await asApp(fx, (tx) => syncOpenRouterCatalog(tx, OPENROUTER_FIXTURE_MODELS));
    const model = await asTenant(fx, (tx) => loadModel(tx, 'openrouter:anthropic/claude-sonnet-4.6'));
    expect(model?.provider).toBe('openrouter');
    expect(model?.transport).toBe('openrouter_chat');
    expect(model?.pricing.input).toBe(3);
    expect(model?.pricing.output).toBe(15);
    expect(model?.pricing.cached_input).toBe(0.3);
    expect(model?.effort_map).toEqual({ low: 'low', medium: 'medium', high: 'high' });
  });

  it('cannot overwrite a seeded row, even when the payload names one', async () => {
    const fx = await seedWorkspace();
    const before = await asTenant(fx, (tx) => loadModel(tx, 'deepseek-flash'));
    // A hostile payload that tries to rewrite the pilot default's price. The
    // id does not carry the prefix, so it is filtered; and even if it did, the
    // function's WHERE clause only updates `source = 'provider_list'` rows.
    await asApp(fx, (tx) =>
      syncOpenRouterCatalog(tx, {
        data: [
          { id: 'deepseek-flash', name: 'Free!', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
        ],
      }),
    );
    const after = await asTenant(fx, (tx) => loadModel(tx, 'deepseek-flash'));
    expect(after).toEqual(before);
  });

  it('disables a row the provider has stopped listing rather than deleting it', async () => {
    const fx = await seedWorkspace();
    await asApp(fx, (tx) => syncOpenRouterCatalog(tx, OPENROUTER_FIXTURE_MODELS));
    const shortened = {
      data: OPENROUTER_FIXTURE_MODELS.data.filter((m) => m.id !== 'google/gemini-3-flash'),
    };
    await asApp(fx, (tx) => syncOpenRouterCatalog(tx, shortened));

    const row = await asTenant(fx, async (tx) => {
      const { rows } = await tx.query<{ disabled_reason: string | null }>(
        'SELECT disabled_reason FROM catalog WHERE model_id = $1',
        ['openrouter:google/gemini-3-flash'],
      );
      return rows[0];
    });
    // Still there — `sessions.model_id` references it — and it says why.
    expect(row?.disabled_reason).toBe('No longer listed by OpenRouter.');
  });
});

describe('what a workspace sees after a sync', () => {
  it('offers a synced row only once an OpenRouter key has verified', async () => {
    const fx = await seedWorkspace();
    await asApp(fx, (tx) => syncOpenRouterCatalog(tx, OPENROUTER_FIXTURE_MODELS));

    const before = await asTenant(fx, (tx) => loadCatalog(tx, fx.workspaceId));
    const sonnet = () => before.find((row) => row.model_id === 'openrouter:anthropic/claude-sonnet-4.6')!;
    expect(sonnet().enabled).toBe(false);
    expect(sonnet().disabled_code).toBe('no_key');
    expect(sonnet().disabled_reason).toContain('OpenRouter');

    await addVerifiedOpenRouterKey(fx);
    const after = await asTenant(fx, (tx) => loadCatalog(tx, fx.workspaceId));
    expect(after.find((row) => row.model_id === 'openrouter:anthropic/claude-sonnet-4.6')?.enabled).toBe(true);
  });

  it('greys a model with no tool calling, with a reason, because every run calls a tool', async () => {
    const fx = await seedWorkspace();
    await asApp(fx, (tx) => syncOpenRouterCatalog(tx, OPENROUTER_FIXTURE_MODELS));
    await addVerifiedOpenRouterKey(fx);

    const rows = await asTenant(fx, (tx) => loadCatalog(tx, fx.workspaceId));
    const llama = rows.find((row) => row.model_id === 'openrouter:meta-llama/llama-4-70b-instruct')!;
    expect(llama.supports_tools).toBe(false);
    expect(llama.enabled).toBe(false);
    expect(llama.disabled_code).toBe('catalog');
    expect(llama.disabled_reason).toContain('tool calling');
  });

  it('keeps the four seeded rows working', async () => {
    const fx = await seedWorkspace();
    await asApp(fx, (tx) => syncOpenRouterCatalog(tx, OPENROUTER_FIXTURE_MODELS));
    const rows = await asTenant(fx, (tx) => loadCatalog(tx, fx.workspaceId));
    for (const seed of CATALOG_SEED) {
      const row = rows.find((r) => r.model_id === seed.model_id);
      expect(row?.source).toBe('seed');
      expect(row?.label).toBe(seed.label);
      expect(row?.pricing_per_million.input).toBe(seed.pricing_per_million.input);
    }
  });
});

describe('the catalog page (GET /w/:ws/catalog)', () => {
  it('searches on the id and the label, case-insensitively', async () => {
    const fx = await seedWorkspace();
    await asApp(fx, (tx) => syncOpenRouterCatalog(tx, OPENROUTER_FIXTURE_MODELS));

    const byId = await asTenant(fx, (tx) => loadCatalogPage(tx, fx.workspaceId, { q: 'META-LLAMA' }));
    expect(byId.models.map((m) => m.model_id)).toContain('openrouter:meta-llama/llama-4-70b-instruct');
    expect(byId.models.every((m) => `${m.model_id} ${m.label}`.toLowerCase().includes('meta-llama'))).toBe(true);

    const byLabel = await asTenant(fx, (tx) => loadCatalogPage(tx, fx.workspaceId, { q: 'gemini' }));
    expect(byLabel.models.length).toBeGreaterThan(0);
    expect(byLabel.models.every((m) => `${m.model_id} ${m.label}`.toLowerCase().includes('gemini'))).toBe(true);
  });

  it('filters by provider and reports the unpaged total', async () => {
    const fx = await seedWorkspace();
    await asApp(fx, (tx) => syncOpenRouterCatalog(tx, OPENROUTER_FIXTURE_MODELS));
    const page = await asTenant(fx, (tx) => loadCatalogPage(tx, fx.workspaceId, { provider: 'openrouter', limit: 2 }));

    expect(page.models).toHaveLength(2);
    expect(page.models.every((m) => m.provider === 'openrouter')).toBe(true);
    // `total` is the unpaged count, which is what a "showing 2 of N" line needs
    // and what a client cannot compute from a page. The catalog is a platform
    // table shared by every test in this project, so the assertion is
    // "more than this page", not a literal.
    expect(page.total).toBeGreaterThanOrEqual(4);
    expect(page.total).toBeGreaterThan(page.models.length);
    expect(page.next_cursor).toBe(page.models[1]!.model_id);
  });

  it('pages forward without repeating or skipping a row', async () => {
    const fx = await seedWorkspace();
    await asApp(fx, (tx) => syncOpenRouterCatalog(tx, OPENROUTER_FIXTURE_MODELS));

    const seen: string[] = [];
    let after: string | undefined;
    for (let i = 0; i < 50; i += 1) {
      const page = await asTenant(fx, (tx) => loadCatalogPage(tx, fx.workspaceId, { limit: 2, after }));
      seen.push(...page.models.map((m) => m.model_id));
      if (page.next_cursor === null) break;
      after = page.next_cursor;
    }
    // No row seen twice, and the pages arrive in one total order.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...seen].sort());
    // Every seeded row and every usable fixture row is somewhere in the walk.
    for (const seed of CATALOG_SEED) expect(seen).toContain(seed.model_id);
    for (const row of normaliseModels(OPENROUTER_FIXTURE_MODELS)) expect(seen).toContain(row.model_id);
  });
});

describe('verifying an OpenRouter key', () => {
  it('records `verified` from the fixture probe and a model count from the sync', async () => {
    const fx = await seedWorkspace();
    const keyId = await asTenant(fx, async (tx) => {
      const key = await addProviderKey(tx, ENV, {
        workspaceId: fx.workspaceId,
        provider: 'openrouter',
        label: 'OpenRouter',
        plaintext: OR_KEY,
        addedBy: fx.adminId,
      });
      return key.id;
    });

    const provider = new OpenRouterProvider({ fetch: openRouterFixtureFetch });
    const input = {
      workspaceId: fx.workspaceId,
      keyId,
      provider: 'openrouter',
      apiKey: OR_KEY,
      probeModel: null,
      forbiddenCount: 0,
    };
    const outcome = await probeKey(provider, input);
    expect(outcome).toMatchObject({ status: 'verified', reason: 'verified', retry: false });

    const body = await provider.listCatalog({ provider: 'openrouter', apiKey: OR_KEY, keyId });
    const written = normaliseModels(body).length;
    await asApp(fx, async (tx) => {
      await recordVerification(tx, input, outcome);
      const synced = await syncOpenRouterCatalog(tx, body);
      await recordModelSync(tx, fx.workspaceId, keyId, synced.written);
      expect(synced.written).toBe(written);
    });

    const keys = await asTenant(fx, (tx) => listProviderKeys(tx, fx.workspaceId));
    const row = keys.find((k) => k.id === keyId)!;
    expect(row.status).toBe('verified');
    // The list is in the catalog, not on the key row (decision R7).
    expect(row.verified_models).toEqual([]);
    expect(row.synced_model_count).toBe(written);
    expect(row.models_synced_at).not.toBeNull();
  });

  it('marks the key invalid on a 401 and leaves the catalog alone', async () => {
    const fx = await seedWorkspace();
    await asApp(fx, (tx) => syncOpenRouterCatalog(tx, OPENROUTER_FIXTURE_MODELS));
    const keyId = await asTenant(fx, async (tx) => {
      const key = await addProviderKey(tx, ENV, {
        workspaceId: fx.workspaceId,
        provider: 'openrouter',
        label: 'OpenRouter',
        plaintext: OR_KEY,
        addedBy: fx.adminId,
      });
      return key.id;
    });

    const rejecting = new OpenRouterProvider({
      fetch: () => Promise.resolve(new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 })),
    });
    const input = {
      workspaceId: fx.workspaceId,
      keyId,
      provider: 'openrouter',
      apiKey: OR_KEY,
      probeModel: null,
      forbiddenCount: 0,
    };
    const outcome = await probeKey(rejecting, input);
    expect(outcome).toMatchObject({ status: 'invalid', reason: 'rejected', retry: false });

    await asApp(fx, (tx) => recordVerification(tx, input, outcome));
    const rows = await asTenant(fx, (tx) => loadCatalog(tx, fx.workspaceId));
    const sonnet = rows.find((r) => r.model_id === 'openrouter:anthropic/claude-sonnet-4.6')!;
    expect(sonnet.enabled).toBe(false);
    expect(sonnet.disabled_code).toBe('key_invalid');
  });

  it('stays unverified, with a reverify job, when the probe is throttled', async () => {
    const fx = await seedWorkspace();
    const keyId = await asTenant(fx, async (tx) => {
      const key = await addProviderKey(tx, ENV, {
        workspaceId: fx.workspaceId,
        provider: 'openrouter',
        label: 'OpenRouter',
        plaintext: OR_KEY,
        addedBy: fx.adminId,
      });
      return key.id;
    });

    const throttled = new OpenRouterProvider({
      fetch: () => Promise.resolve(new Response(JSON.stringify({ error: { code: 429 } }), { status: 429 })),
    });
    const input = {
      workspaceId: fx.workspaceId,
      keyId,
      provider: 'openrouter',
      apiKey: OR_KEY,
      probeModel: null,
      forbiddenCount: 0,
    };
    const outcome = await probeKey(throttled, input);
    expect(outcome).toMatchObject({ status: 'unverified', reason: 'throttled', retry: true });

    await asApp(fx, (tx) => recordVerification(tx, input, outcome));
    const jobs = await asTenant(fx, async (tx) => {
      const { rows } = await tx.query<{ key: string }>(
        "SELECT key FROM jobs WHERE workspace_id = $1 AND kind = 'reverify' AND done_at IS NULL",
        [fx.workspaceId],
      );
      return rows;
    });
    expect(jobs.map((j) => j.key)).toContain(`reverify:${keyId}`);
  });

  it('never marks a 402 key invalid: out of credits is not a bad key', async () => {
    const fx = await seedWorkspace();
    const outOfCredits = new OpenRouterProvider({
      fetch: () => Promise.resolve(new Response(JSON.stringify({ error: { code: 402 } }), { status: 402 })),
    });
    const outcome = await probeKey(outOfCredits, {
      workspaceId: fx.workspaceId,
      keyId: randomUUID(),
      provider: 'openrouter',
      apiKey: OR_KEY,
      probeModel: null,
      forbiddenCount: 0,
    });
    // `permanent` is not in the 401/403/429 table, so it lands on the
    // learned-nothing branch: unverified, and retried later.
    expect(outcome.status).toBe('unverified');
  });
});
