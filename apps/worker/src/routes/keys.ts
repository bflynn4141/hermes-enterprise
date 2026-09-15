// Settings > Provider keys, and the catalog the model menu reads.
//
// Five routes, all of them Admin plus step-up, and one that is neither. The
// split is the product's: choosing which model to run is an ordinary thing any
// member does, and adding the credential that pays for it is a decision-grade
// action. Step-up is the same guard the decision route uses (section 6), for
// the same reason — an unattended laptop should not be a way to install a
// credential that bills someone else's account.
//
// Three rules this file exists to keep:
//
//   1. No route returns key material. The only projection is `MaskedProviderKey`
//      and there is no shape in the contract that could carry a key.
//   2. The provider probe happens with no transaction open. Hyperdrive pins a
//      Postgres connection for the life of a transaction; a probe inside one
//      would hold it on a third party's availability.
//   3. Audit rows carry `key_id` only.
import type { Context } from 'hono';
import { catalogPageSchema, providerKeyListSchema, PROVIDERS } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireStepUp } from '../auth.js';
import { consumeRate, type RateLimit } from '../auth/rate-limit.js';
import { withTenantTransaction, type Tx } from '../db/client.js';
import {
  addProviderKey,
  findByFingerprint,
  getProviderKey,
  listProviderKeys,
  openKeyForVerification,
  removeProviderKey,
  rotateProviderKey,
} from '../keys/store.js';
import { logEvent } from '../keys/redact.js';
import { defaultProbeModel } from '../keys/reverify.js';
import { forbiddenCountFor, probeKey, recordVerification, type VerifyInput } from '../keys/verify.js';
import { loadCatalog } from '../model/catalog.js';
import { adapterOptions, providerForName } from '../model/index.js';
import { RouteError, inWorkspace, jsonBody, pathUuid } from './tenant.js';

/**
 * Five verifications an hour, per the plan's rate-limit table.
 *
 * Low because each one is a request to a third party made with someone else's
 * credential, and a loop that retried a 429 forever would look, from the
 * provider's side, like us attacking our own customer's account.
 */
const VERIFY_LIMIT: RateLimit = { action: 'provider_key.verify', limit: 5, windowSeconds: 3_600 };

/** A provider key is at least this long. Below it, nothing is worth storing. */
const MIN_KEY_LENGTH = 16;
const MAX_KEY_LENGTH = 512;
const MAX_LABEL_LENGTH = 80;

interface AddKeyBody {
  provider?: unknown;
  key?: unknown;
  label?: unknown;
}

function readProvider(value: unknown): string {
  if (typeof value !== 'string' || !(PROVIDERS as readonly string[]).includes(value)) {
    throw new RouteError('provider must be one of the supported providers', 'unknown_provider', 400);
  }
  if (value === 'nous_portal') {
    // In the catalog for completeness; there is no adapter and no key column
    // value for it, so accepting one would store something unusable.
    throw new RouteError('that provider does not accept a workspace key', 'unknown_provider', 400);
  }
  return value;
}

/**
 * The key, validated only by shape.
 *
 * Deliberately not validated by prefix. A provider that changes its prefix
 * would otherwise make every new key un-addable until we deployed, and the
 * provider's own 401 is a better verdict on whether a key is a key than a
 * regular expression of ours. Length is checked because an empty string or a
 * pasted paragraph is a mistake we can name before spending a probe.
 */
function readKey(value: unknown): string {
  if (typeof value !== 'string') throw new RouteError('key must be a string', 'bad_key', 400);
  const trimmed = value.trim();
  if (trimmed.length < MIN_KEY_LENGTH || trimmed.length > MAX_KEY_LENGTH) {
    throw new RouteError('that does not look like a provider key', 'bad_key', 400);
  }
  if (/\s/.test(trimmed)) throw new RouteError('a provider key contains no whitespace', 'bad_key', 400);
  return trimmed;
}

const readLabel = (value: unknown): string =>
  typeof value === 'string' ? value.trim().slice(0, MAX_LABEL_LENGTH) : '';

