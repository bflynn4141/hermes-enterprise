// Explicit, resettable demo fixture helper. Nothing imports or calls this from
// a live route or migration; an isolated scenario/test must opt in and supply
// real tenant ids that were created for that scenario.
import type { ApprovalProposal, ApprovalType, ApprovalView } from '@hermes/shared';
import type { ApprovalProposerContext } from './approvals.js';
import { proposeApproval } from './approvals.js';
import { RouteError } from '../routes/tenant.js';

export interface ApprovalDemoFixtureOptions {
  readonly requesterOwnerMemberId: string;
  readonly primaryReviewerMemberId: string;
  readonly secondaryReviewerMemberId: string;
  readonly targetAgentId: string;
  readonly targetAgentOwnerMemberId: string;
  readonly idempotencyPrefix: string;
}

const TYPES: readonly ApprovalType[] = [
  'run_plan', 'team_commitment', 'access', 'communication', 'shared_learning',
  'deliverable', 'data_disclosure', 'record_change', 'exception', 'agent_governance',
];

const RESOURCE_FIXTURES = [
  ['partner-folder', 'folder', 'Partner reference folder', '1', '1'.repeat(64)],
  ['screening-skill', 'skill', 'Partner screening skill', '2', '2'.repeat(64)],
  ['weekly-shortlist', 'artifact', 'Weekly partner shortlist', '1', '3'.repeat(64)],
  ['partner-summary', 'data', 'Partner summary dataset', '1', '4'.repeat(64)],
  ['partner-crm', 'system', 'Partner CRM', '42', '5'.repeat(64)],
  ['two-references', 'rule', 'Two references required', '1', '6'.repeat(64)],
] as const;

function proposals(context: ApprovalProposerContext, options: ApprovalDemoFixtureOptions): Record<ApprovalType, ApprovalProposal> {
  const common = {
    kind: 'approval' as const,
    consequence: 'Authorize only this reviewed version; no external side effect is executed by the fixture.',
    evidence: [],
    illustrative: true,
  };
  return {
    run_plan: {
      ...common, approval_type: 'run_plan', summary: 'Run the illustrative weekly partner research plan.',
      details: {
        goal: 'Produce a cited weekly partner shortlist.',
        steps: [{ id: 'research', label: 'Research partners', agent_id: context.agentId, output: 'Cited shortlist' }],
        participating_agents: [{ agent_id: context.agentId, role: 'Researcher' }],
        deliverables: ['Weekly shortlist'], schedule: 'Mondays at 09:00 America/Los_Angeles',
        budget: {
          currency: 'USD', estimated_min_minor: 100, estimated_max_minor: 300, cap_minor: 500,
          estimated_input_tokens: 10_000, estimated_output_tokens: 2_000, total_token_cap: 15_000,
          call_cap: 4, max_output_tokens_per_call: 2_000, max_parallel_calls: 1,
          model_ids: ['deepseek-flash'], metered_tools: [], retries_included: 1, illustrative: true,
        },
      },
    },
    team_commitment: {
      ...common, approval_type: 'team_commitment', summary: 'Ask a colleague agent to verify technical evidence.',
      details: { requester_agent_id: context.agentId, recipient_agent_id: options.targetAgentId, receiving_owner_member_id: options.targetAgentOwnerMemberId, workload: 'Verify technical evidence in the shortlist.', due_at: '2026-10-01T17:00:00-07:00', dependencies: ['Weekly shortlist'], acceptance_criteria: ['Each technical claim has a primary source'] },
    },
    access: {
      ...common, approval_type: 'access', summary: 'Allow read-only access to the partner reference folder.',
      details: { resource_id: 'partner-folder', resource_label: 'Partner reference folder', requested_agent_id: context.agentId, operations: ['read'], purpose: 'Verify public partner claims.', access_expires_at: '2026-10-01T17:00:00-07:00' },
    },
    communication: {
      ...common, approval_type: 'communication', summary: 'Approve the exact illustrative introduction.',
      details: { channel: 'email', draft_only: false, sender: { member_id: options.primaryReviewerMemberId, address: 'sender@example.test' }, recipients: [{ name: 'Selected prospect', address: 'prospect@example.test' }], subject: 'Introduction', body: 'This is the complete illustrative message.', attachments: [] },
    },
    shared_learning: {
      ...common, approval_type: 'shared_learning', summary: 'Publish the revised screening checklist.',
      details: { skill_id: 'screening-skill', title: 'Partner screening checklist', current_version: '1', proposed_version: '2', diff: '+ Verify official source.', source_evidence_ids: ['fixture-source'], reuse_audience: ['Partner program agents'], excluded_private_data: ['Applicant evidence'] },
    },
    deliverable: {
      ...common, approval_type: 'deliverable', summary: 'Accept the weekly partner shortlist.',
      details: { artifact_id: 'weekly-shortlist', title: 'Weekly partner shortlist', version: '1', content: 'Full illustrative shortlist.', evidence_ids: [], missing_information: ['Program terms'], releases_dependent_request_ids: [] },
    },
    data_disclosure: {
      ...common, approval_type: 'data_disclosure', summary: 'Allow the exact redacted summary disclosure.',
      details: { recipient: { organization: 'Example Foundation' }, purpose: 'Partner diligence.', items: [{ resource_id: 'partner-summary', fields: ['name', 'public_program_url'] }], redactions: ['Private notes'], retention_until: '2026-10-15T17:00:00-07:00' },
    },
    record_change: {
      ...common, approval_type: 'record_change', summary: 'Approve the exact CRM status update.',
      details: { system_id: 'partner-crm', system_label: 'Partner CRM', changes: [{ record_id: 'partner-42', field: 'status', before: 'reviewing', after: 'qualified' }], validation: ['Status is allowed'], rollback: 'Restore reviewing.' },
    },
    exception: {
      ...common, approval_type: 'exception', summary: 'Allow one time-bounded reference exception.',
      details: { rule_id: 'two-references', rule_label: 'Two references required', reason: 'One verified reference is temporarily unavailable.', scope: 'Partner 42 only.', compensating_controls: ['Manual owner review'], exception_expires_at: '2026-10-01T17:00:00-07:00' },
    },
    agent_governance: {
      ...common, approval_type: 'agent_governance', summary: 'Change the colleague agent schedule.',
      details: { agent_id: options.targetAgentId, current_schedule: 'Weekly', proposed_schedule: 'Weekdays', current_tools: ['web'], proposed_tools: ['web'], setting_changes: [], affected_permissions: [] },
    },
  };
}

