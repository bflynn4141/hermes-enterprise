import { DEFAULT_MODEL_ID } from '@hermes/shared';
import type { Env } from '../env.js';
import { connect, type Tx } from '../db/client.js';
import { enqueueJob, runJobsAfterCommit, withWorkspaceTransaction, type Job } from '../jobs.js';
import { allowedProviders } from '../model/allowed.js';
import { resolveRuntimeBinding } from '../runtime/config.js';
import { createRunInstance, submitTurn, type RunInstanceParams, type TurnSession } from '../runs/submit.js';
import { partnerScreeningAgentIds, type PartnerAgentConfig } from './config.js';
import { resolvePartnerSkillAssignment } from '../enterprise-skills/service.js';
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
  if (!automatedTriggersEnabled(env)) {
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
               FROM members m
              WHERE m.workspace_id=a.workspace_id AND m.status='active'
                AND (
                  EXISTS (
                    SELECT 1 FROM agent_owners ao
                     WHERE ao.workspace_id=a.workspace_id AND ao.agent_id=a.id
                       AND ao.member_id=m.id
                  )
                  OR (
                    EXISTS (
                      SELECT 1 FROM sessions own_session
                       WHERE own_session.workspace_id=a.workspace_id
                         AND own_session.agent_id=a.id AND own_session.owner_id=m.user_id
                         AND NOT own_session.archived AND NOT own_session.read_only
                    )
                    AND NOT EXISTS (
                      SELECT 1
                        FROM sessions other_session
                        JOIN members other_member
                          ON other_member.workspace_id=other_session.workspace_id
                         AND other_member.user_id=other_session.owner_id
                       WHERE other_session.workspace_id=a.workspace_id
                         AND other_session.agent_id=a.id
                         AND NOT other_session.archived AND NOT other_session.read_only
                         AND other_member.status='active' AND other_member.user_id<>m.user_id
                    )
                  )
                )
              ORDER BY EXISTS (
                SELECT 1 FROM agent_owners explicit_owner
                 WHERE explicit_owner.workspace_id=a.workspace_id
                   AND explicit_owner.agent_id=a.id AND explicit_owner.member_id=m.id
              ) DESC,
              m.joined_at,
              m.id
              LIMIT 1
           ) owner ON true
          WHERE a.workspace_id=$1 AND (
            $3::boolean OR a.id=ANY($2::uuid[]) OR EXISTS (
              SELECT 1 FROM enterprise_skill_assignments esa
               WHERE esa.workspace_id=a.workspace_id AND esa.agent_id=a.id
                 AND esa.skill_key='partner-program-screening' AND esa.state='active'
            )
          )
          ORDER BY a.id`,
        [workspaceId, agentIds, useDefaultPolicy],
      );
      for (const candidate of candidates.rows) {
        candidateAgents += 1;
        if (candidate.status !== 'started') continue;
        startedAgents += 1;
        if (!candidate.user_id) continue;
        activeOwnedAgents += 1;
        const assigned = await resolvePartnerSkillAssignment(env, tx, workspaceId, candidate.agent_id, { materialize: true });
        const configured = assigned.config;
        if (!configured) continue;
        if (assigned.assignment && !assigned.assignment.schedule.enabled) continue;
        configuredAgents += 1;
        if (configured.source === 'agentcash_people' && !paidEnabled) {
          skippedPaid += 1;
          continue;
        }
        // A failed cycle is recovered in place, never replaced by a new paid allowance.
        if (await unresolvedPartnerWork(tx, workspaceId, candidate.agent_id)) continue;
        const candidateInterval = assigned.assignment?.schedule.interval_minutes ?? interval;
        const candidateBucket = `${candidateInterval}m-${Math.floor(now.getTime() / (candidateInterval * 60_000))}`;
        const id = await enqueueJob(
          tx,
          workspaceId,
          'partner_screening',
          `partner-screening:auto:${workspaceId}:${candidate.agent_id}:${candidateBucket}`,
          { agent_id: candidate.agent_id, owner_user_id: candidate.user_id, bucket: candidateBucket },
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
  readonly sendAfterApproval: boolean;
}

async function ensurePartnerOutreachDraftPolicy(
  tx: Tx,
  env: Env,
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

  const sendAfterApproval = env.PARTNER_OUTREACH_EMAIL_MODE === 'send_after_approval';
  const policyKey = `partner-outreach-${sendAfterApproval ? 'send' : 'draft'}-${agentId}`;
  const steps = [{
    id: 'owner-review', label: sendAfterApproval ? 'Approve personalized outreach email' : 'Review personalized outreach draft', order: 0,
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
    return { memberId: row.member_id, senderAddress: row.email, policyKey, sendAfterApproval };
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
  return { memberId: row.member_id, senderAddress: row.email, policyKey, sendAfterApproval };
}

function outreachDraftInstructions(context: DraftPolicyContext): string {
  const disposition = context.sendAfterApproval
    ? [
        'Set details.channel to email and details.draft_only to false.',
        'Use preferred_verified_email as the recipient address. If it is null, stop without proposing approval.',
        'State in summary and consequence that approval authorizes this exact email for the server-side outbox. Do not claim it has already been sent.',
      ]
    : [
        'Set details.channel to email and details.draft_only to true.',
        'Set the address only to preferred_verified_email; otherwise set it to null.',
        'State in summary and consequence that this is a draft only: approval records reviewed copy and sends nothing.',
      ];
  return [
    'Choose exactly one strongest previously unengaged prospect whose stored professional evidence supports outreach. Do not enrich or draft for any other prospect in this run.',
    'Call get_partner_candidate for that prospect. When next_contact_call is present, call mcp__agentcash__fetch with those exact arguments, then call get_partner_candidate again. Continue only through the returned enrichment, email-verification, and bounded verification-poll calls. When next_contact_call is absent, inspect professional_contact rather than inferring lookup failure: copy its stored phone_numbers and social_profiles when present; only when professional_contact is null use a null address and empty phone/social lists. Never alter an argument, repeat a completed paid call, use another contact source, or discard completed stored contact fields.',
    `Call propose_approval with policy_key ${JSON.stringify(context.policyKey)}, approval_type communication, illustrative false, target_member_ids [${JSON.stringify(context.memberId)}], and no target agents, resources, dependent requests, continuation, or scheduled_for.`,
    ...disposition,
    `Set details.sender to ${JSON.stringify({ member_id: context.memberId, address: context.senderAddress })}.`,
    'Set one recipient with candidate_id and the candidate name. Copy only stored phone_numbers and social_profiles into the recipient for human review.',
    'Write a concise subject and body grounded in the cited professional evidence. Invite the person to explore or apply to the configured Partner Program without claiming prior interest, approval, benefits, or terms.',
    'Cite the stored candidate artifacts and, when professional_contact is present, its contact enrichment id in proposal.evidence.',
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
  const source = settings.rows[0];
  if (!source) throw new Error('partner_automation_workspace_settings_missing');
  // Automation follows the workspace policy. Active run snapshots remain fixed.
  const existing = await tx.query<TurnSession>(
    `UPDATE sessions SET model_id=$5, effort=$6
      WHERE id=(SELECT id FROM sessions WHERE workspace_id=$1 AND owner_id=$2 AND agent_id=$3
        AND title=$4 AND NOT archived AND NOT read_only ORDER BY created_at LIMIT 1 FOR UPDATE)
      RETURNING id, agent_id, owner_id, read_only, mode, model_id, effort`,
    [workspaceId,ownerId,agentId,AUTOMATION_TITLE,source.default_model_id,source.default_effort]);
  if (existing.rows[0]) return existing.rows[0];
  const resolvedRuntime = env.AGENT_RUNTIME === 'hermes'
    ? await resolveRuntimeBinding(env, tx, workspaceId, agentId)
    : null;
  const runtime = resolvedRuntime
    ? (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/])/.test(resolvedRuntime.baseUrl) ? 'local' : 'cloud')
    : source.default_runtime;
  const inserted = await tx.query<TurnSession>(
    `INSERT INTO sessions (workspace_id, owner_id, agent_id, title, mode, model_id, effort, runtime)
     VALUES ($1,$2,$3,$4,'work',$5,$6,$7)
     RETURNING id, agent_id, owner_id, read_only, mode, model_id, effort`,
    [
      workspaceId, ownerId, agentId, AUTOMATION_TITLE,
      source.default_model_id,
      source.default_effort,
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
    const draftContext = await ensurePartnerOutreachDraftPolicy(tx, env, workspaceId, ownerUserId, agentId);
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

/** Existing active work or the latest unresolved screening owns the agent. */
export async function unresolvedPartnerWork(tx: Tx, workspaceId: string, agentId: string): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT r.id FROM runs r JOIN sessions s ON s.id=r.session_id
      WHERE r.workspace_id=$1 AND r.agent_id=$2 AND NOT s.archived
        AND (r.status IN ('working','waiting','stopping') OR
          (r.status IN ('error','stopped') AND r.client_turn_id LIKE 'partner-screening:%'
            AND (NOT EXISTS(SELECT 1 FROM requests q WHERE q.workspace_id=r.workspace_id AND q.run_id=r.id)
              OR EXISTS(SELECT 1 FROM requests q WHERE q.workspace_id=r.workspace_id AND q.run_id=r.id AND q.status='pending'))
            AND NOT EXISTS(SELECT 1 FROM runs newer WHERE newer.workspace_id=r.workspace_id
              AND newer.agent_id=r.agent_id AND newer.client_turn_id LIKE 'partner-screening:%'
              AND newer.created_at>r.created_at)))
      ORDER BY r.created_at DESC LIMIT 1`, [workspaceId,agentId]);
  return rows[0]?.id ?? null;
}

