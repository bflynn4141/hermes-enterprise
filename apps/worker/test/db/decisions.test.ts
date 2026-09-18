// The decision route, against the real database.
//
// The first test is the demo's, ported: four requests decided in all 24 orders,
// the counts read from the views every time, and nothing sent, paid, granted or
// signed in any of them. It is the property the whole product rests on — that
// the Inbox reaches zero however you work through it, because the counts are
// derived rather than decremented — and it is worth 96 round trips to keep.
//
// The rest are the five guards, each refused on its own, and the two-tab race.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decisionResultSchema, requestReviewBinding, type ReviewableRequest } from '@hermes/shared';
import { recordDecision } from '../../src/domain/decisions.js';
import type { TenantWork } from '../../src/routes/tenant.js';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { ageSession, fetchReviewBinding, INBOX_HEADERS, permutations, seedQueue, seedRequest } from './m4-fixtures.js';

/** The renders queue is recorded rather than run: Node has no Cloudflare queue. */
function env() {
  const sent: unknown[] = [];
  const made = makeEnv({ RENDERS_QUEUE: { send: (message: unknown) => void sent.push(message) } } as never);
  return { ...made, sent };
}

const decide = (e: ReturnType<typeof env>, fx: Fixture, requestId: string, decision = 'approve', review: object = {}) =>
  asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
    method: 'POST',
    headers: INBOX_HEADERS,
    body: { decision, ...review },
  });

/** The counts the Inbox badge, the Overview and History read. Views only. */
async function counts(fx: Fixture): Promise<{ inbox: number; decisions: number; grants: number; documents: number }> {
  return readTenant(fx.workspaceId, fx.adminId, async (c) => {
    const { rows } = await c.query<{ inbox: number; decisions: number; grants: number; documents: number }>(
      `SELECT COALESCE((SELECT pending FROM v_inbox_count WHERE workspace_id = $1), 0)     AS inbox,
              COALESCE((SELECT decisions FROM v_decision_count WHERE workspace_id = $1), 0) AS decisions,
              COALESCE((SELECT pending FROM v_pending_grants WHERE workspace_id = $1), 0)  AS grants,
              (SELECT count(*)::int FROM v_created_documents WHERE workspace_id = $1)       AS documents`,
      [fx.workspaceId],
    );
    return rows[0]!;
  });
}

