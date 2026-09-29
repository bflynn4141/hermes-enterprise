// Workspace wallet root setup (C101).
//
// An Admin creates a passkey in the browser; Hermes asks Turnkey to create the
// workspace's sub-organization with that passkey as its only root user, then
// reads the sub-organization back to confirm nobody else (Hermes included) can
// act as root. Provider calls happen outside database transactions, and an
// uncertain outcome is reconciled by the sub-organization's unique name rather
// than retried, so a timeout can never create a second organization.
import type { Context } from 'hono';
import { walletRootChallengeSchema, walletRootSchema, walletRootSubmitSchema, type WalletRoot } from '@hermes/shared';
import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { consumeRate } from '../auth/rate-limit.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { inWorkspace, jsonBody, RouteError } from './tenant.js';
import { turnkeySetupConfig, type TurnkeySetupConfig } from '../wallets/turnkey-config.js';
import {
  createRootedSubOrganization, findSubOrganizationsByName, readRoot, rootIsCustomerOwned, subOrganizationResult,
} from '../wallets/turnkey-client.js';

type C = Context<{ Bindings: Env }>;
const CHALLENGE_TTL_MINUTES = 5;
/** How long an unanswered create may still be in flight before "not found" means "not created". */
const RECONCILE_GRACE_MS = 2 * 60 * 1000;

const unavailable = () => new RouteError('wallet setup is not enabled', 'wallets_unavailable', 503);
const rootExists = () => new RouteError('this workspace already has a wallet owner or a setup in progress', 'wallet_root_exists', 409);
const expired = () => new RouteError('the passkey request expired; start again', 'wallet_setup_expired', 400);
const badPasskey = () => new RouteError('the passkey could not be verified for this request', 'wallet_passkey_invalid', 400);

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

function decodeBase64url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
}

/**
 * The browser's signed ceremony data must be a registration, for this exact
 * challenge, from one of this deployment's origins. Turnkey verifies the
 * attestation itself; this stops a passkey made elsewhere or for another
 * request from ever reaching it.
 */
export function clientDataMatches(clientDataJson: string, challenge: string, origins: readonly string[]): boolean {
  try {
    const data = JSON.parse(decodeBase64url(clientDataJson)) as { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
    return data.type === 'webauthn.create' && data.challenge === challenge
      && typeof data.origin === 'string' && origins.includes(data.origin) && data.crossOrigin !== true;
  } catch {
    return false;
  }
}

type SetupRow = {
  id: string; workspace_id: string; member_id: string; challenge: string; state: string; suborg_name: string;
  credential_id: string | null; provider_org_id: string | null; provider_root_user_id: string | null; updated_at: Date;
};

type Finish =
  | { state: 'verified'; orgId: string; rootUserId: string; activityId?: string }
  | { state: 'unverified'; orgId: string; rootUserId: string | null; activityId?: string; code: string }
  | { state: 'created'; orgId: string; rootUserId: string; activityId?: string }
  | { state: 'rejected'; activityId?: string; code: string }
  | { state: 'ambiguous'; activityId?: string; code: string };

const CONFIG_STATUS: Record<Finish['state'], string> = {
  verified: 'root_verified', unverified: 'needs_attention', created: 'needs_reconciliation',
  rejected: 'awaiting_owner_enrollment', ambiguous: 'needs_reconciliation',
};

/** Records a provider outcome. Runs as the system so a demoted or signed-out Admin cannot lose the result. */
async function finish(env: Env, setup: Pick<SetupRow, 'id' | 'workspace_id' | 'member_id'>, from: string[], outcome: Finish): Promise<void> {
  await withWorkspaceTransaction(env, setup.workspace_id, async (tx: Tx) => {
    await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [setup.workspace_id]);
    const orgId = 'orgId' in outcome ? outcome.orgId : null;
    const rootUserId = 'rootUserId' in outcome ? outcome.rootUserId : null;
    const code = 'code' in outcome ? outcome.code.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64) : null;
    const updated = await tx.query(
      `UPDATE wallet_root_setups SET state=$3, provider_org_id=COALESCE($4, provider_org_id),
         provider_root_user_id=COALESCE($5, provider_root_user_id), provider_activity_id=COALESCE($6, provider_activity_id),
         failure_code=$7, updated_at=now()
       WHERE workspace_id=$1 AND id=$2 AND state = ANY($8::text[])`,
      [setup.workspace_id, setup.id, outcome.state, orgId, rootUserId, outcome.activityId ?? null, code, from]);
    if (!updated.rowCount) return;
    await tx.query(
      `UPDATE workspace_wallet_config SET status=CASE WHEN $2='root_verified' AND NOT EXISTS (
           SELECT 1 FROM members WHERE workspace_id=$1 AND id=$4::uuid AND status='active' AND role='admin'
         ) THEN 'needs_attention' ELSE $2 END, provider_org_id=COALESCE($3, provider_org_id),
         root_member_id=CASE WHEN $2='root_verified' THEN $4::uuid ELSE root_member_id END,
         root_verified_at=CASE WHEN $2='root_verified' THEN now() ELSE root_verified_at END, updated_at=now()
       WHERE workspace_id=$1`,
      [setup.workspace_id, CONFIG_STATUS[outcome.state], orgId, setup.member_id]);
  });
}

