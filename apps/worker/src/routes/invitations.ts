// `POST /invitations/:token/accept`.
//
// The second route with no tenant in its path, and for the same reason as
// `POST /workspaces`: the workspace is what the call is trying to reach, so it
// cannot be the key the call is authorised under. `hermes_invitation_workspace`
// (migration 0013) turns the token into one id, and everything after that runs
// under that workspace's own key with row-level security in force.
//
// What it does *not* do is trust the token for identity. The token says which
// invitation; the session says who. The two have to agree — the signed-in
// person's verified email must be the address the invitation was sent to —
// because a link forwarded to a colleague would otherwise admit the colleague.
//
// In `AUTH_MODE=fake` the email comes from the `x-dev-user` row, which is the
// same rule with a development identity provider; nothing here is dev-only.
// See decision F2.
import type { Context } from 'hono';
import { bootstrapSchema, invitationPreviewSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { AuthError, getSession, requireCsrf, requireOrigin } from '../auth.js';
import { connect } from '../db/client.js';
import { consumeRate, LIMITS } from '../auth/rate-limit.js';
import { runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';
import { RouteError } from './tenant.js';
import { mirrorMembership } from './members.js';
import { allowedProviders } from '../model/allowed.js';
import { loadBootstrap } from './workspace.js';
import { coordinateAcceptedMember } from '../domain/member-agent-coordination.js';
import {
  verifyReservedCapacityForInvitation,
  withCapacityGrantQuarantine,
} from '../hermes-cloud/capacity.js';

export async function acceptInvitation(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const session = await getSession(c);
  const token = (c.req.param('token') ?? '').trim();
  if (!token || token.length > 200) throw new RouteError('an invitation token is required', 'bad_token', 400);

  const client = await connect(c.env, 'app');
  let email: string;
  let workspaceId: string;
  try {
    // Before the lookup, so a guesser spends budget on every attempt including
    // the ones that find nothing. Outside any transaction, so the count stands
    // even though the attempt that follows it throws.
    await consumeRate(client, session.userId, null, LIMITS.acceptInvitation);

    const user = await client.query<{ email: string; email_verified: boolean }>(
      `SELECT email, email_verified FROM users WHERE id = $1`,
      [session.userId],
    );
    const row = user.rows[0];
    if (!row) throw new RouteError('no such user', 'unknown_user', 404);
    // The header comment promises the *verified* email must match, and the
    // column was selected for that and then never read: the comparison below
    // ran against `users.email` whatever its verification state. An identity
    // provider that lets someone sign up claiming an address without proving
    // it — which is a configuration, not an exotic one — therefore turned
    // "forwarding the link does not admit the forwardee" into "anyone who
    // learns the invited address can claim it". An unverified address is not
    // an identity, so it cannot be the thing the invitation is matched on.
    if (!row.email_verified) {
      throw new RouteError(
        'verify your email address before accepting an invitation',
        'email_unverified',
        403,
      );
    }
    email = row.email;

    const found = await client.query<{ workspace_id: string | null }>(
      `SELECT hermes_invitation_workspace($1) AS workspace_id`,
      [token],
    );
    const id = found.rows[0]?.workspace_id ?? null;
    // One answer for "no such token", "withdrawn" and "expired". Which of the
    // three it is tells a guesser something, and tells the person holding a
    // real link nothing they can act on that "ask for a new invitation" does
    // not already cover.
    if (!id) throw new RouteError('this invitation is not open', 'invitation_unavailable', 404);
    workspaceId = id;
  } finally {
    await client.end();
  }

  const jobs: string[] = [];
  const invitationId = await withWorkspaceTransaction(c.env, workspaceId, async (tx) => {
    const invitation = await tx.query<{ id: string; email: string }>(
      `SELECT id, email FROM invitations
        WHERE workspace_id=$1 AND status='pending' AND expires_at > now()
          AND (workos_invitation_id=$2 OR token_hash=$2
               OR ($2 ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                   AND id=$2::uuid))
        LIMIT 1`,
      [workspaceId, token],
    );
    const invite = invitation.rows[0];
    if (!invite) throw new RouteError('this invitation is not open', 'invitation_unavailable', 404);
    if (invite.email !== email.toLowerCase()) throw new RouteError(
      'this invitation was sent to a different address',
      'invitation_email_mismatch',
      403,
    );
    return invite.id;
  });
  const capacityProof = c.env.AGENT_RUNTIME === 'hermes'
    ? await verifyReservedCapacityForInvitation(c.env, workspaceId, invitationId)
    : null;
  const result = await withCapacityGrantQuarantine(c.env, () => withWorkspaceTransaction(c.env, workspaceId, async (tx) => {
    const invitation = await tx.query<{ id: string; email: string; role: string }>(
      `SELECT id, email, role FROM invitations
        WHERE workspace_id = $1 AND status = 'pending' AND expires_at > now()
          AND (workos_invitation_id = $2 OR token_hash = $2
               OR ($2 ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                   AND id = $2::uuid))
        LIMIT 1
        FOR UPDATE`,
      [workspaceId, token],
    );
    const invite = invitation.rows[0];
    if (!invite) throw new RouteError('this invitation is not open', 'invitation_unavailable', 404);
    if (invite.email !== email.toLowerCase()) {
      throw new RouteError(
        'this invitation was sent to a different address',
        'invitation_email_mismatch',
        403,
      );
    }

    // The same mirror `/auth/callback` and the events poller write, so a
    // membership that arrives by any of the three routes is one shape of row.
    // It also flips the invitation to `accepted`, keyed on the email.
    const mirrored = await mirrorMembership(tx, {
      workspaceId,
      userId: session.userId,
      role: invite.role === 'admin' ? 'admin' : 'member',
      workosMembershipId: null,
      status: 'active',
      email,
    });
    if (!mirrored.acceptedInvitation) {
      throw new RouteError('this invitation is not open', 'invitation_unavailable', 404);
    }
    await coordinateAcceptedMember({
      env: c.env,
      tx,
      workspaceId,
      joiningUserId: session.userId,
      joiningMemberId: mirrored.memberId,
      invitationId: mirrored.acceptedInvitation.id,
      capacityProof,
      jobs,
    });

    // The whole workspace, from inside the transaction that admitted them, so
    // the shell renders without a second round trip and without a window in
    // which they are a member of a workspace that reads as missing.
    return bootstrapSchema.parse(await loadBootstrap(
      tx, workspaceId, session.userId, allowedProviders(c.env), c.env.AUTOMATED_TRIGGERS_ENABLED === '1',
      c.env.HERMES_MEMBER_PROVISIONING_ENABLED === '1',
    ));
  }));

  if (jobs.length > 0) await runJobsAfterCommit(c.env, workspaceId, jobs);

  return c.json(result, 200);
}

/**
 * `GET /invitations/:token`: what the join page may say before "Accept".
 *
 * The page used to say "Join a workspace" and nothing else, because nothing
 * told it which one. This read is scoped by the token exactly as the accept
 * is: the directory turns it into one workspace id, the row is read under that
 * workspace's key, and an unknown, withdrawn, accepted or expired token gets
 * the same 404 the accept gives. It answers with the workspace's name, the
 * role and who sent it — never the invited address.
 *
 * Signed out, a valid token is enough: the link *is* the secret, and the page
 * needs the name before it sends the person through sign-in. Signed in, the
 * session's verified email must be the invited one, with the same
 * `invitation_email_mismatch` answer the accept gives, so a forwarded link
 * does not even tell the forwardee whose workspace it was.
 */
export async function previewInvitation(c: Context<{ Bindings: Env }>): Promise<Response> {
  const token = (c.req.param('token') ?? '').trim();
  if (!token || token.length > 200) throw new RouteError('an invitation token is required', 'bad_token', 400);

  let session: Awaited<ReturnType<typeof getSession>> | null = null;
  try {
    session = await getSession(c);
  } catch (error) {
    // Only "nobody is signed in" is an anonymous preview. A misconfigured or
    // unreachable identity provider is still an error.
    if (!(error instanceof AuthError && error.status === 401)) throw error;
  }

  const client = await connect(c.env, 'app');
  let email: string | null = null;
  let workspaceId: string;
  try {
    if (session) {
      await consumeRate(client, session.userId, null, LIMITS.previewInvitation);
      const user = await client.query<{ email: string; email_verified: boolean }>(
        `SELECT email, email_verified FROM users WHERE id = $1`,
        [session.userId],
      );
      const row = user.rows[0];
      if (!row) throw new RouteError('no such user', 'unknown_user', 404);
      if (!row.email_verified) {
        throw new RouteError('verify your email address before accepting an invitation', 'email_unverified', 403);
      }
      email = row.email.toLowerCase();
    }
    const found = await client.query<{ workspace_id: string | null }>(
      `SELECT hermes_invitation_workspace($1) AS workspace_id`,
      [token],
    );
    const id = found.rows[0]?.workspace_id ?? null;
    if (!id) throw new RouteError('this invitation is not open', 'invitation_unavailable', 404);
    workspaceId = id;
  } finally {
    await client.end();
  }

  const preview = await withWorkspaceTransaction(c.env, workspaceId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; email: string; role: string; expires_at: Date; workspace_name: string;
      invited_by: string | null; role_template_key: string | null;
    }>(
      `SELECT i.id, i.email, i.role, i.expires_at, w.name AS workspace_name,
              COALESCE(u.name, u.email) AS invited_by, op.role_template_key
         FROM invitations i
         JOIN workspaces w ON w.id = i.workspace_id
         LEFT JOIN users u ON u.id = i.invited_by AND u.deleted_at IS NULL
         LEFT JOIN member_provisioning_operations op
           ON op.workspace_id = i.workspace_id AND op.invitation_id = i.id AND op.cancellation <> 'complete'
        WHERE i.workspace_id = $1 AND i.status = 'pending' AND i.expires_at > now()
          AND (i.workos_invitation_id = $2 OR i.token_hash = $2
               OR ($2 ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                   AND i.id = $2::uuid))
        LIMIT 1`,
      [workspaceId, token],
    );
    const invite = rows[0];
    if (!invite) throw new RouteError('this invitation is not open', 'invitation_unavailable', 404);
    if (email !== null && invite.email !== email) {
      throw new RouteError('this invitation was sent to a different address', 'invitation_email_mismatch', 403);
    }
    return invitationPreviewSchema.parse({
      token,
      workspace: { id: workspaceId, name: invite.workspace_name },
      role: invite.role === 'admin' ? 'admin' : 'member',
      role_template_key: invite.role_template_key,
      invited_by: invite.invited_by,
      expires_at: invite.expires_at.toISOString(),
    });
  });
  return c.json(preview, 200);
}
