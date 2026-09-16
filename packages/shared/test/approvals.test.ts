import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TYPES,
  approvalPayloadSchema,
  approvalProposalSchema,
  decideApprovalInputSchema,
  proposeApprovalInputSchema,
  sameRef,
  viewFocusRef,
  type ApprovalProposal,
} from '../src/index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const evidence = [{ id: 'source-1', kind: 'source' as const, label: 'Reviewed source' }];
const common = { kind: 'approval' as const, summary: 'Review this bounded proposal.', consequence: 'Only the reviewed version is authorized.', evidence, illustrative: true };

const proposals: ApprovalProposal[] = [
  {
    ...common,
    approval_type: 'run_plan',
    details: {
      goal: 'Produce a weekly partner shortlist.',
      steps: [{ id: 'research', label: 'Research partners', agent_id: A, output: 'Cited shortlist' }],
      participating_agents: [{ agent_id: A, role: 'Researcher' }],
      deliverables: ['Weekly shortlist'],
      schedule: 'Mondays at 09:00 America/Los_Angeles',
      budget: { currency: 'USD', estimated_min_minor: 100, estimated_max_minor: 300, cap_minor: 500, total_token_cap: 25_000, call_cap: 4, max_output_tokens_per_call: 5_000, max_parallel_calls: 1, model_ids: ['model-1'], metered_tools: [], retries_included: 1, illustrative: true },
    },
  },
  {
    ...common,
    approval_type: 'team_commitment',
    details: { requester_agent_id: A, recipient_agent_id: B, receiving_owner_member_id: M, workload: 'Check technical evidence.', due_at: '2026-09-20T17:00:00-07:00', dependencies: ['Shortlist'], acceptance_criteria: ['Citations checked'] },
  },
  {
    ...common,
    approval_type: 'access',
    details: { resource_id: 'partner-folder', resource_label: 'Partner references', requested_agent_id: A, operations: ['read'], purpose: 'Check public claims against licensed references.', access_expires_at: '2026-09-30T17:00:00-07:00' },
  },
  {
    ...common,
    approval_type: 'communication',
    details: { channel: 'email', sender: { member_id: M, address: 'maya@example.test' }, recipients: [{ name: 'Prospect', address: 'prospect@example.test' }], subject: 'Introduction', body: 'Reviewed introduction.', attachments: [], scheduled_for: '2026-09-18T09:00:00-07:00' },
  },
  {
    ...common,
    approval_type: 'shared_learning',
    details: { skill_id: 'screening', title: 'Partner screening', current_version: 'v1', proposed_version: 'v2', diff: '+ Verify official source.', source_evidence_ids: ['source-1'], reuse_audience: ['Partner program agents'], excluded_private_data: ['Applicant records'] },
  },
  {
    ...common,
    approval_type: 'deliverable',
    details: { artifact_id: 'shortlist-2026-09-15', title: 'Weekly shortlist', version: 'v1', content: 'Full reviewed shortlist.', evidence_ids: ['source-1'], missing_information: ['Program terms'], releases_dependent_request_ids: [] },
  },
  {
    ...common,
    approval_type: 'data_disclosure',
    details: { recipient: { organization: 'Example Foundation', contact: 'reviewer@example.test' }, purpose: 'Partner diligence.', items: [{ resource_id: 'partner-summary', fields: ['name', 'public_program_url'] }], redactions: ['Private notes'], retention_until: '2026-10-15T17:00:00-07:00' },
  },
  {
    ...common,
    approval_type: 'record_change',
    details: { system_id: 'crm', system_label: 'Partner CRM', changes: [{ record_id: 'partner-42', field: 'status', before: 'reviewing', after: 'qualified' }], validation: ['Status is in the allowed state list'], rollback: 'Restore status to reviewing.' },
  },
  {
    ...common,
    approval_type: 'exception',
    details: { rule_id: 'onboarding-reference', rule_label: 'Two references required', reason: 'One verified reference is temporarily unavailable.', scope: 'Partner 42 only.', compensating_controls: ['Manual owner review'], exception_expires_at: '2026-09-22T17:00:00-07:00' },
  },
  {
    ...common,
    approval_type: 'agent_governance',
    details: { agent_id: A, current_schedule: 'Weekly', proposed_schedule: 'Weekdays', current_tools: ['web'], proposed_tools: ['web'], setting_changes: [], affected_permissions: [] },
  },
];

