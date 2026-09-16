// The jobs the Cron has to be able to find, and the publish that must not be
// lost.
//
// The claim itself is covered by `jobs.test.ts`. What is new in M2 is that the
// Cron drains *across* workspaces, which nothing in this system can do with an
// ordinary query: no connection can read two tenants' `jobs` rows, by design.
// The pointer table is how that circle is squared, so it is what these tests
// exercise.
import { describe, expect, it } from 'vitest';
import { seedWorkspace } from './helpers.js';
import { clearFakeWorkOS, makeEnv, readTenant } from './harness.js';
import { drainJobs, publishEvents, runJob, withWorkspaceTransaction } from '../../src/jobs.js';

/**
 * `drainJobs` is cross-tenant by design — that is the whole point of the
 * pointer table these tests exercise — so it also drains whatever another test
 * in this suite left behind, and the hub calls that produces are not this
 * test's. Draining to empty first is what makes the assertions below about
 * *this* test's event rather than about the order the files ran in.
 */
async function drainBacklog(env: Parameters<typeof drainJobs>[0]): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const drained = await drainJobs(env);
    if (drained.claimed === 0) return;
  }
}

describe('the outbox', () => {
  it('writes the event and the job that delivers it in one transaction', async () => {
    const fixture = await seedWorkspace();
    const { env, hubCalls } = makeEnv();
    await drainBacklog(env);
    hubCalls.length = 0;

    const jobIds = await withWorkspaceTransaction(env, fixture.workspaceId, (tx) =>
      publishEvents(tx, fixture.workspaceId, [
        { kind: 'request.created', payload: { request_id: fixture.sessionId } },
      ]),
    );
    expect(jobIds).toHaveLength(1);

    const drained = await drainJobs(env);
    expect(drained.done).toBeGreaterThan(0);

    const published = hubCalls.find((call) => call.method === 'publish');
    expect(published?.namespace).toBe('workspace');
    expect(published?.name).toBe(fixture.workspaceId);
    expect((published?.argument as { kind: string }[])[0]?.kind).toBe('request.created');
  });

  it('sends a session event to that session’s hub, not to the workspace’s', async () => {
    const fixture = await seedWorkspace();
    const { env, hubCalls } = makeEnv();
    await drainBacklog(env);
    hubCalls.length = 0;

    await withWorkspaceTransaction(env, fixture.workspaceId, (tx) =>
      publishEvents(tx, fixture.workspaceId, [
        { kind: 'message.delta', payload: { message_id: fixture.sessionId }, sessionId: fixture.sessionId },
      ]),
    );
    await drainJobs(env);

    const published = hubCalls.filter((call) => call.method === 'publish');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ namespace: 'session', name: fixture.sessionId });
  });

  it('marks a publish job done only once the hub has taken it', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    await withWorkspaceTransaction(env, fixture.workspaceId, (tx) =>
      publishEvents(tx, fixture.workspaceId, [{ kind: 'request.created', payload: {} }]),
    );

    await drainJobs(env);

    const remaining = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
      const { rows } = await c.query<{ count: string }>(
        `SELECT count(*) AS count FROM jobs WHERE workspace_id = $1 AND done_at IS NULL`,
        [fixture.workspaceId],
      );
      return Number(rows[0]?.count ?? '0');
    });
    expect(remaining).toBe(0);
  });
});

describe('the Cron drain', () => {
  it('finds work in two different workspaces, which no tenant query could', async () => {
    const one = await seedWorkspace();
    const two = await seedWorkspace();
    const { env, hubCalls } = makeEnv();

    for (const fixture of [one, two]) {
      await withWorkspaceTransaction(env, fixture.workspaceId, (tx) =>
        publishEvents(tx, fixture.workspaceId, [{ kind: 'request.created', payload: {} }]),
      );
    }

    const drained = await drainJobs(env);

    expect(drained.done).toBeGreaterThanOrEqual(2);
    const names = hubCalls.filter((call) => call.method === 'publish').map((call) => call.name);
    expect(names).toContain(one.workspaceId);
    expect(names).toContain(two.workspaceId);
  });

  it('leaves no pointer behind once the job it points at is done', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    await withWorkspaceTransaction(env, fixture.workspaceId, (tx) =>
      publishEvents(tx, fixture.workspaceId, [{ kind: 'request.created', payload: {} }]),
    );

    await drainJobs(env);

    // `job_ready` is a platform table: no tenant key needed, and none exists
    // for a Cron.
    const pointers = await withWorkspaceTransaction(env, fixture.workspaceId, async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM job_ready WHERE workspace_id = $1`,
        [fixture.workspaceId],
      );
      return Number(rows[0]?.count ?? '0');
    });
    expect(pointers).toBe(0);
  });
});

describe('WorkOS synchronization', () => {
  it('records failure and retries when workos auth has no usable port', async () => {
    clearFakeWorkOS();
    const fixture = await seedWorkspace();
    const { env } = makeEnv({
      ENVIRONMENT: 'production',
      AUTH_MODE: 'workos',
      WORKOS_API_KEY: undefined,
      WORKOS_CLIENT_ID: undefined,
      WORKOS_COOKIE_PASSWORD: undefined,
    });
    const resourceId = crypto.randomUUID();
    const key = `workos:${resourceId}:remove`;
    await withWorkspaceTransaction(env, fixture.workspaceId, (tx) =>
      tx.query(
        `INSERT INTO workos_sync (workspace_id, resource_type, resource_id, direction, payload)
         VALUES ($1, 'membership', $2, 'outbound', $3::jsonb)`,
        [fixture.workspaceId, resourceId, JSON.stringify({ job_key: key })],
      ),
    );

    await expect(
      runJob(env, {
        id: crypto.randomUUID(),
        workspace_id: fixture.workspaceId,
        kind: 'workos_sync',
        key,
        payload: { action: 'deactivate_membership', workos_membership_id: 'om_test' },
        attempts: 1,
      }),
    ).rejects.toThrow(/WorkOS is required/);

    const sync = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
      const result = await c.query<{ status: string; last_error: string | null }>(
        `SELECT status, last_error FROM workos_sync
          WHERE workspace_id = $1 AND payload->>'job_key' = $2`,
        [fixture.workspaceId, key],
      );
      return result.rows[0];
    });
    expect(sync).toEqual({ status: 'failed', last_error: 'workos not configured' });
  });
});
