// The effects ledger.
//
//   GET  /w/:ws/effects?status=      what a decision implied and nobody has done
//   POST /w/:ws/effects/:id/execute  answers `unavailable`, every time
//   POST /w/:ws/effects/:id/external-evidence records a manual access/signature
//                                             claim without executing anything
//
// The execute route is the most important honest surface in the product, so it
// is worth being explicit about what it is:
//
// There is no executor. This repository contains no SMTP client, no payment
// provider, no signature provider, no identity provider integration and no
// webhook that would reach one — not behind a flag, not "just for testing"
// (CONVENTIONS, invariant 5). So pressing Execute records an attempt, writes
// `status = 'unavailable'` with the reason, appends an `effect.executed` audit
// row, and tells the person in plain words that nothing was sent, paid, granted
// or signed and that they will have to do it themselves for now.
//
// That is a worse product than one that executes. It is a far better product
// than one that *says* it executed, which is what a stub with a green tick
// would be, and the whole approvals design is only worth anything if the row
// that says "not done" is telling the truth.
//
// Guards: an allowlisted Origin, CSRF, the reviewer role the effect requires,
// and step-up — because it writes an audit row against a person's name, and
// "somebody walked past an unlocked laptop" should not be able to.
import type { Context } from 'hono';
import {
  approvalPayloadSchema,
  effectEntitySchema,
  externalEffectEvidenceInputSchema,
  externalEffectEvidenceReceiptSchema,
  paginatedSchema,
  EFFECT_STATUSES,
} from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { inWorkspace, pathUuid, RouteError } from './tenant.js';
import { effectRows, loadEffect, toEffectEntity } from '../domain/effect-rows.js';
import { unavailableEnforcement } from '../domain/effects.js';
import { publishEvents } from '../jobs.js';

const effectPage = paginatedSchema(effectEntitySchema);

export async function listEffects(c: Context<{ Bindings: Env }>): Promise<Response> {
  const raw = c.req.query('status');
  const status = raw
    ? raw
        .split(',')
        .map((value) => value.trim())
        .filter((value) => (EFFECT_STATUSES as readonly string[]).includes(value))
    : undefined;

  const rows = await inWorkspace(c, (work) =>
    effectRows(work.tx, { ...(status && status.length > 0 ? { status } : {}), audienceUserId: work.userId }),
  );
  return c.json(effectPage.parse({ items: rows.map(toEffectEntity), cursor: null, total: rows.length }));
}

/** Does this member hold the role the effect needs? */
export async function holdsRole(
  tx: { query: (text: string, values?: readonly unknown[]) => Promise<{ rowCount: number | null }> },
  workspaceId: string,
  userId: string,
  requiredRole: string,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `SELECT 1 FROM members
      WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'
        AND (($3 = 'admin' AND role = 'admin') OR $3 = ANY (reviewer_roles))`,
    [workspaceId, userId, requiredRole],
  );
  return rowCount === 1;
}

interface EvidenceReceiptRow {
  id: string;
  effect_id: string;
  effect_kind: 'access_grant' | 'signature';
  snapshot_id: string;
  snapshot_sha256: string;
  claimed_outcome: 'completed_outside_hermes';
  verification: 'evidence_recorded_not_provider_verified';
  occurred_at: Date | string;
  note: string;
  recorded_by: string;
  recorded_at: Date | string;
}

/** Record a person's external-completion claim without changing the effect.
 * This route never calls a provider and is categorically unavailable for email
 * and payment effects. */
