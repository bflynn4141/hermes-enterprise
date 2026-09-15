// The `reverify` job.
//
// Two callers, one body:
//
//   the route      a probe that was throttled or forbidden enqueues one, so an
//                  Admin who added a key during a provider incident does not
//                  have to remember to come back.
//   the weekly     every usable key is re-probed. A key revoked at the provider
//   sweep          is otherwise discovered by a run failing mid-answer, which
//                  is the worst place to discover it.
//
// The sweep is a backstop, not the mechanism: a 401 during a run already marks
// the key invalid immediately. What the sweep buys is that a workspace whose
// agent has been idle for a fortnight learns about a revoked key from a
// Settings banner rather than from its next run.
import type { Tx } from '../db/client.js';
import { providerForName } from '../model/index.js';
import type { AdapterOptions } from '../model/types.js';
import type { KekEnv } from './envelope.js';
import { allowedProviders, type AllowedProvidersEnv } from '../model/allowed.js';
import { logError, logEvent } from './redact.js';
import { resolveKey } from './store.js';
import { probeKey, recordVerification } from './verify.js';
import { syncOpenRouterForKey } from './catalog-sync.js';

/**
 * Whether this provider's verification probe needs a model to name.
 *
 * OpenRouter's is `GET /api/v1/key`, which authenticates without one — and it
 * has to be, because its catalog rows do not exist until the first sync has
 * run, so requiring a row would make the first key unverifiable forever.
 */
export const needsProbeModel = (provider: string): boolean => provider !== 'openrouter';

/** How often the weekly sweep re-probes a key that is already verified. */
export const REVERIFY_INTERVAL_DAYS = 7;

export interface ReverifyPayload {
  readonly key_id: string;
  readonly provider: string;
  readonly forbidden_count?: number;
}

/** Runs `fn` in a transaction scoped to this workspace. */
export type TxRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export type ReverifyResult = { readonly status: string } | { readonly skipped: string };

/**
 * Run one `reverify` job.
 *
 * Three phases, and the shape is the point: read, probe, record. The probe is a
 * call to a third party, and Hyperdrive pins a Postgres connection for the life
 * of a transaction, so making it with a transaction open would hold a
 * connection on the provider's availability. The plaintext exists only between
 * the first phase and the third.
 */
export async function runReverifyJob(
  run: TxRunner,
  // `AllowedProvidersEnv` as well as the KEK: the weekly sweep is also the
  // weekly catalog refresh, and a refresh is where a workspace still on a
  // provider this deployment no longer offers is moved (decision R13).
  env: KekEnv & AllowedProvidersEnv,
  workspaceId: string,
  payload: ReverifyPayload,
  options: AdapterOptions = {},
): Promise<ReverifyResult> {
  const prepared = await run(async (tx): Promise<{ apiKey: string; keyId: string; probeModel: string | null } | null> => {
    const probeModel = await defaultProbeModel(tx, payload.provider);
    if (probeModel === null && needsProbeModel(payload.provider)) return null;
    try {
      const resolved = await resolveKey(tx, env, workspaceId, payload.provider);
      // Rotated away between the enqueue and now: this job is about a row that
      // no longer needs an answer, and probing the new key under the old job's
      // count would apply the old key's 403s to it.
      if (resolved.keyId !== payload.key_id) return null;
      return { apiKey: resolved.apiKey, keyId: resolved.keyId, probeModel };
    } catch {
      // Removed, revoked, or never verified. Not a failure.
      return null;
    }
  });

  if (prepared === null) {
    logEvent({ at: 'reverify.skipped', workspace_id: workspaceId, key_id: payload.key_id });
    return { skipped: 'no_usable_key' };
  }

  const input = {
    workspaceId,
    keyId: prepared.keyId,
    provider: payload.provider,
    apiKey: prepared.apiKey,
    probeModel: prepared.probeModel,
    forbiddenCount: payload.forbidden_count ?? 0,
  };

  try {
    const outcome = await probeKey(providerForName(payload.provider, options), input);
    await run((tx) => recordVerification(tx, input, outcome));
    // The weekly sweep is also the weekly catalog refresh: OpenRouter adds and
    // retires models continuously, and a price that is a fortnight stale is the
    // thing `pricing_verified_on` exists to make visible rather than tolerable.
    if (payload.provider === 'openrouter' && (outcome.status === 'verified' || outcome.status === 'verified_scoped')) {
      const allowed = allowedProviders(env);
      await syncOpenRouterForKey(
        run,
        options,
        workspaceId,
        prepared.keyId,
        { provider: payload.provider, apiKey: prepared.apiKey, keyId: prepared.keyId },
        allowed,
      );
    }
    return { status: outcome.status };
  } catch (error) {
    logError({ at: 'reverify.failed', workspace_id: workspaceId, key_id: payload.key_id, error });
    throw error;
  }
}

/**
 * Which keys the weekly sweep should enqueue for this workspace.
 *
 * `invalid` keys are included: an Admin who fixed the key at the provider
 * should not have to click Verify for the product to notice. `revoked` ones are
 * not: their ciphertext is a zero byte.
 */
export async function enqueueWeeklyReverify(tx: Tx, workspaceId: string): Promise<number> {
  const { rows } = await tx.query<{ id: string; provider: string }>(
    `SELECT id, provider FROM workspace_provider_keys
      WHERE workspace_id = $1
        AND revoked_at IS NULL
        AND status IN ('verified', 'verified_scoped', 'invalid', 'unverified')
        AND (verified_at IS NULL OR verified_at < now() - ($2 || ' days')::interval)`,
    [workspaceId, String(REVERIFY_INTERVAL_DAYS)],
  );

  for (const row of rows) {
    await tx.query(
      `INSERT INTO jobs (workspace_id, kind, key, payload)
       VALUES ($1, 'reverify', $2, $3::jsonb)
       ON CONFLICT (kind, key) DO UPDATE SET done_at = NULL, next_at = now()`,
      [workspaceId, `reverify:${row.id}`, JSON.stringify({ key_id: row.id, provider: row.provider })],
    );
  }
  return rows.length;
}

/**
 * A model to probe with, when the probe has to be a real inference call.
 *
 * The cheapest enabled row for the provider is not knowable from price alone
 * (input and output rates trade off), so this takes the first catalog row the
 * pilot offers for that provider: a disabled row may not be callable at all,
 * and probing with one would report the catalog's problem as the key's.
 */
export async function defaultProbeModel(tx: Tx, provider: string): Promise<string | null> {
  const { rows } = await tx.query<{ model_id: string }>(
    `SELECT model_id FROM catalog
      WHERE provider = $1
      ORDER BY (disabled_reason IS NULL) DESC, (pricing_per_million ->> 'input')::numeric, model_id
      LIMIT 1`,
    [provider],
  );
  return rows[0]?.model_id ?? null;
}
