import {
  mockUuid,
  type ApprovalListProjection,
  type ApprovalPayload,
  type ApprovalProposal,
  type ApprovalType,
  type ApprovalView,
  type RequestEntity,
} from '@hermes/shared';

export const APPROVAL_DEMO_REQUEST_IDS: Record<ApprovalType, string> = {
  run_plan: mockUuid(1_001),
  team_commitment: mockUuid(1_002),
  access: mockUuid(1_003),
  communication: mockUuid(1_004),
  shared_learning: mockUuid(1_005),
  deliverable: mockUuid(1_006),
  data_disclosure: mockUuid(1_007),
  record_change: mockUuid(1_008),
  exception: mockUuid(1_009),
  agent_governance: mockUuid(1_010),
};

export interface ApprovalDemoContext {
  workspaceId: string;
  sessionId: string;
  runId: string;
  requesterAgentId: string;
  mayaUserId: string;
  mayaMemberId: string;
  alexUserId: string;
  alexMemberId: string;
  at(offsetMinutes?: number): string;
}

export interface ApprovalDemoFixtures {
  requests: RequestEntity[];
  views: Map<string, ApprovalView>;
}

const hashFor = (index: number): `sha256:${string}` => `sha256:${index.toString(16).padStart(64, '0')}`;

function effectFor(type: ApprovalType): ApprovalView['effect']['kind'] {
  switch (type) {
    case 'access': return 'access';
    case 'communication': return 'communication';
    case 'shared_learning': return 'shared_learning_publish';
    case 'data_disclosure': return 'data_disclosure';
    case 'record_change': return 'record_change';
    case 'agent_governance': return 'agent_governance_change';
    default: return 'none';
  }
}

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

function targetAgentIds(proposal: ApprovalProposal): string[] {
  switch (proposal.approval_type) {
    case 'run_plan': return sortedUnique(proposal.details.participating_agents.map((agent) => agent.agent_id));
    case 'team_commitment': return [proposal.details.recipient_agent_id];
    case 'access': return [proposal.details.requested_agent_id];
    case 'agent_governance': return [proposal.details.agent_id];
    default: return [];
  }
}

function targetResourceIds(proposal: ApprovalProposal): string[] {
  switch (proposal.approval_type) {
    case 'access': return [proposal.details.resource_id];
    case 'shared_learning': return [proposal.details.skill_id];
    case 'deliverable': return [proposal.details.artifact_id];
    case 'data_disclosure': return sortedUnique(proposal.details.items.map((item) => item.resource_id));
    case 'record_change': return [proposal.details.system_id];
    case 'exception': return [proposal.details.rule_id];
    default: return [];
  }
}

function targetMemberIds(
  proposal: ApprovalProposal,
  resourceIds: readonly string[],
  defaultOwnerMemberId: string,
): string[] {
  const ids = resourceIds.length > 0 ? [defaultOwnerMemberId] : [];
  if (proposal.approval_type === 'team_commitment') ids.push(proposal.details.receiving_owner_member_id);
  if (proposal.approval_type === 'communication') ids.push(proposal.details.sender.member_id);
  if (proposal.approval_type === 'agent_governance') ids.push(defaultOwnerMemberId);
  return sortedUnique(ids);
}

