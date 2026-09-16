// Synchronize a changing provider catalog after its workspace key verifies.
// The third-party fetch runs without a database transaction; the normalized
// rows, sync timestamp, and default-model promotion commit together afterward.
import { NousPortalProvider } from '../model/nous.js';
import { syncNousPortalCatalog } from '../model/nous-catalog.js';
import { OpenRouterProvider } from '../model/openrouter.js';
import { syncOpenRouterCatalog, type SyncResult } from '../model/openrouter-catalog.js';
import type { AdapterOptions, Credential } from '../model/types.js';
import type { Tx } from '../db/client.js';
import { logError, logEvent } from './redact.js';
import { recordModelSync } from './store.js';
import { promoteDefaultModel } from './default-model.js';

export type TxRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

async function writeSync(
  run: TxRunner,
  workspaceId: string,
  keyId: string,
  allowed: readonly string[],
  body: unknown,
  sync: (tx: Tx, body: unknown) => Promise<SyncResult>,
): Promise<SyncResult> {
  return run(async (tx) => {
    const synced = await sync(tx, body);
    await recordModelSync(tx, workspaceId, keyId, synced.written);
    const promoted = await promoteDefaultModel(tx, workspaceId, allowed);
    if (promoted) {
      logEvent({
        at: 'workspace.default_model_promoted',
        workspace_id: workspaceId,
        from: promoted.from,
        to: promoted.to,
        sessions: promoted.sessions,
      });
    }
    return synced;
  });
}

/** Returns null when catalog refresh fails; the verified key remains usable. */
export async function syncCatalogForKey(
  run: TxRunner,
  options: AdapterOptions,
  workspaceId: string,
  keyId: string,
  credential: Credential,
  allowed: readonly string[],
): Promise<SyncResult | null> {
  const provider = credential.provider;
  try {
    let body: unknown;
    let result: SyncResult;
    if (provider === 'nous_portal') {
      body = await new NousPortalProvider(options).listCatalog(credential);
      result = await writeSync(run, workspaceId, keyId, allowed, body, syncNousPortalCatalog);
    } else if (provider === 'openrouter') {
      body = await new OpenRouterProvider(options).listCatalog(credential);
      result = await writeSync(run, workspaceId, keyId, allowed, body, syncOpenRouterCatalog);
    } else {
      return null;
    }
    logEvent({
      at: `${provider}.catalog_synced`,
      workspace_id: workspaceId,
      key_id: keyId,
      written: result.written,
      skipped: result.skipped,
    });
    return result;
  } catch (error) {
    logError({ at: `${provider}.catalog_sync_failed`, workspace_id: workspaceId, key_id: keyId, error });
    return null;
  }
}

/** Compatibility export for existing OpenRouter tests and historical deployments. */
export async function syncOpenRouterForKey(
  run: TxRunner,
  options: AdapterOptions,
  workspaceId: string,
  keyId: string,
  credential: Credential,
  allowed: readonly string[],
): Promise<SyncResult | null> {
  return syncCatalogForKey(run, options, workspaceId, keyId, credential, allowed);
}