/** Read-back decides custody; a read failure leaves the setup "created" for later reconciliation. */
async function verifyRoot(config: TurnkeySetupConfig, orgId: string, rootUserId: string, credentialId: string, activityId?: string): Promise<Finish> {
  try {
    const readBack = await readRoot(config.turnkey, orgId);
    return rootIsCustomerOwned(readBack, { rootUserId, credentialId })
      ? { state: 'verified', orgId, rootUserId, activityId }
      : { state: 'unverified', orgId, rootUserId, activityId, code: 'custody_check_failed' };
  } catch {
    return { state: 'created', orgId, rootUserId, activityId };
  }
}

export async function rootOverview(tx: Tx, env: Env, workspaceId: string): Promise<WalletRoot> {
  const { rows } = await tx.query<{ status: string; owner_name: string | null; root_verified_at: Date | null }>(
    `SELECT c.status, u.name AS owner_name, c.root_verified_at
       FROM workspace_wallet_config c
       LEFT JOIN members m ON m.workspace_id = c.workspace_id AND m.id = c.root_member_id
       LEFT JOIN users u ON u.id = m.user_id
      WHERE c.workspace_id = $1`, [workspaceId]);
  const row = rows[0];
  const status = !row || row.status === 'awaiting_owner_enrollment' ? 'not_started'
    : row.status === 'creating_root' ? 'in_progress'
    : row.status === 'root_verified' ? 'verified'
    : row.status === 'needs_attention' ? 'needs_attention' : 'needs_reconciliation';
  return walletRootSchema.parse({
    status,
    available: turnkeySetupConfig(env) !== null,
    owner_name: status === 'verified' ? row?.owner_name ?? null : null,
    verified_at: status === 'verified' && row?.root_verified_at ? new Date(row.root_verified_at).toISOString() : null,
  });
}

