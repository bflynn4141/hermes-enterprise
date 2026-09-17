import type { Context } from 'hono';
import { partnerScreeningSnapshotSchema, partnerScreeningStartInputSchema } from '@hermes/shared';
import { requireCsrf, requireOrigin } from '../auth.js';
import type { Env } from '../env.js';
import { handoffPartnerScreeningToIris } from '../partner-screening/automation.js';
import { partnerAgentConfig, partnerSourceMatrix } from '../partner-screening/config.js';
import {
  discoverGitHubOrganizations,
  PartnerSourceError,
  type PartnerFetch,
} from '../partner-screening/github.js';
import {
  beginPartnerScreening,
  completePartnerScreening,
  failPartnerScreening,
  loadPartnerScreeningSnapshot,
} from '../partner-screening/service.js';
import { inWorkspace, jsonBody, pathUuid, RouteError } from './tenant.js';
import { resolveRuntimeBinding } from '../runtime/config.js';

function sourceFetcher(env: Env): PartnerFetch {
  if (env.PARTNER_SOURCE_FETCHER) {
    return (input, init) => env.PARTNER_SOURCE_FETCHER!.fetch(new Request(input, init));
  }
  return (input, init) => globalThis.fetch(input, init);
}

/** GET /w/:ws/partner-screening/agents/:agentId/sources */
export async function partnerScreeningSources(c: Context<{ Bindings: Env }>): Promise<Response> {
  const agentId = pathUuid(c, 'agentId');
  const matrix = await inWorkspace(c, async (work) => {
    const agent = await work.tx.query(`SELECT 1 FROM agents WHERE workspace_id = $1 AND id = $2`, [work.workspaceId, agentId]);
    if (!agent.rowCount) throw new RouteError('no such agent', 'unknown_agent', 404);
    return partnerSourceMatrix(c.env, agentId);
  });
  return c.json(matrix);
}

/** POST /w/:ws/partner-screening/runs */
export async function startPartnerScreening(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const parsed = partnerScreeningStartInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('agent_id or idempotency_key is invalid', 'bad_partner_screening_run', 422);
  const configured = partnerAgentConfig(c.env, parsed.data.agent_id);
  if (!configured.config) {
    throw new RouteError(
      configured.problem ?? 'Real partner discovery is not configured.',
      'partner_source_not_configured',
      503,
    );
  }
  const authentication = configured.config.source === 'agentcash_people'
    ? 'wallet' as const
    : c.env.PARTNER_GITHUB_TOKEN?.trim() ? 'authenticated' as const : 'unauthenticated' as const;
  const started = await inWorkspace(c, async (work) => {
    let memberOnboardingAllowed = false;
    if (work.role === 'member' && configured.config!.source === 'agentcash_people') {
      const binding = await resolveRuntimeBinding(c.env, work.tx, work.workspaceId, parsed.data.agent_id);
      memberOnboardingAllowed = ['invitee_pool', 'provisioned'].includes(binding.assignment) && binding.agentCash;
    }
    return beginPartnerScreening(work, {
      agentId: parsed.data.agent_id,
      idempotencyKey: parsed.data.idempotency_key,
      config: configured.config!,
      authentication,
      memberOnboardingAllowed,
    });
  });
  if (!started.created && !started.resumed) {
    if (started.run.status === 'completed' || configured.config.source === 'agentcash_people') {
      const snapshot = await inWorkspace(c, (work) => loadPartnerScreeningSnapshot(work, started.run.id));
      return c.json(partnerScreeningSnapshotSchema.parse(snapshot), 200, { 'X-Hermes-Idempotent-Replay': 'true' });
    }
    throw new RouteError('this partner screening run is already in progress', 'partner_screening_in_progress', 409);
  }

  // AgentCash executes inside Iris's governed Nous Cloud profile. The route
  // creates the authoritative pending run; the native post-tool hook imports
  // the paid response back into this exact run before Iris evaluates it.
  if (configured.config.source === 'agentcash_people') {
    const snapshot = await inWorkspace(c, (work) => loadPartnerScreeningSnapshot(work, started.run.id));
    return c.json(partnerScreeningSnapshotSchema.parse(snapshot), 201, { 'X-Hermes-Idempotent-Replay': 'false' });
  }

  try {
    const result = await discoverGitHubOrganizations(configured.config, {
      fetcher: sourceFetcher(c.env),
      token: c.env.PARTNER_GITHUB_TOKEN,
    });
    await inWorkspace(c, (work) => completePartnerScreening(work, {
      runId: started.run.id,
      agentId: parsed.data.agent_id,
      result,
    }));
  } catch (error) {
    const sourceError = error instanceof PartnerSourceError
      ? error
      : new PartnerSourceError('The partner source run failed before evidence was committed.', 'partner_source_failed');
    await inWorkspace(c, (work) => failPartnerScreening(work, started.run.id, sourceError.reason, sourceError.message));
    throw new RouteError(sourceError.message, sourceError.reason, sourceError.status);
  }
  const snapshot = await inWorkspace(c, (work) => loadPartnerScreeningSnapshot(work, started.run.id));
  return c.json(partnerScreeningSnapshotSchema.parse(snapshot), 201, { 'X-Hermes-Idempotent-Replay': 'false' });
}

/** GET /w/:ws/partner-screening/runs/:id */
export async function getPartnerScreening(c: Context<{ Bindings: Env }>): Promise<Response> {
  const runId = pathUuid(c, 'id');
  const snapshot = await inWorkspace(c, (work) => loadPartnerScreeningSnapshot(work, runId));
  return c.json(partnerScreeningSnapshotSchema.parse(snapshot));
}

/** POST /w/:ws/partner-screening/runs/:id/handoff */
export async function handoffPartnerScreening(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const runId = pathUuid(c, 'id');
  const owner = await inWorkspace(c, async (work) => {
    const snapshot = await loadPartnerScreeningSnapshot(work, runId);
    return { workspaceId: work.workspaceId, userId: work.userId, agentId: snapshot.run.agent_id };
  });
  await handoffPartnerScreeningToIris(c.env, owner.workspaceId, owner.userId, owner.agentId, runId);
  const snapshot = await inWorkspace(c, (work) => loadPartnerScreeningSnapshot(work, runId));
  return c.json(partnerScreeningSnapshotSchema.parse(snapshot));
}
