// Pure pieces of the Admin agent directory: runtime placement labels and the
// deployment runtime map, which must be read without exposing its secrets.
import { describe, expect, it } from 'vitest';
import { agentDirectoryEntrySchema } from '@hermes/shared';
import { deploymentRuntimeAgentIds, runtimePlacement } from '../../src/domain/agent-directory.js';

const WS = '00000000-0000-4000-8000-000000000001';
const AGENT = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const empty = { capacity_label: null, capacity_state: null, provisioning_label: null, provisioning_status: null, binding_ready: false };

describe('runtime placement', () => {
  it('names a Cloud pool instance and says whether it is connected', () => {
    expect(runtimePlacement({ ...empty, capacity_label: 'hermes-pool-03', capacity_state: 'assigned', binding_ready: true }, false))
      .toEqual({ source: 'cloud_capacity', label: 'hermes-pool-03', state: 'connected' });
    expect(runtimePlacement({ ...empty, capacity_label: 'hermes-pool-05', capacity_state: 'quarantined' }, false))
      .toEqual({ source: 'cloud_capacity', label: 'hermes-pool-05', state: 'failed' });
  });

  it('tells a provisioned instance that is still being created from a failed one', () => {
    expect(runtimePlacement({ ...empty, provisioning_label: 'iris-dana', provisioning_status: 'creating' }, false))
      .toEqual({ source: 'cloud_provisioned', label: 'iris-dana', state: 'setting_up' });
    expect(runtimePlacement({ ...empty, provisioning_label: 'iris-dana', provisioning_status: 'failed' }, false).state).toBe('failed');
  });

  it('treats an operator-configured runtime as connected and nothing as not connected', () => {
    expect(runtimePlacement(empty, true)).toEqual({ source: 'deployment', label: null, state: 'connected' });
    expect(runtimePlacement(empty, false)).toEqual({ source: 'none', label: null, state: 'not_connected' });
  });
});

describe('deployment runtime map', () => {
  it('reads only which agents this workspace has, never the URL or key', () => {
    const raw = JSON.stringify({
      [AGENT]: { workspace_id: WS, base_url: 'https://secret-host.example.test', api_key: 'sk-secret' },
      [OTHER]: { workspace_id: 'another-workspace', base_url: 'https://x.example.test', api_key: 'k' },
    });
    expect([...deploymentRuntimeAgentIds(raw, WS)]).toEqual([AGENT]);
  });

  it('answers empty for a missing or malformed map instead of failing the page', () => {
    expect(deploymentRuntimeAgentIds(undefined, WS).size).toBe(0);
    expect(deploymentRuntimeAgentIds('not json', WS).size).toBe(0);
    expect(deploymentRuntimeAgentIds('[1,2]', WS).size).toBe(0);
  });
});

describe('directory contract', () => {
  it('refuses any field that could carry run content', () => {
    const entry = {
      id: AGENT, name: 'Ledger', responsibility: null, status: 'started', context_scope: 'private',
      owner: null, role: null, skills: [], runtime: { source: 'none', label: null, state: 'not_connected' },
      approvals: { revision: 0, required: [] }, viewer: { can_configure: true, can_view_conversations: false },
    };
    expect(agentDirectoryEntrySchema.safeParse(entry).success).toBe(true);
    for (const extra of ['sessions', 'last_message', 'pending_approvals', 'runs']) {
      expect(agentDirectoryEntrySchema.safeParse({ ...entry, [extra]: [] }).success, extra).toBe(false);
    }
  });
});
