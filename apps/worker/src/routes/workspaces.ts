// `POST /workspaces`: the only place a workspace is created.
//
// This is the one route that cannot use `withTenantTransaction`, because the
// tenant it would key on does not exist yet. It sets the key itself, to the id
// it is about to insert, and every statement after that runs under the same
// forced row-level security as everywhere else — which is why the INSERT is
// accepted at all: the policy's WITH CHECK compares the new row's id to the key
// we just set.
//
// Three guards, in this order and for these reasons:
//
//   * a verified email, because a workspace is an organization in WorkOS and an
//     invitation sent from an unverified address is a phishing primitive;
//   * three per day per person, counted in `rate_counters`, because creating a
//     workspace creates a WorkOS organization, and a script that makes ten
//     thousand of them is our bill and WorkOS's problem;
//   * the creator is the first Admin, because a workspace with no Admin could
//     never decide anything, and the last-Admin trigger would then have nothing
//     to protect.
import type { Context } from 'hono';
import { bootstrapSchema, SETUP, workspaceCreateInputSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { AuthError, getSession, requireCsrf, requireOrigin, takeRefreshedCookie } from '../auth.js';
import { readCookie, SESSION_COOKIE, sessionCookie } from '../auth/cookies.js';
import { connect } from '../db/client.js';
import { consumeRate, LIMITS } from '../auth/rate-limit.js';
import { workosPort, type WorkOSPort } from '../auth/workos.js';
import { jsonBody, RouteError } from './tenant.js';
import { allowedProviders } from '../model/allowed.js';
import { loadBootstrap } from './workspace.js';

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';

export const FIRST_SETUP_MESSAGE = 'Let’s set up the work you want me to repeat. What do you own?';

export async function createWorkspace(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const session = await getSession(c);
  const parsed = workspaceCreateInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path ?? [];
    if (path[0] === 'name') {
      throw new RouteError('a workspace needs a name of 2 to 80 characters', 'bad_name', 422);
    }
    if (path[0] === 'agent' && path[1] === 'name') {
      throw new RouteError('the agent needs a name of 1 to 80 characters', 'bad_agent_name', 422);
    }
    throw new RouteError('agent instructions are required and may contain up to 8000 characters', 'bad_instructions', 422);
  }
  const input = parsed.data;
  const name = input.name;
  const jurisdiction = input.jurisdiction ?? 'default';

  const client = await connect(c.env, 'app');
  try {
    const { rows } = await client.query<{
      email: string;
      email_verified: boolean;
      workos_user_id: string | null;
    }>(
      `SELECT email, email_verified, workos_user_id FROM users WHERE id = $1`,
      [session.userId],
    );
    const user = rows[0];
    if (!user) throw new RouteError('no such user', 'unknown_user', 404);
    if (!user.email_verified) {
      throw new RouteError('verify your email address before creating a workspace', 'email_unverified', 403);
    }

    // The WorkOS organization is created before our transaction opens, because
    // it is a network call and a transaction that waits on a third party holds
    // a Postgres connection open for as long as that party is slow. If the
    // transaction below then fails, an empty organization is left behind in
    // WorkOS: the cheaper of the two orphans, and the reconciliation query in
    // the runbook finds it.
    let port: WorkOSPort | null = null;
    let organization: { id: string } | null = null;
    if (c.env.AUTH_MODE === 'workos') {
      port = workosPort(c.env);
      if (!user.workos_user_id) {
        throw new AuthError('the signed-in account is not linked to WorkOS', 'invalid_session');
      }
      organization = await port.createOrganization(name);
      try {
        await port.createOrganizationMembership({
          userId: user.workos_user_id,
          organizationId: organization.id,
          roleSlug: 'admin',
        });
      } catch (error) {
        // Do not knowingly leave an empty organization behind when the owner
        // membership itself failed. Cleanup is best effort; the reconciliation
        // query still catches a delete failure.
        await port.deleteOrganization(organization.id).catch(() => undefined);
        throw error;
      }
    }

    const workspaceId = crypto.randomUUID();
    await client.query('BEGIN');
    try {
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', workspaceId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', session.userId]);
      await consumeRate(client, session.userId, null, LIMITS.createWorkspace);

      const slug = `${slugify(name)}-${workspaceId.slice(0, 8)}`;
      await client.query(
        `INSERT INTO workspaces (id, workos_organization_id, name, slug, jurisdiction, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [workspaceId, organization?.id ?? null, name, slug, jurisdiction, session.userId],
      );
      // The platform-side pointer, so that `/auth/callback` and the events
      // poller can find this workspace from a WorkOS organization id without a
      // connection that can read every tenant.
      await client.query(
        `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1, $2)`,
        [workspaceId, organization?.id ?? null],
      );
      await client.query(`INSERT INTO workspace_settings (workspace_id) VALUES ($1)`, [workspaceId]);
      const createdMember = await client.query<{ id: string }>(
        `INSERT INTO members (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'admin', 'active')
         RETURNING id`,
        [workspaceId, session.userId],
      );
      const memberId = createdMember.rows[0]?.id;
      if (!memberId) throw new RouteError('the workspace member was not created', 'create_failed', 409);
      // The agent starts in `draft`: the Setup flow is what moves it to
      // `started`, and an agent that could run before anyone described its
      // responsibility is an agent with no instructions.
      const createdAgent = await client.query<{ id: string }>(
        `INSERT INTO agents (workspace_id, name, instructions_active, status)
         VALUES ($1, $2, $3, 'draft')
         RETURNING id`,
        [workspaceId, input.agent.name, input.agent.instructions],
      );
      const agentId = createdAgent.rows[0]?.id;
      if (!agentId) throw new RouteError('the agent was not created', 'create_failed', 409);
      await client.query(
        `INSERT INTO agent_owners (workspace_id, agent_id, member_id) VALUES ($1, $2, $3)`,
        [workspaceId, agentId, memberId],
      );
      await client.query(
        `INSERT INTO instruction_versions
           (workspace_id, agent_id, body, status, proposed_by, sources, saved_at)
         VALUES ($1, $2, $3, 'saved', $4, '[]'::jsonb, now())`,
        [workspaceId, agentId, input.agent.instructions, session.userId],
      );

      // This session and message are product-authored setup state. They do not
      // create a run, call a model, or require a provider key.
      const setupSessionId = crypto.randomUUID();
      const setupTitle = `Set up ${input.agent.name}`;
      await client.query(
        `INSERT INTO sessions
           (id, workspace_id, owner_id, agent_id, title, mode, model_id, effort, runtime, next_seq, focus_ref)
         SELECT $1, $2, $3, $4, $5, 'work',
                default_model_id, default_effort, default_runtime, 1, $6::jsonb
           FROM workspace_settings WHERE workspace_id = $2`,
        [setupSessionId, workspaceId, session.userId, agentId, setupTitle, JSON.stringify(SETUP('identity'))],
      );
      await client.query(
        `INSERT INTO messages (workspace_id, session_id, seq, role, kind, text, status)
         VALUES ($1, $2, 0, 'iris', 'setup', $3, 'complete')`,
        [workspaceId, setupSessionId, FIRST_SETUP_MESSAGE],
      );
      await client.query(
        `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind)
         VALUES ($1, 'user', $2, 'workspace.created'),
                ($1, 'user', $2, 'instruction.saved')`,
        [workspaceId, session.userId],
      );
      // The whole workspace state, from inside the transaction that created
      // it, so the client can render the shell without a second round trip and
      // without a window where the workspace exists but reads as empty.
      const body = bootstrapSchema.parse(await loadBootstrap(
        client, workspaceId, session.userId, allowedProviders(c.env), c.env.AUTOMATED_TRIGGERS_ENABLED === '1',
        c.env.HERMES_MEMBER_PROVISIONING_ENABLED === '1',
      ));
      await client.query('COMMIT');

      const response = c.json(body, 201);
      // WorkOS sessions are organization-scoped. Once the admin membership and
      // local workspace both exist, switch the sealed session to the new
      // organization. A transient refresh failure does not make a committed
      // workspace look like a failed POST: local membership already authorizes
      // the returned bootstrap, and the next explicit sign-in can select it.
      const sealed = session.refreshedCookie ?? readCookie(c, SESSION_COOKIE);
      if (port && organization && sealed) {
        try {
          const switched = await port.refresh(sealed, organization.id);
          takeRefreshedCookie(c.req.raw);
          response.headers.append('Set-Cookie', sessionCookie(c.env, switched.sealedSession));
        } catch (error) {
          console.log(
            JSON.stringify({
              at: 'workspace.create.session_switch',
              workspace_id: workspaceId,
              switched: false,
              error: error instanceof Error ? error.name : 'unknown',
            }),
          );
        }
      }
      return response;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}
