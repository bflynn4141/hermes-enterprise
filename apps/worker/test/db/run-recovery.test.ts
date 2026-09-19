import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID } from '@hermes/shared';
import type { Tx } from '../../src/db/client.js';
import type { Env } from '../../src/env.js';
import type { Job } from '../../src/jobs.js';
import { syncNousPortalCatalog } from '../../src/model/nous-catalog.js';
import { NOUS_PORTAL_FIXTURE_MODELS } from '../../src/model/nous-dev.js';
import {
  loadRecoveryRun, recoveryView, retryTask, runRecoveryJob, scheduleRunRecovery, wakeAuthorizedWork,
  type RecoveryWork,
} from '../../src/runs/recovery.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { asUser, makeEnv, readTenant } from './harness.js';

const OLD_MODEL = 'deepseek-flash';
const oldError = { reason: 'hermes_provider_unavailable', message: 'The model is temporarily unavailable.', retryable: true, class: 'transient' };
const sourcePolicy = {
  source: 'github', source_purpose: 'organization_partner_research', organization_only: true,
  no_outreach: true, role_label: 'Partner', search_queries: ['topic:agents'], keywords: ['agents'],
};

beforeAll(async () => {
  await withClient('owner', async (client) => {
    await syncNousPortalCatalog(client as unknown as Tx, NOUS_PORTAL_FIXTURE_MODELS);
  });
});

function environment() {
  const created: unknown[] = [];
  const { env } = makeEnv({
    MODEL_SCRIPTED: '1', AGENT_RUNTIME: 'hermes', ALLOWED_PROVIDERS: 'nous_portal,openrouter,deepseek',
    AUTOMATED_TRIGGERS_ENABLED: '1', PARTNER_SCREENING_AUTOMATION_INTERVAL_MINUTES: '360',
    PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(sourcePolicy),
    RUN_ATTEMPT: { create: async (value: unknown) => { created.push(value); return { id: 'test-instance' }; } } as unknown as Env['RUN_ATTEMPT'],
  });
  return { env, created };
}

async function fixture(options: { scheduled?: boolean; attempt?: number; cancelled?: boolean; paymentPending?: boolean } = {}) {
  const fx = await seedWorkspace();
  const runId = randomUUID();
  const screeningId = randomUUID();
  const traceId = randomUUID();
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    await client.query(`INSERT INTO agent_owners(workspace_id,agent_id,member_id)
      SELECT $1,$2,id FROM members WHERE workspace_id=$1 AND user_id=$3`, [fx.workspaceId, fx.agentId, fx.adminId]);
    await client.query('UPDATE sessions SET model_id=$2,effort=$3 WHERE id=$1', [fx.sessionId, DEFAULT_MODEL_ID, 'high']);
    if (options.scheduled) await client.query(
      'INSERT INTO workspace_directory(workspace_id,workos_organization_id) VALUES($1,$2)',
      [fx.workspaceId, `recovery-${fx.workspaceId}`],
    );
    if (options.scheduled || options.paymentPending) {
      await client.query(
        `INSERT INTO partner_screening_runs
           (id,workspace_id,agent_id,created_by,idempotency_key,status,source,authentication,
            config_snapshot,api_requests_max,api_requests_used,agentcash_tool_call_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{"minimum_priority":40}',1,$9,$10)`,
        [screeningId, fx.workspaceId, fx.agentId, fx.adminId, `recovery-test:${screeningId}`,
          options.paymentPending ? 'running' : 'completed', options.paymentPending ? 'agentcash_people' : 'github',
          options.paymentPending ? 'wallet' : 'unauthenticated', options.paymentPending ? 1 : 0,
          options.paymentPending ? 'pending-paid-call' : null],
      );
    }
    await client.query(
      `INSERT INTO runs
         (id,workspace_id,session_id,agent_id,status,model_id,effort,client_turn_id,mode,attempt,
          trace_id,error,ended_at,recovery_cancelled)
       VALUES ($1,$2,$3,$4,'error',$5,'high',$6,'work',$7,$8,$9::jsonb,now()-interval '10 minutes',$10)`,
      [runId, fx.workspaceId, fx.sessionId, fx.agentId, OLD_MODEL,
        options.scheduled || options.paymentPending ? `partner-screening:${screeningId}` : randomUUID(),
        options.attempt ?? 1, traceId, JSON.stringify(oldError), options.cancelled ?? false],
    );
    await client.query('COMMIT');
  });
  return { ...fx, runId, screeningId, traceId };
}

