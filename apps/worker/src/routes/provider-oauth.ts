import type { Context } from 'hono';
import { providerOAuthPollSchema, providerOAuthStartSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { consumeRate, type RateLimit } from '../auth/rate-limit.js';
import { withTenantTransaction } from '../db/client.js';
import { openKey, sealKey } from '../keys/envelope.js';
import {
  addProviderOAuthConnection,
  getProviderKey,
  setProviderOAuthAccount,
  type NousOAuthAccount,
  type NousOAuthCredential,
} from '../keys/store.js';
import { syncCatalogForKey } from '../keys/catalog-sync.js';
import { adapterOptions } from '../model/index.js';
import { allowedProviders } from '../model/allowed.js';
import { inWorkspace, pathUuid } from './tenant.js';
import { RouteError } from './errors.js';

const PORTAL_ORIGIN = 'https://portal.nousresearch.com';
const INFERENCE_BASE = 'https://inference-api.nousresearch.com/v1';
// Match Hermes Agent's current DEFAULT_NOUS_SCOPE. Dashboard access and
// billing scopes are deliberately excluded from the workspace runtime grant.
const SCOPE = 'inference:invoke';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const START_LIMIT: RateLimit = { action: 'provider_oauth.start', limit: 5, windowSeconds: 3_600 };

interface OAuthConfig { clientId: string; portalBaseUrl: string; scope: string }
interface DeviceResponse {
  device_code: string; user_code: string; verification_uri: string;
  verification_uri_complete: string; expires_in: number; interval: number;
}

const boundedText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
};

const boundedEmail = (value: unknown): string | null => {
  const email = boundedText(value, 320);
  return email && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
};

/**
 * Resolve the Nous identity that approved the workspace grant.
 *
 * The account endpoint is newer than the pinned device-code contract, so an
 * older Portal deployment must not make inference unusable. A successful,
 * trusted response is retained for the Admin audit surface; an unavailable
 * endpoint leaves the connection explicitly unattributed instead of trusting
 * unverified JWT display claims.
 */
