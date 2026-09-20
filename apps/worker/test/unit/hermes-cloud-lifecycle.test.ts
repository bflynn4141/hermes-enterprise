import { describe, expect, it } from 'vitest';
import {
  cloudAgentProvisioningName,
  dispatchCloudAgentCreation,
  inspectCloudProvisioningSupport,
  listCloudAgents,
  reconcileCloudAgentCreation,
} from '../../src/hermes-cloud/lifecycle.js';
import { CLOUD_RESOURCE, CLOUD_SCOPE, type CloudToolContract } from '../../src/hermes-cloud/management.js';

const credential = { accessToken: 'test-access-not-a-real-token', scope: CLOUD_SCOPE };
const operationId = 'e9091a44-4720-43cf-991b-532021db04d2';
const cloudName = `hermes-${operationId}`;
const agent = {
  id: 'cloud-agent-id', name: cloudName, status: 'running', region: 'iad', model: 'test-model',
  createdAt: '2026-09-19T00:00:00.000Z', health: 'healthy', healthDetail: 'ready',
  dashboardUrl: 'https://agent.example/', lastError: null, scheduledDeletionAt: null,
};

type ToolCall = { name: string; arguments: Record<string, unknown> };
function transport(handler: (call: ToolCall) => Record<string, unknown>): { fetcher: typeof fetch; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(CLOUD_RESOURCE);
    expect(init?.redirect).toBe('manual');
    const body = JSON.parse(String(init?.body)) as { id?: string; method: string; params?: ToolCall };
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } }, { headers: { 'mcp-session-id': 'session' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    expect(body.method).toBe('tools/call');
    const call = body.params as ToolCall;
    calls.push(call);
    const payload = handler(call);
    return Response.json({ jsonrpc: '2.0', id: body.id,
      result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false } });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('Cloud lifecycle reconciliation boundary', () => {
  it('derives a stable provider reconciliation name from the durable operation', () => {
    expect(cloudAgentProvisioningName(operationId)).toBe(cloudName);
    expect(() => cloudAgentProvisioningName('not-an-operation')).toThrow('cloud_contract_invalid');
  });

  it('lists only validated provider records', async () => {
    const { fetcher } = transport(call => {
      expect(call).toEqual({ name: 'agents', arguments: { action: 'list' } });
      return { agents: [agent] };
    });
    expect(await listCloudAgents(credential, fetcher)).toEqual([agent]);
  });

  it('reconciles an existing deterministic instance without creating another', async () => {
    const { fetcher, calls } = transport(call => ({ agents: call.name === 'agents' ? [agent] : [] }));
    await expect(dispatchCloudAgentCreation(credential, { operationId, size: 'medium' }, fetcher))
      .resolves.toMatchObject({ kind: 'confirmed', agent, reconciled: true });
    expect(calls).toEqual([{ name: 'agents', arguments: { action: 'list' } }]);
  });

  it('dispatches one create with only the reviewed schema fields', async () => {
    const { fetcher, calls } = transport(call => call.name === 'agents' ? { agents: [] } : { agent });
    await expect(dispatchCloudAgentCreation(credential, {
      operationId, size: 'medium', region: 'iad', model: 'test-model', env: { ENTERPRISE_MODE: '1' },
    }, fetcher)).resolves.toMatchObject({ kind: 'confirmed', agent, reconciled: false });
    expect(calls).toEqual([
      { name: 'agents', arguments: { action: 'list' } },
      { name: 'agent', arguments: { action: 'create', name: cloudName, size: 'medium', region: 'iad',
        model: 'test-model', env: { ENTERPRISE_MODE: '1' } } },
    ]);
  });

  it('turns an uncertain create response into reconciliation instead of replay', async () => {
    const { fetcher, calls } = transport(call => {
      if (call.name === 'agents') return { agents: [] };
      throw new Error('connection lost after dispatch');
    });
    await expect(dispatchCloudAgentCreation(credential, { operationId, size: 'medium' }, fetcher))
      .resolves.toEqual({ kind: 'reconciliation_required', cloudName });
    expect(calls.map(call => call.name)).toEqual(['agents', 'agent']);
  });

  it('keeps a missing dispatched operation pending and never calls create', async () => {
    const { fetcher, calls } = transport(() => ({ agents: [] }));
    await expect(reconcileCloudAgentCreation(credential, operationId, fetcher))
      .resolves.toEqual({ kind: 'pending', cloudName });
    expect(calls).toEqual([{ name: 'agents', arguments: { action: 'list' } }]);
  });

  it('fails closed on duplicate names or a mismatched create response', async () => {
    const duplicate = transport(() => ({ agents: [agent, { ...agent, id: 'other' }] }));
    await expect(reconcileCloudAgentCreation(credential, operationId, duplicate.fetcher))
      .rejects.toThrow('cloud_contract_invalid');
    const mismatch = transport(call => call.name === 'agents' ? { agents: [] } : { agent: { ...agent, name: 'other' } });
    await expect(dispatchCloudAgentCreation(credential, { operationId, size: 'medium' }, mismatch.fetcher))
      .rejects.toThrow('cloud_contract_invalid');
  });

  it('separates supported billing/lifecycle primitives from missing governed bootstrap', () => {
    const contract = (name: string, actions: string[]): CloudToolContract => ({ name,
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: actions } } } });
    expect(inspectCloudProvisioningSupport([
      contract('agents', ['list', 'get', 'status', 'cost_estimate']),
      contract('agent', ['create', 'start', 'stop', 'restart', 'destroy', 'update_env', 'update_image']),
      contract('usage', ['transactions', 'hourly', 'daily']),
      contract('service_credentials', ['create', 'list', 'revoke']),
    ])).toEqual({ lifecycle: true, organizationUsage: true, unattendedCredentials: true,
      governedBootstrap: false, automaticProvisioningReady: false });
  });
});