async function work<T>(fx: Fixture, fn: (value: RecoveryWork) => Promise<T>, userId = fx.adminId): Promise<T> {
  return withClient('app', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, userId);
    try {
      const result = await fn({ tx: client as unknown as Tx, workspaceId: fx.workspaceId, userId, jobs: [] });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function recoveryJob(fx: Fixture & { runId: string }): Promise<Job | undefined> {
  return readTenant(fx.workspaceId, fx.adminId, async (client) => (
    await client.query<Job>(`SELECT id,workspace_id,kind,key,payload,attempts FROM jobs
      WHERE workspace_id=$1 AND kind='run_recovery' AND payload->>'run_id'=$2 ORDER BY created_at DESC LIMIT 1`,
    [fx.workspaceId, fx.runId])
  ).rows[0]);
}

describe('durable run recovery admission', () => {
  it('admits one new attempt on the current session model and preserves the old attempt provenance', async () => {
    const fx = await fixture();
    const { env } = environment();
    const retried = await work(fx, (context) => retryTask(context, env, fx.agentId, fx.runId, 1));
    expect(retried).toMatchObject({ id: fx.runId, attempt: 2, status: 'working', model_id: DEFAULT_MODEL_ID, effort: 'high' });
    const duplicate = await work(fx, (context) => retryTask(context, env, fx.agentId, fx.runId, 1));
    expect(duplicate).toMatchObject({ id: fx.runId, attempt: 2 });
    await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const current = (await client.query('SELECT model_id,attempt,recovery_history FROM runs WHERE id=$1', [fx.runId])).rows[0];
      expect(current.recovery_history).toEqual([expect.objectContaining({ attempt: 1, model_id: OLD_MODEL,
        trace_id: fx.traceId, reason: 'hermes_provider_unavailable', next_model_id: DEFAULT_MODEL_ID, trigger: 'manual' })]);
      expect((await client.query("SELECT count(*)::int AS count FROM jobs WHERE workspace_id=$1 AND kind='run_launch'", [fx.workspaceId])).rows[0].count).toBe(1);
      expect((await client.query("SELECT count(*)::int AS count FROM events WHERE workspace_id=$1 AND kind='run.retried'", [fx.workspaceId])).rows[0].count).toBe(1);
    });
  });

  it('refuses another member, another tenant, and a run not owned by the requesting session owner', async () => {
    const fx = await fixture();
    const other = await fixture();
    const { env } = environment();
    await expect(work(fx, (context) => retryTask(context, env, fx.agentId, fx.runId, 1), fx.memberId))
      .rejects.toMatchObject({ reason: 'agent_not_bound', status: 404 });
    await expect(work(other, (context) => retryTask(context, env, fx.agentId, fx.runId, 1)))
      .rejects.toMatchObject({ reason: 'agent_not_bound', status: 404 });
    await expect(work(fx, (context) => loadRecoveryRun(context, fx.agentId, fx.runId), fx.memberId))
      .rejects.toMatchObject({ reason: 'unknown_run', status: 404 });
    expect((await work(fx, (context) => loadRecoveryRun(context, fx.agentId, fx.runId)))?.attempt).toBe(1);
  });

  it('blocks a pending paid receipt before attempt or model mutation', async () => {
    const fx = await fixture({ paymentPending: true });
    const { env } = environment();
    await expect(work(fx, (context) => retryTask(context, env, fx.agentId, fx.runId, 1)))
      .rejects.toMatchObject({ reason: 'payment_result_pending', status: 409 });
    expect(await work(fx, (context) => recoveryView(context, env, fx.agentId))).toMatchObject({ state: 'blocked', can_retry: false });
    await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      expect((await client.query('SELECT attempt,model_id,recovery_history FROM runs WHERE id=$1', [fx.runId])).rows[0])
        .toEqual({ attempt: 1, model_id: OLD_MODEL, recovery_history: [] });
      expect((await client.query('SELECT api_requests_used,agentcash_tool_call_id FROM partner_screening_runs WHERE id=$1', [fx.screeningId])).rows[0])
        .toEqual({ api_requests_used: 1, agentcash_tool_call_id: 'pending-paid-call' });
    });
  });

  it('schedules a durable retry once, caps automatic attempts at three, and respects cancellation', async () => {
    const eligible = await fixture({ scheduled: true, attempt: 2 });
    const capped = await fixture({ scheduled: true, attempt: 3 });
    const cancelled = await fixture({ scheduled: true, cancelled: true });
    const { env, created } = environment();
    await scheduleRunRecovery(env);
    await scheduleRunRecovery(env);
    const job = await recoveryJob(eligible);
    expect(job).toBeDefined();
    expect(await recoveryJob(capped)).toBeUndefined();
    expect(await recoveryJob(cancelled)).toBeUndefined();
    await readTenant(eligible.workspaceId, eligible.adminId, async (client) => {
      const rows = (await client.query(`SELECT next_at,payload FROM jobs WHERE workspace_id=$1 AND kind='run_recovery'`, [eligible.workspaceId])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.expected_attempt).toBe(2);
      expect(rows[0].next_at).toBeInstanceOf(Date);
    });
    await runRecoveryJob(env, job!);
    expect((await work(eligible, (context) => loadRecoveryRun(context, eligible.agentId, eligible.runId)))?.attempt).toBe(3);
    expect(created).toHaveLength(1);
    await runRecoveryJob(env, job!);
    expect(created).toHaveLength(1);

    // A human can cancel after the durable job was enqueued; a stale worker
    // must re-read that decision rather than treating the old job as authority.
    const lateCancel = await fixture({ scheduled: true });
    await scheduleRunRecovery(env);
    const cancelledJob = await recoveryJob(lateCancel);
    expect(cancelledJob).toBeDefined();
    await work(lateCancel, async (context) => {
      await context.tx.query('UPDATE runs SET recovery_cancelled=true,recovery_next_at=NULL WHERE id=$1', [lateCancel.runId]);
    });
    await runRecoveryJob(env, cancelledJob!);
    expect((await work(lateCancel, (context) => loadRecoveryRun(context, lateCancel.agentId, lateCancel.runId)))?.attempt).toBe(1);
    expect(created).toHaveLength(1);
  });

  it('deduplicates Run now within the authorized cadence bucket and never bypasses an unresolved cycle', async () => {
    const fx = await seedWorkspace();
    const { env } = environment();
    const first = await work(fx, (context) => wakeAuthorizedWork(context, env, fx.agentId));
    const second = await work(fx, (context) => wakeAuthorizedWork(context, env, fx.agentId));
    expect(first.state).toBe('queued');
    expect(second.state).toBe('queued');
    await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const rows = (await client.query("SELECT key,payload FROM jobs WHERE workspace_id=$1 AND kind='partner_screening'", [fx.workspaceId])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toContain(`partner-screening:auto:${fx.workspaceId}:${fx.agentId}:360m-`);
      expect(rows[0].payload).toMatchObject({ agent_id: fx.agentId, owner_user_id: fx.adminId });
    });
    const unresolved = await fixture({ scheduled: true });
    const result = await work(unresolved, (context) => wakeAuthorizedWork(context, env, unresolved.agentId));
    expect(result.run_id).toBe(unresolved.runId);
    await readTenant(unresolved.workspaceId, unresolved.adminId, async (client) => {
      expect((await client.query("SELECT count(*)::int AS count FROM jobs WHERE workspace_id=$1 AND kind='partner_screening'", [unresolved.workspaceId])).rows[0].count).toBe(0);
    });
  });

  it('lets a reviewed deliverable settle a failed cycle without retrying or duplicating its request', async () => {
    const fx = await fixture({ scheduled: true });
    const requestId = randomUUID();
    const { env } = environment();
    await work(fx, async (context) => {
      await context.tx.query(
        `INSERT INTO requests(id,workspace_id,kind,label,payload,status,run_id,session_id,tool_call_id)
         VALUES($1,$2,'agreement','Partner outreach draft','{"kind":"agreement"}','pending',$3,$4,'completed-draft')`,
        [requestId, fx.workspaceId, fx.runId, fx.sessionId],
      );
    });
    const pending = await work(fx, (context) => wakeAuthorizedWork(context, env, fx.agentId));
    expect(pending).toMatchObject({ state: 'blocked', run_id: fx.runId, can_retry: false });
    expect(pending.message).toContain('Inbox');
    await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      expect((await client.query("SELECT count(*)::int AS count FROM jobs WHERE workspace_id=$1 AND kind='partner_screening'", [fx.workspaceId])).rows[0].count).toBe(0);
    });
    // Model the persisted outcome of a human's review. Recovery consumes that
    // outcome; it does not reopen the reviewed draft or replay its failed run.
    await work(fx, async (context) => {
      await context.tx.query("UPDATE requests SET status='drafted' WHERE id=$1", [requestId]);
    });
    const next = await work(fx, (context) => wakeAuthorizedWork(context, env, fx.agentId));
    expect(next.state).toBe('queued');
    await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      expect((await client.query('SELECT attempt,status FROM runs WHERE id=$1', [fx.runId])).rows[0]).toEqual({ attempt: 1, status: 'error' });
      expect((await client.query('SELECT id,status FROM requests WHERE run_id=$1', [fx.runId])).rows).toEqual([{ id: requestId, status: 'drafted' }]);
      expect((await client.query("SELECT count(*)::int AS count FROM jobs WHERE workspace_id=$1 AND kind='partner_screening'", [fx.workspaceId])).rows[0].count).toBe(1);
      expect((await client.query("SELECT count(*)::int AS count FROM jobs WHERE workspace_id=$1 AND kind='run_launch'", [fx.workspaceId])).rows[0].count).toBe(0);
    });
  });

  it('skips stale ownership during the recovery scan and still queues another workspace', async () => {
    const reassigned = await fixture({ scheduled: true });
    const eligible = await fixture({ scheduled: true });
    const { env } = environment();
    await work(reassigned, async (context) => {
      await context.tx.query(`UPDATE agent_owners SET member_id=(
        SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2)
        WHERE workspace_id=$1 AND agent_id=$3`, [reassigned.workspaceId, reassigned.memberId, reassigned.agentId]);
    });
    await expect(scheduleRunRecovery(env)).resolves.toMatchObject({ queued: expect.any(Number) });
    expect(await recoveryJob(reassigned)).toBeUndefined();
    expect(await recoveryJob(eligible)).toBeDefined();
    expect((await work(reassigned, (context) => loadRecoveryRun(context, reassigned.agentId, reassigned.runId)))?.attempt).toBe(1);
  });
});

