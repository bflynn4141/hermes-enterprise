import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EngineRunRow } from '../../src/engine/agent-db.js';
import { agentCashPeopleSearchArguments } from '../../src/partner-screening/agentcash-people.js';
import { partnerAgentConfigSchema } from '../../src/partner-screening/config.js';
import { bridgeToken } from '../../src/runtime/config.js';
import { RuntimeDb } from '../../src/runtime/store.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';
import { call, makeEnv, readTenant } from './harness.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('paid lease admission versus retry', () => {
  it('rejects a stale active-run lookup when retry advances the attempt before payment reservation', async () => {
    const fx = await seedWorkspace();
    const screeningId = randomUUID();
    const runId = randomUUID();
    const oldNativeId = `run_${'a'.repeat(32)}`;
    const newNativeId = `run_${'b'.repeat(32)}`;
    const config = partnerAgentConfigSchema.parse({
      source: 'agentcash_people', source_purpose: 'person_partner_research', organization_only: false,
      no_outreach: true, role_label: 'Partner', keywords: ['artificial intelligence'],
      people_search: { current_position_seniority_level: ['Founder'] },
      max_api_requests: 1, max_spend_usd: 0.15,
    });
    const { env } = makeEnv({
      AGENT_RUNTIME: 'hermes', HERMES_BRIDGE_SECRET: 'paid-retry-concurrency-test-secret-123456789',
      HERMES_RUNTIME_AGENTS: JSON.stringify({ [fx.agentId]: {
        workspace_id: fx.workspaceId, base_url: 'https://runtime.example/v1', api_key: 'test-runtime-key',
      } }),
    });
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO partner_screening_runs
           (id,workspace_id,agent_id,created_by,idempotency_key,source,authentication,config_snapshot,api_requests_max)
         VALUES($1,$2,$3,$4,$5,'agentcash_people','wallet',$6::jsonb,1)`,
        [screeningId, fx.workspaceId, fx.agentId, fx.adminId, `race:${screeningId}`, JSON.stringify(config)],
      );
      await client.query(
        `INSERT INTO runs
           (id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,mode,runtime_kind,runtime_run_id,runtime_attempt)
         VALUES($1,$2,$3,$4,'working','deepseek-flash',$5,'work','hermes',$6,1)`,
        [runId, fx.workspaceId, fx.sessionId, fx.agentId, `partner-screening:${screeningId}`, oldNativeId],
      );
      await client.query('COMMIT');
    });

    const cachedRead = deferred<EngineRunRow | null>();
    const continueAuthorization = deferred<void>();
    const originalLookup = RuntimeDb.prototype.findRuntimeRun;
    const lookup = vi.spyOn(RuntimeDb.prototype, 'findRuntimeRun').mockImplementation(async function (
      this: RuntimeDb, nativeId: string, agentId: string,
    ) {
      const result = await originalLookup.call(this, nativeId, agentId);
      if (nativeId === oldNativeId && agentId === fx.agentId) {
        cachedRead.resolve(result);
        await continueAuthorization.promise;
      }
      return result;
    });
    let response: Promise<Response> | undefined;
    try {
      response = call(env, `/internal/runtime/w/${fx.workspaceId}/agents/${fx.agentId}/agentcash/people-search/authorize`, {
        method: 'POST', origin: null,
        headers: { Authorization: `Bearer ${await bridgeToken(env, fx.workspaceId, fx.agentId)}` },
        body: { runtime_run_id: oldNativeId, tool_call_id: 'stale-paid-call', arguments: agentCashPeopleSearchArguments(config) },
      });
      const cached = await Promise.race([
        cachedRead.promise,
        response.then((result) => { throw new Error(`Authorization returned ${result.status} before reading the active run`); }),
      ]);
      expect(cached).toMatchObject({ id: runId, status: 'working', attempt: 1 });

      // The preliminary lookup has really read Postgres. Hold that cached
      // value while another transaction commits a retry's new attempt/map.
      await withClient('owner', async (client) => {
        await client.query('BEGIN');
        await setTenant(client, fx.workspaceId, fx.adminId);
        await client.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE', [runId]);
        await client.query('UPDATE runs SET attempt=2,runtime_attempt=2,runtime_run_id=$2 WHERE id=$1', [runId, newNativeId]);
        await client.query('COMMIT');
      });
      continueAuthorization.resolve();
      const rejected = await response;
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ reason: 'runtime_run_inactive' });
      await readTenant(fx.workspaceId, fx.adminId, async (client) => {
        expect((await client.query('SELECT api_requests_used,agentcash_tool_call_id FROM partner_screening_runs WHERE id=$1', [screeningId])).rows[0])
          .toEqual({ api_requests_used: 0, agentcash_tool_call_id: null });
        expect((await client.query('SELECT attempt,runtime_run_id FROM runs WHERE id=$1', [runId])).rows[0])
          .toEqual({ attempt: 2, runtime_run_id: newNativeId });
      });
    } finally {
      continueAuthorization.resolve();
      await response?.catch(() => undefined);
      lookup.mockRestore();
    }
  });
});
