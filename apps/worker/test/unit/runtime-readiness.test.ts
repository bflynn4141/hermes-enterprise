import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnterpriseSkillAssignment } from '@hermes/shared';
import { HermesClient, type HermesEnterpriseReadiness } from '../../src/runtime/client.js';
import type { RuntimeSkillManifest } from '../../src/runtime/skills.js';
import {
  AGENTCASH_MCP_TOOL,
  ENTERPRISE_BRIDGE_VERSION,
  HERMES_NATIVE_REVISION,
  enterpriseReadinessToolNames,
  LEGACY_PARTNER_CONTENT_DIGEST,
  matchesLegacyCapacityAttestation,
  matchesManagedDiscoveryGrantAttestation,
  matchesExactEnterpriseAttestation,
  matchesExactManagedEnterpriseAttestation,
  matchesEnterpriseReadiness,
  matchesManagedRuntimeAttestation,
  requiresExactEnterpriseAttestation,
} from '../../src/runtime/readiness.js';
import type { DiscoveryGrantRow } from '../../src/runtime/discovery-grants.js';
import {
  PARTNER_INVOICE_REVIEW_DEFINITION,
  PARTNER_PROGRAM_DEFINITION,
  PARTNER_PROGRAM_MULTI_PARTY_DEFINITION,
  toolsForSkillVersion,
} from '../../src/enterprise-skills/registry.js';

const PLUGIN_REVISION = 'a'.repeat(40);
const PLUGIN_DIGEST = `sha256:${'d'.repeat(64)}`;

function assignment(overrides: Partial<EnterpriseSkillAssignment> = {}): EnterpriseSkillAssignment {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    agent_id: '22222222-2222-4222-8222-222222222222',
    agent_name: 'Iris', team: null,
    skill_key: 'partner-invoice-review', runtime_name: 'enterprise_bridge:partner-invoice-review',
    name: 'Partner invoice review', version: '1.0.1',
    artifact_digest: `sha256:${'b'.repeat(64)}`,
    description: 'Review invoices.', state: 'active', revision: 1,
    config: {}, capability_grants: ['partner.invoice.review.prepare'],
    schedule: { enabled: false, interval_minutes: 360 }, human_review_required: true,
    config_fields: [], updated_at: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

function readiness(overrides: Partial<HermesEnterpriseReadiness> = {}): HermesEnterpriseReadiness {
  return {
    object: 'hermes.enterprise_bridge.readiness', version: ENTERPRISE_BRIDGE_VERSION,
    runtimeRevision: HERMES_NATIVE_REVISION,
    plugin: {
      name: 'enterprise_bridge', version: ENTERPRISE_BRIDGE_VERSION,
      revision: PLUGIN_REVISION, artifactDigest: PLUGIN_DIGEST,
    },
    workspaceId: 'workspace', agentId: '22222222-2222-4222-8222-222222222222',
    enterpriseUrl: 'https://enterprise.example',
    skills: [{
      name: 'enterprise_bridge:partner-invoice-review', version: '1.0.1',
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      contentDigest: `sha256:${'b'.repeat(64)}`,
    }],
    toolNames: ['get_partner_handoff_result', 'skill_view'],
    agentCashEnabled: false, agentCashWalletPresent: false, nativeCronDisabled: true,
    ...overrides,
  };
}

function manifest(row: EnterpriseSkillAssignment): RuntimeSkillManifest {
  return {
    name: row.runtime_name,
    skill_key: row.skill_key,
    runtime_name: row.runtime_name,
    version: row.version,
    artifact_digest: row.artifact_digest!,
    state: 'active',
    assignment_revision: row.revision,
    grant_revision: null,
    binding_source: 'enterprise_assignment',
    binding_state: null,
    grant_expires_at: null,
    capability_grants: row.capability_grants,
    auto_load: true,
    config: row.config,
  };
}

const managedIdentity = {
  workspaceId: 'workspace',
  agentId: '22222222-2222-4222-8222-222222222222',
  enterpriseUrl: 'https://enterprise.example',
  pluginRevision: PLUGIN_REVISION,
  pluginArtifactDigest: PLUGIN_DIGEST,
};

function discoveryGrant(overrides: Partial<DiscoveryGrantRow> = {}): DiscoveryGrantRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    workspace_id: managedIdentity.workspaceId,
    agent_id: managedIdentity.agentId,
    credential_digest: new Uint8Array(32),
    role_template_key: 'finance-agent', role_template_version: '1.0.0',
    skill_key: PARTNER_INVOICE_REVIEW_DEFINITION.key,
    skill_version: PARTNER_INVOICE_REVIEW_DEFINITION.version,
    runtime_name: PARTNER_INVOICE_REVIEW_DEFINITION.runtimeName,
    artifact_digest: PARTNER_INVOICE_REVIEW_DEFINITION.artifactDigest,
    assignment_id: null, assignment_revision: null,
    config_digest: `sha256:${'c'.repeat(64)}`, grant_revision: 1,
    linked_capacity_id: '44444444-4444-4444-8444-444444444444',
    expires_at: null, revoked_at: null, consumed_at: null, capacity_state: 'available',
    ...overrides,
  };
}