async function expectUnchanged(fx: Fixture, requestId: string): Promise<void> {
  await readTenant(fx.workspaceId, fx.adminId, async (c) => {
    expect((await c.query(`SELECT status FROM requests WHERE id = $1`, [requestId])).rows[0]?.status).toBe('pending');
    for (const table of ['decisions', 'effects', 'documents', 'jobs']) {
      expect((await c.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
    }
    expect((await c.query(`SELECT 1 FROM events WHERE kind = 'decision.recorded'`)).rowCount).toBe(0);
  });
}

describe('all 24 completion orders', () => {
  it(
    'reduces the queue 4 -> 0, records one decision each, and sends, pays and signs nothing',
    async () => {
      const orders = permutations([0, 1, 2, 3]);
      expect(orders).toHaveLength(24);

      for (const order of orders) {
        const fx = await seedWorkspace();
        const queue = await seedQueue(fx);
        const e = env();
        expect((await counts(fx)).inbox).toBe(4);

        for (const [step, index] of order.entries()) {
          const request = queue[index]!;
          const binding = request.kind === 'application' ? {} : await fetchReviewBinding(e.env, fx, request.id);
          const response = await decide(e, fx, request.id, 'approve', binding);
          expect(response.status).toBe(201);
          const body = (await response.json()) as { resulting_status: string; effect_ids: string[] };
          expect(body.resulting_status).toBe(request.expected);

          const after = await counts(fx);
          expect(after.inbox).toBe(3 - step);
          expect(after.decisions).toBe(step + 1);
        }

        const final = await counts(fx);
        expect(final.inbox).toBe(0);
        expect(final.decisions).toBe(4);
        // Two applications admitted -> two access grants nobody has performed.
        expect(final.grants).toBe(2);
        // One invoice created and one agreement drafted -> two saved documents.
        expect(final.documents).toBe(2);

        await readTenant(fx.workspaceId, fx.adminId, async (c) => {
          // Exactly one decision per request, and exactly one audit row each.
          const decisions = await c.query<{ request_id: string }>(`SELECT request_id FROM decisions`);
          expect(decisions.rowCount).toBe(4);
          const events = await c.query(`SELECT 1 FROM events WHERE kind = 'decision.recorded'`);
          expect(events.rowCount).toBe(4);

          // Nothing crossed a boundary. Every effect is still waiting.
          const effects = await c.query<{ status: string; executed_at: Date | null }>(
            `SELECT status, executed_at FROM effects`,
          );
          expect(effects.rows.length).toBeGreaterThan(0);
          for (const effect of effects.rows) {
            expect(effect.status).toBe('pending');
            expect(effect.executed_at).toBeNull();
          }
          const crossed = await c.query(
            `SELECT 1 FROM effects WHERE status IN ('executed', 'assigned') OR executed_by IS NOT NULL`,
          );
          expect(crossed.rowCount).toBe(0);
        });
      }
    },
    300_000,
  );
});

describe('a decision is refused unless every guard passes', () => {
  it.each(['invoice', 'agreement'] as const)('requires the reviewed %s binding before recording a decision', async (kind) => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, kind);
    const e = env();

    const response = await decide(e, fx, requestId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'review_binding_required' });
    expect(await counts(fx)).toEqual({ inbox: 1, decisions: 0, grants: 0, documents: 0 });
    await expectUnchanged(fx, requestId);
    expect(e.sent).toHaveLength(0);
  });

  it('needs an allowlisted Origin', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, 'application');
    const e = env();

    const response = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      headers: INBOX_HEADERS,
      origin: 'https://evil.example',
      body: { decision: 'approve' },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason: string }).reason).toBe('forbidden_origin');
  });

  it('needs an Origin at all, unlike every other state-changing route', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, 'application');
    const e = env();
    const response = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      headers: INBOX_HEADERS,
      origin: null,
      body: { decision: 'approve' },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason: string }).reason).toBe('forbidden_origin');
  });

  it('needs X-Requested-From: inbox', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, 'application');
    const e = env();
    const response = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      body: { decision: 'approve' },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason: string }).reason).toBe('wrong_surface');

    const wrong = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      headers: { 'x-requested-from': 'library' },
      body: { decision: 'approve' },
    });
    expect(wrong.status).toBe(403);
  });

  it('needs a sign-in from the last five minutes', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, 'application');
    const e = env();
    // Touch the session once so the row exists, then age it past the window.
    await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests`);
    await ageSession(fx.adminId, 10);

    const response = await decide(e, fx, requestId);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { reason: string }).reason).toBe('reauth_required');

    const still = await readTenant(fx.workspaceId, fx.adminId, (c) =>
      c.query<{ status: string }>(`SELECT status FROM requests WHERE id = $1`, [requestId]),
    );
    expect(still.rows[0]?.status).toBe('pending');
  });

  it('needs an Admin: a Member is told a decision needs one', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, 'application');
    const e = env();
    const response = await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      headers: INBOX_HEADERS,
      body: { decision: 'approve' },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason: string }).reason).toBe('admin_required');
  });

  it('refuses a decision that is neither approve nor decline', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, 'invoice');
    const e = env();
    for (const decision of ['send', 'pay', 'sign', 'grant', '']) {
      const response = await decide(e, fx, requestId, decision);
      expect(response.status).toBe(422);
      expect(((await response.json()) as { reason: string }).reason).toBe('bad_decision');
    }
  });
});

describe('binding a decision to the reviewed document', () => {
  it.each([
    ['invoice', 'approve', 'created'], ['invoice', 'decline', 'declined'],
    ['agreement', 'approve', 'drafted'], ['agreement', 'decline', 'declined'],
  ] as const)('records a current %s %s decision', async (kind, decision, expectedStatus) => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, kind);
    const e = env();
    const binding = await fetchReviewBinding(e.env, fx, requestId);

    const response = await decide(e, fx, requestId, decision, binding);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ request_id: requestId, resulting_status: expectedStatus });
    expect((await counts(fx)).decisions).toBe(1);
  });

  it.each(['invoice', 'agreement'] as const)('rejects malformed %s bindings without writing anything', async (kind) => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, kind);
    const e = env();
    const binding = await fetchReviewBinding(e.env, fx, requestId);
    const malformed = [
      { expected_version: binding.expected_version },
      { expected_payload_hash: binding.expected_payload_hash },
      { ...binding, expected_version: null },
      { ...binding, expected_version: String(binding.expected_version) },
      { ...binding, expected_version: -1 },
      { ...binding, expected_version: 1.5 },
      { ...binding, expected_version: Number.MAX_SAFE_INTEGER + 1 },
      { ...binding, expected_payload_hash: null },
      { ...binding, expected_payload_hash: 'sha256:1234' },
      { ...binding, expected_payload_hash: `sha256:${'A'.repeat(64)}` },
      { ...binding, expected_payload_hash: { hash: binding.expected_payload_hash } },
    ];
    for (const review of malformed) {
      const response = await decide(e, fx, requestId, 'approve', review);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ reason: 'bad_review_binding' });
    }
    await expectUnchanged(fx, requestId);
    expect(e.sent).toHaveLength(0);
  });

  it.each(['invoice', 'agreement'] as const)('rejects an old %s version even when its payload matches', async (kind) => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, kind);
    const e = env();
    const binding = await fetchReviewBinding(e.env, fx, requestId);

    const response = await decide(e, fx, requestId, 'decline', { ...binding, expected_version: binding.expected_version - 1 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'stale_request' });
    await expectUnchanged(fx, requestId);
  });

  it.each(['invoice', 'agreement'] as const)('rejects a %s payload revised after the reviewer fetched it', async (kind) => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, kind);
    const e = env();
    const binding = await fetchReviewBinding(e.env, fx, requestId);
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(`UPDATE requests SET payload = payload || '{"notes":"Revised after review"}'::jsonb WHERE id = $1`, [requestId]);
      await c.query('COMMIT');
    });

    const response = await decide(e, fx, requestId, 'approve', binding);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'stale_request' });
    await expectUnchanged(fx, requestId);
  });

  it.each(['invoice', 'agreement'] as const)('catches a same-second %s edit under the database row lock', async (kind) => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, kind);

    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      try {
        // now() is constant in one transaction, so both real updates receive
        // exactly the same timestamp without disabling the timestamp trigger.
        await c.query(`UPDATE requests SET payload = payload WHERE id = $1`, [requestId]);
        const before = await c.query<ReviewableRequest>(
          `SELECT id, kind, payload, EXTRACT(EPOCH FROM updated_at)::int AS version FROM requests WHERE id = $1`, [requestId],
        );
        const binding = await requestReviewBinding(before.rows[0]!);
        await c.query(`UPDATE requests SET payload = payload || '{"notes":"Different reviewed terms"}'::jsonb WHERE id = $1`, [requestId]);
        const after = await c.query(`SELECT EXTRACT(EPOCH FROM updated_at)::int AS version FROM requests WHERE id = $1`, [requestId]);
        expect(after.rows[0]?.version).toBe(binding.expected_version);

        const work = { tx: c, session: { sid: 'same-second-test' } } as unknown as TenantWork;
        await expect(recordDecision(work, requestId, 'approve', null, binding))
          .rejects.toMatchObject({ reason: 'stale_request', status: 409 });
        expect((await c.query(`SELECT 1 FROM decisions WHERE request_id = $1`, [requestId])).rowCount).toBe(0);
      } finally {
        await c.query('ROLLBACK');
      }
    });
    await expectUnchanged(fx, requestId);
  });

  it('rejects a binding taken from another invoice', async () => {
    const fx = await seedWorkspace();
    const firstId = await seedRequest(fx, 'invoice');
    const secondId = await seedRequest(fx, 'invoice');
    const e = env();
    const first = await fetchReviewBinding(e.env, fx, firstId);
    const second = await fetchReviewBinding(e.env, fx, secondId);
    const response = await decide(e, fx, secondId, 'approve', { ...first, expected_version: second.expected_version });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'stale_request' });
    await expectUnchanged(fx, secondId);
  });
});

describe('two tabs', () => {
  it.each(['application', 'invoice', 'agreement'] as const)('produce one %s decision, one receipt job, and a conflict for the loser', async (kind) => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, kind);
    const e = env();
    const binding = kind === 'application' ? {} : await fetchReviewBinding(e.env, fx, requestId);

    const [first, second] = await Promise.all([
      decide(e, fx, requestId, 'approve', binding), decide(e, fx, requestId, 'approve', binding),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 201]);

    const created = first.status === 201 ? first : second;
    const conflicted = first.status === 201 ? second : first;
    expect(conflicted.headers.get('x-hermes-conflict')).toBe('true');
    expect(created.headers.get('x-hermes-conflict')).toBe('false');

    const a = (await created.json()) as { decision_id: string };
    const b = (await conflicted.json()) as { decision_id: string };
    // The loser gets the decision that exists, not an error about a race.
    expect(b.decision_id).toBe(a.decision_id);

    await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      expect((await c.query(`SELECT 1 FROM decisions WHERE request_id = $1`, [requestId])).rowCount).toBe(1);
      const receipts = await c.query<{ key: string }>(`SELECT key FROM jobs WHERE kind = 'receipt'`);
      expect(receipts.rowCount).toBe(1);
      expect(receipts.rows[0]?.key).toBe(`receipt:${a.decision_id}`);
    });
  });

  it.each(['invoice', 'agreement'] as const)('returns the recorded %s decision even if a retry binding is absent, malformed or stale', async (kind) => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, kind);
    const e = env();
    const binding = await fetchReviewBinding(e.env, fx, requestId);
    const created = await decide(e, fx, requestId, 'approve', binding);
    expect(created.status).toBe(201);
    const recorded = decisionResultSchema.parse(await created.json());

    for (const review of [{}, { expected_version: null }, { ...binding, expected_version: binding.expected_version - 1 }]) {
      const retry = await decide(e, fx, requestId, 'decline', review);
      expect(retry.status).toBe(200);
      expect(retry.headers.get('x-hermes-conflict')).toBe('true');
      const returned = decisionResultSchema.parse(await retry.json());
      expect({ ...returned, effect_ids: [...returned.effect_ids].sort() })
        .toEqual({ ...recorded, effect_ids: [...recorded.effect_ids].sort() });
    }
    expect((await counts(fx)).decisions).toBe(1);
    expect((await counts(fx)).documents).toBe(1);
    expect(e.sent).toHaveLength(1);
  });

  it('refuses a second decision on a request that is already admitted', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, 'application');
    const e = env();

    expect((await decide(e, fx, requestId, 'approve')).status).toBe(201);
    // The opposite decision on a resolved request is the demo's rule: ignored,
    // and answered with what is already true.
    const opposite = await decide(e, fx, requestId, 'decline');
    expect(opposite.status).toBe(200);
    expect(opposite.headers.get('x-hermes-conflict')).toBe('true');
    expect(((await opposite.json()) as { resulting_status: string }).resulting_status).toBe('admitted');

    await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      expect((await c.query(`SELECT 1 FROM decisions WHERE request_id = $1`, [requestId])).rowCount).toBe(1);
      const request = await c.query<{ status: string }>(`SELECT status FROM requests WHERE id = $1`, [requestId]);
      expect(request.rows[0]?.status).toBe('admitted');
    });
  });
});

describe('the agent role, at the database', () => {
  it('cannot insert a decision, an effect or a job, and cannot move a request', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, 'application');

    await withClient('agent', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fx.workspaceId]);
      await c.query('SELECT set_config($1, $2, true)', ['app.user_id', fx.adminId]);

      await expect(
        c.query(
          `INSERT INTO decisions (workspace_id, request_id, decision, resulting_status, decided_by)
           VALUES ($1, $2, 'approve', 'admitted', $3)`,
          [fx.workspaceId, requestId, fx.adminId],
        ),
      ).rejects.toThrow(/permission denied/i);
      await c.query('ROLLBACK');
    });

    await withClient('agent', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fx.workspaceId]);
      await expect(
        c.query(`UPDATE requests SET status = 'admitted' WHERE id = $1`, [requestId]),
      ).rejects.toThrow(/permission denied/i);
      await c.query('ROLLBACK');
    });

    await withClient('agent', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fx.workspaceId]);
      await expect(
        c.query(`INSERT INTO jobs (workspace_id, kind, key) VALUES ($1, 'receipt', $2)`, [
          fx.workspaceId,
          `receipt:${randomUUID()}`,
        ]),
      ).rejects.toThrow(/permission denied/i);
      await c.query('ROLLBACK');
    });
  });
});
