// `POST /demo/request-access` — the public request-access form.
//
// The demo host forwards one link and one passcode to people whose addresses we
// do not know in advance. Each of them types a work email and the passcode on
// `/demo`, and if the passcode is right this route creates the same invitation
// an Admin's click on Members → Invite would create, on behalf of the demo
// workspace's earliest Admin, so the WorkOS email names a real person and the
// existing accept flow (`POST /invitations/:token/accept`) binds the
// membership. Nothing here is a second invitation path: the rows are written
// by `inviteInTransaction` and `resendInTransaction` in `routes/members.ts`.
//
// Three things the route is careful about, because it has no session:
//
//   * **It is a guessing oracle, so every attempt is a row.** The budget lives
//     in `demo_access_requests` (migration 0067), not in isolate memory, and
//     it is spent per address, per caller and in total before the passcode is
//     even looked at. A wrong guess is not refunded.
//   * **The passcode is compared in constant time**, on SHA-256 digests so the
//     lengths never differ, with workerd's `timingSafeEqual` when it exists
//     and a fixed-length XOR loop when it does not (the `db` tests run in
//     Node).
//   * **It says nothing about an address until the passcode matched.** The
//     two answers that do name an address — invited, already a member — are
//     what the visitor needs to act; a wrong passcode and a domain outside
//     the allowlist get the same shape with distinct reasons and no hint of
//     which domains are allowed.
//
// Unconfigured means unavailable, in words: with no passcode secret or no
// workspace id the route answers `demo_access_not_configured` and invites
// nobody, the way `provider-oauth.ts` reports `oauth_not_configured`.
import type { Context } from 'hono';
import { demoAccessRequestSchema, demoAccessResponseSchema, type DemoAccessResponse } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireOrigin } from '../auth.js';
import { connect, type Tx } from '../db/client.js';
import { runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';
import { withCapacityGrantQuarantine } from '../hermes-cloud/capacity.js';
import { memberProvisioningEnabled } from '../member-provisioning/service.js';
import { invitationCorrelationId, logInvitationDiagnostic } from '../ops/invitation-diagnostics.js';
import { inviteInTransaction, resendInTransaction, type InvitationWork } from './members.js';
import { jsonBody } from './tenant.js';
import { RouteError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DemoAccessConfig {
  readonly passcode: string;
  readonly workspaceId: string;
  /** Lower-cased, trimmed. Empty means any domain. */
  readonly allowedDomains: readonly string[];
}

/** `null` when the deployment has not opted in; the route then invites nobody. */
export function demoAccessConfig(env: Env): DemoAccessConfig | null {
  const passcode = env.DEMO_ACCESS_PASSCODE ?? '';
  const workspaceId = (env.DEMO_ACCESS_WORKSPACE_ID ?? '').trim().toLowerCase();
  if (!passcode || !UUID.test(workspaceId)) return null;
  return { passcode, workspaceId, allowedDomains: parseAllowedDomains(env.DEMO_ACCESS_ALLOWED_DOMAINS) };
}

export function parseAllowedDomains(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter((domain) => domain.length > 0);
}

/** Exact match on the part after `@`; `a.example.com` is not `example.com`. */
export function domainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const at = email.lastIndexOf('@');
  const domain = at < 0 ? '' : email.slice(at + 1).toLowerCase();
  return allowedDomains.includes(domain);
}

/**
 * Constant-time string equality.
 *
 * Both sides are hashed first so the comparison always runs over 32 bytes:
 * a length check before the loop would leak the passcode's length one
 * millisecond at a time. workerd exposes `crypto.subtle.timingSafeEqual`;
 * Node's WebCrypto does not, so the fallback is the fixed-length OR-of-XORs
 * loop with no early exit.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean };
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(left, right);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < x.length; index += 1) difference |= (x[index] ?? 0) ^ (y[index] ?? 0);
  return difference === 0;
}

/**
 * The hourly budget. Modest on purpose: a real visitor types the passcode
 * once, perhaps twice, and a whole invited cohort fits inside the total.
 */
export const DEMO_ACCESS_BUDGET = {
  perEmail: 5,
  perCaller: 10,
  total: 60,
  windowSeconds: 3_600,
} as const;

type Outcome =
  | 'invited' | 'resent' | 'already_member' | 'passcode_invalid'
  | 'domain_not_allowed' | 'rate_limited' | 'unavailable' | 'failed';

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Cloudflare's header first; the first hop of `x-forwarded-for` in local runs. */
function callerAddress(c: Context<{ Bindings: Env }>): string {
  const direct = c.req.header('cf-connecting-ip')?.trim();
  if (direct) return direct;
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || 'unknown';
}

async function recordAttempt(tx: Pick<Tx, 'query'>, email: string, ipHash: string, outcome: Outcome): Promise<void> {
  await tx.query(
    `INSERT INTO demo_access_requests (email, ip_hash, outcome) VALUES ($1, $2, $3)`,
    [email, ipHash, outcome],
  );
}

interface Spent { email: number; caller: number; total: number }

async function spentThisHour(tx: Pick<Tx, 'query'>, email: string, ipHash: string): Promise<Spent> {
  // The table only has to remember the window; anything older is noise that
  // would otherwise grow one row per attempt forever.
  await tx.query(`DELETE FROM demo_access_requests WHERE created_at < now() - interval '7 days'`);
  const { rows } = await tx.query<{ by_email: string; by_caller: string; total: string }>(
    `SELECT count(*) FILTER (WHERE email = $1) AS by_email,
            count(*) FILTER (WHERE ip_hash = $2) AS by_caller,
            count(*) AS total
       FROM demo_access_requests
      WHERE created_at > now() - make_interval(secs => $3)`,
    [email, ipHash, DEMO_ACCESS_BUDGET.windowSeconds],
  );
  const row = rows[0];
  return {
    email: Number(row?.by_email ?? '0'),
    caller: Number(row?.by_caller ?? '0'),
    total: Number(row?.total ?? '0'),
  };
}

const unavailable = (c: Context<{ Bindings: Env }>): Response =>
  c.json(demoAccessResponseSchema.parse({ status: 'unavailable', reason: 'demo_access_not_configured' }));

type WorkspaceOutcome =
  | { kind: 'unavailable' }
  | { kind: 'already_member' }
  | { kind: 'invited'; invitationId: string; resent: boolean };

/** POST /demo/request-access */
export async function requestDemoAccess(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  const cfg = demoAccessConfig(c.env);
  if (!cfg) return unavailable(c);

  const parsed = demoAccessRequestSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) {
    const onEmail = parsed.error.issues.some((issue) => issue.path[0] === 'email');
    throw onEmail
      ? new RouteError('enter the work email address the invitation should go to', 'bad_email', 422)
      : new RouteError('enter the passcode you were sent', 'bad_passcode', 422);
  }
  const { email, passcode } = parsed.data;
  const ipHash = await sha256Hex(callerAddress(c));
  const correlationId = invitationCorrelationId();

  // The budget and the two refusals run on a plain connection, outside any
  // transaction, so the row that counts a wrong guess stands even though the
  // attempt throws: refunding failures would limit only the successes.
  const client = await connect(c.env, 'app');
  try {
    const spent = await spentThisHour(client, email, ipHash);
    if (spent.email >= DEMO_ACCESS_BUDGET.perEmail
        || spent.caller >= DEMO_ACCESS_BUDGET.perCaller
        || spent.total >= DEMO_ACCESS_BUDGET.total) {
      await recordAttempt(client, email, ipHash, 'rate_limited');
      c.header('Retry-After', String(DEMO_ACCESS_BUDGET.windowSeconds));
      throw new RouteError('too many requests for this address or from this connection; try again in an hour', 'rate_limited', 429);
    }
    if (!(await constantTimeEqual(passcode, cfg.passcode))) {
      await recordAttempt(client, email, ipHash, 'passcode_invalid');
      throw new RouteError('that passcode is not right', 'demo_passcode_invalid', 403);
    }
    if (!domainAllowed(email, cfg.allowedDomains)) {
      await recordAttempt(client, email, ipHash, 'domain_not_allowed');
      throw new RouteError('this demo is open to work addresses only', 'demo_domain_not_allowed', 403);
    }
  } finally {
    await client.end();
  }

  const jobs: string[] = [];
  const preparing = memberProvisioningEnabled(c.env);
  let checkpoint = 'request_received';
  let outcome: WorkspaceOutcome;
  try {
    outcome = await withCapacityGrantQuarantine(c.env, () => withWorkspaceTransaction(c.env, cfg.workspaceId, async (tx) => {
      // The earliest Admin still active is the inviter: deterministic, so the
      // same person signs every demo invitation, and a real member, so the
      // WorkOS email names somebody the recipient could reply to.
      const admin = await tx.query<{ user_id: string }>(
        `SELECT user_id FROM members
          WHERE workspace_id = $1 AND role = 'admin' AND status = 'active'
          ORDER BY joined_at ASC, id ASC LIMIT 1`,
        [cfg.workspaceId],
      );
      const inviter = admin.rows[0]?.user_id;
      if (!inviter) return { kind: 'unavailable' } as const;

      const member = await tx.query(
        `SELECT 1 FROM members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1 AND u.email = $2 AND m.status = 'active'`,
        [cfg.workspaceId, email],
      );
      if ((member.rowCount ?? 0) > 0) {
        await recordAttempt(tx, email, ipHash, 'already_member');
        return { kind: 'already_member' } as const;
      }

      const work: InvitationWork = { tx, workspaceId: cfg.workspaceId, userId: inviter, jobs };
      const pending = await tx.query<{ id: string }>(
        `SELECT id FROM invitations WHERE workspace_id = $1 AND email = $2 AND status = 'pending' FOR UPDATE`,
        [cfg.workspaceId, email],
      );
      const live = pending.rows[0];
      if (live) {
        // A second request from the same person is a resend, not a second
        // invitation: the old row becomes `resent`, the new one carries the
        // email, exactly as the Admin's Resend button does.
        const entity = await resendInTransaction(c.env, work, live.id, correlationId, (name) => { checkpoint = name; });
        await recordAttempt(tx, email, ipHash, 'resent');
        return { kind: 'invited', invitationId: entity.id, resent: true } as const;
      }
      const created = await inviteInTransaction(c.env, work, {
        email, role: 'member', roleTemplateKey: 'partnerships-agent', preparing, correlationId, actorUserId: null,
      }, (name) => { checkpoint = name; });
      await recordAttempt(tx, email, ipHash, 'invited');
      return { kind: 'invited', invitationId: created.entity.id, resent: false } as const;
    }));
  } catch (error) {
    logInvitationDiagnostic({
      action: 'create', checkpoint, correlationId, workspaceId: cfg.workspaceId, ok: false,
      reason: error instanceof RouteError ? error.reason : 'invitation_failed',
      status: error instanceof RouteError ? error.status : 500,
    });
    throw error;
  }

  if (outcome.kind === 'unavailable') {
    // A demo workspace with no active Admin is a deployment problem, not the
    // visitor's; it is recorded and reported in the same words as unset config.
    const recorder = await connect(c.env, 'app');
    try { await recordAttempt(recorder, email, ipHash, 'unavailable'); } finally { await recorder.end(); }
    return unavailable(c);
  }
  if (outcome.kind === 'already_member') {
    return c.json(demoAccessResponseSchema.parse({ status: 'already_member', email } satisfies DemoAccessResponse));
  }

  if (jobs.length > 0) await runJobsAfterCommit(c.env, cfg.workspaceId, jobs);
  logInvitationDiagnostic({
    action: outcome.resent ? 'resend' : 'create', checkpoint: 'committed', correlationId,
    workspaceId: cfg.workspaceId, invitationId: outcome.invitationId, ok: true,
    reason: outcome.resent ? 'duplicate' : 'delivery_queued', status: 200,
  });
  return c.json(demoAccessResponseSchema.parse({ status: 'invited', email } satisfies DemoAccessResponse));
}