export async function fetchNousOAuthAccount(
  cfg: OAuthConfig,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<NousOAuthAccount | null> {
  const response = await fetcher(`${cfg.portalBaseUrl}/api/oauth/account`, {
    method: 'GET', redirect: 'manual',
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload) return null;
  const user = payload.user && typeof payload.user === 'object' ? payload.user as Record<string, unknown> : {};
  const organization = payload.organisation && typeof payload.organisation === 'object'
    ? payload.organisation as Record<string, unknown>
    : {};
  const account = {
    user_id: boundedText(user.id ?? user.user_id, 255),
    email: boundedEmail(user.email),
    organization_id: boundedText(organization.id, 255),
    organization_name: boundedText(organization.name, 200),
    organization_slug: boundedText(organization.slug, 200),
    verified_at: new Date().toISOString(),
  } satisfies NousOAuthAccount;
  return account.user_id || account.email || account.organization_id ? account : null;
}

function config(env: Env): OAuthConfig | null {
  if (env.NOUS_PORTAL_OAUTH_ENABLED !== '1') return null;
  const clientId = env.NOUS_PORTAL_OAUTH_CLIENT_ID?.trim() ?? '';
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) return null;
  const portalBaseUrl = (env.NOUS_PORTAL_BASE_URL || PORTAL_ORIGIN).replace(/\/$/, '');
  const url = new URL(portalBaseUrl);
  if (env.ENVIRONMENT !== 'development' && env.ENVIRONMENT !== 'test' && url.origin !== PORTAL_ORIGIN) return null;
  if (url.protocol !== 'https:' && env.ENVIRONMENT !== 'development' && env.ENVIRONMENT !== 'test') return null;
  return { clientId, portalBaseUrl, scope: SCOPE };
}

function portalUrl(raw: unknown, cfg: OAuthConfig): string {
  if (typeof raw !== 'string') throw new RouteError('Nous returned an invalid verification URL', 'oauth_upstream_invalid', 503);
  const parsed = new URL(raw);
  if (parsed.origin !== new URL(cfg.portalBaseUrl).origin || parsed.username || parsed.password) {
    throw new RouteError('Nous returned an untrusted verification URL', 'oauth_upstream_invalid', 503);
  }
  return parsed.toString();
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export async function requestDeviceCode(cfg: OAuthConfig, fetcher: typeof fetch = fetch): Promise<DeviceResponse> {
  const response = await fetcher(`${cfg.portalBaseUrl}/api/oauth/device/code`, {
    method: 'POST', redirect: 'manual',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, scope: cfg.scope }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new RouteError('Nous OAuth is temporarily unavailable', 'oauth_upstream_unavailable', 503);
  const value = await response.json() as Partial<DeviceResponse>;
  if (typeof value.device_code !== 'string' || value.device_code.length < 8 || value.device_code.length > 2048 ||
      typeof value.user_code !== 'string' || value.user_code.length < 1 || value.user_code.length > 32) {
    throw new RouteError('Nous returned an invalid device authorization response', 'oauth_upstream_invalid', 503);
  }
  return {
    device_code: value.device_code,
    user_code: value.user_code,
    verification_uri: portalUrl(value.verification_uri, cfg),
    verification_uri_complete: portalUrl(value.verification_uri_complete, cfg),
    expires_in: boundedInt(value.expires_in, 60, 1_800, 600),
    interval: boundedInt(value.interval, 1, 30, 5),
  };
}

type TokenPoll = { kind: 'pending' } | { kind: 'slow_down' } | { kind: 'failed'; reason: string } | { kind: 'connected'; credential: NousOAuthCredential };

export async function pollDeviceToken(cfg: OAuthConfig, deviceCode: string, fetcher: typeof fetch = fetch): Promise<TokenPoll> {
  const response = await fetcher(`${cfg.portalBaseUrl}/api/oauth/token`, {
    method: 'POST', redirect: 'manual',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: DEVICE_GRANT, client_id: cfg.clientId, device_code: deviceCode }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = String(payload.error ?? 'oauth_failed');
    if (code === 'authorization_pending') return { kind: 'pending' };
    if (code === 'slow_down') return { kind: 'slow_down' };
    const safe = ['access_denied', 'expired_token', 'invalid_grant'].includes(code) ? code : 'oauth_failed';
    return { kind: 'failed', reason: safe };
  }
  const access = typeof payload.access_token === 'string' ? payload.access_token : '';
  const refresh = typeof payload.refresh_token === 'string' ? payload.refresh_token : '';
  const scope = typeof payload.scope === 'string' ? payload.scope : cfg.scope;
  if (!access || !refresh || !scope.split(/\s+/).includes('inference:invoke')) {
    return { kind: 'failed', reason: 'oauth_scope_invalid' };
  }
  const ttl = boundedInt(payload.expires_in, 60, 86_400, 3_600);
  const candidateBase = typeof payload.inference_base_url === 'string' ? payload.inference_base_url : INFERENCE_BASE;
  const parsedBase = new URL(candidateBase);
  if (parsedBase.origin !== new URL(INFERENCE_BASE).origin && cfg.portalBaseUrl === PORTAL_ORIGIN) {
    return { kind: 'failed', reason: 'oauth_upstream_invalid' };
  }
  return { kind: 'connected', credential: {
    access_token: access, refresh_token: refresh, client_id: cfg.clientId, scope,
    token_type: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    portal_base_url: cfg.portalBaseUrl,
    inference_base_url: candidateBase.replace(/\/$/, ''),
    expires_at: new Date(Date.now() + ttl * 1_000).toISOString(),
  } };
}

interface SessionRow {
  id: string; initiated_by: string; connection_id: string | null; client_id: string; scope: string; portal_base_url: string;
  ciphertext: Uint8Array; iv: Uint8Array; wrapped_dek: Uint8Array; wrap_iv: Uint8Array;
  kek_version: number; poll_interval_seconds: number; next_poll_at: Date; expires_at: Date; status: string;
}

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  throw new Error('expected encrypted OAuth bytes');
};

/** POST /w/:ws/provider-connections/nous/start */
export async function startNousOAuth(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false }); requireCsrf(c);
  const cfg = config(c.env);
  const actor = await inWorkspace(c, async (work) => {
    work.requireAdmin('connecting Nous Portal'); requireStepUp(work.session);
    await consumeRate(work.tx, work.userId, work.workspaceId, START_LIMIT);
    return { userId: work.userId, workspaceId: work.workspaceId };
  });
  // This is a deployment capability result, not an upstream outage. Keeping
  // it in the typed 2xx contract lets the client reveal the explicit manual
  // fallback without treating an intentionally disabled integration as a
  // generic network failure.
  if (!cfg) return c.json(providerOAuthStartSchema.parse({ status: 'unavailable', reason: 'oauth_not_configured', manual_fallback: true }));
  const device = await requestDeviceCode(cfg);
  const sessionId = crypto.randomUUID();
  const sealed = await sealKey(c.env, { workspaceId: actor.workspaceId, keyId: sessionId }, device.device_code);
  const expiresAt = new Date(Date.now() + device.expires_in * 1_000);
  await withTenantTransaction(c.env, 'app', actor, async (tx) => {
    await tx.query(`UPDATE provider_oauth_sessions SET status = 'cancelled' WHERE workspace_id = $1 AND provider = 'nous_portal' AND status = 'pending'`, [actor.workspaceId]);
    await tx.query(
      `INSERT INTO provider_oauth_sessions
       (id, workspace_id, provider, initiated_by, client_id, scope, portal_base_url,
        verification_uri, user_code, ciphertext, iv, wrapped_dek, wrap_iv, kek_version,
        poll_interval_seconds, next_poll_at, expires_at)
       VALUES ($1,$2,'nous_portal',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15)`,
      [sessionId, actor.workspaceId, actor.userId, cfg.clientId, cfg.scope, cfg.portalBaseUrl,
       device.verification_uri_complete, device.user_code, Buffer.from(sealed.ciphertext), Buffer.from(sealed.iv),
       Buffer.from(sealed.wrappedDek), Buffer.from(sealed.wrapIv), sealed.kekVersion, device.interval, expiresAt],
    );
  });
  return c.json(providerOAuthStartSchema.parse({ status: 'pending', session_id: sessionId,
    verification_uri: device.verification_uri_complete, user_code: device.user_code,
    expires_at: expiresAt.toISOString(), poll_after_ms: device.interval * 1_000 }));
}