export async function installApprovalDemoFixture(
  context: ApprovalProposerContext,
  options: ApprovalDemoFixtureOptions,
): Promise<ApprovalView[]> {
  if (context.workspaceId.length === 0 || options.idempotencyPrefix.length < 8) {
    throw new RouteError('the demo fixture needs an isolated workspace and stable prefix', 'bad_demo_fixture', 422);
  }
  if (new Set([options.requesterOwnerMemberId, options.primaryReviewerMemberId, options.secondaryReviewerMemberId]).size < 3) {
    throw new RouteError('the demo fixture needs distinct requester and reviewer members', 'bad_demo_fixture', 422);
  }

  await context.tx.query(
    `INSERT INTO agent_owners (workspace_id, agent_id, member_id) VALUES ($1,$2,$3),($1,$4,$5)
     ON CONFLICT (agent_id) DO UPDATE SET member_id = EXCLUDED.member_id`,
    [context.workspaceId, context.agentId, options.requesterOwnerMemberId, options.targetAgentId, options.targetAgentOwnerMemberId],
  );
  for (const [key, kind, label, version, digest] of RESOURCE_FIXTURES) {
    await context.tx.query(
      `INSERT INTO approval_resources
         (workspace_id, resource_key, kind, label, owner_member_id, version, sha256, executor_available)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false)
       ON CONFLICT (workspace_id, resource_key) DO UPDATE
         SET owner_member_id=EXCLUDED.owner_member_id, version=EXCLUDED.version, sha256=EXCLUDED.sha256, active=true`,
      [context.workspaceId, key, kind, label, options.primaryReviewerMemberId, version, digest],
    );
  }

  const ownerStep = [{ id: 'owner', label: 'Responsible owner', order: 0, reviewers: [{ kind: 'member', member_id: options.primaryReviewerMemberId }], quorum: 1 }];
  const planStep = [{ id: 'budget', label: 'Two distinct plan reviewers', order: 0, reviewers: [{ kind: 'member', member_id: options.primaryReviewerMemberId }, { kind: 'member', member_id: options.secondaryReviewerMemberId }], quorum: 2 }];
  for (const type of TYPES) {
    await context.tx.query(
      `INSERT INTO approval_policies
         (workspace_id, key, version, approval_type, requester_agent_id, max_budget_minor,
          priority, mode, prevent_self_review, steps)
       VALUES ($1,$2,1,$3,$4,$5,100,'parallel',true,$6::jsonb)
       ON CONFLICT (workspace_id, key, version) DO UPDATE SET active=true, steps=EXCLUDED.steps`,
      [context.workspaceId, `demo-${type}`, type, context.agentId, type === 'run_plan' ? 500 : null, JSON.stringify(type === 'run_plan' ? planStep : ownerStep)],
    );
  }

  const definitions = proposals(context, options);
  const created: ApprovalView[] = [];
  for (const type of TYPES) {
    const proposal = definitions[type];
    created.push(await proposeApproval(context, {
      label: proposal.summary,
      policy_key: `demo-${type}`,
      proposal,
      target_agent_ids: [], target_member_ids: [], target_resource_ids: [], dependent_request_ids: [],
      idempotency_key: `${options.idempotencyPrefix}:${type}`,
    }));
  }
  return created;
}
