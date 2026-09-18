import { partnerScreeningSnapshotSchema, type PartnerScreeningSnapshot } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { RouteError } from '../routes/tenant.js';
import { agentCashPeopleSearchArguments } from './agentcash-people.js';
import { configSnapshot, partnerAgentConfigSchema, type PartnerAgentConfig } from './config.js';
import type { DiscoveryPriority } from './score.js';

export const LIVE_DISCLOSURE =
  'Public organization evidence was fetched through the official GitHub REST API. No person was contacted and no application, admission, message, payment, signature, or external write was performed.' as const;
export const AGENTCASH_DISCLOSURE =
  'Public professional evidence was fetched through AgentCash People Search using one capped wallet payment. No person was contacted and no application, admission, message, signature, or other external write was performed.' as const;
export const AGENTCASH_CREATOR_DISCLOSURE =
  'Public LinkedIn and YouTube creator evidence was fetched through one explicitly requested AgentCash search. Influence scale and contactability remain evidence gaps; no person was contacted and no message was sent.' as const;
export const PRIORITY_NOTE = 'This is connector-side triage, not an Iris or Hermes decision.' as const;

export type PartnerScreeningSource = 'github' | 'agentcash_people' | 'agentcash_creators';

interface PartnerArtifactInput {
  readonly key: string;
  readonly kind: 'search_result' | 'organization_profile' | 'repository_snapshot' | 'person_profile' | 'creator_profile' | 'creator_content';
  readonly url: string;
  readonly sourceUpdatedAt: string | null;
  readonly fetchedAt: string;
  readonly content: Record<string, unknown>;
}

export interface PartnerDiscoveryResult {
  readonly candidates: readonly {
    readonly sourceKey: string;
    readonly displayName: string;
    readonly profileUrl: string;
    readonly priority: DiscoveryPriority;
    readonly artifacts: readonly PartnerArtifactInput[];
  }[];
  readonly artifacts: readonly PartnerArtifactInput[];
  readonly apiRequestsUsed: number;
  readonly rateLimits: readonly unknown[];
  readonly monetaryCostUsd?: number;
}

interface RunRow {
  id: string;
  agent_id: string;
  created_by: string;
  status: 'running' | 'completed' | 'failed';
  source: PartnerScreeningSource;
  authentication: 'authenticated' | 'unauthenticated' | 'wallet';
  config_snapshot: Record<string, unknown>;
  api_requests_max: number;
  api_requests_used: number;
  rate_limits: unknown;
  error_code: string | null;
  error_detail: string | null;
  started_at: Date;
  completed_at: Date | null;
  monetary_cost_usd: string | number;
}

/** The narrow authority discovery needs, shared by an authenticated route and the scheduler. */
export interface PartnerScreeningWork {
  readonly tx: Tx;
  readonly workspaceId: string;
  readonly userId: string;
  /** `system` is admitted only by deployment-controlled background automation. */
  readonly role: 'admin' | 'member' | 'system';
  requireAdmin(action: string): void;
}

