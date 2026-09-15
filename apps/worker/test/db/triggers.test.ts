// The rules a grant cannot express.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seedPendingRequest, seedWorkspace, setTenant, withClient } from './helpers.js';

describe('the outbox kind guard', () => {
  it('lets the agent role publish message.* and run.*', async () => {
    const fx = await seedWorkspace();
    await withClient('agent', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      for (const kind of ['message.delta', 'message.final', 'run.step', 'run.status']) {
        await c.query(
          `INSERT INTO stream_events (workspace_id, session_id, kind, payload) VALUES ($1, $2, $3, '{}'::jsonb)`,
          [fx.workspaceId, fx.sessionId, kind],
        );
      }
      await c.query('COMMIT');
    });
  });

  it('refuses a forged decision.recorded from the agent role', async () => {
    const fx = await seedWorkspace();
    await withClient('agent', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      // Without this, a run could make every client render a receipt for a
      // decision nobody made: the client believes the outbox.
      await expect(
        c.query(`INSERT INTO stream_events (workspace_id, kind, payload) VALUES ($1, 'decision.recorded', '{}'::jsonb)`, [
          fx.workspaceId,
        ]),
      ).rejects.toThrow(/the agent role may publish/);
      await c.query('ROLLBACK');
    });
  });

  it('lets the app role publish a decision.recorded', async () => {
    const fx = await seedWorkspace();
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(`INSERT INTO stream_events (workspace_id, kind, payload) VALUES ($1, 'decision.recorded', '{}'::jsonb)`, [
        fx.workspaceId,
      ]);
      await c.query('COMMIT');
    });
  });
});

describe('append-only audit', () => {
  it('refuses UPDATE and DELETE on events, even as the owner', async () => {
    const fx = await seedWorkspace();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind)
         VALUES ($1, 'user', $2, 'settings.changed') RETURNING id`,
        [fx.workspaceId, fx.adminId],
      );
      const id = rows[0]!.id;
      await c.query('COMMIT');

      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await expect(c.query(`UPDATE events SET kind = 'member.removed' WHERE id = $1`, [id])).rejects.toThrow(
        /append-only/,
      );
      await c.query('ROLLBACK');

      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await expect(c.query('DELETE FROM events WHERE id = $1', [id])).rejects.toThrow(/append-only/);
      await c.query('ROLLBACK');
    });
  });
});

describe('a tool may version a document only while the request is pending', () => {
  it('accepts an agent-written document for a pending request', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedPendingRequest(fx, 'invoice');
    await withClient('agent', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO documents (workspace_id, request_id, kind, payload) VALUES ($1, $2, 'invoice', '{}'::jsonb)`,
        [fx.workspaceId, requestId],
      );
      await c.query('COMMIT');
    });
  });

  it('refuses one after the request has been decided', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedPendingRequest(fx, 'invoice');

    // The human decides. From here the approved content is fixed: a new version
    // would mean a signature or a payment applying to text nobody approved.
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO decisions (workspace_id, request_id, decision, resulting_status, decided_by)
         VALUES ($1, $2, 'approve', 'created', $3)`,
        [fx.workspaceId, requestId, fx.adminId],
      );
      await c.query(`UPDATE requests SET status = 'created' WHERE id = $1`, [requestId]);
      await c.query('COMMIT');
    });

    await withClient('agent', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
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

describe('a workspace keeps one Admin', () => {
  it('refuses to demote or remove the last Admin', async () => {
    const fx = await seedWorkspace();
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      // Two Admins: demoting one is fine.
      await c.query(`UPDATE members SET role = 'admin' WHERE user_id = $1`, [fx.memberId]);
      await c.query(`UPDATE members SET role = 'member' WHERE user_id = $1`, [fx.adminId]);
      // Now there is one left, and it may not go.
      await expect(c.query(`UPDATE members SET role = 'member' WHERE user_id = $1`, [fx.memberId])).rejects.toThrow(
        /at least one active Admin/,
      );
      await c.query('ROLLBACK');
    });

    // The `app` role has no DELETE on members at all: removal is a status
    // change, so History keeps rendering. The trigger still covers DELETE,
    // which the owner (a migration, a WorkOS reconciliation) could attempt.
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await expect(c.query('DELETE FROM members WHERE user_id = $1', [fx.adminId])).rejects.toThrow(
        /permission denied/i,
      );
      await c.query('ROLLBACK');
    });

    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await expect(c.query('DELETE FROM members WHERE user_id = $1', [fx.adminId])).rejects.toThrow(
        /at least one active Admin/,
      );
      await c.query('ROLLBACK');
    });
  });
});

describe('erasure', () => {
  it('tombstones the subject and leaves an audit row behind', async () => {
    const fx = await seedWorkspace();
    const subjectId = randomUUID();
    const requestId = randomUUID();

    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO requests (id, workspace_id, kind, subject_id, subject_key, label, payload)
         VALUES ($1, $2, 'application', $3, 'leah@example.test', 'Leah Martinez',
                 '{"kind":"application","applicant":{"name":"Leah Martinez"}}'::jsonb)`,
        [requestId, fx.workspaceId, subjectId],
      );
      await c.query(
        `INSERT INTO request_notes (workspace_id, request_id, body) VALUES ($1, $2, 'Leah described two deployments')`,
        [fx.workspaceId, requestId],
      );
      await c.query('COMMIT');
    });

    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const { rows } = await c.query<{ redact_subject: number }>('SELECT redact_subject($1, $2)', [
        subjectId,
        fx.workspaceId,
      ]);
      expect(rows[0]!.redact_subject).toBeGreaterThan(0);

      const request = await c.query<{ label: string; payload: { redacted?: boolean } }>(
        'SELECT label, payload FROM requests WHERE id = $1',
        [requestId],
      );
      expect(request.rows[0]?.label).toBe('Deleted applicant');
      expect(request.rows[0]?.payload.redacted).toBe(true);

      const note = await c.query<{ body: string }>('SELECT body FROM request_notes WHERE request_id = $1', [requestId]);
      expect(note.rows[0]?.body).toBe('[redacted]');

      // History still renders: the audit row survives, holding ids only.
      const audit = await c.query('SELECT id FROM events WHERE kind = $1 AND subject_id = $2', [
        'subject.redacted',
        subjectId,
      ]);
      expect(audit.rowCount).toBe(1);
      await c.query('COMMIT');
    });
  });
});