export async function recordExternalEffectEvidence(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const effectId = pathUuid(c, 'id');
  const parsed = externalEffectEvidenceInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new RouteError('Evidence receipt details are invalid', 'invalid_input', 422);
  const occurredAt = new Date(parsed.data.occurred_at);
  if (occurredAt.getTime() > Date.now()) {
    throw new RouteError('Evidence cannot be recorded with a future occurrence time', 'future_evidence_time', 422);
  }

  const result = await inWorkspace(c, async (work) => {
    requireStepUp(work.session);
    const effect = await loadEffect(work.tx, effectId, work.userId);
    if (!effect) throw new RouteError('no such effect', 'unknown_effect', 404);
    if (effect.kind !== 'access_grant' && effect.kind !== 'signature') {
      throw new RouteError('External evidence is only accepted for access and signature effects', 'unsupported_effect_evidence', 409);
    }
    if (effect.status === 'cancelled') throw new RouteError('this effect was cancelled by a later version', 'effect_cancelled', 409);
    if (!(await holdsRole(work.tx, work.workspaceId, work.userId, effect.required_role))) {
      throw new RouteError(`recording this needs the ${effect.required_role} role`, 'role_required', 403);
    }
    const approval = (await work.tx.query<{
      requester_agent_id: string;
      authorization_revision: number;
      authorization_hash: string;
      payload: unknown;
    }>(
      `SELECT ar.requester_agent_id,ar.authorization_revision,ar.authorization_hash,revision.payload
         FROM approval_requests ar
         JOIN approval_revisions revision
           ON revision.workspace_id=ar.workspace_id
          AND revision.request_id=ar.request_id
          AND revision.revision=ar.authorization_revision
          AND revision.authorization_hash=ar.authorization_hash
         JOIN decisions decision
           ON decision.workspace_id=ar.workspace_id
          AND decision.request_id=ar.request_id
          AND decision.id=$3
          AND decision.decision='approve'
        WHERE ar.workspace_id=$1 AND ar.request_id=$2
          AND ar.status='approved' AND revision.status='approved'
          AND EXISTS (
            SELECT 1 FROM request_audiences audience
             WHERE audience.workspace_id=ar.workspace_id
               AND audience.request_id=ar.request_id
               AND audience.user_id=$4
          )
        FOR SHARE OF ar,revision`,
      [work.workspaceId, effect.request_id, effect.decision_id, work.userId],
    )).rows[0];
    if (!approval) {
      throw new RouteError('The effect has no approved revision available to this reviewer', 'approval_binding_required', 409);
    }
    const approvalPayload = approvalPayloadSchema.safeParse(approval.payload);
    if (!approvalPayload.success
        || approvalPayload.data.authorization.revision !== approval.authorization_revision
        || approvalPayload.data.authorization.hash !== approval.authorization_hash
        || approvalPayload.data.context.requester.agent_id !== approval.requester_agent_id
        || !approvalPayload.data.evidence.some((item) => item.id === parsed.data.snapshot_id
          && (item.kind === 'artifact' || item.kind === 'source'))) {
      throw new RouteError('The snapshot is not cited by the approved effect revision', 'evidence_binding_required', 409);
    }
    const snapshot = await work.tx.query<{
      id: string;
      library_source_id: string;
      library_version_id: string;
      normalized_sha256: string;
    }>(
      `SELECT s.id,s.library_source_id,s.library_version_id,s.normalized_sha256
         FROM mailbox_thread_snapshots s
         JOIN library_source_versions source_version
           ON source_version.workspace_id=s.workspace_id
          AND source_version.source_id=s.library_source_id
          AND source_version.id=s.library_version_id
         JOIN library_source_team_grants source_grant
           ON source_grant.workspace_id=s.workspace_id
          AND source_grant.source_id=s.library_source_id
          AND source_grant.team_id=s.team_id
        WHERE s.workspace_id=$1 AND s.id=$2
          AND EXISTS (
            SELECT 1 FROM enterprise_team_agents team_agent
             WHERE team_agent.workspace_id=s.workspace_id
               AND team_agent.team_id=s.team_id
               AND team_agent.agent_id=$3
          )`,
      [work.workspaceId, parsed.data.snapshot_id, approval.requester_agent_id],
    );
    const evidence = snapshot.rows[0];
    if (!evidence) throw new RouteError('No accessible mailbox evidence snapshot', 'evidence_not_found', 404);
    const inserted = await work.tx.query<EvidenceReceiptRow>(
      `INSERT INTO external_effect_evidence_receipts
         (workspace_id,effect_id,request_id,decision_id,authorization_revision,authorization_hash,
          snapshot_id,library_source_id,library_version_id,snapshot_sha256,
          claimed_outcome,verification,occurred_at,note,recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         'completed_outside_hermes','evidence_recorded_not_provider_verified',$11,$12,$13)
       ON CONFLICT (workspace_id,effect_id,snapshot_id,authorization_revision,authorization_hash) DO NOTHING
       RETURNING id,effect_id,$14::text AS effect_kind,snapshot_id,snapshot_sha256,
         claimed_outcome,verification,occurred_at,note,recorded_by,recorded_at`,
      [work.workspaceId, effectId, effect.request_id, effect.decision_id,
        approval.authorization_revision, approval.authorization_hash,
        evidence.id, evidence.library_source_id, evidence.library_version_id, evidence.normalized_sha256,
        occurredAt, parsed.data.note, work.userId, effect.kind],
    );
    let receipt = inserted.rows[0];
    if (!receipt) {
      const existing = await work.tx.query<EvidenceReceiptRow>(
        `SELECT r.id,r.effect_id,e.kind AS effect_kind,r.snapshot_id,r.snapshot_sha256,
                r.claimed_outcome,r.verification,r.occurred_at,r.note,r.recorded_by,r.recorded_at
           FROM external_effect_evidence_receipts r
           JOIN effects e ON e.workspace_id=r.workspace_id AND e.id=r.effect_id
          WHERE r.workspace_id=$1 AND r.effect_id=$2 AND r.snapshot_id=$3
            AND r.authorization_revision=$4 AND r.authorization_hash=$5`,
        [work.workspaceId, effectId, evidence.id,
          approval.authorization_revision, approval.authorization_hash],
      );
      receipt = existing.rows[0];
    }
    if (!receipt) throw new Error('external_effect_evidence_receipt_not_stored');
    return externalEffectEvidenceReceiptSchema.parse({
      ...receipt,
      provider_execution_by_hermes: false,
      occurred_at: new Date(receipt.occurred_at).toISOString(),
      recorded_at: new Date(receipt.recorded_at).toISOString(),
    });
  });
  return c.json(result, 201);
}

