// The effects ledger, the honest execute route, and the guarded re-version.
import { describe, expect, it } from 'vitest';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, withClient, type Fixture } from './helpers.js';
import { fetchReviewBinding, INBOX_HEADERS, invoicePayload, seedRequest } from './m4-fixtures.js';

function env() {
  const sent: { workspace_id: string; document_id: string; version: number }[] = [];
  const made = makeEnv({
    RENDERS_QUEUE: { send: (message: never) => void sent.push(message) },
  } as never);
  return { ...made, sent };
}

async function approve(e: ReturnType<typeof env>, fx: Fixture, requestId: string): Promise<string[]> {
  const response = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
    method: 'POST',
    headers: INBOX_HEADERS,
    body: { decision: 'approve', ...await fetchReviewBinding(e.env, fx, requestId) },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { effect_ids: string[] }).effect_ids;
}

describe('what a decision records', () => {
  it('an admission records one access grant, still pending, and nothing else', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'application');
    const effectIds = await approve(e, fx, requestId);
    expect(effectIds).toHaveLength(1);

    const list = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/effects`);
    const body = (await list.json()) as { items: { kind: string; status: string; required_role: string; reason: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ kind: 'access_grant', status: 'pending', required_role: 'access' });
    expect(body.items[0]?.reason).toContain('Nothing executed');
  });

  it('an approved invoice records a send and a payment; an agreement a signature and a send', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const invoice = await seedRequest(fx, 'invoice');
    const agreement = await seedRequest(fx, 'agreement');

    expect(await approve(e, fx, invoice)).toHaveLength(2);
    expect(await approve(e, fx, agreement)).toHaveLength(2);

    const rows = await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      const { rows } = await c.query<{ kind: string; approvals_required: number; required_role: string }>(
        `SELECT kind, approvals_required, required_role FROM effects ORDER BY kind`,
      );
      return rows;
    });
    expect(rows.map((r) => r.kind)).toEqual(['email_send', 'email_send', 'payment', 'signature']);
    // A payment needs two people, from the shared contract's requirements table.
    expect(rows.find((r) => r.kind === 'payment')).toMatchObject({ approvals_required: 2, required_role: 'finance' });
  });
});

describe('executing an effect', () => {
  it('answers unavailable, in words, and records the attempt', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'application');
    const [effectId] = await approve(e, fx, requestId);

    const response = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/effects/${effectId}/execute`, {
      method: 'POST',
      body: {},
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; reason: string };
    expect(body.status).toBe('unavailable');
    expect(body.reason).toMatch(/legacy effect has no configured executor/);

    await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      const { rows } = await c.query<{ status: string; executed_by: string; enforcement_result: { result: string } }>(
        `SELECT status, executed_by, enforcement_result FROM effects WHERE id = $1`,
        [effectId],
      );
      expect(rows[0]?.status).toBe('unavailable');
      expect(rows[0]?.executed_by).toBe(fx.adminId);
      expect(rows[0]?.enforcement_result.result).toBe('unavailable');

      // Nothing anywhere in the database claims something was executed.
      const executed = await c.query(`SELECT 1 FROM effects WHERE status = 'executed'`);
      expect(executed.rowCount).toBe(0);
    });
  });

  it('refuses somebody who does not hold the role the effect needs', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'application');
    const [effectId] = await approve(e, fx, requestId);

    // The seeded Member holds no reviewer roles at all.
    const response = await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/effects/${effectId}/execute`, {
      method: 'POST',
      body: {},
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason: string }).reason).toBe('role_required');
  });
});

describe('a new document version after the decision', () => {
  it('cancels the pending effects and enqueues a re-render', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'invoice');
    const effectIds = await approve(e, fx, requestId);
    expect(effectIds).toHaveLength(2);
    expect(e.sent).toHaveLength(1);

    const documentId = await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM documents WHERE request_id = $1`, [requestId]);
      return rows[0]!.id;
    });

    const revised = invoicePayload('INV-2026-014');
    (revised as { notes: string }).notes = 'Corrected after the delivery statement was re-read.';

    const response = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/documents/${documentId}/versions`, {
      method: 'POST',
      body: { payload: revised },
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; version: number };
    expect(created.version).toBe(2);

    await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      const effects = await c.query<{ status: string; cancelled_reason: string }>(
        `SELECT status, cancelled_reason FROM effects WHERE request_id = $1`,
        [requestId],
      );
      expect(effects.rows.every((row) => row.status === 'cancelled')).toBe(true);
      expect(effects.rows[0]?.cancelled_reason).toMatch(/approver has not read/);

      const cancelledEvents = await c.query(`SELECT 1 FROM events WHERE kind = 'effect.cancelled'`);
      expect(cancelledEvents.rowCount).toBe(2);
      const versioned = await c.query(`SELECT 1 FROM events WHERE kind = 'document.versioned'`);
      expect(versioned.rowCount).toBe(1);
    });

    // The re-render was queued, for the new version and not the old one.
    expect(e.sent).toHaveLength(2);
    expect(e.sent[1]).toMatchObject({ document_id: created.id, version: 2 });
  });

  it('needs an Admin and a recent sign-in', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'invoice');
    await approve(e, fx, requestId);
    const documentId = await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM documents WHERE request_id = $1`, [requestId]);
      return rows[0]!.id;
    });

    const response = await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/documents/${documentId}/versions`, {
      method: 'POST',
      body: { payload: invoicePayload('INV-2026-014') },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason: string }).reason).toBe('admin_required');
  });

  it('cannot be done by a tool: the agent role is refused by the database', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'invoice');
    await approve(e, fx, requestId);

    // The trigger in migration 0005: a tool may write a document version only
    // while the request is still pending. It is `created` now.
    await withClient('agent', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fx.workspaceId]);
      await expect(
        c.query(
          `INSERT INTO documents (workspace_id, request_id, kind, version, payload)
           VALUES ($1, $2, 'invoice', 2, '{}'::jsonb)`,
          [fx.workspaceId, requestId],
        ),
      ).rejects.toThrow(/only while the request is pending/);
      await c.query('ROLLBACK');
    });
  });
});
