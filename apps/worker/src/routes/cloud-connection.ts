import type { Context } from 'hono';
import { cloudConnectionResponseSchema, cloudConnectionStartSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { consumeRate } from '../auth/rate-limit.js';
import { openSecret, sealSecret } from '../keys/envelope.js';
import { inWorkspace, RouteError } from './tenant.js';
import { discoverCloudOAuth, exchangeCloudCode, inspectCloudTools, inspectCloudOrganization, makeCloudAuthorizationUrl, registerCloudClient } from '../hermes-cloud/management.js';
import { cloudCredentialIdentity } from '../hermes-cloud/credential-envelope.js';

type C = Context<{ Bindings: Env }>;
interface EnvelopeRow {
  id: string; ciphertext: Uint8Array; iv: Uint8Array; wrapped_dek: Uint8Array; wrap_iv: Uint8Array; kek_version: number;
}
interface AttemptRow extends EnvelopeRow { initiated_by: string; status: string; expires_at: Date }
interface AttemptSecret { clientId: string; redirectUri: string; verifier: string; sid: string }

function origin(env: Env): string | null {
  if (env.HERMES_CLOUD_MANAGEMENT_ENABLED !== '1') return null;
  try {
    const url = new URL(env.HERMES_ENTERPRISE_PUBLIC_URL ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (!env.ALLOWED_ORIGINS.split(',').map(item => item.trim()).includes(url.origin)) return null;
    return url.origin;
  } catch { return null; }
}
const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
const envelope = (row: EnvelopeRow) => ({ ciphertext: new Uint8Array(row.ciphertext), iv: new Uint8Array(row.iv),
  wrappedDek: new Uint8Array(row.wrapped_dek), wrapIv: new Uint8Array(row.wrap_iv), kekVersion: row.kek_version });
const safeFailure = () => new RouteError('Cloud could not be connected. Please try again.', 'cloud_connection_unavailable', 503);

/** Read-only Settings projection. Capability stays false until governed bootstrap is proven. */
export async function getCloudConnection(c: C): Promise<Response> {
  const result = await inWorkspace(c, async work => {
    work.requireAdmin('viewing Cloud connection');
    const connections = await work.tx.query<{ status: string; organization_name: string | null }>(
      'SELECT status, organization_name FROM cloud_connections WHERE workspace_id=$1', [work.workspaceId]);
    const attempts = await work.tx.query<{ status: string }>(
      `SELECT status FROM cloud_connection_attempts WHERE workspace_id=$1 AND status IN ('pending','consumed') AND expires_at>now()`, [work.workspaceId]);
    const row = connections.rows[0];
    return { status: attempts.rows.length ? 'connecting' : row?.status ?? 'not_connected',
      organization_name: row?.status === 'connected' ? row.organization_name : null,
      automatic_setup_ready: false, available: origin(c.env) !== null };
  });
  c.header('Cache-Control', 'no-store');
  return c.json(cloudConnectionResponseSchema.parse(result));
}

/** Admin chooses the organization at the provider; no credentials are entered in Hermes. */
export async function startCloudConnection(c: C): Promise<Response> {
  requireOrigin(c, { required: true }); requireCsrf(c);
  const publicOrigin = origin(c.env);
  await inWorkspace(c, async work => {
    work.requireAdmin('connecting Cloud'); requireStepUp(work.session);
    await consumeRate(work.tx, work.userId, work.workspaceId, { action: 'cloud_connection.start', limit: 5, windowSeconds: 3600 });
  });
  if (!publicOrigin) throw safeFailure();
  const workspaceId = c.req.param('ws')!;
  const redirectUri = `${publicOrigin}/w/${workspaceId}/cloud/connection/callback`;
  const id = crypto.randomUUID(), state = random(), verifier = random();
  let clientId: string, authorizationUrl: string;
  try {
    const metadata = await discoverCloudOAuth();
    clientId = await registerCloudClient(metadata, redirectUri);
    authorizationUrl = await makeCloudAuthorizationUrl(metadata, { clientId, redirectUri, state, verifier });
  } catch { throw safeFailure(); }
  await inWorkspace(c, async work => {
    // Recheck the live session and membership after the external request.
    work.requireAdmin('connecting Cloud'); requireStepUp(work.session);
    await work.tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
    const sealed = await sealSecret(
      c.env,
      cloudCredentialIdentity('cloud_connection_attempt', workspaceId, id),
      JSON.stringify({ clientId, redirectUri, verifier, sid: work.session.sid } satisfies AttemptSecret),
    );
    await work.tx.query(`UPDATE cloud_connection_attempts SET status='cancelled', ciphertext=decode('00','hex'), wrapped_dek=decode('00','hex')
      WHERE workspace_id=$1 AND status IN ('pending','consumed')`, [workspaceId]);
    await work.tx.query(`INSERT INTO cloud_connection_attempts
      (id,workspace_id,initiated_by,state_hash,status,ciphertext,iv,wrapped_dek,wrap_iv,kek_version,expires_at)
      VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,now()+interval '10 minutes')`,
    [id, workspaceId, work.userId, await hash(state), Buffer.from(sealed.ciphertext), Buffer.from(sealed.iv),
      Buffer.from(sealed.wrappedDek), Buffer.from(sealed.wrapIv), sealed.kekVersion]);
  });
  c.header('Cache-Control', 'no-store');
  return c.json(cloudConnectionStartSchema.parse({ authorization_url: authorizationUrl }));
}

/** OAuth callback is bound to workspace + initiating user + authenticated session + one-use state. */
export async function completeCloudConnection(c: C): Promise<Response> {
  c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
  const state = c.req.query('state') ?? '';
  if (!origin(c.env) || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw new RouteError('Connection request expired', 'cloud_connection_expired', 400);
  const stateHash = await hash(state);
  const prepared = await inWorkspace(c, async work => {
    work.requireAdmin('connecting Cloud');
    await work.tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [work.workspaceId]);
    const { rows } = await work.tx.query<AttemptRow>(
      'SELECT * FROM cloud_connection_attempts WHERE workspace_id=$1 AND state_hash=$2 FOR UPDATE', [work.workspaceId, stateHash]);
    const row = rows[0];
    if (!row || row.initiated_by !== work.userId || row.status !== 'pending' || row.expires_at.getTime() <= Date.now())
      throw new RouteError('Connection request expired', 'cloud_connection_expired', 400);
    const secret = JSON.parse(await openSecret(
      c.env,
      cloudCredentialIdentity('cloud_connection_attempt', work.workspaceId, row.id),
      envelope(row),
    )) as AttemptSecret;
    if (secret.sid !== work.session.sid) throw new RouteError('Use the session that started this connection', 'cloud_connection_expired', 403);
    await work.tx.query(`UPDATE cloud_connection_attempts SET status='consumed', ciphertext=decode('00','hex'), wrapped_dek=decode('00','hex') WHERE id=$1`, [row.id]);
    return { id: row.id, workspaceId: work.workspaceId, secret };
  });
  let outcome = 'failed';
  try {
    if (c.req.query('error')) throw safeFailure();
    const code = c.req.query('code') ?? '';
    const metadata = await discoverCloudOAuth();
    const credential = await exchangeCloudCode(metadata, { ...prepared.secret, code });
    // Failed optional checks leave a new grant explicitly unverified. A replacement
    // cannot overwrite an existing organization binding without verifying a match.
    const account = await inspectCloudOrganization(credential.accessToken).catch(() => null);
    const toolsVerified = await inspectCloudTools(credential).then(() => true).catch(() => false);
    await inWorkspace(c, async work => {
      work.requireAdmin('connecting Cloud');
      if (work.session.sid !== prepared.secret.sid) throw safeFailure();
      await work.tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [work.workspaceId]);
      const current = await work.tx.query(`SELECT id FROM cloud_connection_attempts WHERE id=$1 AND status='consumed' AND expires_at>now()`, [prepared.id]);
      if (!current.rows.length) throw safeFailure();
      // Reconnecting cannot silently switch the workspace to another billed organization.
      const existing = await work.tx.query<{ organization_id: string | null }>('SELECT organization_id FROM cloud_connections WHERE workspace_id=$1', [work.workspaceId]);
      const expectedOrganizationId = existing.rows[0]?.organization_id;
      if (expectedOrganizationId && (account?.id !== expectedOrganizationId || !toolsVerified)) throw safeFailure();
      const sealed = await sealSecret(
        c.env,
        cloudCredentialIdentity('cloud_connection', work.workspaceId, prepared.id),
        JSON.stringify({ credential, clientId: prepared.secret.clientId,
          expectedOrganizationId: expectedOrganizationId ?? null }),
      );
      await work.tx.query(`INSERT INTO cloud_connections (id,workspace_id,initiated_by,status,ciphertext,iv,wrapped_dek,wrap_iv,kek_version)
        VALUES ($1,$2,$3,'verification_required',$4,$5,$6,$7,$8)
        ON CONFLICT (workspace_id) DO UPDATE SET id=EXCLUDED.id, initiated_by=EXCLUDED.initiated_by, status='verification_required',
          ciphertext=EXCLUDED.ciphertext,iv=EXCLUDED.iv,wrapped_dek=EXCLUDED.wrapped_dek,wrap_iv=EXCLUDED.wrap_iv,kek_version=EXCLUDED.kek_version,updated_at=now()`,
      [prepared.id, work.workspaceId, work.userId, Buffer.from(sealed.ciphertext), Buffer.from(sealed.iv), Buffer.from(sealed.wrappedDek), Buffer.from(sealed.wrapIv), sealed.kekVersion]);
      if (account && toolsVerified) {
        await work.tx.query(`UPDATE cloud_connections SET status='connected', organization_id=$3, organization_name=$4,updated_at=now()
          WHERE workspace_id=$1 AND id=$2 AND (organization_id IS NULL OR organization_id=$3)`,
        [work.workspaceId, prepared.id, account.id, account.name]);
      }
      await work.tx.query(`UPDATE cloud_connection_attempts SET status='complete' WHERE id=$1`, [prepared.id]);
    });
    outcome = 'saved';
  } catch {
    // A stored grant remains explicitly unverified. Never leak upstream error descriptions.
    await inWorkspace(c, async work => {
      work.requireAdmin('connecting Cloud');
      await work.tx.query(`UPDATE cloud_connection_attempts SET status='failed' WHERE id=$1 AND status='consumed'`, [prepared.id]);
    });
  }
  return c.redirect(`/workspace/${prepared.workspaceId}?cloud=${outcome}#settings/Organization`, 303);
}