export async function executeEffect(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const effectId = pathUuid(c, 'id');

  const row = await inWorkspace(c, async (work) => {
    requireStepUp(work.session);
    const effect = await loadEffect(work.tx, effectId, work.userId);
    if (!effect) throw new RouteError('no such effect', 'unknown_effect', 404);

    if (!(await holdsRole(work.tx, work.workspaceId, work.userId, effect.required_role))) {
      throw new RouteError(
        `executing this needs the ${effect.required_role} role`,
        'role_required',
        403,
      );
    }
    if (effect.status === 'cancelled') {
      throw new RouteError('this effect was cancelled by a later version', 'effect_cancelled', 409);
    }

    // Recorded once. A second press finds the row already `unavailable` and
    // answers with it rather than appending a second identical audit row.
    if (effect.status === 'unavailable') return effect;

    await work.tx.query(
      `UPDATE effects
          SET status = 'unavailable',
              executed_by = $2,
              executed_at = now(),
              enforcement_result = $3::jsonb
        WHERE id = $1`,
      [effectId, work.userId, JSON.stringify(unavailableEnforcement(work.userId))],
    );
    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, request_id, decision_id, effect_id)
       VALUES ($1, 'user', $2, 'effect.executed', $3, $4, $5)`,
      [work.workspaceId, work.userId, effect.request_id, effect.decision_id, effectId],
    );
    work.jobs.push(
      ...(await publishEvents(work.tx, work.workspaceId, [
        {
          kind: 'entity.updated',
          payload: {
            entity_type: 'effect',
            entity_id: effectId,
            ref: { section: 'inbox', view: 'request', id: effect.request_id },
            version: null,
          },
        },
      ])),
    );

    const updated = await loadEffect(work.tx, effectId, work.userId);
    return updated ?? effect;
  });

  return c.json(effectEntitySchema.parse(toEffectEntity(row)));
}
