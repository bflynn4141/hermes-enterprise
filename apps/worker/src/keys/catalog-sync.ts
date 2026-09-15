// Syncing a provider's model list onto the catalog, after its key verified.
//
// One provider needs this today. OpenRouter is a broker rather than a vendor:
// what a key can reach is a list of several hundred ids that changes weekly, so
// the four-rows-in-a-migration model the other three providers use would be a
// migration a week and still wrong.
//
// The shape is the same read-probe-record shape the rest of `keys/` uses, for
// the same reason: the list fetch is a call to a third party, and Hyperdrive
// pins a Postgres connection for the life of a transaction. So the list is
// fetched with nothing open, and written in a transaction of its own.
//
// A sync that fails is not a verification that failed. The key is good; the
// catalog is stale; the Settings screen says when it last synced and offers the
// button again. Treating the two as one failure would tell an Admin their key
// was rejected because OpenRouter's CDN had a bad minute.
import { OpenRouterProvider } from '../model/openrouter.js';
import { syncOpenRouterCatalog, type SyncResult } from '../model/openrouter-catalog.js';
import type { AdapterOptions, Credential } from '../model/types.js';
import type { Tx } from '../db/client.js';
import { logError, logEvent } from './redact.js';
import { recordModelSync } from './store.js';
import { promoteDefaultModel } from './default-model.js';

export type TxRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/**
 * Fetch OpenRouter's list and write it, recording the count on the key row.
 *
 * Returns null when the sync failed, which every caller treats as "the key is
 * still verified and the catalog is still whatever it was".
 */
export async function syncOpenRouterForKey(
  run: TxRunner,
  options: AdapterOptions,
  workspaceId: string,
  keyId: string,
  credential: Credential,
  /** This deployment's providers, for the default-model promotion below. */
  allowed: readonly string[],
): Promise<SyncResult | null> {
  try {
    const body = await new OpenRouterProvider(options).listCatalog(credential);
    const result = await run(async (tx) => {
      const synced = await syncOpenRouterCatalog(tx, body);
      await recordModelSync(tx, workspaceId, keyId, synced.written);
      // In the same transaction as the rows it depends on: the workspace's
      // default is only movable onto a model that exists, and a promotion that
      // committed against a sync that rolled back would name a row that is not
      // there (decision R13).
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
    // Counts and ids. Never a model name the provider chose, never the body.
    logEvent({
      at: 'openrouter.catalog_synced',
      workspace_id: workspaceId,
      key_id: keyId,
      written: result.written,
      skipped: result.skipped,
    });
    return result;
  } catch (error) {
    logError({ at: 'openrouter.catalog_sync_failed', workspace_id: workspaceId, key_id: keyId, error });
    return null;
  }
}
