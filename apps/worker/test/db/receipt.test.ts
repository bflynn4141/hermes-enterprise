// The receipt: two lines in the conversation the request came from.
//
// Three things are worth a test here, and they are the three ways a background
// job that writes into a chat goes wrong: it writes into the wrong session, it
// writes twice, or it writes a number that was true a minute ago.
import { describe, expect, it } from 'vitest';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, withClient } from './helpers.js';
import { fetchReviewBinding, INBOX_HEADERS, seedQueue, seedRequest } from './m4-fixtures.js';
import { claimJob, drainJobs, withWorkspaceTransaction } from '../../src/jobs.js';
import { runReceiptJob } from '../../src/runs/receipt.js';
import { randomUUID } from 'node:crypto';

function env(hub?: { publish: (events: unknown) => unknown }) {
  const made = makeEnv({ RENDERS_QUEUE: { send: () => undefined } } as never);
  if (hub) {
    const namespace = { idFromName: (name: string) => ({ name }), get: () => hub };
    return makeEnv({ RENDERS_QUEUE: { send: () => undefined }, SESSION_HUB: namespace, WORKSPACE_HUB: namespace } as never);
  }
  return made;
}

const messages = (workspaceId: string, userId: string, sessionId: string) =>
  readTenant(workspaceId, userId, async (c) => {
    const { rows } = await c.query<{ role: string; text: string; kind: string; client_id: string; seq: number }>(
      `SELECT role, text, kind, client_id, seq FROM messages WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    );
    return rows;
  });

describe('the receipt job', () => {
  it('posts two lines into the originating session, not the active one', async () => {
    const fx = await seedWorkspace();
    const e = env();

    // A second session, more recently active, which the receipt must ignore.
    const otherSession = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fx.workspaceId]);
      await c.query(
        `INSERT INTO sessions (id, workspace_id, owner_id, title, model_id, last_activity_at)
         VALUES ($1, $2, $3, 'Somewhere else', 'deepseek-flash', now() + interval '1 hour')`,
        [otherSession, fx.workspaceId, fx.adminId],
      );
      await c.query('COMMIT');
    });

    const queue = await seedQueue(fx);
    const leah = queue[0]!;
    const response = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${leah.id}/decisions`, {
      method: 'POST',
      headers: INBOX_HEADERS,
      body: { decision: 'approve' },
    });
    expect(response.status).toBe(201);

    expect(await messages(fx.workspaceId, fx.adminId, otherSession)).toHaveLength(0);

    const rows = await messages(fx.workspaceId, fx.adminId, fx.sessionId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ role: 'human', kind: 'receipt' });
    expect(rows[0]?.text).toBe('Maya Chen admitted Leah in Inbox');
    expect(rows[1]).toMatchObject({ role: 'iris', kind: 'receipt' });
    // Derived from `v_inbox_count` at write time: three of the four are left.
    expect(rows[1]?.text).toBe('Leah is admitted. Access is pending. Three requests remain.');
  });

  it('writes nothing the second time, however the job is replayed', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'application', { label: 'Leah Martinez' });

    const response = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      headers: INBOX_HEADERS,
      body: { decision: 'approve' },
    });
    const { decision_id: decisionId } = (await response.json()) as { decision_id: string };

    const before = await messages(fx.workspaceId, fx.adminId, fx.sessionId);
    expect(before).toHaveLength(2);

    // The Cron's path: the row is claimed again and the runner runs again. The
    // `client_id` unique index is what makes the second run a no-op, and the
    // sequence numbers must not move either.
    const job = await withWorkspaceTransaction(e.env, fx.workspaceId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE jobs SET done_at = NULL, locked_until = NULL WHERE kind = 'receipt' AND key = $1 RETURNING id`,
        [`receipt:${decisionId}`],
      );
      return rows[0]!;
    });
    const claimed = await withWorkspaceTransaction(e.env, fx.workspaceId, (tx) => claimJob(tx, job.id));
    expect(claimed).not.toBeNull();
    await runReceiptJob(e.env, claimed!);

    const after = await messages(fx.workspaceId, fx.adminId, fx.sessionId);
    expect(after).toEqual(before);
  });

  it('says "No requests remain." when it was the last one', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'invoice');
    await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      headers: INBOX_HEADERS,
      body: { decision: 'approve', ...await fetchReviewBinding(e.env, fx, requestId) },
    });
    const rows = await messages(fx.workspaceId, fx.adminId, fx.sessionId);
    expect(rows[1]?.text).toBe(
      'Invoice INV-2026-014 is created in Library. Not sent. No money moved. No requests remain.',
    );
  });

  it('names what did not happen when the decision was a decline', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'application', { label: 'Owen Blake' });
    await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      headers: INBOX_HEADERS,
      body: { decision: 'decline' },
    });
    const rows = await messages(fx.workspaceId, fx.adminId, fx.sessionId);
    expect(rows[0]?.text).toBe('Maya Chen declined Owen in Inbox');
    expect(rows[1]?.text).toContain('No message was sent.');

    // A decline records no effect at all: there is nothing for anyone to do.
    const effects = await readTenant(fx.workspaceId, fx.adminId, (c) =>
      c.query(`SELECT 1 FROM effects WHERE request_id = $1`, [requestId]),
    );
    expect(effects.rowCount).toBe(0);
  });
});

describe('a dropped publish', () => {
  it('does not change the counts, and the Cron drain delivers it later', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, 'application', { label: 'Leah Martinez' });

    // A hub that refuses everything: the fan-out fails, the commit does not.
    const broken = env({
      publish: () => {
        throw new Error('hub unreachable');
      },
    });
    const response = await asUser(broken.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      headers: INBOX_HEADERS,
      body: { decision: 'approve' },
    });
    expect(response.status).toBe(201);

    // The decision is durable and the views agree, because the counts are
    // derived from the rows rather than from anything the hub was told.
    const counts = await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      const { rows } = await c.query<{ inbox: number; decisions: number; grants: number }>(
        `SELECT COALESCE((SELECT pending FROM v_inbox_count WHERE workspace_id = $1), 0)      AS inbox,
                COALESCE((SELECT decisions FROM v_decision_count WHERE workspace_id = $1), 0) AS decisions,
                COALESCE((SELECT pending FROM v_pending_grants WHERE workspace_id = $1), 0)   AS grants`,
        [fx.workspaceId],
      );
      return rows[0]!;
    });
    expect(counts).toMatchObject({ inbox: 0, decisions: 1, grants: 1 });

    const undone = await readTenant(fx.workspaceId, fx.adminId, (c) =>
      c.query(`SELECT 1 FROM jobs WHERE kind = 'publish' AND done_at IS NULL`),
    );
    expect(undone.rowCount).toBeGreaterThan(0);

    // The minute Cron, with a hub that answers. `job_ready` is the only
    // cross-tenant question in the system, and this is what it is for.
    const working = env();
    // Both halves: `jobs.next_at` is the claim predicate and `job_ready.next_at`
    // is what the Cron reads to find the workspace at all.
    await withWorkspaceTransaction(working.env, fx.workspaceId, async (tx) => {
      await tx.query(`UPDATE jobs SET next_at = now(), locked_until = NULL WHERE done_at IS NULL`);
      await tx.query(
        `UPDATE job_ready SET next_at = now() WHERE workspace_id = $1`,
        [fx.workspaceId],
      );
    });
    // `job_ready` is global and this database is shared with every other test
    // file, so the drain is run until this workspace's rows are done rather
    // than once: what is being asserted is that the Cron gets to them, not how
    // many other tenants' rows it walked past first.
    let stillUndone = 1;
    for (let attempt = 0; attempt < 10 && stillUndone > 0; attempt += 1) {
      await drainJobs(working.env, 500);
      const { rowCount } = await readTenant(fx.workspaceId, fx.adminId, (c) =>
        c.query(`SELECT 1 FROM jobs WHERE kind = 'publish' AND done_at IS NULL`),
      );
      stillUndone = rowCount ?? 0;
    }
    expect(stillUndone).toBe(0);
    expect(working.hubCalls.length).toBeGreaterThan(0);
  });
});
