import type { Env } from '../env.js';
import { connect, type Tx } from '../db/client.js';
import { enqueueJob, runJobsAfterCommit, withWorkspaceTransaction, type Job } from '../jobs.js';
import { resolveRuntimeBinding } from '../runtime/config.js';
import { createRunInstance, submitTurn, type RunInstanceParams, type TurnSession } from '../runs/submit.js';
import { partnerAgentConfig, partnerScreeningAgentIds } from './config.js';
import { discoverGitHubOrganizations, PartnerSourceError, type PartnerFetch } from './github.js';
import {
  beginPartnerScreening,
  completePartnerScreening,
  failPartnerScreening,
  loadPartnerScreeningSnapshot,
  type PartnerScreeningWork,
} from './service.js';

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 1_440;
const DEFAULT_INTERVAL_MINUTES = 360;
const AUTOMATION_TITLE = 'Iris · Automated partner screening';

export function automatedTriggersEnabled(env: Env): boolean {
  return env.AUTOMATED_TRIGGERS_ENABLED === '1';
}

export function automationIntervalMinutes(env: Env): number {
  const parsed = Number.parseInt(env.PARTNER_SCREENING_AUTOMATION_INTERVAL_MINUTES ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, parsed));
}

function sourceFetcher(env: Env): PartnerFetch {
  if (env.PARTNER_SOURCE_FETCHER) {
    return (input, init) => env.PARTNER_SOURCE_FETCHER!.fetch(new Request(input, init));
  }
  return (input, init) => globalThis.fetch(input, init);
}

function work(tx: Tx, workspaceId: string, userId: string): PartnerScreeningWork {
  return {
    tx,
    workspaceId,
    userId,
    role: 'admin',
    requireAdmin: () => undefined,
  };
}

async function listWorkspaces(env: Env): Promise<string[]> {
  const client = await connect(env, 'app');
  try {
    const result = await client.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM workspace_directory ORDER BY workspace_id',
    );
    return result.rows.map((row) => row.workspace_id);
  } finally {
    await client.end();
  }
}

export interface AutomationEnqueueResult {
  readonly enabled: boolean;
  readonly workspaces: number;
  readonly configuredAgents: number;
  readonly queued: number;
  readonly bucket: string | null;
}

/** Queue one durable job per configured, started, admin-owned agent and cadence bucket. */
export async function enqueueAutomatedPartnerScreening(
  env: Env,
  now: Date = new Date(),
): Promise<AutomationEnqueueResult> {
  const agentIds = partnerScreeningAgentIds(env);
  const useDefaultPolicy = env.PARTNER_SCREENING_AUTOMATE_DEFAULT_AGENTS === '1';
  if (!automatedTriggersEnabled(env) || (agentIds.length === 0 && !useDefaultPolicy)) {
    return { enabled: automatedTriggersEnabled(env), workspaces: 0, configuredAgents: agentIds.length, queued: 0, bucket: null };
  }
  const interval = automationIntervalMinutes(env);
  const bucketNumber = Math.floor(now.getTime() / (interval * 60_000));
  const bucket = `${interval}m-${bucketNumber}`;
  const workspaces = await listWorkspaces(env);
  let queued = 0;
  let configuredAgents = 0;
  for (const workspaceId of workspaces) {
    await withWorkspaceTransaction(env, workspaceId, async (tx) => {
      const owners = await tx.query<{ agent_id: string; user_id: string }>(
        `SELECT a.id AS agent_id, m.user_id
           FROM agents a
           JOIN agent_owners ao ON ao.workspace_id=a.workspace_id AND ao.agent_id=a.id
           JOIN members m ON m.workspace_id=ao.workspace_id AND m.id=ao.member_id
          WHERE a.workspace_id=$1 AND ($3::boolean OR a.id=ANY($2::uuid[]))
            AND a.status='started' AND m.status='active' AND m.role='admin'
          ORDER BY a.id`,
        [workspaceId, agentIds, useDefaultPolicy],
      );
      for (const owner of owners.rows) {
        if (!partnerAgentConfig(env, owner.agent_id).config) continue;
        configuredAgents += 1;
        const id = await enqueueJob(
          tx,
          workspaceId,
          'partner_screening',
          `partner-screening:auto:${workspaceId}:${owner.agent_id}:${bucket}`,
          { agent_id: owner.agent_id, owner_user_id: owner.user_id, bucket },
        );
        if (id) queued += 1;
      }
    });
  }
  return { enabled: true, workspaces: workspaces.length, configuredAgents, queued, bucket };
}

