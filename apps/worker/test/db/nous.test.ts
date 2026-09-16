import { describe, expect, it } from 'vitest';
import type { Tx } from '../../src/db/client.js';
import { addProviderKey, listProviderKeys, setKeyStatus } from '../../src/keys/store.js';
import { needsProbeModel } from '../../src/keys/reverify.js';
import { loadCatalogPage } from '../../src/model/catalog.js';
import { syncNousPortalCatalog } from '../../src/model/nous-catalog.js';
import { NOUS_PORTAL_FIXTURE_MODELS } from '../../src/model/nous-dev.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const ENV = { KEK_V1: Buffer.alloc(32, 17).toString('base64') };
const KEY = 'nous-development-key-not-a-real-secret';
async function tenant<T>(role: 'owner' | 'app', fx: Fixture, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withClient(role, async (client) => {
    await client.query('BEGIN'); await setTenant(client, fx.workspaceId, fx.adminId);
    try { const value = await fn(client as unknown as Tx); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  });
}

describe('Nous Portal workspace catalog', () => {
  it('accepts an encrypted workspace key without requiring a preexisting probe row', async () => {
    const fx = await seedWorkspace();
    const id = await tenant('owner', fx, async (tx) => {
      const key = await addProviderKey(tx, ENV, { workspaceId: fx.workspaceId, provider: 'nous_portal', label: 'Nous Portal', plaintext: KEY, addedBy: fx.adminId });
      await setKeyStatus(tx, fx.workspaceId, key.id, 'verified', []);
      return key.id;
    });
    expect(needsProbeModel('nous_portal')).toBe(false);
    expect((await tenant('owner', fx, (tx) => listProviderKeys(tx, fx.workspaceId))).find((key) => key.id === id)?.provider).toBe('nous_portal');
  });

  it('syncs provider rows through the narrow function and offers them only with a verified key', async () => {
    const fx = await seedWorkspace();
    await expect(tenant('app', fx, (tx) => tx.query("INSERT INTO catalog (model_id, provider, label, transport, pricing_per_million, pricing_verified_on) VALUES ('nous:x','nous_portal','x','nous_chat','{}'::jsonb, now())"))).rejects.toThrow();

    // A verified key cannot make the compatibility placeholder runnable if the
    // provider catalog fetch fails. Sync is what changes its transport and
    // clears this disabled reason.
    await tenant('owner', fx, async (tx) => {
      await tx.query(
        `UPDATE catalog
            SET transport = 'openrouter_chat', disabled_reason = 'Catalog sync required.'
          WHERE model_id = 'nous:anthropic/claude-sonnet-5'`,
      );
      const key = await addProviderKey(tx, ENV, { workspaceId: fx.workspaceId, provider: 'nous_portal', label: 'Nous Portal', plaintext: KEY, addedBy: fx.adminId });
      await setKeyStatus(tx, fx.workspaceId, key.id, 'verified', []);
    });
    const unsynced = await tenant('owner', fx, (tx) => loadCatalogPage(tx, fx.workspaceId, { provider: 'nous_portal', limit: 100 }));
    expect(unsynced.models.find((row) => row.model_id === 'nous:anthropic/claude-sonnet-5')).toMatchObject({
      enabled: false,
      disabled_reason: 'Catalog sync required.',
    });

    const result = await tenant('app', fx, (tx) => syncNousPortalCatalog(tx, NOUS_PORTAL_FIXTURE_MODELS));
    expect(result).toMatchObject({ written: 5, skipped: 2 });
    const after = await tenant('owner', fx, (tx) => loadCatalogPage(tx, fx.workspaceId, { provider: 'nous_portal', limit: 100 }));
    expect(after.models.find((row) => row.model_id === 'nous:anthropic/claude-sonnet-5')).toMatchObject({ enabled: true, transport: 'nous_chat' });
  });
});
