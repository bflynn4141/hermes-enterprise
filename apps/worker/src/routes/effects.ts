// The effects ledger.
//
//   GET  /w/:ws/effects?status=      what a decision implied and nobody has done
//   POST /w/:ws/effects/:id/execute  answers `unavailable`, or `simulated`
//                                    outside production
//
// The execute route is the most important honest surface in the product, so it
// is worth being explicit about what it is:
//
// Outside production, `EFFECT_EXECUTOR_MODE=simulated` makes it answer with an
// invented outcome under its own status, `simulated`. The row then carries a
// synthetic reference and timeline so the demo reads to the end, and the
// status word keeps every reader honest: `executed` is still never written.
// `effectExecutorMode` ignores the variable under `production`.
//
// There is no executor for these legacy ledger rows. Approved communications
// can use the separate governed Gmail outbox when configured, but recording an
// attempt on a legacy effect does not enqueue that outbox or prove delivery.
// POST …/execute always answers unavailable: it writes `status = 'unavailable'`
// with the reason, appends an `effect.executed` audit row (attempt recorded),
// and states which work remains undone. It never claims bank, mail, access, or
// signature work completed.
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
  effectEntitySchema,
  paginatedSchema,
  EFFECT_STATUSES,
} from '@hermes/shared';
import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { inWorkspace, pathUuid, RouteError } from './tenant.js';
import { effectRows, loadEffect, toEffectEntity } from '../domain/effect-rows.js';
import {
  effectExecutorMode,
  simulateEffect,
  simulatedEnforcement,
  unavailableEnforcement,
  type SimulationContext,
} from '../domain/effects.js';
import type { EffectKind } from '@hermes/shared';
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

    // Recorded once. A second press finds the row already answered and
    // returns it rather than appending a second identical audit row.
    if (effect.status === 'unavailable' || effect.status === 'simulated') return effect;

    const mode = effectExecutorMode(c.env);
    const enforcement =
      mode === 'simulated'
        ? simulatedEnforcement(
            work.userId,
            simulateEffect(effect.kind as EffectKind, await simulationContext(work.tx, effect.request_id)),
          )
        : unavailableEnforcement(work.userId);

    await work.tx.query(
      `UPDATE effects
          SET status = $4,
              executed_by = $2,
              executed_at = now(),
              enforcement_result = $3::jsonb
        WHERE id = $1`,
      [effectId, work.userId, JSON.stringify(enforcement), enforcement.result],
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

/**
 * The few request facts a simulation may echo. Read inside the tenant
 * transaction, so RLS applies; anything missing is simply omitted from the copy.
 */
async function simulationContext(tx: Tx, requestId: string): Promise<SimulationContext> {
  const { rows } = await tx.query<{ label: string | null; payload: Record<string, unknown> | null }>(
    `SELECT label, payload FROM requests WHERE id = $1`,
    [requestId],
  );
  const payload = rows[0]?.payload ?? {};
  const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null);
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const applicant = record(payload['applicant']);
  const parties = Array.isArray(payload['parties'])
    ? (payload['parties'] as unknown[]).map((party) => str(record(party)['name'])).filter((name): name is string => name !== null)
    : [];
  // An agreement's counterparty is the last named party; the first is us.
  const counterparty = parties.length > 1 ? parties[parties.length - 1] ?? null : null;
  return {
    subjectName: str(payload['name']) ?? str(applicant['name']) ?? str(payload['email']) ?? str(applicant['email']) ?? counterparty ?? rows[0]?.label ?? null,
    payeeName: str(record(payload['payee'])['name']),
    currency: str(payload['currency']),
    totalMinor: typeof payload['total_minor'] === 'number' ? (payload['total_minor'] as number) : null,
    documentNumber: str(payload['number']),
    parties,
  };
}
