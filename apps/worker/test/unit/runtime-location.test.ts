import { describe, expect, it } from 'vitest';
import { inviteeRuntimeAgentIds, runtimeBindings, runtimeLocation } from '../../src/runtime/config.js';

const ws = '11111111-1111-4111-8111-111111111111';
const agent = '44444444-4444-4444-8444-444444444444';
const env = (baseUrl: string) => ({ ENVIRONMENT: 'development', AGENT_RUNTIME: 'hermes',
  HERMES_BRIDGE_SECRET: 'test-only-secret-longer-than-32-characters',
  HERMES_RUNTIME_AGENTS: JSON.stringify({ [agent]: { workspace_id: ws, base_url: baseUrl, api_key: 'test' } }),
});

describe('session execution location after a runtime rollout', () => {
  it('replaces an old Cloud label when the agent is now local', () => {
    expect(runtimeLocation(env('http://127.0.0.1:8642'), ws, agent, 'cloud')).toBe('local');
  });
  it('replaces an old Local label when the agent is now hosted', () => {
    expect(runtimeLocation(env('https://runtime.example'), ws, agent, 'local')).toBe('cloud');
  });
  it('keeps history accessible when a profile has not been configured', () => {
    expect(runtimeLocation({ ...env('https://runtime.example'), HERMES_RUNTIME_AGENTS: '{}' }, ws, agent, 'cloud')).toBe('cloud');
    expect(runtimeLocation({ ...env('https://runtime.example'), AGENT_RUNTIME: 'legacy' }, ws, agent, 'local')).toBe('local');
  });

  it('enumerates and validates configured profiles for deployment health', () => {
    expect(runtimeBindings(env('https://runtime.example'))).toEqual([{
      workspaceId: ws,
      agentId: agent,
      profile: `agent-${agent}`,
      baseUrl: 'https://runtime.example',
      apiKey: 'test',
      transport: 'native',
      assignment: 'fixed',
      agentCash: false,
      runtimeAuthMode: 'legacy_hmac',
      runtimeCredentialDigest: null,
    }]);
  });

  it('enumerates only explicitly attested AgentCash invitee capacity for this workspace', () => {
    const poolAgent = '55555555-5555-4555-8555-555555555555';
    const otherAgent = '66666666-6666-4666-8666-666666666666';
    const configured = {
      ...env('https://runtime.example'),
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [agent]: { workspace_id: ws, base_url: 'https://fixed.example', api_key: 'fixed' },
        [poolAgent]: { workspace_id: ws, base_url: 'https://pool.example', api_key: 'pool', assignment: 'invitee_pool', agentcash: true },
        [otherAgent]: { workspace_id: ws, base_url: 'https://not-ready.example', api_key: 'other', assignment: 'invitee_pool' },
      }),
    };
    expect(inviteeRuntimeAgentIds(configured, ws)).toEqual([poolAgent]);
  });

  it('fails health configuration when Hermes is enabled without a profile', () => {
    expect(() => runtimeBindings({ ...env('https://runtime.example'), HERMES_RUNTIME_AGENTS: '{}' })).toThrow(
      'official Hermes runtime is not configured',
    );
  });
});