async function sha256Hex(value: unknown): Promise<string> {
  const body = JSON.stringify(value);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function boundAgent(work: PartnerScreeningWork, agentId: string): Promise<boolean> {
  if (work.role === 'system') {
    const result = await work.tx.query(
      `SELECT 1
         FROM agents a
         JOIN members m ON m.workspace_id=a.workspace_id
        WHERE a.workspace_id=$1 AND a.id=$2
          AND m.user_id=$3 AND m.status='active'
          AND (
            EXISTS (
              SELECT 1 FROM agent_owners ao
               WHERE ao.workspace_id=a.workspace_id AND ao.agent_id=a.id AND ao.member_id=m.id
            )
            OR (
              EXISTS (
                SELECT 1 FROM sessions own_session
                 WHERE own_session.workspace_id=a.workspace_id AND own_session.agent_id=a.id
                   AND own_session.owner_id=m.user_id
                   AND NOT own_session.archived AND NOT own_session.read_only
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM sessions other_session
                  JOIN members other_member
                    ON other_member.workspace_id=other_session.workspace_id
                   AND other_member.user_id=other_session.owner_id
                 WHERE other_session.workspace_id=a.workspace_id AND other_session.agent_id=a.id
                   AND NOT other_session.archived AND NOT other_session.read_only
                   AND other_member.status='active' AND other_member.user_id<>m.user_id
              )
            )
          )`,
      [work.workspaceId, agentId, work.userId],
    );
    return result.rowCount === 1;
  }
  const result = await work.tx.query(
    `SELECT 1
       FROM agents a
       JOIN agent_owners ao ON ao.workspace_id = a.workspace_id AND ao.agent_id = a.id
       JOIN members m ON m.workspace_id = ao.workspace_id AND m.id = ao.member_id
      WHERE a.workspace_id = $1 AND a.id = $2
        AND m.user_id = $3 AND m.status = 'active'`,
    [work.workspaceId, agentId, work.userId],
  );
  return result.rowCount === 1;
}

export async function beginPartnerScreening(
  work: PartnerScreeningWork,
  input: {
    agentId: string;
    idempotencyKey: string;
    config: PartnerAgentConfig;
    authentication: 'authenticated' | 'unauthenticated' | 'wallet';
    /** True only for a member-owned profile explicitly marked as an AgentCash invitee profile. */
    memberOnboardingAllowed?: boolean;
  },
): Promise<{ run: RunRow; created: boolean; resumed: boolean }> {
  if (!await boundAgent(work, input.agentId)) {
    throw new RouteError('this agent is not bound to your profile', 'agent_not_bound', 403);
  }
  if (work.role === 'member') {
    if (!input.memberOnboardingAllowed
        || input.config.source !== 'agentcash_people'
        || !input.idempotencyKey.startsWith('onboarding:')) {
      work.requireAdmin('Live partner-source discovery');
    }
    await work.tx.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${work.workspaceId}:${input.agentId}:member-agentcash-onboarding`],
    );
    const other = await work.tx.query(
      `SELECT 1 FROM partner_screening_runs
        WHERE workspace_id = $1 AND agent_id = $2 AND created_by = $3
          AND source = 'agentcash_people' AND idempotency_key <> $4
        LIMIT 1`,
      [work.workspaceId, input.agentId, work.userId, input.idempotencyKey],
    );
    if ((other.rowCount ?? 0) > 0) {
      throw new RouteError(
        'The member onboarding allowance has already been used. Ask an Admin to authorize another paid search.',
        'partner_onboarding_allowance_used',
        403,
      );
    }
  }
  const inserted = await work.tx.query<RunRow>(
    `INSERT INTO partner_screening_runs
       (workspace_id, agent_id, created_by, idempotency_key, source, authentication,
        config_snapshot, api_requests_max)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     ON CONFLICT (workspace_id, agent_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      work.workspaceId, input.agentId, work.userId, input.idempotencyKey,
      input.config.source, input.authentication, JSON.stringify(configSnapshot(input.config)), input.config.max_api_requests,
    ],
  );
  if (inserted.rows[0]) return { run: inserted.rows[0], created: true, resumed: false };

  const existing = await work.tx.query<RunRow>(
    `SELECT * FROM partner_screening_runs
      WHERE workspace_id = $1 AND agent_id = $2 AND idempotency_key = $3 AND created_by = $4
      FOR UPDATE`,
    [work.workspaceId, input.agentId, input.idempotencyKey, work.userId],
  );
  const run = existing.rows[0];
  if (!run) throw new RouteError('the idempotency key belongs to another screening run', 'partner_screening_conflict', 409);
  if (run.status === 'running') return { run, created: false, resumed: false };
  if (run.status === 'completed') return { run, created: false, resumed: false };
  if (run.source === 'agentcash_people' && run.api_requests_used > 0) {
    throw new RouteError(
      'This AgentCash run already reserved its payment allowance and cannot be retried automatically.',
      'partner_source_budget_exhausted',
      409,
    );
  }

  const resumed = await work.tx.query<RunRow>(
    `UPDATE partner_screening_runs
        SET status = 'running', error_code = NULL, error_detail = NULL,
            authentication = $3, config_snapshot = $4::jsonb, api_requests_max = $5,
            api_requests_used = 0, agentcash_tool_call_id = NULL,
            rate_limits = '[]'::jsonb, monetary_cost_usd = 0, completed_at = NULL
      WHERE workspace_id = $1 AND id = $2
      RETURNING *`,
    [work.workspaceId, run.id, input.authentication, JSON.stringify(configSnapshot(input.config)), input.config.max_api_requests],
  );
  return { run: resumed.rows[0] ?? run, created: false, resumed: true };
}

async function insertArtifact(
  work: PartnerScreeningWork,
  runId: string,
  source: PartnerScreeningSource,
  artifact: PartnerArtifactInput,
): Promise<string> {
  const digest = await sha256Hex(artifact.content);
  const inserted = await work.tx.query<{ id: string }>(
    `INSERT INTO partner_source_artifacts
       (workspace_id, run_id, source, artifact_key, kind, source_url,
        source_updated_at, fetched_at, sha256, content)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (run_id, artifact_key) DO NOTHING
     RETURNING id`,
    [
      work.workspaceId, runId, source, artifact.key, artifact.kind, artifact.url,
      artifact.sourceUpdatedAt, artifact.fetchedAt, digest, JSON.stringify(artifact.content),
    ],
  );
  const existing = inserted.rows[0] ? null : await work.tx.query<{ id: string }>(
    `SELECT id FROM partner_source_artifacts WHERE run_id = $1 AND artifact_key = $2`,
    [runId, artifact.key],
  );
  const id = inserted.rows[0]?.id ?? existing?.rows[0]?.id;
  if (!id) throw new Error(`source artifact ${artifact.key} was not persisted`);
  return id;
}

export async function completePartnerScreening(
  work: PartnerScreeningWork,
  input: { runId: string; agentId: string; result: PartnerDiscoveryResult; completedAt?: Date },
): Promise<void> {
  const run = await work.tx.query<RunRow>(
    `SELECT * FROM partner_screening_runs
      WHERE workspace_id = $1 AND id = $2 AND agent_id = $3 AND created_by = $4
      FOR UPDATE`,
    [work.workspaceId, input.runId, input.agentId, work.userId],
  );
  if (!run.rows[0]) throw new RouteError('no such partner screening run', 'unknown_partner_screening_run', 404);
  const activeRun = run.rows[0];
  if (activeRun.status === 'completed') return;
  if (activeRun.status !== 'running') throw new RouteError('partner screening run is not active', 'partner_screening_conflict', 409);

  const artifactIds = new Map<string, string>();
  for (const artifact of input.result.artifacts) {
    artifactIds.set(artifact.key, await insertArtifact(work, input.runId, activeRun.source, artifact));
  }

  const seenAt = input.completedAt ?? new Date();
  for (const candidate of input.result.candidates) {
    const breakdown = candidate.priority.criteria.map((criterion) => ({
      id: criterion.id,
      label: criterion.label,
      points: criterion.points,
      points_max: criterion.points_max,
      evidence: criterion.evidence,
      source_artifact_ids: criterion.source_artifact_keys.flatMap((key) => artifactIds.get(key) ? [artifactIds.get(key) as string] : []),
    }));
    const stored = await work.tx.query<{ id: string }>(
      `INSERT INTO partner_candidates
         (workspace_id, agent_id, source, source_key, display_name, profile_url,
          deterministic_priority, priority_breakdown, confidence, evidence_gaps,
          source_updated_at, latest_run_id, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::text[],$11,$12,$13,$13)
       ON CONFLICT (workspace_id, agent_id, source, source_key) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         profile_url = EXCLUDED.profile_url,
         deterministic_priority = EXCLUDED.deterministic_priority,
         priority_breakdown = EXCLUDED.priority_breakdown,
         confidence = EXCLUDED.confidence,
         evidence_gaps = EXCLUDED.evidence_gaps,
         source_updated_at = EXCLUDED.source_updated_at,
         latest_run_id = EXCLUDED.latest_run_id,
         last_seen_at = EXCLUDED.last_seen_at
       RETURNING id`,
      [
        work.workspaceId, input.agentId, activeRun.source, candidate.sourceKey, candidate.displayName,
        candidate.profileUrl, candidate.priority.total, JSON.stringify(breakdown),
        candidate.priority.confidence, [...candidate.priority.gaps], candidate.priority.sourceUpdatedAt,
        input.runId, seenAt,
      ],
    );
    const candidateId = stored.rows[0]?.id;
    if (!candidateId) throw new Error(`candidate ${candidate.sourceKey} was not persisted`);
    const candidateArtifactIds = candidate.artifacts.flatMap((artifact) => artifactIds.get(artifact.key) ? [artifactIds.get(artifact.key) as string] : []);
    await work.tx.query(
      `INSERT INTO partner_screening_run_candidates
         (workspace_id, run_id, candidate_id, deterministic_priority, priority_breakdown,
          confidence, evidence_gaps, artifact_ids)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::text[],$8::uuid[])
       ON CONFLICT (run_id, candidate_id) DO NOTHING`,
      [
        work.workspaceId, input.runId, candidateId, candidate.priority.total,
        JSON.stringify(breakdown), candidate.priority.confidence, [...candidate.priority.gaps], candidateArtifactIds,
      ],
    );
  }

  await work.tx.query(
    `UPDATE partner_screening_runs
        SET status = 'completed', api_requests_used = $3, rate_limits = $4::jsonb,
            candidates_discovered = $5, monetary_cost_usd = $6, completed_at = $7
      WHERE workspace_id = $1 AND id = $2`,
    [
      work.workspaceId, input.runId, input.result.apiRequestsUsed,
      JSON.stringify(input.result.rateLimits), input.result.candidates.length,
      input.result.monetaryCostUsd ?? 0, seenAt,
    ],
  );
}

export async function failPartnerScreening(
  work: PartnerScreeningWork,
  runId: string,
  errorCode: string,
  errorDetail: string,
): Promise<void> {
  await work.tx.query(
    `UPDATE partner_screening_runs
        SET status = 'failed', error_code = $3, error_detail = $4, completed_at = now()
      WHERE workspace_id = $1 AND id = $2 AND created_by = $5 AND status = 'running'`,
    [work.workspaceId, runId, errorCode.slice(0, 100), errorDetail.slice(0, 500), work.userId],
  );
}

export async function loadPartnerScreeningSnapshot(
  work: PartnerScreeningWork,
  runId: string,
): Promise<PartnerScreeningSnapshot> {
  const runResult = await work.tx.query<RunRow>(
    `SELECT * FROM partner_screening_runs
      WHERE workspace_id = $1 AND id = $2 AND created_by = $3`,
    [work.workspaceId, runId, work.userId],
  );
  const run = runResult.rows[0];
  if (!run) throw new RouteError('no such partner screening run', 'unknown_partner_screening_run', 404);
  const candidates = await work.tx.query<{
    id: string; source_key: string; display_name: string; profile_url: string;
    deterministic_priority: number; confidence: 'high' | 'medium' | 'low'; evidence_gaps: string[];
    source_updated_at: Date | null; last_seen_at: Date; existing_request_id: string | null;
  }>(
    `SELECT c.id, c.source_key, c.display_name, c.profile_url,
            rc.deterministic_priority, rc.confidence, rc.evidence_gaps,
            c.source_updated_at, c.last_seen_at,
            (SELECT r.id FROM requests r
              WHERE r.workspace_id = c.workspace_id
                AND r.subject_key = 'partner-candidate:' || c.id::text
              ORDER BY r.created_at LIMIT 1) AS existing_request_id
       FROM partner_screening_run_candidates rc
       JOIN partner_candidates c ON c.id = rc.candidate_id
      WHERE rc.workspace_id = $1 AND rc.run_id = $2
      ORDER BY rc.deterministic_priority DESC, c.display_name`,
    [work.workspaceId, run.id],
  );
  const snapshot = run.config_snapshot;
  const minimum = typeof snapshot.minimum_priority === 'number' ? snapshot.minimum_priority : 0;
  const weights = snapshot.ranking_weights && typeof snapshot.ranking_weights === 'object'
    ? snapshot.ranking_weights as Record<string, number>
    : {};
  const agentRunResult = await work.tx.query<{ id: string; session_id: string; status: 'working' | 'waiting' | 'stopping' | 'stopped' | 'error' | 'completed' }>(
    `SELECT r.id, r.session_id, r.status
       FROM runs r
       JOIN sessions s ON s.workspace_id = r.workspace_id AND s.id = r.session_id
      WHERE r.workspace_id = $1 AND r.agent_id = $2 AND s.owner_id = $3
        AND r.client_turn_id = $4
      ORDER BY r.created_at DESC LIMIT 1`,
    [work.workspaceId, run.agent_id, work.userId, `partner-screening:${run.id}`],
  );
  const eligibleIds = candidates.rows.filter((candidate) => candidate.deterministic_priority >= minimum).map((candidate) => candidate.id);
  const prompt = run.source === 'agentcash_people' && run.status === 'running'
    ? `Perform the approved AgentCash People Search exactly once by calling mcp__agentcash__fetch with ${JSON.stringify(agentCashPeopleSearchArguments(partnerAgentConfigSchema.parse(snapshot)))}. The connector imports and sanitizes the successful result before you see it. Then call list_partner_candidates and get_partner_candidate and independently assess only stored professional evidence. Cite only stored artifact ids, state every evidence gap, do not infer sensitive traits, and do not contact anyone or claim the person applied. Do not create an application request for a discovered prospect.`
    : eligibleIds.length > 0
      ? `Use list_partner_candidates and get_partner_candidate to review candidates ${eligibleIds.join(', ')}. Apply your configured Partner Program criteria independently of the deterministic discovery priority. Cite only stored artifact ids and state every evidence gap. Do not contact anyone, claim the candidate applied, or create an application request for a discovered prospect.`
      : 'The connector found no candidate at or above the configured discovery-priority threshold. Review the evidence gaps before changing the source query or ranking policy.';
  return partnerScreeningSnapshotSchema.parse({
    run: {
      id: run.id, agent_id: run.agent_id, status: run.status, mode: 'live', source: run.source,
      authentication: run.authentication, started_at: run.started_at.toISOString(),
      completed_at: run.completed_at?.toISOString() ?? null,
      error_code: run.error_code, error_detail: run.error_detail,
    },
    budget: {
      api_requests_used: run.api_requests_used,
      api_requests_max: run.api_requests_max,
      monetary_cost_usd: Number(run.monetary_cost_usd),
    },
    rate_limits: Array.isArray(run.rate_limits) ? run.rate_limits : [],
    ranking: {
      kind: 'deterministic_discovery_priority', note: PRIORITY_NOTE,
      weights, minimum_priority: minimum,
    },
    candidates: candidates.rows.map((candidate) => ({
      id: candidate.id, source: run.source, source_key: candidate.source_key,
      display_name: candidate.display_name, profile_url: candidate.profile_url,
      deterministic_priority: candidate.deterministic_priority, priority_max: 100,
      confidence: candidate.confidence, evidence_gaps: candidate.evidence_gaps,
      source_updated_at: candidate.source_updated_at?.toISOString() ?? null,
      last_seen_at: candidate.last_seen_at.toISOString(), existing_request_id: candidate.existing_request_id,
    })),
    handoff: {
      kind: 'ask_iris_to_screen', prompt, candidate_ids: eligibleIds,
      agent_run: agentRunResult.rows[0] ?? null,
    },
    disclosure: run.source === 'agentcash_people'
      ? AGENTCASH_DISCLOSURE
      : run.source === 'agentcash_creators' ? AGENTCASH_CREATOR_DISCLOSURE : LIVE_DISCLOSURE,
  });
}
