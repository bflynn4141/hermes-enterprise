import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROLE_CONTRACTS,
  loadSecureAuthState,
  main,
  validateAcceptanceManifest,
  verifyAcceptanceEvidence,
} from '../scripts/native-staging-acceptance.mjs';

const ids = {
  workspace: '10000000-0000-4000-8000-000000000001',
  intake: '10000000-0000-4000-8000-000000000002',
  handoff: '10000000-0000-4000-8000-000000000003',
  request: '10000000-0000-4000-8000-000000000004',
  decision: '10000000-0000-4000-8000-000000000005',
  document: '10000000-0000-4000-8000-000000000006',
  partnershipsUser: '20000000-0000-4000-8000-000000000001',
  financeUser: '20000000-0000-4000-8000-000000000002',
  partnershipsAgent: '30000000-0000-4000-8000-000000000001',
  financeAgent: '30000000-0000-4000-8000-000000000002',
  partnershipsRun: '40000000-0000-4000-8000-000000000001',
  financeRun: '40000000-0000-4000-8000-000000000002',
  partnershipsAssignment: '50000000-0000-4000-8000-000000000001',
  financeAssignment: '50000000-0000-4000-8000-000000000002',
};

const payloadHash = `sha256:${'a'.repeat(64)}`;

const manifest = () => ({
  schema_version: 1,
  base_url: 'https://hermes.staging.test',
  workspace_id: ids.workspace,
  intake_event_id: ids.intake,
  payload_hash: payloadHash,
  handoff_id: ids.handoff,
  request_id: ids.request,
  decision_id: ids.decision,
  document_id: ids.document,
  input_provenance: 'sample',
  roles: {
    partnerships: {
      auth_state: '/private/partnerships-auth.json',
      user_id: ids.partnershipsUser,
      email: 'partnerships@acme.test',
      agent_id: ids.partnershipsAgent,
      runtime_profile: 'agent-partnerships-native',
      run_id: ids.partnershipsRun,
    },
    finance: {
      auth_state: '/private/finance-auth.json',
      user_id: ids.financeUser,
      email: 'finance@acme.test',
      agent_id: ids.financeAgent,
      runtime_profile: 'agent-finance-native',
      run_id: ids.financeRun,
    },
  },
});

function agent(role) {
  const contract = ROLE_CONTRACTS[role];
  const roleIds = role === 'partnerships'
    ? { agent: ids.partnershipsAgent, user: ids.partnershipsUser, assignment: ids.partnershipsAssignment }
    : { agent: ids.financeAgent, user: ids.financeUser, assignment: ids.financeAssignment };
  return {
    id: roleIds.agent,
    principal_user_id: roleIds.user,
    role_template: { key: contract.roleTemplate, version: '1.0.0' },
    skill_key: contract.skillKey,
    skill_version: contract.version,
    assignment_id: roleIds.assignment,
    assignment_revision: 7,
    assignment_state: 'active',
    schedule_enabled: false,
    capabilities: [...contract.capabilities],
  };
}

function readiness(role) {
  const contract = ROLE_CONTRACTS[role];
  return {
    role,
    configured: true,
    assignment_state: 'active',
    native_status: 'ready',
    skill_key: contract.skillKey,
    skill_version: contract.version,
    artifact_digest: contract.artifactDigest,
    missing: [],
  };
}

function handoff(role) {
  return {
    id: ids.handoff,
    current: true,
    request_id: role === 'finance' ? ids.request : null,
    result_kind: 'checks_passed',
    input_provenance: 'sample',
    simulated: false,
    decided_at: '2026-09-19T12:00:00.000Z',
    outcome: {
      validation: 'passed',
      agent_explanation: 'completed',
      human_decision: 'approved',
      acknowledgment: 'delivered',
    },
    acknowledgment: {
      handoff_id: ids.handoff,
      outcome: 'invoice_draft_saved',
      result_code: 'approved',
      delivery_status: 'delivered',
    },
  };
}

function workflow(role) {
  return {
    configured: true,
    admission_state: 'enabled',
    viewer_role: role,
    agents: [agent('partnerships'), agent('finance')],
    readiness: [readiness('partnerships'), readiness('finance')],
    handoffs: [handoff(role)],
  };
}

function assignment(role) {
  const contract = ROLE_CONTRACTS[role];
  const entry = agent(role);
  return {
    id: entry.assignment_id,
    agent_id: entry.id,
    team: { slug: role },
    skill_key: contract.skillKey,
    runtime_name: contract.runtimeName,
    version: contract.version,
    artifact_digest: contract.artifactDigest,
    state: 'active',
    revision: entry.assignment_revision,
    schedule: { enabled: false },
    human_review_required: true,
    capability_grants: [...contract.capabilities],
  };
}

function trace(role) {
  const contract = ROLE_CONTRACTS[role];
  const entry = manifest().roles[role];
  const argumentsValue = role === 'partnerships'
    ? { intake_event_id: ids.intake, expected_payload_hash: payloadHash }
    : { handoff_id: ids.handoff };
  return {
    run_id: entry.run_id,
    agent_id: entry.agent_id,
    runtime_kind: 'hermes',
    runtime_profile: entry.runtime_profile,
    runtime_run_id: `run_${role}_native`,
    runtime_session_id: `session_${role}_native`,
    status: 'completed',
    model_id: 'deepseek-ai/DeepSeek-V3.2',
    allowed_tools: [...contract.tools],
    tool_calls: [{
      name: contract.requiredTool,
      arguments: JSON.stringify(argumentsValue),
      result: JSON.stringify({ tool: contract.requiredTool, data: { handoff_id: ids.handoff, request_id: ids.request } }),
      truncated: false,
    }],
  };
}