export function createApprovalDemoFixtures(context: ApprovalDemoContext): ApprovalDemoFixtures {
  const recipientAgentId = mockUuid(1_020);
  const releaseRequestId = mockUuid(1_022);
  const proposals: { type: ApprovalType; subject: string; label: string; proposal: ApprovalProposal }[] = [
    {
      type: 'run_plan',
      subject: 'Launch partner research sprint',
      label: 'Research sprint plan',
      proposal: {
        kind: 'approval', approval_type: 'run_plan', illustrative: true,
        summary: 'Iris proposes a bounded two-agent research sprint with explicit cost, token, call and concurrency ceilings.',
        consequence: 'Approval authorizes the plan only. Work starts after the second reviewer approves.',
        evidence: [
          { id: 'brief', kind: 'document', label: 'Partner research brief', ref: 'Partner Program / brief v3', note: 'Illustrative internal brief.' },
          { id: 'prior-run', kind: 'run', label: 'Prior screening run', ref: context.runId, note: 'Illustrative benchmark for the estimate.' },
        ],
        details: {
          goal: 'Compare three onboarding approaches and recommend the smallest credible pilot.',
          steps: [
            { id: 'collect', label: 'Collect comparable programs', agent_id: context.requesterAgentId, output: 'Evidence table with source notes' },
            { id: 'synthesize', label: 'Synthesize the pilot recommendation', agent_id: recipientAgentId, output: 'Decision memo with risks and next experiment' },
          ],
          participating_agents: [
            { agent_id: context.requesterAgentId, role: 'Research lead' },
            { agent_id: recipientAgentId, role: 'Synthesis reviewer' },
          ],
          deliverables: ['Comparable-program evidence table', 'Two-page pilot recommendation'],
          schedule: 'One bounded run, expected to complete within 45 minutes after final authorization.',
          budget: {
            currency: 'USD', estimated_min_minor: 180, estimated_max_minor: 360, cap_minor: 500,
            estimated_input_tokens: 16_000, estimated_output_tokens: 7_000,
            total_token_cap: 25_000, call_cap: 8, max_output_tokens_per_call: 5_000, max_parallel_calls: 2,
            model_ids: ['nous:anthropic/claude-sonnet-5'], metered_tools: ['web-search'], retries_included: 1, illustrative: true,
          },
        },
      },
    },
    {
      type: 'team_commitment',
      subject: 'Assign the onboarding synthesis',
      label: 'Team commitment',
      proposal: {
        kind: 'approval', approval_type: 'team_commitment', illustrative: true,
        summary: 'Iris asks Rowan to own a bounded synthesis task on behalf of Maya.',
        consequence: 'Acceptance admits the task to Rowan’s queue; it does not complete the work.',
        evidence: [{ id: 'handoff', kind: 'artifact', label: 'Onboarding synthesis handoff', ref: 'artifact:handoff-v1', note: 'Illustrative task brief.' }],
        details: {
          requester_agent_id: context.requesterAgentId, recipient_agent_id: recipientAgentId,
          receiving_owner_member_id: context.mayaMemberId,
          workload: 'Synthesize the approved evidence into a concise onboarding recommendation.',
          due_at: context.at(60 * 24 * 2), dependencies: ['Research sprint authorization'],
          acceptance_criteria: ['Cites every material claim', 'Separates evidence from recommendation', 'Fits in two pages'],
        },
      },
    },
    {
      type: 'access',
      subject: 'Read-only access to partner feedback',
      label: 'Temporary access',
      proposal: {
        kind: 'approval', approval_type: 'access', illustrative: true,
        summary: 'Grant Rowan read-only access to an illustrative feedback folder for 24 hours.',
        consequence: 'Authorization permits a time-bound read grant; no write or admin access is included.',
        evidence: [{ id: 'folder-index', kind: 'document', label: 'Feedback folder index', ref: 'drive:partner-feedback:v4' }],
        details: {
          resource_id: 'drive:partner-feedback', resource_label: 'Partner feedback · Q4', requested_agent_id: recipientAgentId,
          operations: ['read'], purpose: 'Extract themes for the approved onboarding synthesis.', access_expires_at: context.at(60 * 24),
        },
      },
    },
    {
      type: 'communication',
      subject: 'Send pilot invitation',
      label: 'External communication',
      proposal: {
        kind: 'approval', approval_type: 'communication', illustrative: true,
        summary: 'Review the exact fictional invitation, recipients and attachment before any send effect.',
        consequence: 'Approval authorizes this exact message; provider sending remains a separate effect.',
        evidence: [{ id: 'invite-source', kind: 'document', label: 'Pilot invite copy', ref: 'invite-copy:v2' }],
        details: {
          channel: 'email', sender: { member_id: context.mayaMemberId, address: 'maya@nous.example' },
          recipients: [{ name: 'Taylor Brooks', address: 'taylor@example.invalid' }],
          subject: 'Invitation to the illustrative partner pilot',
          body: 'Hi Taylor,\n\nWe would like to invite your team to a fictional two-week partner onboarding pilot. Please review the attached outline. No message will be sent from this demo.\n\nMaya',
          attachments: [{ id: 'pilot-outline', label: 'Illustrative pilot outline.pdf' }], scheduled_for: context.at(90),
        },
      },
    },
    {
      type: 'shared_learning',
      subject: 'Publish partner evidence checklist',
      label: 'Shared learning',
      proposal: {
        kind: 'approval', approval_type: 'shared_learning', illustrative: true,
        summary: 'Promote a reviewed evidence checklist into a reusable team skill without private source material.',
        consequence: 'Approval authorizes publication of this exact diff to the named reuse audience.',
        evidence: [{ id: 'review-notes', kind: 'artifact', label: 'Checklist review notes', ref: 'artifact:review-notes' }],
        details: {
          skill_id: 'partner-evidence', title: 'Partner evidence checklist', current_version: 'v3', proposed_version: 'v4',
          diff: '+ Separate applicant claims from independently verified evidence\n+ Record the source version and review date\n- Treat a public profile as verified customer impact',
          source_evidence_ids: ['review-notes'], reuse_audience: ['Partner Program agents'],
          excluded_private_data: ['Applicant contact details', 'Private interview notes', 'Workspace credentials'],
        },
      },
    },
    {
      type: 'deliverable',
      subject: 'Accept onboarding recommendation',
      label: 'Deliverable acceptance',
      proposal: {
        kind: 'approval', approval_type: 'deliverable', illustrative: true,
        summary: 'Accept the reviewed recommendation and release its dependent pilot-planning request.',
        consequence: 'Acceptance records the artifact as accepted and admits the dependent request.',
        evidence: [{ id: 'source-table', kind: 'artifact', label: 'Comparable-program evidence table', ref: 'artifact:evidence-table:v1' }],
        details: {
          artifact_id: 'onboarding-recommendation', title: 'Smallest credible onboarding pilot', version: 'v2',
          content: 'Run a two-week pilot with one partner cohort, one weekly office hour and a single evidence-backed exit review. Keep outreach manual until the process is validated.',
          evidence_ids: ['source-table'], missing_information: ['Confirmed pilot participant availability'], releases_dependent_request_ids: [releaseRequestId],
        },
      },
    },
    {
      type: 'data_disclosure',
      subject: 'Share redacted pilot summary',
      label: 'Data disclosure',
      proposal: {
        kind: 'approval', approval_type: 'data_disclosure', illustrative: true,
        summary: 'Share three explicitly named fields from a fictional pilot record with a named recipient.',
        consequence: 'Approval permits only the listed fields, redactions and retention window.',
        evidence: [{ id: 'disclosure-preview', kind: 'artifact', label: 'Redacted disclosure preview', ref: 'artifact:disclosure:v1' }],
        details: {
          recipient: { organization: 'Example Research Cooperative', contact: 'research@example.invalid' },
          purpose: 'Evaluate the illustrative onboarding pilot design.',
          items: [{ resource_id: 'pilot:summary:2026-q4', fields: ['cohort_size', 'completion_rate', 'anonymous_feedback'] }],
          redactions: ['Names', 'Email addresses', 'Free-text notes that could identify a participant'], retention_until: context.at(60 * 24 * 30),
        },
      },
    },
    {
      type: 'record_change',
      subject: 'Update pilot readiness records',
      label: 'Record change',
      proposal: {
        kind: 'approval', approval_type: 'record_change', illustrative: true,
        summary: 'Review every before-and-after value in a bounded fictional CRM update.',
        consequence: 'Approval authorizes only these field-level changes and the documented rollback.',
        evidence: [{ id: 'validation-report', kind: 'artifact', label: 'Dry-run validation report', ref: 'artifact:crm-dry-run:v1' }],
        details: {
          system_id: 'crm-demo', system_label: 'Illustrative partner CRM',
          changes: [
            { record_id: 'partner-104', field: 'pilot_status', before: 'qualified', after: 'ready_for_invite' },
            { record_id: 'partner-104', field: 'cohort', before: null, after: '2026-q4-pilot' },
          ],
          validation: ['Dry-run matched exactly one fictional record', 'No protected fields are included'],
          rollback: 'Restore the captured before values for this exact record and authorization revision.',
        },
      },
    },
    {
      type: 'exception',
      subject: 'Allow a 24-hour review extension',
      label: 'Policy exception',
      proposal: {
        kind: 'approval', approval_type: 'exception', illustrative: true,
        summary: 'Allow one fictional pilot review to exceed the normal response window by 24 hours.',
        consequence: 'The exception is limited to this review and expires automatically.',
        evidence: [{ id: 'incident', kind: 'document', label: 'Reviewer outage note', ref: 'incident:reviewer-outage' }],
        details: {
          rule_id: 'review-window-48h', rule_label: 'Pilot requests require a decision within 48 hours',
          reason: 'The named reviewer is unavailable during the final four hours of the normal window.',
          scope: 'Only request pilot-review-104; no other deadlines or policy checks change.',
          compensating_controls: ['No external effect before review', 'Automatic expiry after 24 additional hours'],
          exception_expires_at: context.at(60 * 24),
        },
      },
    },
    {
      type: 'agent_governance',
      subject: 'Change Rowan’s schedule and tools',
      label: 'Agent governance',
      proposal: {
        kind: 'approval', approval_type: 'agent_governance', illustrative: true,
        summary: 'Alex must review a proposed schedule and tool-scope change for Rowan.',
        consequence: 'Approval authorizes only the displayed configuration delta; applying it remains a separate effect.',
        evidence: [{ id: 'config-export', kind: 'artifact', label: 'Current agent configuration', ref: 'agent:rowan:config:v8' }],
        details: {
          agent_id: recipientAgentId, current_schedule: 'Weekdays at 09:00', proposed_schedule: 'Weekdays at 09:00 and 15:00',
          current_tools: ['read_workspace_files'], proposed_tools: ['read_workspace_files', 'web-search'],
          setting_changes: [{ key: 'max_run_minutes', before: 30, after: 45 }],
          affected_permissions: ['External web research', 'Twice-daily scheduled runs'],
        },
      },
    },
  ];

  const requests: RequestEntity[] = [];
  const views = new Map<string, ApprovalView>();

  proposals.forEach(({ type, subject, label, proposal }, index) => {
    const requestId = APPROVAL_DEMO_REQUEST_IDS[type];
    const isPlan = type === 'run_plan';
    const waitsForAlex = type === 'agent_governance';
    const policySteps = isPlan
      ? [
          { id: 'owner-review', label: 'Workspace owner', order: 0, reviewers: [{ kind: 'member' as const, member_id: context.mayaMemberId }], quorum: 1 },
          { id: 'finance-review', label: 'Budget reviewer', order: 1, reviewers: [{ kind: 'member' as const, member_id: context.alexMemberId }], quorum: 1 },
        ]
      : [{ id: 'primary-review', label: waitsForAlex ? 'Agent administrator' : 'Workspace owner', order: 0, reviewers: [{ kind: 'member' as const, member_id: waitsForAlex ? context.alexMemberId : context.mayaMemberId }], quorum: 1 }];
    const policy = {
      id: mockUuid(1_100 + index), key: `demo-${type}`, version: 1,
      mode: (isPlan ? 'sequential' : 'parallel') as 'sequential' | 'parallel',
      prevent_self_review: true, require_distinct_reviewers: true as const, steps: policySteps,
    };
    const derivedTargetAgentIds = targetAgentIds(proposal);
    const derivedTargetResourceIds = targetResourceIds(proposal);
    const derivedTargetMemberIds = targetMemberIds(proposal, derivedTargetResourceIds, context.mayaMemberId);
    const effectKind = effectFor(type);
    const effectUnavailableReason = 'Illustrative demo only; no external provider is connected and no effect occurred.';
    const payload: ApprovalPayload = {
      ...proposal,
      context: {
        requester: { agent_id: context.requesterAgentId, member_id: null, user_id: null },
        target_agent_ids: derivedTargetAgentIds,
        target_member_ids: derivedTargetMemberIds,
        target_resource_ids: derivedTargetResourceIds,
        source: { session_id: context.sessionId, run_id: context.runId, dependent_request_ids: type === 'deliverable' ? [releaseRequestId] : [] },
      },
      authorization: { revision: 1, hash: hashFor(index + 1), expires_at: context.at(60 * 24 * 7) },
      policy,
      resource_bindings: proposal.evidence.map((item, evidenceIndex) => ({
        kind: item.kind === 'source' ? 'resource' : item.kind,
        id: item.id, version: 'v1', sha256: (index + evidenceIndex + 20).toString(16).padStart(64, '0'),
        immutable: true, executor_available: true, reason: null,
      })),
    } as ApprovalPayload;
    const currentMemberId = waitsForAlex ? context.alexMemberId : context.mayaMemberId;
    const projection: ApprovalListProjection = {
      approval_type: type, authorization_status: 'pending', authorization_revision: 1,
      expires_at: payload.authorization.expires_at,
      pending_for_viewer: !waitsForAlex, waiting_on_others: waitsForAlex,
      current_reviewer_names: [waitsForAlex ? 'Alex Rivera' : 'Maya Chen'],
      effect_status: effectKind === 'none' ? 'not_required' : 'unavailable', work_status: 'waiting',
    };
    requests.push({
      id: requestId, kind: 'approval', status: 'pending', label, subject, title: subject,
      session_id: context.sessionId, run_id: context.runId, created_at: context.at(index - 20), version: 1,
      payload: payload as unknown as Record<string, unknown>, sources: [], missing: [], note: null,
      decision_id: null, decided_at: null, decided_by_name: null, approval: projection,
    });
    views.set(requestId, {
      request_id: requestId, workspace_id: context.workspaceId, status: 'pending', payload,
      identities: {
        requester_agent: { id: context.requesterAgentId, name: 'Iris', email: 'iris@hermesmail.example' },
        target_agents: derivedTargetAgentIds.map((agentId) => agentId === context.requesterAgentId
          ? { id: agentId, name: 'Iris', email: 'iris@hermesmail.example', responsible_member_id: null, responsible_member_name: null }
          : { id: agentId, name: 'Rowan', email: 'rowan@hermesmail.example', responsible_member_id: context.mayaMemberId, responsible_member_name: 'Maya Chen' }),
        reviewers: [
          { member_id: context.mayaMemberId, user_id: context.mayaUserId, name: 'Maya Chen', authority_roles: ['workspace_owner'] },
          { member_id: context.alexMemberId, user_id: context.alexUserId, name: 'Alex Rivera', authority_roles: ['finance', 'agent_admin'] },
        ],
      },
      votes: [],
      steps: policySteps.map((step, stepIndex) => ({
        step_id: step.id, label: step.label, order: step.order,
        status: stepIndex === 0 ? 'current' : 'blocked', approvals_recorded: 0, quorum: step.quorum,
        current_reviewer_member_ids: stepIndex === 0 ? [currentMemberId] : [],
      })),
      capabilities: waitsForAlex
        ? { allowed_decisions: [], eligible_step_ids: [], can_route: false, can_submit_revision: false, reason: 'Waiting for Alex Rivera.' }
        : { allowed_decisions: ['approve', 'decline', 'request_changes'], eligible_step_ids: [policySteps[0]!.id], can_route: true, can_submit_revision: false, reason: null },
      effect: { kind: effectKind, status: effectKind === 'none' ? 'not_required' : 'unavailable', effect_id: null, reason: effectKind === 'none' ? 'No external provider effect is required.' : effectUnavailableReason },
      work: { status: 'waiting', continuation_id: null, reason: 'Waiting for authorization.' },
      finalized_at: null,
    });
  });

  return { requests, views };
}