describe('enterprise approval contract', () => {
  it('validates one typed proposal for every approval family', () => {
    expect(proposals.map((proposal) => approvalProposalSchema.parse(proposal).approval_type)).toEqual(APPROVAL_TYPES);
  });

  it('keeps server policy and requester identity out of agent-authored input', () => {
    const input = { label: 'Weekly plan', policy_key: 'run-plan-standard', proposal: proposals[0], target_agent_ids: [], target_member_ids: [], target_resource_ids: [], dependent_request_ids: [], idempotency_key: 'proposal:weekly:1' };
    expect(proposeApprovalInputSchema.parse(input).policy_key).toBe('run-plan-standard');
    expect(proposeApprovalInputSchema.safeParse({ ...input, policy: { mode: 'parallel' } }).success).toBe(false);
    expect(proposeApprovalInputSchema.safeParse({ ...input, requester_member_id: M }).success).toBe(false);
  });

  it('requires a revision and hash on every human decision', () => {
    const command = { decision: 'approve', expected_authorization_revision: 1, expected_authorization_hash: `sha256:${'a'.repeat(64)}`, idempotency_key: 'decision:weekly:1', note: null };
    expect(decideApprovalInputSchema.parse(command).decision).toBe('approve');
    expect(decideApprovalInputSchema.safeParse({ ...command, expected_authorization_hash: undefined }).success).toBe(false);
  });

  it('stores verified context, policy and binding beside the flattened typed payload', () => {
    const parsed = approvalPayloadSchema.parse({
      ...proposals[0],
      context: { requester: { agent_id: A, member_id: M, user_id: M }, target_agent_ids: [], target_member_ids: [], target_resource_ids: [], source: { session_id: null, run_id: null, dependent_request_ids: [] } },
      authorization: { revision: 1, hash: `sha256:${'b'.repeat(64)}`, expires_at: '2026-09-30T17:00:00-07:00' },
      policy: { id: B, key: 'run-plan-standard', version: 1, mode: 'sequential', prevent_self_review: true, require_distinct_reviewers: true, steps: [{ id: 'owner', label: 'Program owner', order: 0, reviewers: [{ kind: 'member', member_id: M }], quorum: 1 }] },
      resource_bindings: [],
    });
    expect(parsed.approval_type).toBe('run_plan');
    expect(parsed.authorization.revision).toBe(1);
  });

  it('rejects a budget estimate that exceeds its authorization cap', () => {
    const proposal = structuredClone(proposals[0]!);
    if (proposal.approval_type !== 'run_plan') throw new Error('fixture drift');
    proposal.details.budget.estimated_max_minor = 501;
    expect(approvalProposalSchema.safeParse(proposal).success).toBe(false);
  });

  it('requires enforceable run-plan call and token ceilings', () => {
    const proposal = structuredClone(proposals[0]!);
    if (proposal.approval_type !== 'run_plan') throw new Error('fixture drift');
    const unsafe = { ...proposal, details: { ...proposal.details, budget: { ...proposal.details.budget, total_token_cap: undefined } } };
    expect(approvalProposalSchema.safeParse(unsafe).success).toBe(false);
  });

  it('normalizes an absent Inbox reviewer filter to for_me', () => {
    expect(sameRef(
      { section: 'inbox', view: 'list' },
      { section: 'inbox', view: 'list', filters: { reviewer: 'for_me' } },
    )).toBe(true);
    expect(viewFocusRef({ view: 'inbox' }).filters?.reviewer).toBe('for_me');
  });
});
