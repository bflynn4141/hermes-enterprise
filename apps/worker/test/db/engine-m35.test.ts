// M3.5, against the real database: the three things that are only true if the
// SQL is right.
//
//   * `runs.mode` is written at turn creation, so a person changing the mode
//     selector mid-run cannot change what the run in flight may do.
//   * Guidance typed after a run has finished is kept and carried: the route
//     answers "Applied to your next message" and parks the row with no run id,
//     and `PgAgentDb.loadGuidance` is what the next run reads it with.
//   * The `fetch_url` allowlist is read from `workspace_settings.flags` on the
//     `agent` role, which already has SELECT there. No grant moves for it, and
//     the default — no flag at all — refuses every host.
import { describe, expect, it } from 'vitest';
import { PgAgentDb } from '../../src/engine/pg-agent-db.js';
import type { Env } from '../../src/env.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, withClient, setTenant, type Fixture } from './helpers.js';

function envWithWorkflow(): Env {
  const created: { id: string }[] = [];
  const { env } = makeEnv({
    MODEL_SCRIPTED: '1',
    RUN_ATTEMPT: {
      create: (options: { id: string }) => {
        created.push({ id: options.id });
        return Promise.resolve({ id: options.id });
      },
      get: () => Promise.resolve({ sendEvent: () => Promise.resolve(), terminate: () => Promise.resolve() }),
    } as unknown as Env['RUN_ATTEMPT'],
  });
  return env;
}

async function asTenant<T>(fixture: Fixture, fn: (c: Parameters<Parameters<typeof withClient>[1]>[0]) => Promise<T>): Promise<T> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    try {
      await setTenant(c, fixture.workspaceId, fixture.adminId);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

const turnPath = (f: Fixture): string => `/w/${f.workspaceId}/sessions/${f.sessionId}/turns`;

async function startRun(fixture: Fixture, env: Env, clientTurnId: string): Promise<string> {
  const response = await asUser(env, fixture.adminId, turnPath(fixture), {
    method: 'POST',
    body: { client_turn_id: clientTurnId, text: 'go' },
  });
  expect([200, 201]).toContain(response.status);
  return ((await response.json()) as { run_id: string }).run_id;
}

describe('the run carries the mode it was created in', () => {
  it('copies the session mode onto the run row', async () => {
    const fixture = await seedWorkspace();
    const env = envWithWorkflow();

    await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/sessions/${fixture.sessionId}`, {
      method: 'PATCH',
      body: { mode: 'plan' },
    });
    const runId = await startRun(fixture, env, 'turn-mode-1');

    await asTenant(fixture, async (c) => {
      const { rows } = await c.query<{ mode: string }>(`SELECT mode FROM runs WHERE id = $1`, [runId]);
      expect(rows[0]?.mode).toBe('plan');
    });

    // The person switches back to Work while the run is in flight. The row the
    // engine reads does not move.
    await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/sessions/${fixture.sessionId}`, {
      method: 'PATCH',
      body: { mode: 'work' },
    });
    const db = new PgAgentDb(env, fixture.workspaceId, 'trace-m35');
    try {
      const run = await db.loadRun(runId);
      expect(run?.mode).toBe('plan');
    } finally {
      await db.close();
    }
  });
});

describe('guidance that arrives too late for the run it was aimed at', () => {
  it('is kept, parked on the session, and answered with "Applied to your next message"', async () => {
    const fixture = await seedWorkspace();
    const env = envWithWorkflow();
    const runId = await startRun(fixture, env, 'turn-guide-1');

    // The run finishes while the person is typing.
    await asTenant(fixture, async (c) => {
      await c.query(`UPDATE runs SET status = 'completed', ended_at = now() WHERE id = $1`, [runId]);
    });

    const response = await asUser(
      env,
      fixture.adminId,
      `/w/${fixture.workspaceId}/sessions/${fixture.sessionId}/runs/${runId}/guide`,
      { method: 'POST', body: { text: 'Also check the third reference.' } },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { guidance_id: string; status: string; copy?: string };
    expect(body.status).toBe('next_message');
    expect(body.copy).toBe('Applied to your next message');

    await asTenant(fixture, async (c) => {
      const { rows } = await c.query<{ run_id: string | null; status: string }>(
        `SELECT run_id, status FROM messages WHERE id = $1`,
        [body.guidance_id],
      );
      // No run id: it belongs to the session until a run reads it.
      expect(rows[0]).toMatchObject({ run_id: null, status: 'streaming' });
    });

    // The next run in this session is the one that reads it.
    const nextRunId = await startRun(fixture, env, 'turn-guide-2');
    const db = new PgAgentDb(env, fixture.workspaceId, 'trace-m35');
    try {
      const guidance = await db.loadGuidance(nextRunId);
      expect(guidance.map((g) => g.text)).toContain('Also check the third reference.');
      await db.markGuidanceApplied(nextRunId, guidance[0]?.id ?? '', 0);
      // Once applied it is not read again, by this run or any other.
      expect(await db.loadGuidance(nextRunId)).toHaveLength(0);
    } finally {
      await db.close();
    }

    await asTenant(fixture, async (c) => {
      const { rows } = await c.query<{ run_id: string | null }>(`SELECT run_id FROM messages WHERE id = $1`, [
        body.guidance_id,
      ]);
      // The run that finally read it is recorded, so the log can be audited.
      expect(rows[0]?.run_id).toBe(nextRunId);
    });
  });

  it('still queues guidance against a run that is still working', async () => {
    const fixture = await seedWorkspace();
    const env = envWithWorkflow();
    const runId = await startRun(fixture, env, 'turn-guide-3');

    const response = await asUser(
      env,
      fixture.adminId,
      `/w/${fixture.workspaceId}/sessions/${fixture.sessionId}/runs/${runId}/guide`,
      { method: 'POST', body: { text: 'Weight the references higher.' } },
    );
    const body = (await response.json()) as { guidance_id: string; status: string };
    expect(body.status).toBe('queued');

    await asTenant(fixture, async (c) => {
      const { rows } = await c.query<{ run_id: string | null }>(`SELECT run_id FROM messages WHERE id = $1`, [
        body.guidance_id,
      ]);
      expect(rows[0]?.run_id).toBe(runId);
    });
  });
});

describe('the fetch_url allowlist', () => {
  it('is empty by default, which refuses every host', async () => {
    const fixture = await seedWorkspace();
    const env = envWithWorkflow();
    const db = new PgAgentDb(env, fixture.workspaceId, 'trace-m35');
    try {
      expect(await db.loadFetchAllowlist()).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('is read from workspace_settings.flags, normalised, by the agent role', async () => {
    const fixture = await seedWorkspace();
    const env = envWithWorkflow();
    await asTenant(fixture, async (c) => {
      await c.query(
        `UPDATE workspace_settings
            SET flags = jsonb_build_object('fetch_url_allowlist', $2::jsonb)
          WHERE workspace_id = $1`,
        [fixture.workspaceId, JSON.stringify(['Example.COM ', 'docs.example.org', '', 42])],
      );
    });

    const db = new PgAgentDb(env, fixture.workspaceId, 'trace-m35');
    try {
      // Lower-cased, trimmed, and anything that is not a string dropped: a
      // malformed flag must not become a wildcard.
      expect(await db.loadFetchAllowlist()).toEqual(['example.com', 'docs.example.org']);
    } finally {
      await db.close();
    }
  });
});
