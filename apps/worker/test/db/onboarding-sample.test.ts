import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seedWorkspace, setTenant, withClient } from './helpers.js';
import { asUser, makeEnv, readTenant } from './harness.js';

async function bindAgentToMember(
  fixture: Awaited<ReturnType<typeof seedWorkspace>>,
  userId = fixture.adminId,
): Promise<void> {
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fixture.workspaceId, fixture.adminId);
    await client.query(
      `INSERT INTO agent_owners (workspace_id, agent_id, member_id)
       SELECT $1, $2, id FROM members WHERE workspace_id = $1 AND user_id = $3`,
      [fixture.workspaceId, fixture.agentId, userId],
    );
    await client.query('COMMIT');
  });
}

describe('Partner Program onboarding sample run', () => {
  it('persists a delayed simulation, cursor events and two sample Inbox requests exactly once', async () => {
    const fixture = await seedWorkspace();
    await bindAgentToMember(fixture);
    const { env } = makeEnv();
    const setupAttempt = randomUUID();
    const path = `/w/${fixture.workspaceId}/onboarding/sample-runs`;

    const started = await asUser(env, fixture.adminId, path, {
      method: 'POST',
      body: { agent_id: fixture.agentId, setup_attempt_id: setupAttempt },
    });
    expect(started.status).toBe(201);
    const initial = (await started.json()) as {
      run: { id: string; status: string; simulation: boolean; disclosure: string };
      applications: { state: string; request_id: string | null }[];
      events: { id: string; kind: string; detail: string }[];
      cursor: { head: string };
      next_poll_ms: number | null;
    };
    expect(initial.run).toMatchObject({ status: 'running', simulation: true });
    expect(initial.run.disclosure).toContain('No provider');
    expect(initial.applications).toEqual([]);
    expect(initial.events.map((event) => event.kind)).toEqual(['run.started']);
    expect(initial.events[0]?.detail).toContain('No provider');
    expect(initial.next_poll_ms).not.toBeNull();

    const replay = await asUser(env, fixture.adminId, path, {
      method: 'POST',
      body: { agent_id: fixture.agentId, setup_attempt_id: setupAttempt },
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-hermes-idempotent-replay')).toBe('true');
    expect(((await replay.json()) as { run: { id: string } }).run.id).toBe(initial.run.id);

    // A new client setup UUID is not permission to create another shared run.
    // The durable workspace+creator+agent walkthrough is resumed instead.
    const freshAttempt = await asUser(env, fixture.adminId, path, {
      method: 'POST',
      body: { agent_id: fixture.agentId, setup_attempt_id: randomUUID() },
    });
    expect(freshAttempt.status).toBe(200);
    expect(freshAttempt.headers.get('x-hermes-idempotent-replay')).toBe('true');
    expect(((await freshAttempt.json()) as { run: { id: string } }).run.id).toBe(initial.run.id);

    // Move server time forward without sleeping. At four seconds Owen is
    // researching, Leah has just arrived, and the Inbox remains empty.
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fixture.workspaceId, fixture.adminId);
      await client.query(
        `UPDATE onboarding_sample_runs SET started_at = now() - interval '4 seconds' WHERE id = $1`,
        [initial.run.id],
      );
      await client.query('COMMIT');
    });
    const midway = await asUser(
      env,
      fixture.adminId,
      `${path}/${initial.run.id}?after=${initial.cursor.head}`,
    );
    expect(midway.status).toBe(200);
    const partial = (await midway.json()) as {
      applications: { state: string; request_id: string | null }[];
      events: { kind: string }[];
      cursor: { head: string };
    };
    expect(partial.applications.map((application) => application.state)).toEqual(['researching', 'received']);
    expect(partial.applications.every((application) => application.request_id === null)).toBe(true);
    expect(partial.events.map((event) => event.kind)).toEqual([
      'application.received',
      'application.researching',
      'application.received',
    ]);

    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fixture.workspaceId, fixture.adminId);
      await client.query(
        `UPDATE onboarding_sample_runs SET started_at = now() - interval '12 seconds' WHERE id = $1`,
        [initial.run.id],
      );
      await client.query('COMMIT');
    });
    const finished = await asUser(
      env,
      fixture.adminId,
      `${path}/${initial.run.id}?after=${partial.cursor.head}`,
    );
    expect(finished.status).toBe(200);
    const complete = (await finished.json()) as {
      run: { status: string };
      applications: { state: string; score: number; request_id: string; evidence: { label: string; summary: string }[]; sources: { name: string; note: string; sample: boolean }[] }[];
      events: { kind: string; request_id: string | null }[];
      next_poll_ms: number | null;
    };
    expect(complete.run.status).toBe('completed');
    expect(complete.applications.map((application) => application.state)).toEqual(['needs_review', 'needs_review']);
    expect(complete.applications.map((application) => application.score)).toEqual([86, 78]);
    expect(complete.applications.every((application) => Boolean(application.request_id))).toBe(true);
    expect(complete.applications.every((application) => application.evidence.length === 3)).toBe(true);
    expect(complete.applications.flatMap((application) => application.sources).every((source) => source.sample && source.note.startsWith('Fictional sample'))).toBe(true);
    expect(complete.events.at(-1)?.kind).toBe('run.completed');
    expect(complete.next_poll_ms).toBeNull();

    const persisted = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const requests = await client.query<{
        label: string;
        proposed_role: string;
        source_notes: string[];
        missing: string[];
      }>(
        `SELECT label,
                payload->>'proposed_role' AS proposed_role,
                ARRAY(SELECT source->>'note' FROM jsonb_array_elements(payload->'sources') source) AS source_notes,
                ARRAY(SELECT jsonb_array_elements_text(payload->'missing')) AS missing
           FROM requests
          WHERE subject_key LIKE $1
          ORDER BY label`,
        [`sample:${initial.run.id}:%`],
      );
      const sampleEvents = await client.query(`SELECT id FROM onboarding_sample_events WHERE run_id = $1`, [initial.run.id]);
      const outbox = await client.query(
        `SELECT payload FROM stream_events
          WHERE workspace_id = $1 AND kind = 'request.created'
            AND payload->>'request_id' = ANY($2::text[])`,
        [fixture.workspaceId, complete.applications.map((application) => application.request_id)],
      );
      const calls = await client.query(`SELECT id FROM model_calls WHERE workspace_id = $1`, [fixture.workspaceId]);
      const effects = await client.query(`SELECT id FROM effects WHERE workspace_id = $1`, [fixture.workspaceId]);
      return { requests: requests.rows, eventCount: sampleEvents.rowCount, outboxCount: outbox.rowCount, calls: calls.rowCount, effects: effects.rowCount };
    });
    expect(persisted.requests).toHaveLength(2);
    expect(persisted.requests.every((request) => request.label.startsWith('Sample · '))).toBe(true);
    expect(persisted.requests.every((request) => request.proposed_role.startsWith('Sample · '))).toBe(true);
    expect(persisted.requests.flatMap((request) => request.source_notes).every((note) => note.includes('Fictional sample'))).toBe(true);
    expect(persisted.requests.flatMap((request) => request.missing).every((gap) => gap.includes('simulated'))).toBe(true);
    expect(persisted.eventCount).toBe(10);
    expect(persisted.outboxCount).toBe(2);
    expect(persisted.calls).toBe(0);
    expect(persisted.effects).toBe(0);

    // Refreshing a completed run only replays its snapshot. It does not add a
    // third application, request or event.
    await asUser(env, fixture.adminId, `${path}/${initial.run.id}?after=0`);
    const counts = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const runs = await client.query(
        `SELECT id FROM onboarding_sample_runs
          WHERE workspace_id = $1 AND created_by = $2 AND agent_id = $3`,
        [fixture.workspaceId, fixture.adminId, fixture.agentId],
      );
      const requests = await client.query(`SELECT id FROM requests WHERE subject_key LIKE $1`, [`sample:${initial.run.id}:%`]);
      const events = await client.query(`SELECT id FROM onboarding_sample_events WHERE run_id = $1`, [initial.run.id]);
      return [runs.rowCount, requests.rowCount, events.rowCount];
    });
    expect(counts).toEqual([1, 2, 10]);
  });

  it('only starts the profile-bound agent and keeps its run private', async () => {
    const fixture = await seedWorkspace();
    await bindAgentToMember(fixture);
    const { env } = makeEnv();
    const started = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/onboarding/sample-runs`, {
      method: 'POST',
      body: { agent_id: fixture.agentId, setup_attempt_id: randomUUID() },
    });
    const runId = ((await started.json()) as { run: { id: string } }).run.id;
    const forbiddenStart = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/onboarding/sample-runs`, {
      method: 'POST',
      body: { agent_id: fixture.agentId, setup_attempt_id: randomUUID() },
    });
    expect(forbiddenStart.status).toBe(403);
    expect(await forbiddenStart.json()).toMatchObject({ reason: 'agent_not_bound' });

    const response = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/onboarding/sample-runs/${runId}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: 'unknown_sample_run' });
  });
});