describe('role-aware native readiness', () => {
  it('accepts only the exact unowned Finance discovery profile', () => {
    const grant = discoveryGrant();
    const exact = readiness({
      skills: [{
        name: PARTNER_INVOICE_REVIEW_DEFINITION.runtimeName,
        version: PARTNER_INVOICE_REVIEW_DEFINITION.version,
        artifactDigest: PARTNER_INVOICE_REVIEW_DEFINITION.artifactDigest,
        contentDigest: PARTNER_INVOICE_REVIEW_DEFINITION.artifactDigest,
      }],
      toolNames: [
        ...toolsForSkillVersion(
          PARTNER_INVOICE_REVIEW_DEFINITION.key,
          PARTNER_INVOICE_REVIEW_DEFINITION.version,
          PARTNER_INVOICE_REVIEW_DEFINITION.defaultCapabilityGrants,
        ),
        'skill_view',
      ],
      agentCashEnabled: false, agentCashWalletPresent: false,
    });
    expect(matchesManagedDiscoveryGrantAttestation(exact, grant, managedIdentity)).toBe(true);

    const invalid = [
      discoveryGrant({ role_template_key: 'partnerships-agent' }),
      discoveryGrant({ skill_key: PARTNER_PROGRAM_DEFINITION.key }),
      discoveryGrant({ grant_revision: 2 }),
      discoveryGrant({ revoked_at: new Date() }),
      discoveryGrant({ consumed_at: new Date() }),
    ];
    expect(invalid.every((candidate) =>
      !matchesManagedDiscoveryGrantAttestation(exact, candidate, managedIdentity),
    )).toBe(true);
    expect(matchesManagedDiscoveryGrantAttestation({
      ...exact, agentCashEnabled: true, agentCashWalletPresent: true,
    }, grant, managedIdentity)).toBe(false);
    expect(matchesManagedDiscoveryGrantAttestation({
      ...exact, toolNames: [...exact.toolNames!, 'publish_partner_invoice_review'],
    }, grant, managedIdentity)).toBe(false);
  });

  it('accepts exact Finance attestation without AgentCash or a wallet', () => {
    const finance = assignment();
    expect(requiresExactEnterpriseAttestation(finance)).toBe(true);
    expect(enterpriseReadinessToolNames(finance)).not.toContain(AGENTCASH_MCP_TOOL);
    expect(matchesEnterpriseReadiness(
      readiness({ toolNames: enterpriseReadinessToolNames(finance) }), finance,
    )).toBe(true);
  });

  it('binds exact workflow admission to the reviewed managed plugin identity', () => {
    const finance = assignment();
    const exact = readiness({ toolNames: enterpriseReadinessToolNames(finance) });
    expect(matchesExactManagedEnterpriseAttestation(exact, finance, managedIdentity)).toBe(true);

    const invalidReadiness = [
      { ...exact, enterpriseUrl: 'https://other.example' },
      { ...exact, workspaceId: 'other-workspace' },
      { ...exact, agentId: '33333333-3333-4333-8333-333333333333' },
      { ...exact, plugin: { ...exact.plugin!, revision: 'b'.repeat(40) } },
      { ...exact, plugin: { ...exact.plugin!, artifactDigest: `sha256:${'e'.repeat(64)}` } },
    ];
    expect(invalidReadiness.every((candidate) =>
      !matchesExactManagedEnterpriseAttestation(candidate, finance, managedIdentity),
    )).toBe(true);
    expect(matchesExactManagedEnterpriseAttestation(exact, finance, {
      ...managedIdentity, pluginRevision: undefined,
    })).toBe(false);
    expect(matchesExactManagedEnterpriseAttestation(exact, finance, {
      ...managedIdentity, pluginArtifactDigest: undefined,
    })).toBe(false);
  });

  it('rejects Finance with a legacy payload, wrong digest, extra tool or AgentCash enabled', () => {
    const finance = assignment();
    const exact = readiness({ toolNames: enterpriseReadinessToolNames(finance) });
    const invalid = [
      { ...exact, runtimeRevision: null, plugin: null, skills: null, toolNames: null },
      { ...exact, skills: [{ name: 'enterprise_bridge:partner-invoice-review', version: '1.0.1',
        artifactDigest: `sha256:${'0'.repeat(64)}`, contentDigest: `sha256:${'b'.repeat(64)}` }] },
      { ...exact, toolNames: [...exact.toolNames!, 'publish_partner_invoice_review'] },
      { ...exact, toolNames: [...exact.toolNames!, AGENTCASH_MCP_TOOL] },
      { ...exact, agentCashEnabled: true },
    ];
    expect(invalid.every((candidate) => !matchesEnterpriseReadiness(candidate, finance))).toBe(true);
  });

  it('requires the Partnerships AgentCash state and its assignment-specific inventory', () => {
    const partnerships = assignment({
      skill_key: 'partner-program-screening',
      runtime_name: 'enterprise_bridge:partner-program-screening-v1-8',
      name: 'Partner program screening', version: '1.8.0',
      artifact_digest: `sha256:${'a'.repeat(64)}`,
      capability_grants: ['partner.handoff.publish'],
    });
    const attested = readiness({
      skills: [{
        name: partnerships.runtime_name, version: partnerships.version,
        artifactDigest: partnerships.artifact_digest!,
        contentDigest: partnerships.artifact_digest!,
      }],
      toolNames: enterpriseReadinessToolNames(partnerships),
      agentCashEnabled: true, agentCashWalletPresent: true,
    });
    expect(matchesEnterpriseReadiness(attested, partnerships)).toBe(true);
    expect(attested.toolNames).toContain(AGENTCASH_MCP_TOOL);
    expect(matchesEnterpriseReadiness({
      ...attested,
      toolNames: attested.toolNames!.filter((name) => name !== AGENTCASH_MCP_TOOL),
    }, partnerships)).toBe(false);
    expect(matchesEnterpriseReadiness({ ...attested, agentCashWalletPresent: false }, partnerships)).toBe(false);
  });

  it('preserves the prior readiness rule for original 1.7 and unassigned profiles', () => {
    const legacy = assignment({
      skill_key: 'partner-program-screening', runtime_name: 'enterprise_bridge:partner-program-screening',
      version: '1.7.0', artifact_digest: `sha256:${'c'.repeat(64)}`,
    });
    const oldPayload = readiness({ runtimeRevision: null, plugin: null, skills: null, toolNames: null,
      agentCashEnabled: true, agentCashWalletPresent: true });
    expect(requiresExactEnterpriseAttestation(legacy)).toBe(false);
    expect(matchesEnterpriseReadiness(oldPayload, legacy)).toBe(true);
    expect(matchesEnterpriseReadiness(oldPayload, null)).toBe(true);
    expect(matchesExactEnterpriseAttestation(oldPayload, legacy)).toBe(false);
    expect(matchesExactEnterpriseAttestation(oldPayload, null)).toBe(false);
  });

  it('accepts a captured managed P1.7 native connector attestation', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const nativePayload = JSON.parse(readFileSync(join(
      root, 'apps/worker/test/fixtures/managed-p17-native-readiness.json',
    ), 'utf8')) as Record<string, unknown>;
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(nativePayload));
    const exact = await new HermesClient(
      'https://connector.example/control', 'control-secret', send, 'dashboard_connector',
    ).enterpriseReadiness();
    expect(matchesLegacyCapacityAttestation(exact)).toBe(true);
    const expected = {
      workspaceId: exact.workspaceId, agentId: exact.agentId,
      enterpriseUrl: exact.enterpriseUrl,
      pluginRevision: exact.plugin!.revision!, pluginArtifactDigest: exact.plugin!.artifactDigest!,
    };
    expect(matchesLegacyCapacityAttestation(exact, expected)).toBe(true);
    expect(matchesLegacyCapacityAttestation({
      ...exact,
      plugin: { name: 'enterprise_bridge', version: ENTERPRISE_BRIDGE_VERSION,
        revision: null, artifactDigest: null },
    }, expected)).toBe(false);
    expect(matchesLegacyCapacityAttestation({ ...exact, enterpriseUrl: 'https://other.example' }, expected)).toBe(false);
    expect(matchesLegacyCapacityAttestation({ ...exact, plugin: { ...exact.plugin!, revision: 'b'.repeat(40) } }, expected)).toBe(false);
    expect(matchesLegacyCapacityAttestation({ ...exact, plugin: { ...exact.plugin!, artifactDigest: `sha256:${'e'.repeat(64)}` } }, expected)).toBe(false);
    expect(matchesLegacyCapacityAttestation({ ...exact, runtimeRevision: null })).toBe(false);
    expect(matchesLegacyCapacityAttestation({ ...exact, version: '1.6.0' })).toBe(false);
    expect(matchesLegacyCapacityAttestation({ ...exact, skills: [{ ...exact.skills![0]!, contentDigest: `sha256:${'0'.repeat(64)}` }] })).toBe(false);
    expect(matchesLegacyCapacityAttestation({
      ...exact,
      toolNames: exact.toolNames!.filter((name) => name !== AGENTCASH_MCP_TOOL),
    })).toBe(false);
    expect(matchesLegacyCapacityAttestation({ ...exact, toolNames: [...exact.toolNames!, 'publish_partner_invoice_review'] })).toBe(false);
  });

  it('matches managed P1.7 and P1.8 run attestations only with their native MCP tool', () => {
    const partnerships = [
      assignment({
        skill_key: PARTNER_PROGRAM_DEFINITION.key,
        runtime_name: PARTNER_PROGRAM_DEFINITION.runtimeName,
        name: PARTNER_PROGRAM_DEFINITION.name,
        version: PARTNER_PROGRAM_DEFINITION.version,
        artifact_digest: PARTNER_PROGRAM_DEFINITION.artifactDigest,
        capability_grants: [...PARTNER_PROGRAM_DEFINITION.defaultCapabilityGrants],
      }),
      assignment({
        skill_key: PARTNER_PROGRAM_MULTI_PARTY_DEFINITION.key,
        runtime_name: PARTNER_PROGRAM_MULTI_PARTY_DEFINITION.runtimeName,
        name: PARTNER_PROGRAM_MULTI_PARTY_DEFINITION.name,
        version: PARTNER_PROGRAM_MULTI_PARTY_DEFINITION.version,
        artifact_digest: PARTNER_PROGRAM_MULTI_PARTY_DEFINITION.artifactDigest,
        capability_grants: [...PARTNER_PROGRAM_MULTI_PARTY_DEFINITION.defaultCapabilityGrants],
      }),
    ];
    for (const role of partnerships) {
      const exact = readiness({
        skills: [{
          name: role.runtime_name,
          version: role.version,
          artifactDigest: role.artifact_digest!,
          contentDigest: role.version === PARTNER_PROGRAM_DEFINITION.version
            ? LEGACY_PARTNER_CONTENT_DIGEST
            : role.artifact_digest!,
        }],
        toolNames: enterpriseReadinessToolNames(role),
        agentCashEnabled: true,
        agentCashWalletPresent: true,
      });
      expect(matchesManagedRuntimeAttestation(exact, managedIdentity, [manifest(role)])).toBe(true);
      expect(matchesManagedRuntimeAttestation({
        ...exact,
        toolNames: exact.toolNames!.filter((name) => name !== AGENTCASH_MCP_TOOL),
      }, managedIdentity, [manifest(role)])).toBe(false);
    }
  });

  it('keeps managed Finance runs MCP-free', () => {
    const finance = assignment({
      skill_key: PARTNER_INVOICE_REVIEW_DEFINITION.key,
      runtime_name: PARTNER_INVOICE_REVIEW_DEFINITION.runtimeName,
      name: PARTNER_INVOICE_REVIEW_DEFINITION.name,
      version: PARTNER_INVOICE_REVIEW_DEFINITION.version,
      artifact_digest: PARTNER_INVOICE_REVIEW_DEFINITION.artifactDigest,
      capability_grants: [...PARTNER_INVOICE_REVIEW_DEFINITION.defaultCapabilityGrants],
    });
    const exact = readiness({
      skills: [{
        name: finance.runtime_name,
        version: finance.version,
        artifactDigest: finance.artifact_digest!,
        contentDigest: finance.artifact_digest!,
      }],
      toolNames: enterpriseReadinessToolNames(finance),
      agentCashEnabled: false,
      agentCashWalletPresent: false,
    });
    expect(matchesManagedRuntimeAttestation(exact, managedIdentity, [manifest(finance)])).toBe(true);
    expect(matchesManagedRuntimeAttestation({
      ...exact,
      toolNames: [...exact.toolNames!, AGENTCASH_MCP_TOOL],
    }, managedIdentity, [manifest(finance)])).toBe(false);
  });

  it('pins the strict P1.7 content attestation to the packaged SKILL.md bytes', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const bytes = readFileSync(join(root, 'runtime/hermes/enterprise_bridge/skills/partner-program-screening/SKILL.md'));
    expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(LEGACY_PARTNER_CONTENT_DIGEST);
  });

  it.each([
    ['no assignment', null],
    ['unknown skill', assignment({ skill_key: 'unrecognized-skill', version: '1.0.0' })],
    ['unknown Partnerships version', assignment({ skill_key: 'partner-program-screening', version: '9.9.9' })],
    ['unknown Finance version', assignment({ skill_key: 'partner-invoice-review', version: '9.9.9' })],
  ])('never treats %s as an exact multi-party assignment', (_label, candidate) => {
    const legacyReady = readiness({
      runtimeRevision: null, plugin: null, skills: null, toolNames: null,
      agentCashEnabled: true, agentCashWalletPresent: true,
    });
    expect(requiresExactEnterpriseAttestation(candidate)).toBe(false);
    expect(matchesExactEnterpriseAttestation(legacyReady, candidate)).toBe(false);
  });
});