/** POST /w/:ws/provider-connections/nous/:id/poll */
export async function pollNousOAuth(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false }); requireCsrf(c);
  const cfg = config(c.env);
  if (!cfg) return c.json({ error: 'Nous OAuth is not configured', reason: 'oauth_not_configured' }, 503);
  const id = pathUuid(c, 'id');
  const prepared = await inWorkspace(c, async (work) => {
    // Step-up is enforced when the grant starts. Polling may legitimately run
    // beyond the five-minute freshness window, but it still requires an active
    // WorkOS session, current Admin membership, and the initiating user below.
    work.requireAdmin('connecting Nous Portal');
    const { rows } = await work.tx.query<SessionRow>(`SELECT * FROM provider_oauth_sessions WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [work.workspaceId, id]);
    const row = rows[0];
    if (!row || row.initiated_by !== work.userId) throw new RouteError('OAuth session not found', 'not_found', 404);
    if (row.status === 'connected' && row.connection_id) {
      const key = await getProviderKey(work.tx, work.workspaceId, row.connection_id);
      if (key) return { connectedKey: key, workspaceId: work.workspaceId, userId: work.userId } as const;
    }
    if (row.status !== 'pending') return { terminal: row.status, workspaceId: work.workspaceId, userId: work.userId } as const;
    if (row.expires_at.getTime() <= Date.now()) {
      await work.tx.query(`UPDATE provider_oauth_sessions SET status='expired' WHERE id=$1`, [id]);
      return { terminal: 'expired', workspaceId: work.workspaceId, userId: work.userId } as const;
    }
    const wait = Math.max(0, row.next_poll_at.getTime() - Date.now());
    if (wait > 0) return { wait, workspaceId: work.workspaceId, userId: work.userId } as const;
    await work.tx.query(`UPDATE provider_oauth_sessions SET next_poll_at=now()+($2 * interval '1 second') WHERE id=$1`, [id, row.poll_interval_seconds]);
    const deviceCode = await openKey(c.env, { workspaceId: work.workspaceId, keyId: id }, {
      ciphertext: bytes(row.ciphertext), iv: bytes(row.iv), wrappedDek: bytes(row.wrapped_dek),
      wrapIv: bytes(row.wrap_iv), kekVersion: row.kek_version,
    });
    return { row, deviceCode, workspaceId: work.workspaceId, userId: work.userId } as const;
  });
  if ('connectedKey' in prepared) return c.json(providerOAuthPollSchema.parse({ status: 'connected', key: prepared.connectedKey, synced: null }));
  if ('terminal' in prepared) return c.json(providerOAuthPollSchema.parse({ status: prepared.terminal === 'expired' ? 'expired' : 'failed', reason: prepared.terminal }));
  if ('wait' in prepared) return c.json(providerOAuthPollSchema.parse({ status: 'pending', poll_after_ms: Math.max(1_000, Math.min(30_000, prepared.wait ?? 1_000)) }));
  const outcome = await pollDeviceToken(cfg, prepared.deviceCode);
  if (outcome.kind === 'pending' || outcome.kind === 'slow_down') {
    const delay = (prepared.row.poll_interval_seconds + (outcome.kind === 'slow_down' ? 1 : 0)) * 1_000;
    return c.json(providerOAuthPollSchema.parse({ status: 'pending', poll_after_ms: Math.min(30_000, delay) }));
  }
  if (outcome.kind === 'failed') {
    await withTenantTransaction(c.env, 'app', prepared, (tx) => tx.query(`UPDATE provider_oauth_sessions SET status=$2, completed_at=now(), ciphertext='\\x00'::bytea, wrapped_dek='\\x00'::bytea WHERE id=$1`, [id, outcome.reason === 'expired_token' ? 'expired' : 'failed']));
    return c.json(providerOAuthPollSchema.parse({ status: outcome.reason === 'expired_token' ? 'expired' : 'failed', reason: outcome.reason }));
  }
  let key = await withTenantTransaction(c.env, 'app', prepared, async (tx) => {
    const stored = await addProviderOAuthConnection(tx, c.env, {
      workspaceId: prepared.workspaceId,
      addedBy: prepared.userId,
      credential: outcome.credential,
    });
    await tx.query(`UPDATE provider_oauth_sessions SET status='connected', connection_id=$2, completed_at=now(), ciphertext='\\x00'::bytea, wrapped_dek='\\x00'::bytea WHERE id=$1`, [id, stored.id]);
    if (stored.replaces_key_id) {
      await tx.query(`INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, key_id) VALUES ($1,'user',$2,'provider_key.revoked',$3)`, [prepared.workspaceId, prepared.userId, stored.replaces_key_id]);
    }
    await tx.query(`INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, key_id) VALUES ($1,'user',$2,'provider_key.added',$3)`, [prepared.workspaceId, prepared.userId, stored.id]);
    return stored;
  });
  // Persist the rotating credential before making the optional account lookup.
  // A Portal timeout here must not lose a successfully redeemed device grant.
  const account = await fetchNousOAuthAccount(cfg, outcome.credential.access_token).catch(() => null);
  if (account) {
    key = await withTenantTransaction(c.env, 'app', prepared, (tx) =>
      setProviderOAuthAccount(tx, prepared.workspaceId, key.id, account));
  }
  const synced = await syncCatalogForKey(
    (fn) => withTenantTransaction(c.env, 'app', prepared, fn), adapterOptions(c.env),
    prepared.workspaceId, key.id,
    { provider: 'nous_portal', apiKey: outcome.credential.access_token, keyId: key.id }, allowedProviders(c.env),
  ).then((result) => result ? { count: result.written, at: result.at } : null).catch(() => null);
  return c.json(providerOAuthPollSchema.parse({ status: 'connected', key, synced }));
}
