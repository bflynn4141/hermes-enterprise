import { DEFAULT_MODEL_ID } from '@hermes/shared';
import type { Env } from '../env.js';
import { connect, type Tx } from '../db/client.js';
import { enqueueJob, runJobsAfterCommit, withWorkspaceTransaction, type Job } from '../jobs.js';
import { allowedProviders } from '../model/allowed.js';
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

export function paidPartnerScreeningEnabled(env: Env): boolean {
  return env.PARTNER_SCREENING_PAID_AUTOMATION_ENABLED === '1';
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
    role: 'system',
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
  readonly paidEnabled: boolean;
  readonly workspaces: number;
  readonly candidateAgents: number;
  readonly startedAgents: number;
  readonly activeOwnedAgents: number;
  readonly configuredAgents: number;
  readonly skippedPaid: number;
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
  const paidEnabled = paidPartnerScreeningEnabled(env);
  if (!automatedTriggersEnabled(env) || (agentIds.length === 0 && !useDefaultPolicy)) {
    return {
      enabled: automatedTriggersEnabled(env), paidEnabled, workspaces: 0,
      candidateAgents: 0, startedAgents: 0, activeOwnedAgents: 0,
      configuredAgents: 0, skippedPaid: 0, queued: 0, bucket: null,
    };
  }
  const interval = automationIntervalMinutes(env);
  const bucketNumber = Math.floor(now.getTime() / (interval * 60_000));
  const bucket = `${interval}m-${bucketNumber}`;
  const workspaces = await listWorkspaces(env);
  let queued = 0;
  let candidateAgents = 0;
  let startedAgents = 0;
  let activeOwnedAgents = 0;
  let configuredAgents = 0;
  let skippedPaid = 0;
  for (const workspaceId of workspaces) {
    await withWorkspaceTransaction(env, workspaceId, async (tx) => {
      const candidates = await tx.query<{ agent_id: string; status: string; user_id: string | null }>(
        `SELECT a.id AS agent_id, a.status, owner.user_id
           FROM agents a
           LEFT JOIN LATERAL (
             SELECT m.user_id
               FROM agent_owners ao
               JOIN members m ON m.workspace_id=ao.workspace_id AND m.id=ao.member_id
              WHERE ao.workspace_id=a.workspace_id AND ao.agent_id=a.id
                AND m.status='active'
              LIMIT 1
           ) owner ON true
          WHERE a.workspace_id=$1 AND ($3::boolean OR a.id=ANY($2::uuid[]))
          ORDER BY a.id`,
        [workspaceId, agentIds, useDefaultPolicy],
      );
      for (const candidate of candidates.rows) {
        candidateAgents += 1;
        if (candidate.status !== 'started') continue;
        startedAgents += 1;
        if (!candidate.user_id) continue;
        activeOwnedAgents += 1;
        const configured = partnerAgentConfig(env, candidate.agent_id).config;
        if (!configured) continue;
        configuredAgents += 1;
        if (configured.source === 'agentcash_people' && !paidEnabled) {
          skippedPaid += 1;
          continue;
        }
        const id = await enqueueJob(
          tx,
          workspaceId,
          'partner_screening',
          `partner-screening:auto:${workspaceId}:${candidate.agent_id}:${bucket}`,
          { agent_id: candidate.agent_id, owner_user_id: candidate.user_id, bucket },
        );
        if (id) queued += 1;
      }
    });
  }
  return {
    enabled: true, paidEnabled, workspaces: workspaces.length,
    candidateAgents, startedAgents, activeOwnedAgents, configuredAgents, skippedPaid, queued, bucket,
  };
}

interface DraftPolicyContext {
  readonly memberId: string;
  readonly senderAddress: string;
  readonly policyKey: string;
}

