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
//   4. Every state-changing one passes the same `Origin` and double-submit CSRF
//      guards as the rest of the product. They were missing here for a while,
//      which made the four routes that install, replace and revoke a billing
//      credential the only state-changing routes in the Worker with no CSRF
//      check at all — the exact inversion of where the check is worth most.
//      `SameSite=Strict` covered the ordinary browser case, but the
//      double-submit layer exists precisely for the cases it does not (a
//      same-site subdomain, an older browser), and "the highest-value route is
//      the one without the guard" is not a position to be in.
import type { Context } from 'hono';
import { catalogPageSchema, providerKeyListSchema, PROVIDERS } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
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
import { defaultProbeModel, needsProbeModel } from '../keys/reverify.js';
import { syncCatalogForKey } from '../keys/catalog-sync.js';
import { forbiddenCountFor, probeKey, recordVerification, type VerifyInput } from '../keys/verify.js';
import { CATALOG_PAGE_DEFAULT, CATALOG_PAGE_MAX, loadCatalogPage } from '../model/catalog.js';
import { adapterOptions, providerForName } from '../model/index.js';
import { allowedProviders, requireAllowedProvider } from '../model/allowed.js';
import { openRouterFixtureEnabled, openRouterFixtureFetch } from '../model/openrouter-dev.js';
import { nousPortalFixtureEnabled, nousPortalFixtureFetch } from '../model/nous-dev.js';
import type { AdapterOptions } from '../model/types.js';
import { RouteError, inWorkspace, jsonBody, pathUuid } from './tenant.js';

/**
 * Five verifications an hour, per the plan's rate-limit table.
 *
 * Low because each one is a request to a third party made with someone else's
 * credential, and a loop that retried a 429 forever would look, from the
 * provider's side, like us attacking our own customer's account.
 */
const VERIFY_LIMIT: RateLimit = { action: 'provider_key.verify', limit: 5, windowSeconds: 3_600 };

/**
 * Adding and rotating count separately from verifying.
 *
 * They used to share `VERIFY_LIMIT`'s bucket, which meant an Admin who added
 * five keys had spent the whole hour's budget for *re-verifying* any of them —
 * so the reasonable act of setting a workspace up locked the operator out of
 * the route they would reach for when one of those keys turned out not to work.
 * The probe-per-call reasoning is the same, so the number is the same; only the
 * bucket differs.
 */
const INSTALL_LIMIT: RateLimit = { action: 'provider_key.install', limit: 5, windowSeconds: 3_600 };

/** A provider key is at least this long. Below it, nothing is worth storing. */
const MIN_KEY_LENGTH = 16;
const MAX_KEY_LENGTH = 512;
const MAX_LABEL_LENGTH = 80;

interface AddKeyBody {
  provider?: unknown;
  key?: unknown;
  label?: unknown;
}

