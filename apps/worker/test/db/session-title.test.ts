// The session's name is the server's to keep: the first turn names it, a
// completed run renames it after what it produced, and a person's own name
// beats both. Decision C34, moved server-side.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgAgentDb } from '../../src/engine/pg-agent-db.js';
import type { Env } from '../../src/env.js';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

function envWithWorkflow(): Env {
  const { env } = makeEnv({
    MODEL_SCRIPTED: '1',
    RUN_ATTEMPT: {
      create: (options: { id: string }) => Promise.resolve({ id: options.id }),
      get: () => Promise.resolve({ sendEvent: () => Promise.resolve(), terminate: () => Promise.resolve() }),
    } as unknown as Env['RUN_ATTEMPT'],
  });
  return env;
}

/**
 * A row, not a POST: the seeded workspace's default model is a Nous Portal id
 * and the test harness allows every provider except that one, so a session
 * made through the route cannot take a turn here. The row carries the model
 * the seeded session uses and the title the route would have written.
 */
async function createSession(fixture: Fixture, _env: Env, body: { title?: string } = {}): Promise<string> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fixture.workspaceId, fixture.adminId);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sessions (workspace_id, owner_id, agent_id, title, model_id)
       VALUES ($1, $2, $3, $4, 'deepseek-flash') RETURNING id`,
      [fixture.workspaceId, fixture.adminId, fixture.agentId, body.title ?? 'New session'],
    );
    await c.query('COMMIT');
    return rows[0]!.id;
  });
}

async function turn(fixture: Fixture, env: Env, sessionId: string, text: string): Promise<string> {
  const response = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/sessions/${sessionId}/turns`, {
    method: 'POST',
    body: { client_turn_id: randomUUID(), text },
  });
  const body = await response.text();
  expect(response.status, body).toBe(201);
  return (JSON.parse(body) as { run_id: string }).run_id;
}

async function titleOf(fixture: Fixture, sessionId: string): Promise<{ title: string; title_source: string }> {
  return readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
    const { rows } = await c.query<{ title: string; title_source: string }>(
      'SELECT title, title_source FROM sessions WHERE id = $1',
      [sessionId],
    );
    return rows[0]!;
  });
}

/** What `propose_request` writes, without running the engine. */
async function proposeApplication(fixture: Fixture, runId: string, sessionId: string, name: string): Promise<void> {
  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fixture.workspaceId, fixture.adminId);
    await c.query(
      `INSERT INTO requests (workspace_id, kind, subject_key, label, payload, status, run_id, session_id, tool_call_id)
       VALUES ($1, 'application', $2, $3, $4::jsonb, 'pending', $5, $6, 'call_1')`,
      [fixture.workspaceId, `email:${name.toLowerCase().replace(' ', '.')}@example.com`, name, JSON.stringify({ applicant: { name } }), runId, sessionId],
    );
    await c.query('COMMIT');
  });
}

describe('the first turn names the session', () => {
  it('writes the first six words to a placeholder session, and records that the turn did it', async () => {
    const fixture = await seedWorkspace();
    const env = envWithWorkflow();
    const sessionId = await createSession(fixture, env);
    expect(await titleOf(fixture, sessionId)).toEqual({ title: 'New session', title_source: 'default' });

    await turn(fixture, env, sessionId, 'Screen the applicant and say what is missing.');
    expect(await titleOf(fixture, sessionId)).toEqual({ title: 'Screen the applicant and say what', title_source: 'turn' });
  });

  it('leaves a session a person named at creation alone', async () => {
    const fixture = await seedWorkspace();
    const env = envWithWorkflow();
    const sessionId = await createSession(fixture, env, { title: 'Ada, second look' });
    expect(await titleOf(fixture, sessionId)).toEqual({ title: 'Ada, second look', title_source: 'manual' });
    await turn(fixture, env, sessionId, 'Screen the applicant.');
    expect((await titleOf(fixture, sessionId)).title).toBe('Ada, second look');
  });

  it('a rename through PATCH is the person\'s, and resetting it hands the name back', async () => {
    const fixture = await seedWorkspace();
    const env = envWithWorkflow();
    const sessionId = await createSession(fixture, env);
    const renamed = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/sessions/${sessionId}`, {
      method: 'PATCH',
      body: { title: 'Friday batch' },
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()) as { title_source: string }).toMatchObject({ title: 'Friday batch', title_source: 'manual' });

    const reset = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/sessions/${sessionId}`, {
      method: 'PATCH',
      body: { title: '' },
    });
    expect((await reset.json()) as { title_source: string }).toMatchObject({ title: 'New session', title_source: 'default' });
  });
});

describe('a completed run names its session after what it produced', () => {
  it('renames a turn-named session as the agent role, and publishes the change to the session', async () => {
    const fixture = await seedWorkspace();
    const env = envWithWorkflow();
    const sessionId = await createSession(fixture, env);
    const runId = await turn(fixture, env, sessionId, 'Screen the applicant and say what is missing.');
    await proposeApplication(fixture, runId, sessionId, 'Ada Ling');

    const db = new PgAgentDb(env, fixture.workspaceId, 'trace-title');
    try {
      const named = await db.nameSessionFromRun(runId);
      expect(named).toMatchObject({ sessionId, title: 'Ada Ling · application' });
      expect(named?.events).toHaveLength(1);
      expect(named?.events[0]).toMatchObject({ kind: 'entity.updated', sessionId, payload: { entity_type: 'session', entity_id: sessionId } });
      // Idempotent: the same name is not an update.
      expect(await db.nameSessionFromRun(runId)).toBeNull();
    } finally {
      await db.close();
    }
    expect(await titleOf(fixture, sessionId)).toEqual({ title: 'Ada Ling · application', title_source: 'run' });

    const published = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
      const { rows } = await c.query<{ session_id: string | null; payload: { entity_type: string } }>(
        `SELECT session_id, payload FROM stream_events WHERE workspace_id = $1 AND kind = 'entity.updated' ORDER BY id DESC LIMIT 1`,
        [fixture.workspaceId],
      );
      return rows[0];
    });
    expect(published).toMatchObject({ session_id: sessionId, payload: { entity_type: 'session' } });
  });

  it('never replaces a name a person chose', async () => {
    const fixture = await seedWorkspace();
    const env = envWithWorkflow();
    const sessionId = await createSession(fixture, env);
    const runId = await turn(fixture, env, sessionId, 'Screen the applicant.');
    await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/sessions/${sessionId}`, { method: 'PATCH', body: { title: 'Mine' } });
    await proposeApplication(fixture, runId, sessionId, 'Ada Ling');

    const db = new PgAgentDb(env, fixture.workspaceId, 'trace-title');
    try {
      expect(await db.nameSessionFromRun(runId)).toBeNull();
    } finally {
      await db.close();
    }
    expect(await titleOf(fixture, sessionId)).toEqual({ title: 'Mine', title_source: 'manual' });
  });

  it('returns nothing for a run that proposed nothing', async () => {
    const fixture = await seedWorkspace();
    const env = envWithWorkflow();
    const sessionId = await createSession(fixture, env);
    const runId = await turn(fixture, env, sessionId, 'Just thinking.');
    const db = new PgAgentDb(env, fixture.workspaceId, 'trace-title');
    try {
      expect(await db.nameSessionFromRun(runId)).toBeNull();
    } finally {
      await db.close();
    }
    expect((await titleOf(fixture, sessionId)).title_source).toBe('turn');
  });
});
