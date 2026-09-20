import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_ID } from '@hermes/shared';
import type { Tx } from '../../src/db/client.js';
import type { Env } from '../../src/env.js';
import type { Job } from '../../src/jobs.js';
import { syncNousPortalCatalog } from '../../src/model/nous-catalog.js';
import { NOUS_PORTAL_FIXTURE_MODELS } from '../../src/model/nous-dev.js';
import { sealSecret } from '../../src/keys/envelope.js';
import { RuntimeDb } from '../../src/runtime/store.js';
import {
  loadRecoveryRun, recoveryView, retryTask, runRecoveryJob, scheduleRunRecovery, wakeAuthorizedWork,
  type RecoveryWork,
} from '../../src/runs/recovery.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { asUser, makeEnv, readTenant } from './harness.js';

const OLD_MODEL = 'deepseek-flash';
const RECOVERY_KEK = Buffer.alloc(32, 61).toString('base64');
const CONTROL_NAMESPACE = 'hermes/runtime-control/v1';
const oldError = { reason: 'hermes_provider_unavailable', message: 'The model is temporarily unavailable.', retryable: true, class: 'transient' };
const sourcePolicy = {
  source: 'github', source_purpose: 'organization_partner_research', organization_only: true,
  no_outreach: true, role_label: 'Partner', search_queries: ['topic:agents'], keywords: ['agents'],
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeAll(async () => {
  await withClient('owner', async (client) => {
    await syncNousPortalCatalog(client as unknown as Tx, NOUS_PORTAL_FIXTURE_MODELS);
  });
});

function environment(overrides: Partial<Env> = {}) {
  const created: unknown[] = [];
  const { env } = makeEnv({
    MODEL_SCRIPTED: '1', AGENT_RUNTIME: 'hermes', ALLOWED_PROVIDERS: 'nous_portal,openrouter,deepseek',
    AUTOMATED_TRIGGERS_ENABLED: '1', PARTNER_SCREENING_AUTOMATION_INTERVAL_MINUTES: '360',
    PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(sourcePolicy),
    RUN_ATTEMPT: { create: async (value: unknown) => { created.push(value); return { id: 'test-instance' }; } } as unknown as Env['RUN_ATTEMPT'],
    ...overrides,
  });
  return { env, created };
}

const capabilities = () => ({
  object: 'hermes.api_server.capabilities', platform: 'hermes-agent',
  auth: { type: 'bearer', required: true },
  runtime: { mode: 'server_agent', tool_execution: 'server', split_runtime: false },
  features: {
    run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_steer: true,
    runs_idempotency: { supported: true, durable: true, retention_seconds: 86_400 },
  },
  endpoints: {
    runs: { method: 'POST', path: '/v1/runs' },
    run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
    run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
    run_steer: { method: 'POST', path: '/v1/runs/{run_id}/steer' },
    run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
  },
  enterprise_contract: {
    schema_version: 1,
    source_revision: '345cd2b057a452236de401d3534b8502a7465e8d',
    release_ring: 'stable',
    terminal_errors: { supported: true, schema_version: 1 },
  },
});

async function managedEnvironment(fx: Fixture & { runId: string }) {
  const result = environment({
    MODEL_SCRIPTED: '0', AGENT_RUNTIME: 'hermes', KEK_V1: RECOVERY_KEK,
    HERMES_BRIDGE_SECRET: 'automatic-recovery-managed-runtime-test'.padEnd(32, '!'),
  });
  const envelope = await sealSecret(
    result.env,
    { workspaceId: fx.workspaceId, keyId: fx.agentId, namespace: CONTROL_NAMESPACE },
    'managed-runtime-test-key',
  );
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    await client.query(
      `INSERT INTO workspace_provider_keys
         (workspace_id,provider,label,ciphertext,iv,wrapped_dek,wrap_iv,kek_version,fingerprint,last4,status,verified_at)
       VALUES ($1,'deepseek','Recovery test','\\x00','\\x00','\\x00','\\x00',1,$2,'test','verified',now())`,
      [fx.workspaceId, `recovery-${fx.runId}`],
    );
    await client.query(
      `INSERT INTO agent_runtime_bindings
         (workspace_id,agent_id,profile,base_url,transport,assignment,agentcash,
          ciphertext,iv,wrapped_dek,wrap_iv,kek_version,runtime_credential_digest,runtime_auth_mode,ready_at)
       VALUES ($1,$2,$3,'https://managed-runtime.example.test','native','provisioned',false,
               $4,$5,$6,$7,$8,decode(repeat('01',32),'hex'),'token_digest',now())`,
      [fx.workspaceId, fx.agentId, `agent-${fx.agentId}`, Buffer.from(envelope.ciphertext), Buffer.from(envelope.iv),
        Buffer.from(envelope.wrappedDek), Buffer.from(envelope.wrapIv), envelope.kekVersion],
    );
    await client.query('COMMIT');
  });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(capabilities())));
  return result;
}