/** Durable discovery -> stored evidence -> Iris run. A retry reuses both ids. */
export async function runPartnerScreeningAutomationJob(env: Env, job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as { agent_id?: string; owner_user_id?: string; bucket?: string };
  if (!payload.agent_id || !payload.owner_user_id || !payload.bucket) {
    throw new Error('partner_screening_payload_invalid');
  }
  if (!automatedTriggersEnabled(env)) return;
  const idempotencyKey = `auto:${payload.bucket}`;
  const admitted = await withWorkspaceTransaction(env, job.workspace_id, async tx => {
    const configured = await resolvePartnerSkillAssignment(env, tx, job.workspace_id, payload.agent_id!, { materialize: true });
    if (!configured.config) throw new Error('partner_screening_config_missing');
    if (configured.assignment && !configured.assignment.schedule.enabled) return null;
    if (configured.config.source === 'agentcash_people' && !paidPartnerScreeningEnabled(env)) return null;
    const authentication = configured.config.source === 'agentcash_people'
      ? 'wallet' as const
      : env.PARTNER_GITHUB_TOKEN?.trim() ? 'authenticated' as const : 'unauthenticated' as const;
    await tx.query('SELECT id FROM agents WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [job.workspace_id,payload.agent_id]);
    const unresolved = await unresolvedPartnerWork(tx,job.workspace_id,payload.agent_id!);
    if (unresolved) {
      const same = await tx.query(`SELECT 1 FROM runs r JOIN partner_screening_runs p
        ON r.client_turn_id='partner-screening:' || p.id::text
        WHERE r.id=$1 AND p.workspace_id=$2 AND p.idempotency_key=$3`,
        [unresolved,job.workspace_id,idempotencyKey]);
      if (!same.rows.length) return null;
    }
    let runConfig: PartnerAgentConfig = configured.config!;
    if (runConfig.source === 'agentcash_people' && runConfig.people_search) {
      const cursor = await tx.query<{ next_offset: number; search_after: string | null }>(
        `SELECT next_offset, search_after
           FROM partner_discovery_cursors
          WHERE workspace_id=$1 AND agent_id=$2 AND source='agentcash_people'
          FOR UPDATE`,
        [job.workspace_id, payload.agent_id],
      );
      const position = cursor.rows[0];
      runConfig = {
        ...runConfig,
        people_search: {
          ...runConfig.people_search,
          offset: position?.next_offset ?? 0,
          search_after: position?.search_after ?? null,
        },
      };
    }
    const started = await beginPartnerScreening(work(tx, job.workspace_id, payload.owner_user_id!),
      { agentId: payload.agent_id!, idempotencyKey, config: runConfig, authentication });
    return { started, config: runConfig };
  });
  if (!admitted) return;
  const { started, config } = admitted;

  if (config.source === 'github' && started.run.status !== 'completed') {
    try {
      const result = await discoverGitHubOrganizations(config, {
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