describe('agent recovery HTTP controls', () => {
  it('keeps the completed-run GET view read-only under legacy default policy', async () => {
    const fx = await fixture();
    const { env } = environment();
    await work(fx, (context) => context.tx.query(
      `UPDATE runs SET status='completed', error=NULL, recovery_next_at=NULL, ended_at=now() WHERE id=$1`,
      [fx.runId],
    ));
    const state = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.agentId}/recovery`);
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ state: 'idle', can_run_now: true });
    await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const result = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM enterprise_skill_assignments
          WHERE workspace_id=$1 AND agent_id=$2`,
        [fx.workspaceId, fx.agentId],
      );
      expect(result.rows[0]?.count).toBe(0);
    });
  });

  it('returns owner-scoped state and rejects malformed or foreign actions', async () => {
    const fx = await fixture();
    const { env } = environment();
    const base = `/w/${fx.workspaceId}/agents/${fx.agentId}`;
    const state = await asUser(env, fx.adminId, `${base}/recovery`);
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ state: 'retryable', run_id: fx.runId, attempt: 1, can_retry: true, model_id: DEFAULT_MODEL_ID });
    expect((await asUser(env, fx.memberId, `${base}/recovery`)).status).toBe(404);
    expect((await asUser(env, fx.adminId, `${base}/recovery?run_id=bad`)).status).toBe(400);
    expect((await asUser(env, fx.adminId, `${base}/wake`, { method: 'POST', body: { action: 'retry' } })).status).toBe(422);
    const forbidden = await asUser(env, fx.adminId, `${base}/wake`, {
      method: 'POST', origin: 'https://foreign.example', body: { action: 'retry', run_id: fx.runId, expected_attempt: 1 },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ reason: 'forbidden_origin' });
    const csrf = await asUser({ ...env, AUTH_MODE: 'workos' }, fx.adminId, `${base}/wake`, {
      method: 'POST', body: { action: 'retry', run_id: fx.runId, expected_attempt: 1 },
    });
    expect(csrf.status).toBe(403);
    expect(await csrf.json()).toMatchObject({ reason: 'csrf_failed' });
  });

  it('retries without a chat message and makes a duplicate click idempotent', async () => {
    const fx = await fixture();
    const { env, created } = environment();
    const path = `/w/${fx.workspaceId}/agents/${fx.agentId}/wake`;
    const options = { method: 'POST', body: { action: 'retry', run_id: fx.runId, expected_attempt: 1, idempotency_key: randomUUID() } };
    const first = await asUser(env, fx.adminId, path, options);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ state: 'working', attempt: 2, run_id: fx.runId });
    const duplicate = await asUser(env, fx.adminId, path, options);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ state: 'working', attempt: 2 });
    expect(created).toHaveLength(1);
    await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      expect((await client.query('SELECT count(*)::int AS count FROM messages WHERE run_id=$1', [fx.runId])).rows[0].count).toBe(0);
    });
  });

  it('cancels the scheduled retry through the control and rejects an old attempt', async () => {
    const fx = await fixture({ scheduled: true });
    const { env } = environment();
    await scheduleRunRecovery(env);
    const path = `/w/${fx.workspaceId}/agents/${fx.agentId}/wake`;
    const wrong = await asUser(env, fx.adminId, path, { method: 'POST', body: { action: 'cancel_retry', run_id: fx.runId, expected_attempt: 2, idempotency_key: randomUUID() } });
    expect(wrong.status).toBe(409);
    const cancelled = await asUser(env, fx.adminId, path, { method: 'POST', body: { action: 'cancel_retry', run_id: fx.runId, expected_attempt: 1, idempotency_key: randomUUID() } });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ state: 'retryable', can_cancel: false, next_retry_at: null });
    const job = await recoveryJob(fx);
    expect(job).toBeDefined();
    await runRecoveryJob(env, job!);
    expect((await work(fx, (context) => loadRecoveryRun(context, fx.agentId, fx.runId)))?.attempt).toBe(1);
  });

  it('requires expected_attempt on Chat Retry and ignores a duplicate arriving after the next failure', async () => {
    const fx = await fixture();
    const { env, created } = environment();
    const path = `/w/${fx.workspaceId}/sessions/${fx.sessionId}/runs/${fx.runId}/retry`;
    const missingAttempt = await asUser(env, fx.adminId, path, { method: 'POST', body: {} });
    expect(missingAttempt.status).toBe(422);
    expect(await missingAttempt.json()).toMatchObject({ reason: 'expected_attempt_required' });
    const retried = await asUser(env, fx.adminId, path, { method: 'POST', body: { expected_attempt: 1 } });
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({ run_id: fx.runId, attempt: 2, status: 'working' });
    await work(fx, async (context) => {
      await context.tx.query("UPDATE runs SET status='error',error=$2::jsonb,ended_at=now() WHERE id=$1", [fx.runId, JSON.stringify(oldError)]);
    });
    const delayedDuplicate = await asUser(env, fx.adminId, path, { method: 'POST', body: { expected_attempt: 1 } });
    expect(delayedDuplicate.status).toBe(201);
    expect(await delayedDuplicate.json()).toMatchObject({ run_id: fx.runId, attempt: 2, status: 'error' });
    expect(created).toHaveLength(1);
    expect((await work(fx, (context) => loadRecoveryRun(context, fx.agentId, fx.runId)))?.attempt).toBe(2);
  });
});