async function automationSession(
  tx: Tx,
  env: Env,
  workspaceId: string,
  ownerId: string,
  agentId: string,
): Promise<TurnSession> {
  const existing = await tx.query<TurnSession>(
    `SELECT id, agent_id, owner_id, read_only, mode, model_id, effort
       FROM sessions
      WHERE workspace_id=$1 AND owner_id=$2 AND agent_id=$3
        AND title=$4 AND archived=false
      ORDER BY created_at LIMIT 1 FOR UPDATE`,
    [workspaceId, ownerId, agentId, AUTOMATION_TITLE],
  );
  if (existing.rows[0]) return existing.rows[0];

  const template = await tx.query<{ model_id: string; effort: string | null; runtime: string }>(
    `SELECT model_id, effort, runtime FROM sessions
      WHERE workspace_id=$1 AND owner_id=$2 AND agent_id=$3
      ORDER BY last_activity_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [workspaceId, ownerId, agentId],
  );
  const settings = await tx.query<{ default_model_id: string; default_effort: string | null; default_runtime: string }>(
    'SELECT default_model_id, default_effort, default_runtime FROM workspace_settings WHERE workspace_id=$1',
    [workspaceId],
  );
  const source = template.rows[0] ?? settings.rows[0];
  if (!source) throw new Error('partner_automation_workspace_settings_missing');
  const resolvedRuntime = env.AGENT_RUNTIME === 'hermes'
    ? await resolveRuntimeBinding(env, tx, workspaceId, agentId)
    : null;
  const runtime = resolvedRuntime
    ? (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/])/.test(resolvedRuntime.baseUrl) ? 'local' : 'cloud')
    : ('runtime' in source ? source.runtime : source.default_runtime);
  const inserted = await tx.query<TurnSession>(
    `INSERT INTO sessions (workspace_id, owner_id, agent_id, title, mode, model_id, effort, runtime)
     VALUES ($1,$2,$3,$4,'work',$5,$6,$7)
     RETURNING id, agent_id, owner_id, read_only, mode, model_id, effort`,
    [
      workspaceId, ownerId, agentId, AUTOMATION_TITLE,
      'model_id' in source ? source.model_id : source.default_model_id,
      'effort' in source ? source.effort : source.default_effort,
      runtime,
    ],
  );
  const session = inserted.rows[0];
  if (!session) throw new Error('partner_automation_session_create_failed');
  return session;
}

/**
 * Submit the stored discovery evidence to Iris exactly once.
 *
 * The live onboarding route and Cloudflare Cron share this seam so both create
 * the same auditable session/run shape. The client never forwards connector
 * output into a model prompt; Iris reads only the artifacts committed by the
 * Worker.
 */
export async function handoffPartnerScreeningToIris(
  env: Env,
  workspaceId: string,
  ownerUserId: string,
  agentId: string,
  screeningRunId: string,
): Promise<boolean> {
  const jobIds: string[] = [];
  let create: RunInstanceParams | null = null;
  let admitted = false;
  await withWorkspaceTransaction(env, workspaceId, async (tx) => {
    const scoped = work(tx, workspaceId, ownerUserId);
    const snapshot = await loadPartnerScreeningSnapshot(scoped, screeningRunId);
    if (snapshot.run.agent_id !== agentId ||
        (snapshot.run.source !== 'agentcash_people' && snapshot.handoff.candidate_ids.length === 0)) return;
    const session = await automationSession(tx, env, workspaceId, ownerUserId, agentId);
    const submitted = await submitTurn({
      tx,
      env,
      workspaceId,
      userId: ownerUserId,
      session,
      clientTurnId: `partner-screening:${screeningRunId}`,
      text: snapshot.handoff.prompt,
      jobIds,
    });
    admitted = true;
    if (!submitted.duplicate) {
      create = submitted.create;
    } else {
      // The first attempt may have committed the run and died before Workflow
      // creation. Reconstructing the same instance makes a retry heal that
      // seam; createRunInstance treats an already-existing id as success.
      const trace = await tx.query<{ trace_id: string }>(
        'SELECT trace_id FROM runs WHERE workspace_id=$1 AND id=$2',
        [workspaceId, submitted.run.id],
      );
      if (!trace.rows[0]?.trace_id) throw new Error('partner_automation_run_trace_missing');
      create = {
        runId: submitted.run.id,
        workspaceId,
        sessionId: submitted.run.session_id,
        attempt: submitted.run.attempt,
        engineVersion: submitted.run.engine_version,
        traceId: trace.rows[0].trace_id,
      };
    }
  });
  if (jobIds.length > 0) await runJobsAfterCommit(env, workspaceId, jobIds);
  if (create) await createRunInstance(env, create);
  return admitted;
}

/** Durable discovery -> stored evidence -> Iris run. A retry reuses both ids. */
export async function runPartnerScreeningAutomationJob(env: Env, job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as { agent_id?: string; owner_user_id?: string; bucket?: string };
  if (!payload.agent_id || !payload.owner_user_id || !payload.bucket) {
    throw new Error('partner_screening_payload_invalid');
  }
  const configured = partnerAgentConfig(env, payload.agent_id);
  if (!configured.config) throw new Error('partner_screening_config_missing');
  const idempotencyKey = `auto:${payload.bucket}`;
  const authentication = configured.config.source === 'agentcash_people'
    ? 'wallet' as const
    : env.PARTNER_GITHUB_TOKEN?.trim() ? 'authenticated' as const : 'unauthenticated' as const;
  const started = await withWorkspaceTransaction(env, job.workspace_id, (tx) => beginPartnerScreening(
    work(tx, job.workspace_id, payload.owner_user_id!),
    { agentId: payload.agent_id!, idempotencyKey, config: configured.config!, authentication },
  ));

  if (configured.config.source === 'github' && started.run.status !== 'completed') {
    try {
      const result = await discoverGitHubOrganizations(configured.config, {
        fetcher: sourceFetcher(env), token: env.PARTNER_GITHUB_TOKEN,
      });
      await withWorkspaceTransaction(env, job.workspace_id, (tx) => completePartnerScreening(
        work(tx, job.workspace_id, payload.owner_user_id!),
        { runId: started.run.id, agentId: payload.agent_id!, result },
      ));
    } catch (error) {
      const sourceError = error instanceof PartnerSourceError
        ? error
        : new PartnerSourceError('The automated partner source run failed.', 'partner_source_failed');
      await withWorkspaceTransaction(env, job.workspace_id, (tx) => failPartnerScreening(
        work(tx, job.workspace_id, payload.owner_user_id!), started.run.id, sourceError.reason, sourceError.message,
      ));
      throw sourceError;
    }
  }

  await handoffPartnerScreeningToIris(
    env,
    job.workspace_id,
    payload.owner_user_id,
    payload.agent_id,
    started.run.id,
  );
}