/** An audit row. Ids and an enum kind; never a key, never a fingerprint. */
async function auditKeyEvent(
  tx: Tx,
  workspaceId: string,
  userId: string,
  kind: 'provider_key.added' | 'provider_key.verified' | 'provider_key.revoked',
  keyId: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, key_id)
     VALUES ($1, 'user', $2, $3, $4)`,
    [workspaceId, userId, kind, keyId],
  );
}

/** GET /w/:ws/provider-keys — masked, Admin, step-up. */
export async function listKeys(c: Context<{ Bindings: Env }>): Promise<Response> {
  const keys = await inWorkspace(c, async (work) => {
    work.requireAdmin('reading provider keys');
    requireStepUp(work.session);
    return listProviderKeys(work.tx, work.workspaceId);
  });
  return c.json(providerKeyListSchema.parse({ keys }));
}

/**
 * What a probe needs, read in the first transaction.
 *
 * Returned as plain values rather than held on a transaction-bound object,
 * because the probe runs after the transaction has committed.
 */
interface ProbePlan {
  readonly input: VerifyInput;
  readonly provider: string;
}

/** Probe, then record, with no transaction open across the network call. */
async function probeAndRecord(
  c: Context<{ Bindings: Env }>,
  plan: ProbePlan,
  userId: string,
): Promise<{ status: string; models: readonly string[]; reason: string }> {
  const outcome = await probeKey(providerForName(plan.provider, adapterOptions(c.env)), plan.input);

  await withTenantTransaction(c.env, 'app', { workspaceId: plan.input.workspaceId, userId }, async (tx) => {
    await recordVerification(tx, plan.input, outcome);
    if (outcome.status === 'verified' || outcome.status === 'verified_scoped') {
      await auditKeyEvent(tx, plan.input.workspaceId, userId, 'provider_key.verified', plan.input.keyId);
    }
  });

  return { status: outcome.status, models: outcome.models, reason: outcome.reason };
}

/**
 * POST /w/:ws/provider-keys — add and verify.
 *
 * The key is stored *before* it is verified. That order is deliberate: a probe
 * that times out after a successful store leaves an unverified row an Admin can
 * retry, while a probe-then-store would lose the key they pasted and make them
 * paste it again, which is how a key ends up in a chat message.
 */
export async function addKey(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await jsonBody<AddKeyBody>(c);
  const provider = readProvider(body.provider);
  const plaintext = readKey(body.key);
  const label = readLabel(body.label);

  const prepared = await inWorkspace(c, async (work) => {
    work.requireAdmin('adding a provider key');
    requireStepUp(work.session);
    await consumeRate(work.tx, work.userId, work.workspaceId, VERIFY_LIMIT);

    const existing = await findByFingerprint(work.tx, work.workspaceId, plaintext);
    if (existing) {
      // The same key, already here. Not an error: re-verify the row they have
      // rather than telling them their key is a duplicate of itself.
      const probeModel = await defaultProbeModel(work.tx, provider);
      return {
        key: existing,
        probeModel,
        userId: work.userId,
        forbiddenCount: await forbiddenCountFor(work.tx, work.workspaceId, existing.id),
      };
    }

    const live = await work.tx.query<{ id: string }>(
      `SELECT id FROM workspace_provider_keys
        WHERE workspace_id = $1 AND provider = $2 AND revoked_at IS NULL`,
      [work.workspaceId, provider],
    );
    if (live.rowCount && live.rowCount > 0) {
      // One live key per provider, enforced by a partial unique index. Rotate
      // is the route that replaces one, and it says so, because silently
      // revoking the old key here would be a surprise with a bill attached.
      throw new RouteError(`this workspace already has a ${provider} key; rotate it instead`, 'key_exists', 409);
    }

    const key = await addProviderKey(work.tx, c.env, {
      workspaceId: work.workspaceId,
      provider,
      label,
      plaintext,
      addedBy: work.userId,
    });
    await auditKeyEvent(work.tx, work.workspaceId, work.userId, 'provider_key.added', key.id);
    const probeModel = await defaultProbeModel(work.tx, provider);
    return { key, probeModel, userId: work.userId, forbiddenCount: 0 };
  });

  const verification =
    prepared.probeModel === null
      ? { status: 'unverified', models: [] as readonly string[], reason: 'unavailable' }
      : await probeAndRecord(
          c,
          {
            provider,
            input: {
              workspaceId: c.req.param('ws') ?? '',
              keyId: prepared.key.id,
              provider,
              apiKey: plaintext,
              probeModel: prepared.probeModel,
              forbiddenCount: prepared.forbiddenCount,
            },
          },
          prepared.userId,
        );

  return c.json(
    {
      key: { ...prepared.key, status: verification.status, verified_models: [...verification.models] },
      verification: { status: verification.status, reason: verification.reason },
    },
    201,
  );
}

/** POST /w/:ws/provider-keys/:id/verify — probe an existing row again. */
export async function verifyKey(c: Context<{ Bindings: Env }>): Promise<Response> {
  const keyId = pathUuid(c, 'id');

  const prepared = await inWorkspace(c, async (work) => {
    work.requireAdmin('verifying a provider key');
    requireStepUp(work.session);
    await consumeRate(work.tx, work.userId, work.workspaceId, VERIFY_LIMIT);

    const row = await getProviderKey(work.tx, work.workspaceId, keyId);
    if (!row) throw new RouteError('no such key', 'not_found', 404);
    if (row.revoked_at !== null) throw new RouteError('this key is revoked', 'key_revoked', 409);

    const probeModel = await defaultProbeModel(work.tx, row.provider);
    if (probeModel === null) throw new RouteError('no catalog model for that provider', 'no_model', 409);

    // Decrypted here, inside the transaction, because that is the only place
    // the tenant key and the AAD are both in force. The plaintext lives from
    // here until the probe returns and is written nowhere.
    const apiKey = await openKeyForVerification(work.tx, c.env, work.workspaceId, keyId);
    return {
      provider: row.provider,
      probeModel,
      apiKey,
      userId: work.userId,
      forbiddenCount: await forbiddenCountFor(work.tx, work.workspaceId, keyId),
    };
  });

  const verification = await probeAndRecord(
    c,
    {
      provider: prepared.provider,
      input: {
        workspaceId: c.req.param('ws') ?? '',
        keyId,
        provider: prepared.provider,
        apiKey: prepared.apiKey,
        probeModel: prepared.probeModel,
        forbiddenCount: prepared.forbiddenCount,
      },
    },
    prepared.userId,
  );

  return c.json({ key_id: keyId, status: verification.status, reason: verification.reason });
}

/**
 * POST /w/:ws/provider-keys/:id/rotate — new row, old one revoked.
 *
 * `replaces_key_id` is what keeps `model_calls` history coherent: a run from
 * last month still points at the key that paid for it, and the chain says which
 * key replaced it.
 */
export async function rotateKey(c: Context<{ Bindings: Env }>): Promise<Response> {
  const previousKeyId = pathUuid(c, 'id');
  const body = await jsonBody<AddKeyBody>(c);
  const plaintext = readKey(body.key);
  const label = readLabel(body.label);

  const prepared = await inWorkspace(c, async (work) => {
    work.requireAdmin('rotating a provider key');
    requireStepUp(work.session);
    await consumeRate(work.tx, work.userId, work.workspaceId, VERIFY_LIMIT);

    const previous = await getProviderKey(work.tx, work.workspaceId, previousKeyId);
    if (!previous) throw new RouteError('no such key', 'not_found', 404);
    if (previous.revoked_at !== null) throw new RouteError('this key is revoked', 'key_revoked', 409);

    const { key } = await rotateProviderKey(work.tx, c.env, {
      workspaceId: work.workspaceId,
      provider: previous.provider,
      label: label === '' ? previous.label : label,
      plaintext,
      addedBy: work.userId,
      previousKeyId,
    });
    await auditKeyEvent(work.tx, work.workspaceId, work.userId, 'provider_key.revoked', previousKeyId);
    await auditKeyEvent(work.tx, work.workspaceId, work.userId, 'provider_key.added', key.id);

    return {
      key,
      provider: previous.provider,
      userId: work.userId,
      probeModel: await defaultProbeModel(work.tx, previous.provider),
    };
  });

  const verification =
    prepared.probeModel === null
      ? { status: 'unverified', models: [] as readonly string[], reason: 'unavailable' }
      : await probeAndRecord(
          c,
          {
            provider: prepared.provider,
            input: {
              workspaceId: c.req.param('ws') ?? '',
              keyId: prepared.key.id,
              provider: prepared.provider,
              apiKey: plaintext,
              probeModel: prepared.probeModel,
              // A rotation is a new key: the old key's 403s say nothing about it.
              forbiddenCount: 0,
            },
          },
          prepared.userId,
        );

  return c.json({
    key: { ...prepared.key, status: verification.status, verified_models: [...verification.models] },
    replaces_key_id: previousKeyId,
    verification: { status: verification.status, reason: verification.reason },
  });
}

/**
 * DELETE /w/:ws/provider-keys/:id — stop the runs, zero the ciphertext.
 *
 * The response says how many runs were asked to stop, because "your key is
 * gone" and "three of your colleagues' runs just stopped" are the same event
 * and the person who caused it should see both halves.
 */
export async function deleteKey(c: Context<{ Bindings: Env }>): Promise<Response> {
  const keyId = pathUuid(c, 'id');
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('removing a provider key');
    requireStepUp(work.session);

    const removed = await removeProviderKey(work.tx, work.workspaceId, keyId);
    await auditKeyEvent(work.tx, work.workspaceId, work.userId, 'provider_key.revoked', keyId);
    logEvent({
      at: 'provider_key.removed',
      workspace_id: work.workspaceId,
      key_id: keyId,
      stopped_runs: removed.stoppedRuns.length,
    });
    return removed;
  });

  return c.json({ key: result.key, stopped_runs: result.stoppedRuns });
}

/**
 * GET /w/:ws/catalog — every model, with this workspace's answer attached.
 *
 * Any member, no step-up: choosing a model is not a decision-grade action, and
 * the response carries no credential — only whether one exists and, if not,
 * what to do about it.
 */
export async function catalog(c: Context<{ Bindings: Env }>): Promise<Response> {
  const models = await inWorkspace(c, (work) => loadCatalog(work.tx, work.workspaceId));
  return c.json(catalogPageSchema.parse({ models }));
}
