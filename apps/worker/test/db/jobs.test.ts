// Jobs, and the claim that makes a receipt arrive exactly once.
//
// The committing request runs its own job immediately and the minute Cron
// retries whatever is still undone, so the two of them race on every job. The
// claim has to be the arbiter, and the test has to actually race.
import { describe, expect, it } from 'vitest';
import { claimJob, claimNextJob, enqueueJob, failJob, finishJob } from '../../src/jobs.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';

describe('the jobs table', () => {
  it('lets exactly one of two concurrent claimers win', async () => {
    const fx = await seedWorkspace();

    const jobId = await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await enqueueJob(c, fx.workspaceId, 'receipt', `decision:${fx.sessionId}`, { session_id: fx.sessionId });
      const { rows } = await c.query<{ id: string }>('SELECT id FROM jobs WHERE kind = $1 AND key = $2', [
        'receipt',
        `decision:${fx.sessionId}`,
      ]);
      await c.query('COMMIT');
      return rows[0]!.id;
    });

    const claim = (): Promise<unknown> =>
      withClient('app', async (c) => {
        await c.query('BEGIN');
        await setTenant(c, fx.workspaceId, fx.adminId);
        const job = await claimJob(c, jobId);
        await c.query('COMMIT');
        return job;
      });

    const [first, second] = await Promise.all([claim(), claim()]);
    const winners = [first, second].filter((job) => job !== null);
    expect(winners).toHaveLength(1);
  });

  it('makes a duplicate enqueue a no-op, so two tabs produce one receipt', async () => {
    const fx = await seedWorkspace();
    const key = `decision:${fx.workspaceId}`;
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await enqueueJob(c, fx.workspaceId, 'receipt', key);
      await enqueueJob(c, fx.workspaceId, 'receipt', key);
      const { rows } = await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM jobs WHERE kind = 'receipt' AND key = $1`,
        [key],
      );
      expect(rows[0]!.count).toBe('1');
      await c.query('COMMIT');
    });
  });

  it('treats UNIQUE(kind, key) as global, which is why keys carry an id', async () => {
    // This is a trap worth pinning down. The uniqueness is not per workspace,
    // so a key like 'decision:latest' would let one workspace's enqueue
    // silently suppress another's — and the second workspace could not even see
    // the row that blocked it, because row-level security hides it. Every key
    // the product writes therefore contains a uuid.
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    const sharedKey = `receipt-collision-${a.workspaceId}`;

    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, a.workspaceId, a.adminId);
      await enqueueJob(c, a.workspaceId, 'receipt', sharedKey);
      await c.query('COMMIT');
    });

    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, b.workspaceId, b.adminId);
      await enqueueJob(c, b.workspaceId, 'receipt', sharedKey);
      const { rows } = await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM jobs WHERE kind = 'receipt' AND key = $1`,
        [sharedKey],
      );
      // Zero, not one: the insert was suppressed by a row this tenant cannot see.
      expect(rows[0]!.count).toBe('0');
      await c.query('COMMIT');
    });
  });

  it('does not hand out a finished job again', async () => {
    const fx = await seedWorkspace();
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await enqueueJob(c, fx.workspaceId, 'publish', `stream:${fx.workspaceId}:1:9`);
      const claimed = await claimNextJob(c);
      expect(claimed?.kind).toBe('publish');
      await finishJob(c, claimed!.id);
      expect(await claimJob(c, claimed!.id)).toBeNull();
      await c.query('COMMIT');
    });
  });

  it('releases a failed job for a later attempt, with backoff', async () => {
    const fx = await seedWorkspace();
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await enqueueJob(c, fx.workspaceId, 'render', `document:${fx.sessionId}`);
      const claimed = await claimNextJob(c);
      await failJob(c, claimed!.id, 'renderer unavailable', claimed!.attempts);

      const { rows } = await c.query<{ locked_until: string | null; future: boolean; last_error: string }>(
        `SELECT locked_until, next_at > now() AS future, last_error FROM jobs WHERE id = $1`,
        [claimed!.id],
      );
      expect(rows[0]!.locked_until).toBeNull();
      expect(rows[0]!.future).toBe(true);
      expect(rows[0]!.last_error).toBe('renderer unavailable');
      await c.query('COMMIT');
    });
  });

  it('keeps jobs out of the reach of the agent role entirely', async () => {
    const fx = await seedWorkspace();
    await withClient('agent', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      // A job is how a side effect leaves the system. The run engine writing
      // one would be the run engine sending an email.
      await expect(c.query('SELECT id FROM jobs')).rejects.toThrow(/permission denied/i);
      await c.query('ROLLBACK');
    });
  });
});
