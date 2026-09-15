// History, and the erasure it has to survive.
//
// The interesting test is the last one. `events` holds ids and enum kinds only,
// so every sentence in History is composed at read time from the rows the ids
// point at. That is what lets `redact_subject` tombstone an applicant without
// destroying the audit trail — and it is only true if somebody checks, because
// the failure mode is a 500 on the History page of the one workspace that has
// exercised its data subject rights.
import { describe, expect, it } from 'vitest';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, type Fixture } from './helpers.js';
import { FakeQueue, FakeR2 } from '../stubs/fake-r2.js';
import { INBOX_HEADERS, seedQueue, seedRequest } from './m4-fixtures.js';

function env() {
  const bucket = new FakeR2();
  const made = makeEnv({ UPLOADS: bucket, RENDERS_QUEUE: new FakeQueue() } as never);
  return { ...made, bucket };
}

const decide = (e: ReturnType<typeof env>, fx: Fixture, requestId: string, decision = 'approve') =>
  asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
    method: 'POST',
    headers: INBOX_HEADERS,
    body: { decision },
  });

interface Row {
  id: string;
  kind: string;
  at: string;
  actor_name: string;
  text: string;
  detail: string;
  status: string;
  request_id: string | null;
}

const history = async (e: ReturnType<typeof env>, fx: Fixture, query = ''): Promise<Row[]> => {
  const response = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/history${query}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: Row[] }).items;
};

describe('GET /w/:ws/history', () => {
  it('renders a sentence per event by joining the ids to the rows they name', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const queue = await seedQueue(fx);
    await decide(e, fx, queue[0]!.id, 'approve');
    await decide(e, fx, queue[2]!.id, 'decline');

    const rows = await history(e, fx);
    const decisions = rows.filter((row) => row.kind === 'decision.recorded');
    expect(decisions).toHaveLength(2);

    const admitted = decisions.find((row) => row.request_id === queue[0]!.id)!;
    expect(admitted.text).toBe('Maya Chen admitted Leah Martinez');
    expect(admitted.detail).toBe('Access pending · No message sent');

    const declined = decisions.find((row) => row.request_id === queue[2]!.id)!;
    expect(declined.text).toBe('Maya Chen declined INV-2026-014');
    expect(declined.detail).toBe('No further action taken · No message sent');

    // The agent's own proposals are in the same trail, attributed to the agent.
    const proposed = rows.filter((row) => row.kind === 'request.created');
    expect(proposed).toHaveLength(4);
    expect(proposed[0]?.actor_name).toBe('Iris');
  });

  it('has three tabs, and `blocked` is derived from the present, not the past', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const queue = await seedQueue(fx);
    await decide(e, fx, queue[0]!.id, 'approve');

    const decisions = await history(e, fx, '?tab=decisions');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe('decision.recorded');

    const blocked = await history(e, fx, '?tab=blocked');
    // The three requests still pending, plus the access grant nobody has done.
    expect(blocked.filter((row) => row.kind === 'request.created')).toHaveLength(3);
    expect(blocked.some((row) => row.kind === 'effect.assigned')).toBe(true);
    // The decided one is no longer blocked, even though its event is unchanged.
    expect(blocked.some((row) => row.request_id === queue[0]!.id && row.kind === 'request.created')).toBe(false);

    const bad = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/history?tab=everything`);
    expect(bad.status).toBe(400);
  });

  it('counts come from the views, and agree with the decisions taken', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const queue = await seedQueue(fx);
    await decide(e, fx, queue[0]!.id, 'approve');
    await decide(e, fx, queue[1]!.id, 'decline');

    const response = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/history/counts`);
    expect(await response.json()).toMatchObject({
      decisions: 2,
      approved: 1,
      declined: 1,
      inbox: 2,
      pending_grants: 1,
    });
  });
});

describe('DELETE /w/:ws/applicants/:subject_key', () => {
  it('tombstones the subject and History still renders', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'application', {
      label: 'Leah Martinez',
      subjectKey: 'subject-leah',
    });
    await decide(e, fx, requestId, 'approve');

    const before = await history(e, fx, '?tab=decisions');
    expect(before[0]?.text).toBe('Maya Chen admitted Leah Martinez');

    const erased = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/applicants/subject-leah`, {
      method: 'DELETE',
    });
    expect(erased.status).toBe(200);
    const result = (await erased.json()) as { rows_redacted: number; subjects: string[] };
    expect(result.rows_redacted).toBeGreaterThan(0);
    expect(result.subjects).toHaveLength(1);

    // The subject rows are rewritten; the audit rows are untouched.
    await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      const request = await c.query<{ label: string; payload: { redacted?: boolean }; subject_key: string | null }>(
        `SELECT label, payload, subject_key FROM requests WHERE id = $1`,
        [requestId],
      );
      expect(request.rows[0]).toMatchObject({ label: 'Deleted applicant', subject_key: null });
      expect(request.rows[0]?.payload.redacted).toBe(true);

      const audit = await c.query(`SELECT 1 FROM events WHERE kind = 'decision.recorded'`);
      expect(audit.rowCount).toBe(1);
      const redaction = await c.query(`SELECT 1 FROM events WHERE kind = 'subject.redacted'`);
      expect(redaction.rowCount).toBe(1);
    });

    // And the page still renders, naming what it can no longer name.
    const after = await history(e, fx, '?tab=decisions');
    expect(after).toHaveLength(1);
    expect(after[0]?.text).toBe('Maya Chen admitted a deleted applicant');
    expect(after[0]?.detail).toBe('Access pending · No message sent');

    const all = await history(e, fx);
    expect(all.some((row) => row.kind === 'subject.redacted')).toBe(true);
    expect(all.find((row) => row.kind === 'request.created')?.text).toBe(
      'Iris screened a deleted applicant’s application',
    );
  });

  it('needs an Admin, a recent sign-in and a subject that exists', async () => {
    const fx = await seedWorkspace();
    const e = env();
    await seedRequest(fx, 'application', { label: 'Leah Martinez', subjectKey: 'subject-leah' });

    const asMember = await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/applicants/subject-leah`, {
      method: 'DELETE',
    });
    expect(asMember.status).toBe(403);

    const missing = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/applicants/nobody`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { reason: string }).reason).toBe('unknown_subject');
  });
});