afterEach(() => vi.unstubAllGlobals());

async function fixture(options: {
  scheduled?: boolean;
  directory?: boolean;
  attempt?: number;
  cancelled?: boolean;
  paymentPending?: boolean;
  rateLimited?: boolean;
  retryNotBefore?: Date;
} = {}) {
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
    if (options.scheduled || options.directory) await client.query(
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
          trace_id,error,ended_at,recovery_cancelled,recovery_not_before)
       VALUES ($1,$2,$3,$4,'error',$5,'high',$6,'work',$7,$8,$9::jsonb,now()-interval '10 minutes',$10,$11)`,
      [runId, fx.workspaceId, fx.sessionId, fx.agentId, OLD_MODEL,
        options.scheduled || options.paymentPending ? `partner-screening:${screeningId}` : randomUUID(),
        options.attempt ?? 1, traceId, JSON.stringify(options.rateLimited
          ? { ...oldError, reason: 'hermes_provider_rate_limited', message: 'The selected model is rate limited. Wait a moment, then retry.' }
          : oldError), options.cancelled ?? false, options.retryNotBefore ?? null],
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

async function recordReadOnlyResult(fx: Fixture & { runId: string }): Promise<void> {
  await work(fx, async (context) => {
    await context.tx.query(
      `INSERT INTO run_steps (workspace_id,run_id,turn,step_id,label,state,tool_call_id)
       VALUES ($1,$2,0,'hermes-tool-1','list_partner_candidates','done','approved-read')`,
      [fx.workspaceId,fx.runId],
    );
    await context.tx.query(
      `INSERT INTO run_turns (workspace_id,run_id,turn,seq,role,provider_message)
       VALUES ($1,$2,0,0,'assistant',$3::jsonb),($1,$2,0,1,'tool',$4::jsonb)`,
      [fx.workspaceId,fx.runId,
        JSON.stringify({ role: 'assistant', content: '', tool_calls: [{ id: 'approved-read', name: 'list_partner_candidates', arguments: '{"limit":1,"minimum_priority":100}' }] }),
        JSON.stringify({ role: 'tool', tool_call_id: 'approved-read', content: '{"candidates":[]}' })],
    );
  });
}

describe('durable run recovery admission', () => {
  it('pins the failed attempt model and effort while preserving its provenance', async () => {
    const fx = await fixture();
    const { env } = environment();
    const retried = await work(fx, (context) => retryTask(context, env, fx.agentId, fx.runId, 1));
    expect(retried).toMatchObject({ id: fx.runId, attempt: 2, status: 'working', model_id: OLD_MODEL, effort: 'high' });
    const duplicate = await work(fx, (context) => retryTask(context, env, fx.agentId, fx.runId, 1));
    expect(duplicate).toMatchObject({ id: fx.runId, attempt: 2 });
    await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const current = (await client.query('SELECT model_id,attempt,recovery_history FROM runs WHERE id=$1', [fx.runId])).rows[0];
      expect(current.recovery_history).toEqual([expect.objectContaining({ attempt: 1, model_id: OLD_MODEL,
        trace_id: fx.traceId, reason: 'hermes_provider_unavailable', next_model_id: OLD_MODEL, trigger: 'manual' })]);
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
    const eligible = await fixture({ directory: true, rateLimited: true, attempt: 2 });
    await recordReadOnlyResult(eligible);
    const capped = await fixture({ scheduled: true, attempt: 3 });
    const cancelled = await fixture({ scheduled: true, cancelled: true });
    const { env, created } = await managedEnvironment(eligible);
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
    const lateCancel = await fixture({ directory: true,rateLimited: true });
    await recordReadOnlyResult(lateCancel);
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

  it('fails closed instead of automatically replaying a task without a response-only contract', async () => {
    const direct = await fixture({ directory: true, rateLimited: true });
    const { env, created } = environment();
    await expect(work(direct,(context) => retryTask(context,env,direct.agentId,direct.runId,1,true)))
      .rejects.toMatchObject({ reason: 'automatic_recovery_requires_response_only',status: 409 });
    const fx = await fixture({ directory: true, rateLimited: true });
    const partner = await fixture({ scheduled: true,rateLimited: true });
    await scheduleRunRecovery(env);
    expect(await recoveryJob(fx)).toBeUndefined();
    expect(await recoveryJob(partner)).toBeUndefined();
    expect(created).toHaveLength(0);
    await readTenant(fx.workspaceId,fx.adminId,async client => {
      expect((await client.query(
        'SELECT attempt,recovery_cancelled,recovery_next_at,recovery_blocked_reason FROM runs WHERE id=$1',
        [fx.runId],
      )).rows[0]).toEqual({
        attempt: 1,recovery_cancelled: true,recovery_next_at: null,
        recovery_blocked_reason: 'automatic_recovery_requires_response_only',
      });
    });
    await readTenant(partner.workspaceId,partner.adminId,async client => {
      expect((await client.query(
        'SELECT attempt,recovery_cancelled,recovery_blocked_reason FROM runs WHERE id=$1',
        [partner.runId],
      )).rows[0]).toEqual({
        attempt: 1,recovery_cancelled: true,
        recovery_blocked_reason: 'automatic_recovery_requires_response_only',
      });
    });
  });

  it.each([undefined, 'legacy' as const])(
    'rejects response-only automatic admission on a %s deployment before runtime dispatch',
    async (runtime) => {
      const fx = await fixture({ directory: true, rateLimited: true });
      await recordReadOnlyResult(fx);
      const upstream = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', upstream);
      const { env, created } = environment({ MODEL_SCRIPTED: '0', AGENT_RUNTIME: runtime });
      await expect(work(fx, (context) => retryTask(context, env, fx.agentId, fx.runId, 1, true)))
        .rejects.toMatchObject({ reason: 'automatic_recovery_legacy_auth', status: 409 });
      expect(upstream).not.toHaveBeenCalled();
      expect(created).toHaveLength(0);
      await readTenant(fx.workspaceId, fx.adminId, async (client) => {
        expect((await client.query(
          'SELECT attempt,status,automatic_recovery FROM runs WHERE id=$1', [fx.runId],
        )).rows[0]).toEqual({ attempt: 1, status: 'error', automatic_recovery: false });
      });
      // Keep this deliberately rejected fixture out of later file-scoped cron
      // scans; production would persist the same choice through Cancel retry.
      await work(fx, (context) => context.tx.query(
        'UPDATE runs SET recovery_cancelled=true WHERE id=$1', [fx.runId],
      ));
    },
  );

  it('atomically refuses to fail a newer or stopped automatic attempt', async () => {
    const fx = await fixture({ directory: true, rateLimited: true });
    await work(fx, (context) => context.tx.query(
      `UPDATE runs SET attempt=3,status='working',stop_requested=false,automatic_recovery=true,error=NULL
        WHERE id=$1`, [fx.runId],
    ));
    const runtime = new RuntimeDb(environment().env, fx.workspaceId, fx.traceId);
    const drift = {
      class: 'permanent', retryable: false, reason: 'automatic_recovery_runtime_drift',
      message: 'The managed runtime changed before automatic recovery could start.',
    };
    try {
      expect(await runtime.failAutomaticRecoveryExecution(fx.runId, 2, drift)).toBe(false);
      await readTenant(fx.workspaceId, fx.adminId, async (client) => {
        expect((await client.query(
          'SELECT attempt,status,error FROM runs WHERE id=$1', [fx.runId],
        )).rows[0]).toEqual({ attempt: 3, status: 'working', error: null });
      });
      await work(fx, (context) => context.tx.query(
        `UPDATE runs SET stop_requested=true,status='stopping' WHERE id=$1`, [fx.runId],
      ));
      expect(await runtime.failAutomaticRecoveryExecution(fx.runId, 3, drift)).toBe(false);
      await readTenant(fx.workspaceId, fx.adminId, async (client) => {
        expect((await client.query(
          'SELECT attempt,status,stop_requested,error FROM runs WHERE id=$1', [fx.runId],
        )).rows[0]).toEqual({ attempt: 3, status: 'stopping', stop_requested: true, error: null });
      });
      await work(fx, (context) => context.tx.query(
        `UPDATE runs SET stop_requested=false,status='working' WHERE id=$1`, [fx.runId],
      ));
      expect(await runtime.failAutomaticRecoveryExecution(fx.runId, 3, drift)).toBe(true);
      await readTenant(fx.workspaceId, fx.adminId, async (client) => {
        expect((await client.query(
          `SELECT attempt,status,recovery_cancelled,recovery_blocked_reason,error->>'reason' AS reason
             FROM runs WHERE id=$1`, [fx.runId],
        )).rows[0]).toEqual({
          attempt: 3, status: 'error', recovery_cancelled: true,
          recovery_blocked_reason: 'automatic_recovery_runtime_drift',
          reason: 'automatic_recovery_runtime_drift',
        });
      });
    } finally {
      await runtime.close();
    }
  });

  it('holds the automatic dispatch fence through binding against both successor and Stop writes', async () => {
    const fx = await fixture({ directory: true, rateLimited: true });
    await work(fx, (context) => context.tx.query(
      `UPDATE runs SET attempt=2,status='working',stop_requested=false,automatic_recovery=true,error=NULL
        WHERE id=$1`,
      [fx.runId],
    ));
    const runtime = new RuntimeDb(environment().env, fx.workspaceId, fx.traceId);
    const locked = deferred();
    const release = deferred();
    const remoteId = `run_${'d'.repeat(32)}`;
    const dispatch = runtime.withRuntimeTransaction(async () => {
      expect(await runtime.lockAutomaticRecoveryExecution(fx.runId, 2)).toBe(true);
      locked.resolve();
      await release.promise;
      expect(await runtime.bindRun(fx.runId, 2, remoteId, fx.runId, `agent-${fx.agentId}`)).toBe(true);
    });
    const contend = async (statement: string) => withClient('owner', async (client) => {
      await client.query('BEGIN');
      try {
        await setTenant(client, fx.workspaceId, fx.adminId);
        await client.query("SET LOCAL lock_timeout='100ms'");
        await client.query(statement, [fx.runId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
    try {
      await locked.promise;
      await expect(contend('UPDATE runs SET attempt=3 WHERE id=$1')).rejects.toThrow(/lock timeout/i);
      await expect(contend("UPDATE runs SET stop_requested=true,status='stopping' WHERE id=$1")).rejects.toThrow(/lock timeout/i);
      release.resolve();
      await dispatch;
      await work(fx, (context) => context.tx.query(
        "UPDATE runs SET stop_requested=true,status='stopping' WHERE id=$1", [fx.runId],
      ));
      await readTenant(fx.workspaceId, fx.adminId, async (client) => {
        expect((await client.query(
          'SELECT attempt,status,stop_requested,runtime_run_id,runtime_attempt FROM runs WHERE id=$1', [fx.runId],
        )).rows[0]).toEqual({
          attempt: 2, status: 'stopping', stop_requested: true,
          runtime_run_id: remoteId, runtime_attempt: 2,
        });
      });
    } finally {
      release.resolve();
      await dispatch.catch(() => undefined);
      await runtime.close();
    }
  });

  it('marks a queued recovery stale when any newer session run completed during cooldown', async () => {
    const fx = await fixture({ directory: true, rateLimited: true });
    await recordReadOnlyResult(fx);
    const { env, created } = await managedEnvironment(fx);
    expect(await scheduleRunRecovery(env)).toMatchObject({ queued: 1 });
    const job = await recoveryJob(fx);
    expect(job).toBeDefined();
    await work(fx, async (context) => {
      await context.tx.query(
        `INSERT INTO runs
           (id,workspace_id,session_id,agent_id,status,model_id,effort,client_turn_id,mode,attempt,
            trace_id,ended_at,created_at)
         VALUES ($1,$2,$3,$4,'completed',$5,'high',$6,'work',1,$7,now(),now())`,
        [randomUUID(),fx.workspaceId,fx.sessionId,fx.agentId,DEFAULT_MODEL_ID,randomUUID(),randomUUID()],
      );
    });
    await runRecoveryJob(env, job!);
    expect(created).toHaveLength(0);
    await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const run = (await client.query(
        'SELECT attempt,status,recovery_cancelled,recovery_next_at,recovery_blocked_reason FROM runs WHERE id=$1',
        [fx.runId],
      )).rows[0];
      expect(run).toEqual({
        attempt: 1, status: 'error', recovery_cancelled: true,
        recovery_next_at: null, recovery_blocked_reason: 'newer_session_run',
      });
    });
  });

  it('waits out provider cooldown and automatically continues an ordinary post-tool 429 without replaying the read', async () => {
    const retryNotBefore = new Date(Date.now() + 10 * 60_000);
    const fx = await fixture({ directory: true, rateLimited: true, retryNotBefore });
    await recordReadOnlyResult(fx);
    const { env, created } = await managedEnvironment(fx);
    env.AUTOMATED_TRIGGERS_ENABLED = '0';

    await expect(work(fx, (context) => retryTask(context, env, fx.agentId, fx.runId, 1)))
      .rejects.toMatchObject({ reason: 'provider_retry_backoff_active', status: 429 });
    expect(await scheduleRunRecovery(env)).toMatchObject({ queued: 1 });
    const job = await recoveryJob(fx);
    expect(job).toBeDefined();
    await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const row = (await client.query(
        `SELECT r.recovery_next_at,j.next_at FROM runs r JOIN jobs j ON j.workspace_id=r.workspace_id
          AND j.kind='run_recovery' AND j.payload->>'run_id'=r.id::text WHERE r.id=$1`,
        [fx.runId],
      )).rows[0];
      expect(row.recovery_next_at.getTime()).toBeGreaterThanOrEqual(retryNotBefore.getTime());
      expect(row.next_at.getTime()).toBeGreaterThanOrEqual(retryNotBefore.getTime());
    });

    await expect(runRecoveryJob(env, job!)).rejects.toThrow('run_recovery_not_due');
    expect(created).toHaveLength(0);

    // The queue runner honors next_at; calling the handler directly here
    // isolates admission after the scheduled deadline without waiting ten minutes.
    await work(fx, (context) => context.tx.query(
      `UPDATE runs SET recovery_not_before=now()-interval '1 second',
         recovery_next_at=now()-interval '1 second' WHERE id=$1`, [fx.runId]));
    await runRecoveryJob(env, job!);
    expect(created).toHaveLength(1);
    await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const run = (await client.query(
        'SELECT attempt,status,model_id,recovery_input,automatic_recovery,recovery_history FROM runs WHERE id=$1', [fx.runId],
      )).rows[0];
      expect(run).toMatchObject({ attempt: 2, status: 'working', model_id: OLD_MODEL, automatic_recovery: true });
      expect(run.recovery_input).toContain('completed tool results already stored in this session');
      expect(run.recovery_input).toContain('Do not repeat completed tool calls');
      expect(run.recovery_history).toEqual([expect.objectContaining({ trigger: 'automatic', reason: 'hermes_provider_rate_limited' })]);
      expect((await client.query('SELECT count(*)::int AS count FROM run_steps WHERE run_id=$1', [fx.runId])).rows[0].count).toBe(1);
      expect((await client.query('SELECT count(*)::int AS count FROM run_turns WHERE run_id=$1', [fx.runId])).rows[0].count).toBe(2);
    });
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
    const eligible = await fixture({ directory: true,rateLimited: true });
    await recordReadOnlyResult(eligible);
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
    expect(await state.json()).toMatchObject({ state: 'retryable', run_id: fx.runId, attempt: 1, can_retry: true, model_id: OLD_MODEL });
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
    const fx = await fixture({ directory: true,rateLimited: true });
    await recordReadOnlyResult(fx);
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