async function ensurePartnerOutreachDraftPolicy(
  tx: Tx,
  workspaceId: string,
  ownerUserId: string,
  agentId: string,
): Promise<DraftPolicyContext> {
  const owner = await tx.query<{ member_id: string; email: string }>(
    `SELECT m.id AS member_id, u.email
       FROM members m
       JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.status='active'
        AND u.email_verified
      LIMIT 1`,
    [workspaceId, ownerUserId],
  );
  const row = owner.rows[0];
  if (!row) throw new Error('partner_outreach_verified_owner_missing');

  const policyKey = `partner-outreach-draft-${agentId}`;
  const steps = [{
    id: 'owner-review', label: 'Review personalized outreach draft', order: 0,
    reviewers: [{ kind: 'member', member_id: row.member_id }], quorum: 1,
  }];
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${workspaceId}:${policyKey}`]);
  const active = await tx.query<{
    version: number; approval_type: string; requester_agent_id: string | null;
    step_count: number; reviewer_member_id: string | null;
  }>(
    `SELECT version, approval_type, requester_agent_id,
            jsonb_array_length(steps)::int AS step_count,
            steps #>> '{0,reviewers,0,member_id}' AS reviewer_member_id
       FROM approval_policies
      WHERE workspace_id=$1 AND key=$2 AND active
      LIMIT 1`,
    [workspaceId, policyKey],
  );
  const current = active.rows[0];
  if (current?.approval_type === 'communication'
      && current.requester_agent_id === agentId
      && current.step_count === 1
      && current.reviewer_member_id === row.member_id) {
    return { memberId: row.member_id, senderAddress: row.email, policyKey };
  }

  await tx.query(
    `UPDATE approval_policies SET active=false WHERE workspace_id=$1 AND key=$2 AND active`,
    [workspaceId, policyKey],
  );
  const version = await tx.query<{ version: number }>(
    `SELECT COALESCE(max(version), 0)::int + 1 AS version
       FROM approval_policies WHERE workspace_id=$1 AND key=$2`,
    [workspaceId, policyKey],
  );
  await tx.query(
    `INSERT INTO approval_policies
       (workspace_id, key, version, approval_type, requester_agent_id, priority, mode,
        prevent_self_review, require_distinct_reviewers, max_duration_seconds, steps, active)
     VALUES ($1,$2,$3,'communication',$4,1000000,'sequential',false,true,604800,$5::jsonb,true)`,
    [workspaceId, policyKey, version.rows[0]?.version ?? 1, agentId, JSON.stringify(steps)],
  );
  return { memberId: row.member_id, senderAddress: row.email, policyKey };
}

function outreachDraftInstructions(context: DraftPolicyContext): string {
  return [
    'For each prospect whose stored professional evidence supports outreach, prepare a personalized email draft for human review.',
    `Call propose_approval with policy_key ${JSON.stringify(context.policyKey)}, approval_type communication, illustrative false, target_member_ids [${JSON.stringify(context.memberId)}], and no target agents, resources, dependent requests, continuation, or scheduled_for.`,
    `Set details.channel to email, details.draft_only to true, and details.sender to ${JSON.stringify({ member_id: context.memberId, address: context.senderAddress })}.`,
    'Set one recipient with the candidate name and address null. The governed source intentionally removes contact details; do not search for, infer, or invent an email address.',
    'Write a concise subject and body grounded in the cited professional evidence. Invite the person to explore or apply to the configured Partner Program without claiming prior interest, approval, benefits, or terms.',
    'Cite the stored candidate artifacts in proposal.evidence. State in summary and consequence that this is a draft only: approval records reviewed copy and does not send a message.',
    'Do not use propose_request for a discovered prospect. A prospect has not submitted an application.',
  ].join(' ');
}

async function automationSession(
  tx: Tx,
  env: Env,
  workspaceId: string,
  ownerId: string,
  agentId: string,
): Promise<TurnSession> {
  const allowed = allowedProviders(env);
  const existing = await tx.query<TurnSession>(
    `SELECT s.id, s.agent_id, s.owner_id, s.read_only, s.mode, s.model_id, s.effort
       FROM sessions s
       JOIN catalog c ON c.model_id=s.model_id
      WHERE s.workspace_id=$1 AND s.owner_id=$2 AND s.agent_id=$3
        AND s.title=$4 AND NOT s.archived
        AND c.provider=ANY($5::text[]) AND c.disabled_reason IS NULL AND c.supports_tools
      ORDER BY s.created_at LIMIT 1 FOR UPDATE OF s`,
    [workspaceId, ownerId, agentId, AUTOMATION_TITLE, [...allowed]],
  );
  if (existing.rows[0]) return existing.rows[0];

  const template = await tx.query<{ model_id: string; effort: string | null; runtime: string }>(
    `SELECT s.model_id, s.effort, s.runtime
       FROM sessions s
       JOIN catalog c ON c.model_id=s.model_id
      WHERE s.workspace_id=$1 AND s.owner_id=$2 AND s.agent_id=$3
        AND c.provider=ANY($4::text[]) AND c.disabled_reason IS NULL AND c.supports_tools
      ORDER BY s.last_activity_at DESC NULLS LAST, s.created_at DESC LIMIT 1`,
    [workspaceId, ownerId, agentId, [...allowed]],
  );
  const settings = await tx.query<{ default_model_id: string; default_effort: string | null; default_runtime: string }>(
    `SELECT picked.model_id AS default_model_id,
            CASE
              WHEN ws.default_effort IS NOT NULL
                AND COALESCE(picked.effort_map ? ws.default_effort, false)
                THEN ws.default_effort
              ELSE picked.default_effort
            END AS default_effort,
            ws.default_runtime
       FROM workspace_settings ws
       JOIN LATERAL (
         SELECT c.model_id, c.effort_map, c.default_effort
           FROM catalog c
          WHERE c.provider=ANY($2::text[])
            AND c.disabled_reason IS NULL AND c.supports_tools
          ORDER BY (c.model_id=ws.default_model_id) DESC,
                   (c.model_id=$3) DESC,
                   c.model_id
          LIMIT 1
       ) picked ON true
      WHERE ws.workspace_id=$1`,
    [workspaceId, [...allowed], DEFAULT_MODEL_ID],
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
    const draftContext = await ensurePartnerOutreachDraftPolicy(tx, workspaceId, ownerUserId, agentId);
    const session = await automationSession(tx, env, workspaceId, ownerUserId, agentId);
    const submitted = await submitTurn({
      tx,
      env,
      workspaceId,
      userId: ownerUserId,
      session,
      clientTurnId: `partner-screening:${screeningRunId}`,
      text: `${snapshot.handoff.prompt}\n\n${outreachDraftInstructions(draftContext)}`,
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
