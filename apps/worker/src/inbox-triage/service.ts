import { approvalPayloadSchema } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import type { Env } from '../env.js';
import { publishEvents, runJobsAfterCommit, withWorkspaceTransaction, type Job } from '../jobs.js';

export const JEV_MODEL_ID = 'typesafe/jev';
export const SUMMARY_VERSION = '1';

type Band = 'urgent' | 'high' | 'normal' | 'low';
type Signals = {
  goal_relevance: number;
  material_impact: number;
  time_sensitivity: number;
  decision_complexity: number;
  evidence_sufficiency: number;
  primary_reason: string;
  needs_human_triage: boolean;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeText = (value: unknown, max = 500): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, '[phone]')
    .replace(/https?:\/\/\S+/g, '[url]')
    .slice(0, max);
};

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const data = value as Record<string, unknown>;
    return `{${Object.keys(data).sort().map((key) => `${JSON.stringify(key)}:${stable(data[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizedTriageState(input: {
  kind: string;
  status: string;
  label: string;
  payload: unknown;
  createdAt: Date;
}): Record<string, unknown> {
  const payload = record(input.payload);
  const base: Record<string, unknown> = {
    request_kind: input.kind,
    status: input.status,
    created_at: input.createdAt.toISOString(),
  };
  if (input.kind === 'approval') {
    const parsed = approvalPayloadSchema.safeParse(payload);
    if (parsed.success) {
      const approval = parsed.data;
      const details = approval.details as unknown as Record<string, unknown>;
      return {
        ...base,
        approval_type: approval.approval_type,
        summary: safeText(approval.summary, 700),
        consequence: safeText(approval.consequence, 700),
        expires_at: approval.authorization.expires_at,
        review_mode: approval.policy.mode,
        review_steps: approval.policy.steps.map((step) => ({ label: safeText(step.label, 120), quorum: step.quorum })),
        evidence_count: approval.evidence.length,
        detail_counts: {
          steps: Array.isArray(details.steps) ? details.steps.length : undefined,
          recipients: Array.isArray(details.recipients) ? details.recipients.length : undefined,
          items: Array.isArray(details.items) ? details.items.length : undefined,
          changes: Array.isArray(details.changes) ? details.changes.length : undefined,
          missing_information: Array.isArray(details.missing_information) ? details.missing_information.length : undefined,
        },
      };
    }
  }
  return {
    ...base,
    proposed_role: safeText(payload.proposed_role ?? payload.role, 200),
    score: typeof payload.score === 'number' ? payload.score : undefined,
    score_max: typeof payload.score_max === 'number' ? payload.score_max : undefined,
    total_minor_band: typeof payload.total_minor === 'number' ? Math.ceil(payload.total_minor / 10_000) * 10_000 : undefined,
    sources_count: Array.isArray(payload.sources) ? payload.sources.length : undefined,
    missing_count: Array.isArray(payload.missing) ? payload.missing.length : undefined,
    task_type: safeText(payload.task_type, 100),
  };
}

function answerScore(answer: unknown): number {
  const value = record(answer).score;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(3, value)) : 0;
}
function answerConfidence(answer: unknown): number {
  const value = record(answer).confidence;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function scoreTriage(state: Record<string, unknown>, signals: Signals): { score: number; band: Band; reasons: string[]; confidence: number } {
  const soft = (signals.goal_relevance * 4 + signals.material_impact * 4 + signals.time_sensitivity * 3 + signals.decision_complexity * 1.5 + (3 - signals.evidence_sufficiency) * 1.5) / 42 * 40;
  let score = Math.round((20 + soft) * 100) / 100;
  const reasons = [signals.primary_reason];
  const expires = typeof state.expires_in_hours === 'number'
    ? state.expires_in_hours
    : typeof state.expires_at === 'string'
      ? Math.round((Date.parse(state.expires_at) - Date.now()) / 3_600_000)
      : null;
  if (expires !== null && expires <= 4) { score = Math.max(score, 90); reasons.unshift('expires_within_4h'); }
  else if (expires !== null && expires <= 24) { score = Math.max(score, 70); reasons.unshift('expires_within_24h'); }
  const highRisk = ['access', 'data_disclosure', 'exception', 'agent_governance'].includes(String(state.approval_type ?? ''));
  if (highRisk) { score = Math.max(score, 45); reasons.unshift('sensitive_authorization'); }
  if (signals.needs_human_triage) reasons.push('human_triage_recommended');
  const band: Band = score >= 85 ? 'urgent' : score >= 65 ? 'high' : score >= 35 ? 'normal' : 'low';
  return { score, band, reasons: [...new Set(reasons.filter(Boolean))].slice(0, 8), confidence: Math.min(1, Math.max(0, signals.evidence_sufficiency / 3)) };
}

export async function enqueueRequestTriage(tx: Tx, workspaceId: string, requestId: string, requestVersion: number): Promise<string | null> {
  const key = `request-triage:${requestId}:${requestVersion}`;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO jobs (workspace_id,kind,key,payload)
     VALUES ($1,'request_triage',$2,$3::jsonb)
     ON CONFLICT (kind,key) DO UPDATE
       SET payload=EXCLUDED.payload,done_at=NULL,locked_until=NULL,next_at=now(),last_error=NULL
       WHERE jobs.done_at IS NOT NULL
     RETURNING id`,
    [workspaceId, key, JSON.stringify({ request_id: requestId, request_version: requestVersion })],
  );
  const id = rows[0]?.id ?? null;
  if (id) await tx.query(
    `INSERT INTO job_ready (job_id,workspace_id,next_at) VALUES ($1,$2,now())
     ON CONFLICT (job_id) DO UPDATE SET next_at=now()`, [id, workspaceId],
  );
  return id;
}

export async function runRequestTriageJob(env: Env, job: Job): Promise<void> {
  if ((env.INBOX_TRIAGE_MODE ?? 'off') === 'off') return;
  const payload = record(job.payload);
  const requestId = typeof payload.request_id === 'string' ? payload.request_id : null;
  if (!requestId) return;
  const rubricVersion = env.INBOX_TRIAGE_RUBRIC_VERSION ?? '1';
  const row = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    const result = await tx.query<{ id: string; kind: string; status: string; label: string; payload: unknown; created_at: Date; version: number }>(
      `SELECT id, kind, status, label, payload, created_at, EXTRACT(EPOCH FROM updated_at)::int AS version
         FROM requests WHERE id=$1`, [requestId],
    );
    return result.rows[0] ?? null;
  });
  if (!row || row.status !== 'pending') return;
  const state = normalizedTriageState({ kind: row.kind, status: row.status, label: row.label, payload: row.payload, createdAt: row.created_at });
  const stateHash = await sha256(state);
  const assessmentId = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO request_triage_assessments
        (workspace_id,request_id,request_version,state_hash,rubric_version,summary_version,status,attempt_count)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
       ON CONFLICT (request_id,state_hash,rubric_version,model_id)
       DO UPDATE SET attempt_count=GREATEST(request_triage_assessments.attempt_count, EXCLUDED.attempt_count)
       RETURNING id`,
      [job.workspace_id, requestId, row.version, stateHash, rubricVersion, SUMMARY_VERSION, job.attempts],
    );
    return inserted.rows[0]?.id ?? null;
  });
  if (!assessmentId) return;
  if (!env.AI) {
    await withWorkspaceTransaction(env, job.workspace_id, (tx) => tx.query(
      `UPDATE request_triage_assessments SET status='abstained',failure_class='ai_binding_unavailable',completed_at=now() WHERE id=$1`, [assessmentId],
    ));
    return;
  }

  try {
    const result = await env.AI.run(JEV_MODEL_ID as keyof AiModels, {
      state,
      questions: {
        goal_relevance: { type: 'score', instructions: 'How directly does this request advance the workspace goal?', criteria: ['Unrelated', 'Weakly related', 'Clearly related', 'Critical to the goal'] },
        material_impact: { type: 'score', instructions: 'How material is the consequence of delay or a wrong decision?', criteria: ['Minimal', 'Limited', 'Meaningful', 'Severe'] },
        time_sensitivity: { type: 'score', instructions: 'How time-sensitive is this request beyond the explicit expiry?', criteria: ['No urgency', 'Some timing value', 'Time sensitive', 'Immediate blocker'] },
        decision_complexity: { type: 'score', instructions: 'How much human judgment is required?', criteria: ['Routine', 'Some judgment', 'Substantial judgment', 'Exceptional complexity'] },
        evidence_sufficiency: { type: 'score', instructions: 'How sufficient is the available evidence for a decision?', criteria: ['Insufficient', 'Material gaps', 'Mostly sufficient', 'Sufficient'] },
        primary_reason: { type: 'choice', instructions: 'Choose the main reason this item should be reviewed.', criteria: { deadline: 'Deadline or expiry', impact: 'Material impact', blocker: 'Blocks work', risk: 'Risk or sensitive authorization', goal: 'Goal relevance', routine: 'Routine queue item' } },
        needs_human_triage: { type: 'noul', instructions: 'Does ambiguity or missing context require manual triage before deciding?', criteria: { true: 'Manual triage is needed', false: 'The request is clear enough' } },
      },
    } as never) as unknown;
    const response = record(result);
    const answers = record(response.answers);
    const choice = record(answers.primary_reason).choice;
    const noul = record(answers.needs_human_triage).noul;
    const signals: Signals = {
      goal_relevance: answerScore(answers.goal_relevance),
      material_impact: answerScore(answers.material_impact),
      time_sensitivity: answerScore(answers.time_sensitivity),
      decision_complexity: answerScore(answers.decision_complexity),
      evidence_sufficiency: answerScore(answers.evidence_sufficiency),
      primary_reason: typeof choice === 'string' ? choice : 'routine',
      needs_human_triage: typeof noul === 'number' ? noul >= 0.5 : false,
    };
    const scored = scoreTriage(state, signals);
    const confidences = Object.values(answers).map(answerConfidence).filter((value) => value > 0);
    const confidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : scored.confidence;
    const modelVersion = typeof response.model === 'string' ? response.model : null;
    const publishJobs = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
      await tx.query(
        `UPDATE request_triage_assessments
            SET status='complete',model_version=$2,priority_score=$3,priority_band=$4,confidence=$5,
                signals=$6::jsonb,reason_codes=$7::jsonb,failure_class=NULL,completed_at=now()
          WHERE id=$1`,
        [assessmentId, modelVersion, scored.score, scored.band, confidence, JSON.stringify(signals), JSON.stringify(scored.reasons)],
      );
      return publishEvents(tx, job.workspace_id, [{ kind: 'entity.updated', payload: { entity_type: 'request', entity_id: requestId, ref: { section: 'inbox', view: 'request', id: requestId }, version: row.version } }]);
    });
    console.log(JSON.stringify({
      at: 'inbox.triage', request_id: requestId, status: 'complete', mode: env.INBOX_TRIAGE_MODE,
      band: scored.band, score: scored.score, confidence: Math.round(confidence * 1000) / 1000,
      model_version: modelVersion,
    }));
    if (publishJobs.length) await runJobsAfterCommit(env, job.workspace_id, publishJobs);
  } catch (error) {
    const terminal = job.attempts >= 3;
    await withWorkspaceTransaction(env, job.workspace_id, (tx) => tx.query(
      `UPDATE request_triage_assessments SET status=$2,failure_class='model_call_failed',attempt_count=$3,completed_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE id=$1`,
      [assessmentId, terminal ? 'failed' : 'pending', job.attempts],
    ));
    if (!terminal) throw error;
  }
}
