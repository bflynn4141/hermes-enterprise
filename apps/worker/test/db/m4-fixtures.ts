// The four requests the demo's queue held, as rows in Postgres.
//
// The 24-permutation test is a port of the demo's, and it only means anything
// if the fixtures are the same four shapes: two applications, an invoice and an
// agreement. The payloads are real ones — they parse against the schemas in
// `packages/shared/src/documents.ts` — because the render and the re-version
// route both validate, and a fixture that only looked right would pass the
// decision tests and fail the ones that matter.
import { randomUUID } from 'node:crypto';
import { setTenant, withClient, type Fixture } from './helpers.js';

export const applicationPayload = (name: string, role: string): Record<string, unknown> => ({
  kind: 'application',
  applicant: { name, email: `${name.split(' ')[0]?.toLowerCase()}@example.test` },
  proposed_role: role,
  score: 82,
  score_max: 100,
  criteria: [
    { id: 'track', label: 'Track record', points: 26, points_max: 30, evidence: 'Three shipped programs.', source_ids: ['site'] },
  ],
  sources: [{ id: 'site', name: 'Website', note: 'Checked 2026-09-01' }],
  missing: ['Customer impact'],
});

export const invoicePayload = (number: string): Record<string, unknown> => ({
  kind: 'invoice',
  number,
  currency: 'USD',
  payee: { name: 'Robin Ellis', email: 'robin@example.test' },
  payer: { name: 'Nous Research' },
  issue_date: '2026-09-01',
  due_date: '2026-09-30',
  lines: [{ id: 'l1', label: 'Workshop delivery', qty: 1, amount_minor: 90000, source_ids: [] }],
  total_minor: 90000,
  notes: 'Delivered against the fee schedule.',
});

export const agreementPayload = (number: string): Record<string, unknown> => ({
  kind: 'agreement',
  number,
  version_label: 'v1',
  parties: [{ name: 'Nous Research' }, { name: 'Robin Ellis' }],
  sections: [{ id: 's1', heading: 'Scope', body: 'Two workshops in the 2026 programme.', source_ids: [] }],
});

export interface SeededRequest {
  readonly id: string;
  readonly kind: 'application' | 'invoice' | 'agreement';
  readonly key: string;
  readonly expected: string;
}

/** One pending request, written the way the agent's tool writes one. */
export async function seedRequest(
  fx: Fixture,
  kind: 'application' | 'invoice' | 'agreement',
  options: { label?: string; payload?: Record<string, unknown>; subjectKey?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  const label = options.label ?? (kind === 'application' ? 'Leah Martinez' : kind === 'invoice' ? 'Invoice INV-1' : 'Agreement AGR-1');
  const payload =
    options.payload ??
    (kind === 'application'
      ? applicationPayload(label, 'Delivery partner')
      : kind === 'invoice'
        ? invoicePayload('INV-2026-014')
        : agreementPayload('AGR-2026-004'));

  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    await c.query(
      `INSERT INTO requests (id, workspace_id, kind, subject_key, label, payload, session_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        id,
        fx.workspaceId,
        kind,
        options.subjectKey === undefined ? `key-${label.toLowerCase().replaceAll(' ', '-')}` : options.subjectKey,
        label,
        JSON.stringify(payload),
        fx.sessionId,
      ],
    );
    // The `request.created` audit row the tool writes beside it, so History has
    // something to render that is not a decision.
    await c.query(
      `INSERT INTO events (workspace_id, actor_type, kind, request_id, session_id)
       VALUES ($1, 'agent', 'request.created', $2, $3)`,
      [fx.workspaceId, id, fx.sessionId],
    );
    await c.query('COMMIT');
  });
  return id;
}

/** The demo's queue: Leah, Owen, the invoice and the agreement. */
export async function seedQueue(fx: Fixture): Promise<SeededRequest[]> {
  const leah = await seedRequest(fx, 'application', {
    label: 'Leah Martinez',
    payload: applicationPayload('Leah Martinez', 'Delivery partner'),
  });
  const owen = await seedRequest(fx, 'application', {
    label: 'Owen Blake',
    payload: applicationPayload('Owen Blake', 'Delivery partner'),
  });
  const invoice = await seedRequest(fx, 'invoice', { label: 'Invoice INV-2026-014' });
  const agreement = await seedRequest(fx, 'agreement', { label: 'Agreement AGR-2026-004' });

  return [
    { id: leah, kind: 'application', key: 'leah', expected: 'admitted' },
    { id: owen, kind: 'application', key: 'owen', expected: 'admitted' },
    { id: invoice, kind: 'invoice', key: 'invoice', expected: 'created' },
    { id: agreement, kind: 'agreement', key: 'agreement', expected: 'drafted' },
  ];
}

/** Every ordering of four items: the 24 the demo's test enumerated. */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]),
  );
}

/** Make the caller's `sid` look older than the step-up window. */
export async function ageSession(userId: string, minutes: number): Promise<void> {
  await withClient('owner', async (c) => {
    await c.query(
      `UPDATE auth_sessions SET authenticated_at = now() - ($2 || ' minutes')::interval WHERE sid = $1`,
      [`dev-${userId}`, String(minutes)],
    );
  });
}

/** The headers a decision needs beyond the session: the surface it came from. */
export const INBOX_HEADERS = { 'x-requested-from': 'inbox' };
