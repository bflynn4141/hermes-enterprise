import { describe, expect, it } from 'vitest';
import type { EnterpriseSkillAssignment } from '@hermes/shared';
import type { HermesEnterpriseReadiness } from '../../src/runtime/client.js';
import {
  ENTERPRISE_BRIDGE_VERSION,
  HERMES_NATIVE_REVISION,
  enterpriseReadinessToolNames,
  matchesExactEnterpriseAttestation,
  matchesEnterpriseReadiness,
  requiresExactEnterpriseAttestation,
} from '../../src/runtime/readiness.js';

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
    plugin: { name: 'enterprise_bridge', version: ENTERPRISE_BRIDGE_VERSION },
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

describe('role-aware native readiness', () => {
  it('accepts exact Finance attestation without AgentCash or a wallet', () => {
    const finance = assignment();
    expect(requiresExactEnterpriseAttestation(finance)).toBe(true);
    expect(matchesEnterpriseReadiness(
      readiness({ toolNames: enterpriseReadinessToolNames(finance) }), finance,
    )).toBe(true);
  });

  it('rejects Finance with a legacy payload, wrong digest, extra tool or AgentCash enabled', () => {
    const finance = assignment();
    const exact = readiness({ toolNames: enterpriseReadinessToolNames(finance) });
    const invalid = [
      { ...exact, runtimeRevision: null, plugin: null, skills: null, toolNames: null },
      { ...exact, skills: [{ name: 'enterprise_bridge:partner-invoice-review', version: '1.0.1',
        artifactDigest: `sha256:${'0'.repeat(64)}`, contentDigest: `sha256:${'b'.repeat(64)}` }] },
      { ...exact, toolNames: [...exact.toolNames!, 'publish_partner_invoice_review'] },
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
