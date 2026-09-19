// The effects ledger.
//
//   GET  /w/:ws/effects?status=      what a decision implied and nobody has done
//   POST /w/:ws/effects/:id/execute  answers `unavailable`, every time
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
import { effectEntitySchema, paginatedSchema, EFFECT_STATUSES } from '@hermes/shared';
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
async function holdsRole(
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
