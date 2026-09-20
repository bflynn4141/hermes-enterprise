import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { PARTNER_INVOICE_REVIEW_DEFINITION } from '../../src/enterprise-skills/registry.js';
import {
  FINANCE_CAPACITY_ROLE,
  FINANCE_DISCOVERY_CONFIG,
  discoveryConfigDigest,
  discoveryProfileDescriptor,
  exactDiscoveryConfig,
  requireCurrentGrantConfig,
  requireExactGrantMetadata,
  type DiscoveryGrantRow,
} from '../../src/runtime/discovery-grants.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const assignmentId = '33333333-3333-4333-8333-333333333333';

function assignment(revision = 1, changes: Record<string, unknown> = {}) {
  return {
    id: assignmentId, agent_id: agentId, agent_name: 'Iris',
    team_id: '44444444-4444-4444-8444-444444444444', team_slug: 'finance', team_name: 'Finance',
    artifact_id: '55555555-5555-4555-8555-555555555555',
    artifact_digest: PARTNER_INVOICE_REVIEW_DEFINITION.artifactDigest,
    skill_key: PARTNER_INVOICE_REVIEW_DEFINITION.key,
    skill_version: PARTNER_INVOICE_REVIEW_DEFINITION.version,
    state: 'active', config: { ...FINANCE_DISCOVERY_CONFIG },
    capability_grants: [...PARTNER_INVOICE_REVIEW_DEFINITION.defaultCapabilityGrants],
    schedule: { enabled: false, interval_minutes: 360 },
    approval_policy: { human_review_required: true },
    revision, updated_at: new Date('2026-09-19T00:00:00Z'),
    ...changes,
  };
}

function grant(configDigest: string, changes: Partial<DiscoveryGrantRow> = {}): DiscoveryGrantRow {
  return {
    id: '66666666-6666-4666-8666-666666666666', workspace_id: workspaceId, agent_id: agentId,
    credential_digest: new Uint8Array(32), role_template_key: 'finance-agent', role_template_version: '1.0.0',
    skill_key: PARTNER_INVOICE_REVIEW_DEFINITION.key,
    skill_version: PARTNER_INVOICE_REVIEW_DEFINITION.version,
    runtime_name: PARTNER_INVOICE_REVIEW_DEFINITION.runtimeName,
    artifact_digest: PARTNER_INVOICE_REVIEW_DEFINITION.artifactDigest,
    assignment_id: null, assignment_revision: null, config_digest: configDigest,
    grant_revision: 1, linked_capacity_id: null,
    expires_at: new Date('2999-01-01T00:00:00Z'), revoked_at: null, consumed_at: null,
    capacity_state: null,
    ...changes,
  };
}

describe('role-aware discovery grants', () => {
  it('defines the exact Finance tuple and default preflight config without creating an assignment', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const profile = await exactDiscoveryConfig(
      {} as Env, { query } as never, workspaceId, agentId, FINANCE_CAPACITY_ROLE,
    );

    expect(profile).toMatchObject({
      descriptor: {
        roleTemplateKey: 'finance-agent', roleTemplateVersion: '1.0.0', expectsAgentCash: false,
        definition: {
          key: 'partner-invoice-review', version: '1.0.1',
          runtimeName: 'enterprise_bridge:partner-invoice-review',
          artifactDigest: 'sha256:bdb13d70f7a603f92eb47fc2d1c057c82f26658e61df8cf357790f23875753e4',
        },
      },
      config: FINANCE_DISCOVERY_CONFIG,
      assignmentId: null, assignmentRevision: null,
    });
    expect(profile.configDigest).toBe(await discoveryConfigDigest({
      role_template_key: 'finance-agent', role_template_version: '1.0.0',
      config: FINANCE_DISCOVERY_CONFIG,
    }));
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('rejects cross-role or tuple drift before readiness can use it', async () => {
    const digest = await discoveryConfigDigest({
      role_template_key: 'finance-agent', role_template_version: '1.0.0',
      config: FINANCE_DISCOVERY_CONFIG,
    });
    expect(() => requireExactGrantMetadata(grant(digest))).not.toThrow();
    for (const changed of [
      { role_template_key: 'partnerships-agent' as const },
      { skill_version: '1.0.0' },
      { runtime_name: 'enterprise_bridge:partner-program-screening' },
      { artifact_digest: `sha256:${'0'.repeat(64)}` },
    ]) {
      expect(() => requireExactGrantMetadata(grant(digest, changed))).toThrowError(
        expect.objectContaining({ reason: 'discovery_profile_changed' }),
      );
    }
    expect(() => discoveryProfileDescriptor({
      roleTemplateKey: 'finance-agent', roleTemplateVersion: '9.9.9' as '1.0.0',
    })).toThrowError(expect.objectContaining({ reason: 'discovery_profile_mismatch' }));
  });

  it('allows exactly one same-role materialization and rejects a stale assignment revision', async () => {
    const digest = await discoveryConfigDigest({
      role_template_key: 'finance-agent', role_template_version: '1.0.0',
      config: FINANCE_DISCOVERY_CONFIG,
    });
    const promoted = grant(digest);
    const update = vi.fn();
    const tx = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('UPDATE runtime_discovery_grants')) {
          update();
          return { rows: [], rowCount: 1 };
        }
        return { rows: [assignment()] };
      }),
    };
    await expect(requireCurrentGrantConfig(
      {} as Env, tx as never, promoted, { allowAssignmentPromotion: true },
    )).resolves.toEqual(FINANCE_DISCOVERY_CONFIG);
    expect(promoted).toMatchObject({ assignment_id: assignmentId, assignment_revision: 1 });
    expect(update).toHaveBeenCalledOnce();

    const staleTx = { query: vi.fn(async () => ({ rows: [assignment(2)], rowCount: 1 })) };
    await expect(requireCurrentGrantConfig(
      {} as Env, staleTx as never, grant(digest), { allowAssignmentPromotion: true },
    )).rejects.toMatchObject({ reason: 'discovery_profile_changed' });
  });

  it('does not treat an unsupported persisted Finance assignment as an unowned default profile', async () => {
    const tx = {
      query: vi.fn(async (sql: string) => sql.includes('SELECT EXISTS')
        ? { rows: [{ exists: true }], rowCount: 1 }
        : { rows: [assignment(1, { skill_version: '9.9.9' })], rowCount: 1 }),
    };
    await expect(exactDiscoveryConfig(
      {} as Env, tx as never, workspaceId, agentId, FINANCE_CAPACITY_ROLE,
    )).rejects.toMatchObject({ reason: 'discovery_profile_mismatch' });
  });
});
