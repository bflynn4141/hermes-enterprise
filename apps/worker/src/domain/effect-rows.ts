// Reading the effects ledger.
//
// One query shape serves the ledger screen, a request's review pane and the
// execute route, because they differ only in their filter. The shaping is here
// rather than in the route for the same reason `requests.ts` shapes there: the
// client parses with a `.strict()` schema, so exactly these fields exist and
// exactly one place decides what goes in them.
//
// `reason` is the honest column. An effect that has never been executed carries
// the sentence explaining what it is waiting for; one somebody pressed Execute
// on carries the sentence explaining that nothing happened. Neither is an error
// string: both are the product telling the truth about a boundary it does not
// cross.
import type { EffectKind } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { EFFECT_LABELS, EFFECT_UNAVAILABLE_REASON } from './effects.js';

export interface EffectRow {
  id: string;
  request_id: string;
  decision_id: string;
  kind: string;
  status: string;
  required_role: string;
  approvals_required: number;
  assignee_id: string | null;
  assignee_name: string | null;
  cancelled_reason: string | null;
  created_at: Date;
}

const SELECT = `
  SELECT e.id, e.request_id, e.decision_id, e.kind, e.status, e.required_role,
         e.approvals_required, e.assignee_id, u.name AS assignee_name,
         e.cancelled_reason, e.created_at
    FROM effects e
    LEFT JOIN users u ON u.id = e.assignee_id`;

export interface EffectFilter {
  readonly requestId?: string;
  readonly status?: readonly string[];
  readonly limit?: number;
}

export async function effectRows(tx: Tx, filter: EffectFilter = {}): Promise<EffectRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.requestId) {
    values.push(filter.requestId);
    where.push(`e.request_id = $${values.length}`);
  }
  if (filter.status && filter.status.length > 0) {
    values.push([...filter.status]);
    where.push(`e.status = ANY ($${values.length}::text[])`);
  }
  values.push(Math.min(200, filter.limit ?? 100));

  const { rows } = await tx.query<EffectRow>(
    `${SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $${values.length}`,
    values,
  );
  return rows;
}

export async function loadEffect(tx: Tx, effectId: string): Promise<EffectRow | null> {
  const { rows } = await tx.query<EffectRow>(`${SELECT} WHERE e.id = $1`, [effectId]);
  return rows[0] ?? null;
}

/** The sentence under an effect's label: what it is waiting for, or what happened. */
export function effectReason(row: Pick<EffectRow, 'status' | 'required_role' | 'assignee_name' | 'cancelled_reason'>): string {
  switch (row.status) {
    case 'cancelled':
      return row.cancelled_reason ?? 'Cancelled by a later version';
    case 'unavailable':
    case 'failed':
    case 'executed':
      return EFFECT_UNAVAILABLE_REASON;
    case 'assigned':
    case 'pending':
    default:
      return row.assignee_name
        ? `Waiting on ${row.assignee_name} · ${row.required_role} · Nothing executed`
        : `Waiting on a ${row.required_role} reviewer · Nothing executed`;
  }
}

export function toEffectEntity(row: EffectRow): Record<string, unknown> {
  return {
    id: row.id,
    request_id: row.request_id,
    kind: row.kind,
    status: row.status,
    required_role: row.required_role.slice(0, 32),
    label: (EFFECT_LABELS[row.kind as EffectKind] ?? 'Effect').slice(0, 200),
    reason: effectReason(row).slice(0, 200),
  };
}