/** Step 1: a single-use WebAuthn challenge for the Admin's passkey. */
export async function startWalletRoot(c: C): Promise<Response> {
  requireOrigin(c, { required: true });
  requireCsrf(c);
  const config = turnkeySetupConfig(c.env);
  if (!config) throw unavailable();
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('setting up workspace wallets');
    requireStepUp(work.session);
    await consumeRate(work.tx, work.userId, work.workspaceId, { action: 'wallet_root.challenge', limit: 5, windowSeconds: 3600 });
    const { rows: workspaces } = await work.tx.query<{ name: string }>('SELECT name FROM workspaces WHERE id=$1 FOR UPDATE', [work.workspaceId]);
    const { rows: members } = await work.tx.query<{ id: string }>(
      "SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2 AND status='active'", [work.workspaceId, work.userId]);
    if (!members[0]) throw new RouteError('no active membership', 'admin_required', 403);
    await work.tx.query('INSERT INTO workspace_wallet_config(workspace_id) VALUES ($1) ON CONFLICT DO NOTHING', [work.workspaceId]);
    const { rows: configs } = await work.tx.query<{ status: string }>(
      'SELECT status FROM workspace_wallet_config WHERE workspace_id=$1', [work.workspaceId]);
    if (configs[0]?.status !== 'awaiting_owner_enrollment') throw rootExists();
    const id = crypto.randomUUID();
    const challenge = randomToken();
    const { rows } = await work.tx.query<{ expires_at: Date }>(
      `INSERT INTO wallet_root_setups(id, workspace_id, member_id, challenge, suborg_name, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6)) RETURNING expires_at`,
      [id, work.workspaceId, members[0].id, challenge, `hermes-ws-${work.workspaceId}-${id}`, CHALLENGE_TTL_MINUTES]);
    return walletRootChallengeSchema.parse({
      setup_id: id, challenge, rp_id: config.rpId, user_handle: randomToken(),
      user_name: `${workspaces[0]?.name ?? 'Workspace'} wallets`.slice(0, 64),
      expires_at: new Date(rows[0]!.expires_at).toISOString(),
    });
  });
  c.header('Cache-Control', 'no-store');
  return c.json(result, 201);
}

/** Step 2: the passkey becomes the sub-organization's only root, then custody is read back. */
export async function submitWalletRoot(c: C): Promise<Response> {
  requireOrigin(c, { required: true });
  requireCsrf(c);
  const config = turnkeySetupConfig(c.env);
  if (!config) throw unavailable();
  const parsed = walletRootSubmitSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw badPasskey();
  const { setup_id: setupId, attestation } = parsed.data;
  const setup = await inWorkspace(c, async (work) => {
    work.requireAdmin('setting up workspace wallets');
    requireStepUp(work.session);
    await work.tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [work.workspaceId]);
    const { rows } = await work.tx.query<SetupRow & { user_id: string; live: boolean }>(
      `SELECT s.*, m.user_id, s.expires_at > now() AS live FROM wallet_root_setups s
         JOIN members m ON m.workspace_id = s.workspace_id AND m.id = s.member_id AND m.status = 'active'
        WHERE s.workspace_id=$1 AND s.id=$2 FOR UPDATE OF s`, [work.workspaceId, setupId]);
    const row = rows[0];
    if (!row || row.user_id !== work.userId || row.state !== 'challenged' || !row.live) throw expired();
    if (!clientDataMatches(attestation.client_data_json, row.challenge, config.passkeyOrigins)) throw badPasskey();
    const { rows: configs } = await work.tx.query<{ status: string }>(
      'SELECT status FROM workspace_wallet_config WHERE workspace_id=$1', [work.workspaceId]);
    if (configs[0]?.status !== 'awaiting_owner_enrollment') throw rootExists();
    await work.tx.query(`UPDATE wallet_root_setups SET state='submitting', credential_id=$3, updated_at=now()
      WHERE workspace_id=$1 AND id=$2`, [work.workspaceId, row.id, attestation.credential_id]);
    await work.tx.query(`UPDATE workspace_wallet_config SET status='creating_root', updated_at=now() WHERE workspace_id=$1`, [work.workspaceId]);
    return row;
  });

  const outcome = await createRootedSubOrganization(config.turnkey, {
    name: setup.suborg_name,
    // Turnkey stores this name; it carries no personal data.
    rootUserName: 'Workspace admin',
    challenge: setup.challenge,
    attestation: {
      credentialId: attestation.credential_id,
      clientDataJson: attestation.client_data_json,
      attestationObject: attestation.attestation_object,
      transports: attestation.transports.map((t) => `AUTHENTICATOR_TRANSPORT_${t.toUpperCase()}`),
    },
  });
  let result: Finish;
  if (outcome.kind === 'completed') {
    const created = subOrganizationResult(outcome.activity);
    result = !created || created.rootUserIds.length !== 1
      ? { state: 'ambiguous', activityId: outcome.activity.id, code: 'unexpected_result' }
      : await verifyRoot(config, created.subOrganizationId, created.rootUserIds[0]!, attestation.credential_id, outcome.activity.id);
  } else if (outcome.kind === 'rejected') {
    result = { state: 'rejected', activityId: outcome.activity?.id, code: outcome.code ?? 'rejected' };
  } else {
    result = { state: 'ambiguous', activityId: outcome.kind === 'pending' ? outcome.activity.id : outcome.activityId,
      code: outcome.kind === 'pending' ? 'consensus_needed' : outcome.reason };
  }
  await finish(c.env, setup, ['submitting'], result);
  return overviewResponse(c);
}