function readProvider(env: Env, value: unknown): string {
  if (typeof value !== 'string' || !(PROVIDERS as readonly string[]).includes(value)) {
    throw new RouteError('provider must be one of the supported providers', 'unknown_provider', 400);
  }
  // Refused before anything is stored, rate-limited or probed: this deployment
  // must not hold a credential it will never spend (decision C55).
  requireAllowedProvider(env, value);
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

/**
 * Adapter options for one provider.
 *
 * Identical to `adapterOptions(env)` except for the development fixture seam,
 * which is refused unless `ENVIRONMENT=development` *and* `OPENROUTER_FIXTURE=1`
 * (see `model/openrouter-dev.ts`). A production build takes the first branch
 * and the second is unreachable.
 */
function providerAdapterOptions(c: Context<{ Bindings: Env }>, provider: string): AdapterOptions {
  const base = adapterOptions(c.env);
  if (provider === 'openrouter' && openRouterFixtureEnabled(c.env)) {
    return { ...base, fetch: openRouterFixtureFetch };
  }
  if (provider === 'nous_portal' && nousPortalFixtureEnabled(c.env)) {
    return { ...base, fetch: nousPortalFixtureFetch };
  }
  return base;
}

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
): Promise<{ status: string; models: readonly string[]; reason: string; synced: { count: number; at: string } | null }> {
  const options = providerAdapterOptions(c, plan.provider);
  const outcome = await probeKey(providerForName(plan.provider, options), plan.input);

  await withTenantTransaction(c.env, 'app', { workspaceId: plan.input.workspaceId, userId }, async (tx) => {
    await recordVerification(tx, plan.input, outcome);
    if (outcome.status === 'verified' || outcome.status === 'verified_scoped') {
      await auditKeyEvent(tx, plan.input.workspaceId, userId, 'provider_key.verified', plan.input.keyId);
    }
  });

  // Broker catalogs populate the workspace model menu after verification.
  // Refresh outside the transaction above, and do not take verification down
  // with a catalog failure.
  let synced: { count: number; at: string } | null = null;
  if ((plan.provider === 'openrouter' || plan.provider === 'nous_portal') && (outcome.status === 'verified' || outcome.status === 'verified_scoped')) {
    const result = await syncCatalogForKey(
      (fn) => withTenantTransaction(c.env, 'app', { workspaceId: plan.input.workspaceId, userId }, fn),
      options,
      plan.input.workspaceId,
      plan.input.keyId,
      { provider: plan.provider, apiKey: plan.input.apiKey, keyId: plan.input.keyId },
      allowedProviders(c.env),
    );
    if (result) synced = { count: result.written, at: result.at };
  }

  return { status: outcome.status, models: outcome.models, reason: outcome.reason, synced };
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
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const body = await jsonBody<AddKeyBody>(c);
  const provider = readProvider(c.env, body.provider);
  const plaintext = readKey(body.key);
  const label = readLabel(body.label);

  const prepared = await inWorkspace(c, async (work) => {
    work.requireAdmin('adding a provider key');
    requireStepUp(work.session);
    await consumeRate(work.tx, work.userId, work.workspaceId, INSTALL_LIMIT);

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
    prepared.probeModel === null && needsProbeModel(provider)
      ? { status: 'unverified', models: [] as readonly string[], reason: 'unavailable', synced: null }
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
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const keyId = pathUuid(c, 'id');

  const prepared = await inWorkspace(c, async (work) => {
    work.requireAdmin('verifying a provider key');
    requireStepUp(work.session);
    await consumeRate(work.tx, work.userId, work.workspaceId, VERIFY_LIMIT);

    const row = await getProviderKey(work.tx, work.workspaceId, keyId);
    if (!row) throw new RouteError('no such key', 'not_found', 404);
    if (row.revoked_at !== null) throw new RouteError('this key is revoked', 'key_revoked', 409);
    // A key installed before this deployment narrowed the allowed provider set. It stays
    // in the list, marked "no longer usable", and Remove is the only thing that
    // works on it: re-verifying would spend a probe on a credential no run can
    // use (decision R12).
    requireAllowedProvider(c.env, row.provider);

    const probeModel = await defaultProbeModel(work.tx, row.provider);
    if (probeModel === null && needsProbeModel(row.provider)) {
      throw new RouteError('no catalog model for that provider', 'no_model', 409);
    }

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

  return c.json({ key_id: keyId, status: verification.status, reason: verification.reason, synced: verification.synced });
}

/**
 * POST /w/:ws/provider-keys/:id/rotate — new row, old one revoked.
 *
 * `replaces_key_id` is what keeps `model_calls` history coherent: a run from
 * last month still points at the key that paid for it, and the chain says which
 * key replaced it.
 */
export async function rotateKey(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const previousKeyId = pathUuid(c, 'id');
  const body = await jsonBody<AddKeyBody>(c);
  const plaintext = readKey(body.key);
  const label = readLabel(body.label);

  const prepared = await inWorkspace(c, async (work) => {
    work.requireAdmin('rotating a provider key');
    requireStepUp(work.session);
    await consumeRate(work.tx, work.userId, work.workspaceId, INSTALL_LIMIT);

    const previous = await getProviderKey(work.tx, work.workspaceId, previousKeyId);
    if (!previous) throw new RouteError('no such key', 'not_found', 404);
    if (previous.revoked_at !== null) throw new RouteError('this key is revoked', 'key_revoked', 409);
    // Same rule as verify: a rotation installs a *new* key for that provider.
    requireAllowedProvider(c.env, previous.provider);

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
    prepared.probeModel === null && needsProbeModel(prepared.provider)
      ? { status: 'unverified', models: [] as readonly string[], reason: 'unavailable', synced: null }
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
  requireOrigin(c, { required: false });
  requireCsrf(c);
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
 * GET /w/:ws/catalog?q=&provider=&limit=&after= — one page of models, with this
 * workspace's answer attached.
 *
 * Any member, no step-up: choosing a model is not a decision-grade action, and
 * the response carries no credential — only whether one exists and, if not,
 * what to do about it.
 *
 * Paged since OpenRouter (decision R8). It used to return the whole table,
 * which was four rows; a workspace with a synced OpenRouter key has several
 * hundred, and the model menu asks for the page it is showing.
 */
export async function catalog(c: Context<{ Bindings: Env }>): Promise<Response> {
  const url = new URL(c.req.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? CATALOG_PAGE_DEFAULT);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), CATALOG_PAGE_MAX) : CATALOG_PAGE_DEFAULT;
  const providerParam = url.searchParams.get('provider') ?? undefined;
  if (providerParam !== undefined && !(PROVIDERS as readonly string[]).includes(providerParam)) {
    throw new RouteError('provider must be one of the supported providers', 'unknown_provider', 400);
  }

  const page = await inWorkspace(c, (work) =>
    loadCatalogPage(work.tx, work.workspaceId, {
      q: url.searchParams.get('q') ?? undefined,
      provider: providerParam,
      after: url.searchParams.get('after') ?? undefined,
      limit,
      // Dropped rather than listed-and-greyed: a row for a provider this
      // deployment does not offer has no action behind it, and a menu full of
      // models nobody can pick is what teaches people to stop reading it
      // (decision R12). The four seeded rows are what this removes today.
      allowed: allowedProviders(c.env),
      onlyAllowed: true,
    }),
  );
  return c.json(catalogPageSchema.parse(page));
}
