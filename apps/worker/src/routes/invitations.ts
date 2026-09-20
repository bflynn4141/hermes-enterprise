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
import { bootstrapSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { getSession, requireCsrf, requireOrigin } from '../auth.js';
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
