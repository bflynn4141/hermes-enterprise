import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import type { Tx } from '../../src/db/client.js';
import { sealSecret } from '../../src/keys/envelope.js';
import { dynamicRuntimeBinding, resolveRuntimeBinding } from '../../src/runtime/config.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const KEK_V1 = Buffer.alloc(32, 37).toString('base64');
const CONTROL_NAMESPACE = 'hermes/runtime-control/v1';

function runtimeEnv(fixture: Fixture): Env {
  return {
    ENVIRONMENT: 'development',
    AGENT_RUNTIME: 'hermes',
    HERMES_BRIDGE_SECRET: 'runtime-capacity-admission-test'.padEnd(32, '!'),
    HERMES_RUNTIME_AGENTS: JSON.stringify({
      [fixture.agentId]: {
        workspace_id: fixture.workspaceId,
        base_url: 'https://fixed-runtime.example.test',
        api_key: 'fixed-runtime-test-key',
        transport: 'native',
        assignment: 'fixed',
      },
    }),
    KEK_V1,
  } as Env;
}

async function insertDynamicBinding(fixture: Fixture, env: Env, apiKey = 'dynamic-runtime-test-key'): Promise<void> {
  const envelope = await sealSecret(
    env,
    { workspaceId: fixture.workspaceId, keyId: fixture.agentId, namespace: CONTROL_NAMESPACE },
    apiKey,
  );
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fixture.workspaceId, fixture.adminId);
    await client.query(
      `INSERT INTO agent_runtime_bindings
         (workspace_id, agent_id, profile, base_url, transport, assignment, agentcash,
          ciphertext, iv, wrapped_dek, wrap_iv, kek_version, ready_at)
       VALUES ($1,$2,$3,$4,'native','provisioned',false,$5,$6,$7,$8,$9,now())`,
      [
        fixture.workspaceId,
        fixture.agentId,
        `agent-${fixture.agentId}`,
        'https://dynamic-runtime.example.test',
        Buffer.from(envelope.ciphertext),
        Buffer.from(envelope.iv),
        Buffer.from(envelope.wrappedDek),
        Buffer.from(envelope.wrapIv),
        envelope.kekVersion,
      ],
    );
    await client.query('COMMIT');
  });
}

async function quarantineCapacity(fixture: Fixture): Promise<void> {
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fixture.workspaceId, fixture.adminId);
    const capacityId = randomUUID();
    await client.query(
      `INSERT INTO hermes_cloud_capacity
         (id, workspace_id, cloud_agent_id, instance_name, preflight_agent_id,
          connector_url, state, assigned_agent_id,
          ciphertext, iv, wrapped_dek, wrap_iv, kek_version, plugin_version,
          agentcash_enabled, agentcash_wallet_present, native_cron_disabled,
          readiness_checked_at, last_health_checked_at, quarantined_at, quarantine_reason)
       VALUES ($1,$2,$3,$4,$5,$6,'quarantined',$7,
               '\\x00','\\x00','\\x00','\\x00',1,'test',false,false,false,
               now(),now(),now(),'runtime admission regression')`,
      [
        capacityId,
        fixture.workspaceId,
        `cloud-${capacityId}`,
        `capacity-${capacityId}`,
        randomUUID(),
        `https://capacity-${capacityId}.example.test/control`,
        fixture.agentId,
      ],
    );
    await client.query('COMMIT');
  });
}

async function asAgent<T>(fixture: Fixture, fn: (tx: Pick<Tx, 'query'>) => Promise<T>): Promise<T> {
  return withClient('agent', async (client) => {
    await client.query('BEGIN');
    try {
      await setTenant(client, fixture.workspaceId, fixture.adminId);
      return await fn(client as unknown as Pick<Tx, 'query'>);
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

async function expectAgentDenied(fixture: Fixture, sql: string): Promise<void> {
  await withClient('agent', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fixture.workspaceId, fixture.adminId);
    try {
      await client.query(sql, [fixture.workspaceId]);
      throw new Error('expected the agent role query to be denied');
    } catch (error) {
      expect(error).toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

describe('runtime capacity admission grants', () => {
  it('lets the agent role evaluate capacity and fall back to a fixed binding when no dynamic row exists', async () => {
    const fixture = await seedWorkspace();
    const binding = await asAgent(fixture, (tx) => resolveRuntimeBinding(
      runtimeEnv(fixture),
      tx,
      fixture.workspaceId,
      fixture.agentId,
    ));

    expect(binding).toMatchObject({
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      baseUrl: 'https://fixed-runtime.example.test',
      apiKey: 'fixed-runtime-test-key',
      assignment: 'fixed',
    });
  });

  it('resolves a ready dynamic binding through the actual agent database role', async () => {
    const fixture = await seedWorkspace();
    const env = runtimeEnv(fixture);
    await insertDynamicBinding(fixture, env);

    const binding = await asAgent(fixture, (tx) => dynamicRuntimeBinding(
      env,
      tx,
      fixture.workspaceId,
      fixture.agentId,
      true,
    ));

    expect(binding).toMatchObject({
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      baseUrl: 'https://dynamic-runtime.example.test',
      apiKey: 'dynamic-runtime-test-key',
      assignment: 'provisioned',
    });
  });

  it('rejects a ready dynamic binding when its assigned capacity is quarantined', async () => {
    const fixture = await seedWorkspace();
    const env = runtimeEnv(fixture);
    await insertDynamicBinding(fixture, env);
    await quarantineCapacity(fixture);

    await expect(asAgent(fixture, (tx) => dynamicRuntimeBinding(
      env,
      tx,
      fixture.workspaceId,
      fixture.agentId,
      true,
    ))).rejects.toMatchObject({ reason: 'runtime_not_configured', status: 503 });
  });

  it('keeps another tenant capacity and binding invisible to the agent role', async () => {
    const visible = await seedWorkspace();
    const other = await seedWorkspace();
    const env = runtimeEnv(other);
    await insertDynamicBinding(other, env);
    await quarantineCapacity(other);

    const binding = await asAgent(visible, (tx) => dynamicRuntimeBinding(
      env,
      tx,
      other.workspaceId,
      other.agentId,
      true,
    ));
    expect(binding).toBeNull();

    const capacity = await withClient('agent', async (client) => {
      await client.query('BEGIN');
      try {
        await setTenant(client, visible.workspaceId, visible.adminId);
        return (await client.query(
          `SELECT workspace_id, assigned_agent_id, state
             FROM hermes_cloud_capacity WHERE workspace_id=$1`,
          [other.workspaceId],
        )).rows;
      } finally {
        await client.query('ROLLBACK');
      }
    });
    expect(capacity).toEqual([]);
  });

  it('does not expose capacity credentials or allow capacity mutation', async () => {
    const fixture = await seedWorkspace();
    await expectAgentDenied(
      fixture,
      'SELECT ciphertext FROM hermes_cloud_capacity WHERE workspace_id=$1',
    );
    await expectAgentDenied(
      fixture,
      "UPDATE hermes_cloud_capacity SET state='quarantined' WHERE workspace_id=$1",
    );
    await expectAgentDenied(
      fixture,
      'INSERT INTO hermes_cloud_capacity (workspace_id) VALUES ($1)',
    );
  });
});