function evidence() {
  return {
    health: {
      status: 'ok',
      version: '0.1.0+staging',
      checks: [
        { name: 'auth:config', ok: true },
        { name: 'workos:jwks', ok: true },
        { name: 'hermes:runs', ok: true },
      ],
    },
    roles: {
      partnerships: {
        session: { workspace: { id: ids.workspace }, user: { id: ids.partnershipsUser, email: 'partnerships@acme.test' } },
        workflow: workflow('partnerships'),
        assignment: assignment('partnerships'),
        trace: trace('partnerships'),
      },
      finance: {
        session: { workspace: { id: ids.workspace }, user: { id: ids.financeUser, email: 'finance@acme.test' } },
        workflow: workflow('finance'),
        assignment: assignment('finance'),
        trace: trace('finance'),
      },
    },
    handoff_result: {
      kind: 'checks_passed',
      handoff_id: ids.handoff,
      request_id: ids.request,
      input_provenance: 'sample',
      checks: [{ code: 'duplicate', status: 'passed' }],
      outcome: { validation: 'passed', human_decision: 'approved', acknowledgment: 'delivered' },
    },
    request: {
      id: ids.request,
      kind: 'invoice',
      status: 'created',
      decision_id: ids.decision,
      decided_at: '2026-09-19T12:00:00.000Z',
      payload: { workflow_provenance: {
        handoff_id: ids.handoff,
        source_sessions: [
          { role: 'partnerships', simulated: false },
          { role: 'finance', simulated: false },
        ],
      } },
    },
    documents: { items: [{
      id: ids.document,
      kind: 'invoice',
      request_id: ids.request,
      payload: { workflow_provenance: { handoff_id: ids.handoff } },
    }] },
  };
}

describe('native staging acceptance manifest', () => {
  it('requires distinct human, agent, profile and authentication identities', () => {
    expect(validateAcceptanceManifest(manifest()).roles.finance.user_id).toBe(ids.financeUser);
    const duplicate = manifest();
    duplicate.roles.finance.user_id = ids.partnershipsUser;
    expect(() => validateAcceptanceManifest(duplicate)).toThrow(/distinct human principals/);
  });

  it('refuses local endpoints and CI execution before any network work', async () => {
    expect(() => validateAcceptanceManifest({ ...manifest(), base_url: 'http://127.0.0.1:8788' })).toThrow(/HTTPS/);
    await expect(main([], { CI: 'true', HERMES_NATIVE_STAGING_ACCEPT: 'read-only' })).rejects.toThrow(/refused in CI/);
  });

  it('requires a private secure HttpOnly browser state', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'hermes-native-auth-'));
    const file = path.join(directory, 'auth.json');
    try {
      writeFileSync(file, JSON.stringify({ cookies: [{
        name: '__Host-hermes_session', value: 'secret', domain: 'hermes.staging.test', path: '/',
        secure: true, httpOnly: true,
      }] }), { mode: 0o600 });
      expect(loadSecureAuthState(file, 'https://hermes.staging.test').fingerprint).toMatch(/^[0-9a-f]{64}$/);
      chmodSync(file, 0o644);
      expect(() => loadSecureAuthState(file, 'https://hermes.staging.test')).toThrow(/group\/world/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('native staging acceptance evidence', () => {
  it('retains exact native role contracts and completed sample lineage', () => {
    const report = verifyAcceptanceEvidence(evidence(), manifest());
    expect(report.result).toBe('verified_read_only');
    expect(report.roles.finance.readiness_tools).toEqual([
      'get_partner_handoff_result', 'list_requests', 'get_request', 'skill_view',
    ]);
    expect(report.roles.finance.run_tools).toEqual([
      'get_partner_handoff_result', 'list_requests', 'get_request',
    ]);
    expect(report.input_provenance).toBe('sample');
  });

  it('refuses a legacy assignment or partial Finance inventory', () => {
    const legacy = evidence();
    legacy.roles.partnerships.assignment.runtime_name = 'enterprise_bridge:partner-program-screening';
    legacy.roles.partnerships.assignment.version = '1.7.0';
    expect(() => verifyAcceptanceEvidence(legacy, manifest())).toThrow(/runtime skill name/);

    const partial = evidence();
    partial.roles.finance.trace.allowed_tools = ['get_partner_handoff_result'];
    expect(() => verifyAcceptanceEvidence(partial, manifest())).toThrow(/reviewed inventory/);
  });

  it('refuses scripted, fixture or simulated evidence', () => {
    const scripted = evidence();
    scripted.roles.finance.trace.model_id = 'test/fixture';
    expect(() => verifyAcceptanceEvidence(scripted, manifest())).toThrow(/scripted or fixture/);

    const simulated = evidence();
    simulated.roles.finance.workflow.handoffs[0].simulated = true;
    expect(() => verifyAcceptanceEvidence(simulated, manifest())).toThrow(/native execution marker/);
  });
});