/** Step 3, only after an uncertain answer: find the sub-organization by name and verify it. */
export async function reconcileWalletRoot(c: C): Promise<Response> {
  requireOrigin(c, { required: true });
  requireCsrf(c);
  const config = turnkeySetupConfig(c.env);
  if (!config) throw unavailable();
  const setup = await inWorkspace(c, async (work) => {
    work.requireAdmin('checking workspace wallet setup');
    await consumeRate(work.tx, work.userId, work.workspaceId, { action: 'wallet_root.reconcile', limit: 30, windowSeconds: 3600 });
    const { rows } = await work.tx.query<SetupRow>(
      `SELECT * FROM wallet_root_setups WHERE workspace_id=$1 AND state IN ('submitting','ambiguous','created')`, [work.workspaceId]);
    return rows[0] ?? null;
  });
  if (!setup) return overviewResponse(c);
  const age = Date.now() - new Date(setup.updated_at).getTime();
  // A request still in its own call is not ours to decide yet.
  if (setup.state === 'submitting' && age < RECONCILE_GRACE_MS) return overviewResponse(c);
  const credentialId = setup.credential_id ?? '';
  let result: Finish | null = null;
  try {
    if (setup.state === 'created' && setup.provider_org_id && setup.provider_root_user_id) {
      result = await verifyRoot(config, setup.provider_org_id, setup.provider_root_user_id, credentialId);
    } else {
      const found = await findSubOrganizationsByName(config.turnkey, setup.suborg_name);
      if (found.length > 1) {
        result = { state: 'unverified', orgId: found[0]!, rootUserId: null, code: 'duplicate_suborganizations' };
      } else if (found.length === 1) {
        const readBack = await readRoot(config.turnkey, found[0]!);
        const rootUserId = readBack.rootUserIds.length === 1 ? readBack.rootUserIds[0]! : null;
        result = rootUserId && rootIsCustomerOwned(readBack, { rootUserId, credentialId })
          ? { state: 'verified', orgId: found[0]!, rootUserId }
          : { state: 'unverified', orgId: found[0]!, rootUserId, code: 'custody_check_failed' };
      } else if (age >= RECONCILE_GRACE_MS) {
        // Not found well after the request ended: nothing was created, so a new attempt is safe.
        result = { state: 'rejected', code: 'not_created' };
      }
    }
  } catch {
    throw new RouteError('Turnkey could not be reached; try again shortly', 'wallet_provider_unavailable', 503);
  }
  if (result) await finish(c.env, setup, ['submitting', 'ambiguous', 'created'], result);
  return overviewResponse(c);
}

async function overviewResponse(c: C): Promise<Response> {
  const root = await inWorkspace(c, (work) => rootOverview(work.tx, c.env, work.workspaceId));
  c.header('Cache-Control', 'no-store');
  return c.json(root);
}
