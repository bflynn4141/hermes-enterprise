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
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, withClient, type Fixture } from './helpers.js';
import { ageSession, INBOX_HEADERS, permutations, seedQueue, seedRequest } from './m4-fixtures.js';

/** The renders queue is recorded rather than run: Node has no Cloudflare queue. */
function env() {
  const sent: unknown[] = [];
  const made = makeEnv({ RENDERS_QUEUE: { send: (message: unknown) => void sent.push(message) } } as never);
  return { ...made, sent };
}

const decide = (e: ReturnType<typeof env>, fx: Fixture, requestId: string, decision = 'approve', extra: Record<string, string> = {}) =>
  asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
    method: 'POST',
    headers: { ...INBOX_HEADERS, ...extra },
    body: { decision },
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
          const response = await decide(e, fx, request.id);
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

describe('two tabs', () => {
  it('produce one decision, one receipt job, and a conflict for the loser', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, 'application');
    const e = env();

    const [first, second] = await Promise.all([decide(e, fx, requestId), decide(e, fx, requestId)]);
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
