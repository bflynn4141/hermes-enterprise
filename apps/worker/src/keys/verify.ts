// Verification: what a key is worth, decided by the provider rather than by us.
//
// The table from section 4 of the production plan, in one function:
//
//   401              invalid. The key does not work; say so and stop runs.
//   200              verified, and the model list is recorded.
//   403, 429, 5xx    unverified, with a `reverify` job. We learned nothing, and
//                    pretending a throttled probe was a failure would mark a
//                    good key invalid on a bad afternoon.
//   403 twice        a scoped key. Anthropic's scoped keys are forbidden from
//                    /v1/models but can infer, so the probe becomes a 1-token
//                    messages call: 200 there is `verified (scoped)`.
//
// Why two 403s and not one: a single 403 is also what a transient gateway
// problem looks like, and a messages probe costs a token of the Admin's money.
// The second 403 is what makes "this key is scoped" the likelier explanation.
import type { KeyStatus } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { ProviderError, type ModelProvider } from '../model/types.js';
import { logEvent } from './redact.js';
import { setKeyStatus } from './store.js';

/** How many consecutive 403s before the probe becomes a 1-token call. */
export const SCOPED_PROBE_AFTER_FORBIDDEN = 2;

export interface VerifyInput {
  readonly workspaceId: string;
  readonly keyId: string;
  readonly provider: string;
  /** Plaintext, for this call only. Never stored by anything downstream. */
  readonly apiKey: string;
  /** The model the scoped probe uses. A catalog row for this provider. */
  readonly probeModel: string;
  /** How many 403s this key has already collected. */
  readonly forbiddenCount: number;
  readonly traceId?: string | undefined;
}

export interface VerifyOutcome {
  readonly status: KeyStatus;
  readonly models: readonly string[];
  /** True when nothing was learned and a `reverify` job should run later. */
  readonly retry: boolean;
  /** Machine-readable, for the client's copy. */
  readonly reason: 'verified' | 'verified_scoped' | 'rejected' | 'forbidden' | 'throttled' | 'unavailable';
  /** Incremented when this attempt was a 403. Carried on the reverify job. */
  readonly forbiddenCount: number;
}

/**
 * Probe a key. Does not write anything: the caller decides what to do with the
 * answer, which keeps this function usable from the route, the job and a test
 * without any of them needing a transaction it did not open.
 */
export async function probeKey(provider: ModelProvider, input: VerifyInput): Promise<VerifyOutcome> {
  const credential = { provider: input.provider, apiKey: input.apiKey, keyId: input.keyId };

  try {
    const result = await provider.listModels(credential);
    return {
      status: 'verified',
      models: result.models,
      retry: false,
      reason: 'verified',
      forbiddenCount: 0,
    };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;

    if (error.status === 401) {
      return { status: 'invalid', models: [], retry: false, reason: 'rejected', forbiddenCount: 0 };
    }

    if (error.status === 403) {
      const forbiddenCount = input.forbiddenCount + 1;
      if (forbiddenCount >= SCOPED_PROBE_AFTER_FORBIDDEN) {
        // The key may be scoped rather than broken. One token decides it.
        const works = await provider.probe(credential, input.probeModel);
        return works
          ? {
              status: 'verified_scoped',
              // A scoped key cannot enumerate, so the only model we know it
              // works for is the one we just called. Claiming more would be an
              // invention the model menu would act on.
              models: [input.probeModel],
              retry: false,
              reason: 'verified_scoped',
              forbiddenCount,
            }
          : { status: 'invalid', models: [], retry: false, reason: 'rejected', forbiddenCount };
      }
      return { status: 'unverified', models: [], retry: true, reason: 'forbidden', forbiddenCount };
    }

    if (error.status === 429) {
      return {
        status: 'unverified',
        models: [],
        retry: true,
        reason: 'throttled',
        forbiddenCount: input.forbiddenCount,
      };
    }

    // 5xx, a timeout, a torn connection: we learned nothing about the key.
    return {
      status: 'unverified',
      models: [],
      retry: true,
      reason: 'unavailable',
      forbiddenCount: input.forbiddenCount,
    };
  }
}

/**
 * Record what a probe learned.
 *
 * Separate from `probeKey` on purpose. The probe is a network call to a third
 * party that can take seconds; Hyperdrive in transaction mode pins one Postgres
 * connection for the life of a transaction, so a probe made *inside* a
 * transaction holds a connection open on someone else's availability. Every
 * caller therefore reads what it needs in one transaction, probes with no
 * transaction open, and records in a second. The cost is that the two are not
 * atomic, which is fine: the worst case is a status that is one probe stale,
 * and the next probe corrects it.
 */
export async function recordVerification(
  tx: Tx,
  input: VerifyInput,
  outcome: VerifyOutcome,
): Promise<void> {
  await setKeyStatus(tx, input.workspaceId, input.keyId, outcome.status, outcome.models);
  if (outcome.retry) {
    await scheduleReverify(tx, input.workspaceId, input.keyId, input.provider, outcome.forbiddenCount);
  }

  // The id, the provider and the outcome. Never the key, never the response.
  logEvent({
    at: 'provider_key.verify',
    workspace_id: input.workspaceId,
    key_id: input.keyId,
    provider: input.provider,
    status: outcome.status,
    reason: outcome.reason,
    trace_id: input.traceId ?? null,
  });
}

/**
 * Enqueue or refresh the `reverify` job for one key.
 *
 * Not `enqueueJob`: that one is `ON CONFLICT DO NOTHING`, which is right for a
 * receipt (send it once) and wrong here, because the second 403 has to replace
 * the first one's count or the scoped-key probe never triggers. The key is
 * still the unique one — one pending reverify per key — and it carries the key
 * id because `UNIQUE(kind, key)` is global across workspaces.
 */
export async function scheduleReverify(
  tx: Tx,
  workspaceId: string,
  keyId: string,
  provider: string,
  forbiddenCount: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO jobs (workspace_id, kind, key, payload, next_at)
     VALUES ($1, 'reverify', $2, $3::jsonb, now() + interval '10 minutes')
     ON CONFLICT (kind, key) DO UPDATE
       SET payload = EXCLUDED.payload,
           done_at = NULL,
           next_at = LEAST(jobs.next_at, EXCLUDED.next_at)`,
    [workspaceId, `reverify:${keyId}`, JSON.stringify({ key_id: keyId, provider, forbidden_count: forbiddenCount })],
  );
}

/** How many 403s a pending `reverify` job has already recorded for this key. */
export async function forbiddenCountFor(tx: Tx, workspaceId: string, keyId: string): Promise<number> {
  const { rows } = await tx.query<{ forbidden_count: string | null }>(
    `SELECT payload ->> 'forbidden_count' AS forbidden_count
       FROM jobs
      WHERE workspace_id = $1 AND kind = 'reverify' AND key = $2 AND done_at IS NULL`,
    [workspaceId, `reverify:${keyId}`],
  );
  const raw = rows[0]?.forbidden_count;
  const parsed = raw === null || raw === undefined ? 0 : Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}
