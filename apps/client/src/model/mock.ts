// Mock server mode: the whole client, exercised without the Worker.
//
//     MOCK=1 pnpm --filter @hermes/client build
//     MOCK=1 pnpm --filter @hermes/client dev
//
// It is a `fetch` and a `WebSocket` the adapter is handed instead of the real
// ones, so every byte still goes through the same REST client and the same zod
// parse. A mock response that does not satisfy the contract fails here, in the
// client, which is the point: the fixture and the server cannot drift quietly.
//
// The run stream comes from `packages/shared`'s `mockRunStream`, so the
// difficult sequences the reducer must survive — a retried step attempt, a
// stopped run, a request that is focused before it is created — are the
// contract's own scenarios rather than a second set invented here.
//
// `__MOCK__` is a build-time constant, so a production build drops this module
// entirely.
import { mockRunStream, mockUuid, SCHEMA_VERSION, DEFAULT_MODEL_ID, DEFAULT_EFFORT, messageSchema, sessionSchema, AGENT_OPERATION_CATALOG, type AgentPermissions, type ContextNote, type AttachmentDetail, type AgentRecoveryView, type StreamEvent } from '@hermes/shared';
import type { ApprovalView, EnterpriseSkillAssignment, InstructionVersion, InvitationEntity, LibrarySource, MaskedProviderKey, MemberEntity, PartnerEngagementSummary, PartnerHandoffResult, PartnerWorkflowHandoffV2, PartnerWorkflowViewerRole, Ref, RequestEntity, SharedIntelligenceGoal, SharedIntelligenceProposal, SharedIntelligenceTriageAssessment, SharedIntelligenceWorkspace, TraceEntity } from '@hermes/shared';
import type { SocketLike } from './hub.js';
import { APPROVAL_DEMO_REQUEST_IDS, createApprovalDemoFixtures } from './approval-fixtures.js';
import { actionsFor, initialState, reduce, sessionFrom } from './store.js';
import type { RuntimeDiscoveryGrant } from './runtime-capacity.js';

const WS = mockUuid(1);
const USER = mockUuid(100);
const MEMBER_USER = mockUuid(101);
const AGENT = mockUuid(102);
const FINANCE_AGENT = mockUuid(103);
const MAYA_MEMBER = mockUuid(200);
const ALEX_MEMBER = mockUuid(201);
const SESSION_A = mockUuid(2);
const SESSION_B = mockUuid(20);
const RUN = mockUuid(3);
const REQ_LEAH = mockUuid(11);
const REQ_OWEN = mockUuid(12);
const REQ_INVOICE = mockUuid(13);
const REQ_AGREEMENT = mockUuid(14);
const DOC_INVOICE = mockUuid(30);
const KEY_ID = mockUuid(40);
const TRACE_LEAH = mockUuid(50);
// An explicit selection for recovery UI coverage, independent of product defaults.
const RECOVERY_MODEL_ID = 'nous:deepseek/deepseek-v4.1-flash';

export const MOCK_WORKSPACE_ID = WS;
export const MOCK_WORKSPACE_NAME_KEY = 'hermes:mock-workspace-name';

/**
 * Two strings the server owns, copied here exactly.
 *
 * They are product claims about jurisdiction and about erasure, and the mock's
 * job is to fail when the client stops rendering them — which it cannot do if
 * the fixture's version is a paraphrase. See `apps/worker/src/routes/settings.ts`.
 */
const DEEPSEEK_WARNING =
  'DeepSeek stores data on servers in the People’s Republic of China. Its privacy policy is explicit ' +
  'about this. Do not send real applicant data, or any other personal data you do not have a lawful basis ' +
  'to transfer there, on a DeepSeek key. Use synthetic or consented data, or a provider whose Admin has ' +
  'recorded a zero-retention attestation.';

const ERASURE_COPY =
  'Erasure tombstones the rows immediately: the person’s text is gone from the product the moment you ' +
  'ask, and the audit trail keeps only ids. The bytes take longer to disappear from the places that exist ' +
  'so that we can recover from a failure. Point-in-time database history holds them for 7 days and the ' +
  'nightly backup for 30, both on fixed expiry rules nobody here can shorten for one record. Erasure is ' +
  'therefore complete 30 days after you ask, and we will not tell you otherwise.';

interface MockSession {
  id: string;
  agent_id: string;
  title: string;
  mode: string;
  model_id: string;
  effort: string | null;
  runtime: string;
  pinned: boolean;
  archived: boolean;
  focus_ref: Ref | null;
  status: string;
  last_activity_at: string;
  share: { id: string; url: string; audience: string; created_at: string; messages: number } | null;
  context: { label: string; ref: Ref | null } | null;
  version: number;
}

const iso = (offsetMinutes = 0) => new Date(Date.UTC(2026, 9, 12, 9, 49 + offsetMinutes, 0)).toISOString();
const hashForMock = (index: number): `sha256:${string}` => `sha256:${index.toString(16).padStart(64, '0')}`;
const moneyForMock = (minor: number, currency: string): string => `${currency} ${(minor / 100).toFixed(2)}`;

interface MockOptions {
  /** Opt-in settings fixtures; never part of the live bundle. */
  agentSettings?: 'ok' | 'fail' | 'conflict';
  pendingAgentApproval?: boolean;
  /** Isolated recovery fixtures; no live agent or provider work occurs. */
  recovery?: 'working' | 'retryable' | 'retry_scheduled' | 'blocked' | 'stopped' | 'idle';
  /** Terminal Hermes traces for the activity-card regression, never live data. */
  activity?: 'completed' | 'completed-tool';
  /** `admin` is the first-run Admin seat; `member` exercises the Member copy. */
  seat?: 'admin' | 'member';
  /** `empty` renders every empty state; `seeded` is the October 12 workspace. */
  data?: 'seeded' | 'empty';
  /** No verified provider key: the composer greys and the banner shows. */
  providerKey?: 'verified' | 'none' | 'invalid';
  /** Simulate an older Worker that step-up protects even the masked key list. */
  providerKeysLocked?: boolean;
  /** Browser-only fixture for the Admin capacity step-up and lifecycle flow. */
  runtimeCapacityStepUp?: boolean;
  /**
   * `markdown` swaps the seeded reply for one that uses the whole safe subset
   * (decision C39): headings, bold, a list, a table, inline and fenced code, a
   * blockquote, a link and an `<img onerror>` that must render as text.
   *
   * It exists because the *scripted* provider writes one fixed sentence, so
   * there is no way to see the renderer in the product without either a real
   * provider call or this. It is a fixture, named as one, and it is also the
   * fastest way to look at the thing by hand: `MOCK=1 pnpm --filter client dev`
   * then `/?reply=markdown`.
   */
  reply?: 'seeded' | 'markdown';
  /** Dedicated opt-in enterprise approval fixture. The default remains the legacy four-request demo. */
  scenario?: 'legacy' | 'approvals';
  communicationDraft?: boolean;
  /** Preserve the name created by the credential-free onboarding fixture. */
  workspaceName?: string;
  /** Browser regression fixture for rejected member and invitation writes. */
  memberWrites?: 'ok' | 'fail';
  /** Server-advertised invitation contract; default mirrors flag-off deployments. */
  memberInvitations?: 'legacy_delivery' | 'setup_only';
  /** Existing unfinished setup shown while the deployment is flag-off. */
  pausedMemberSetup?: boolean;
  /** Explicitly labeled connected Slack fixture for Settings browser coverage. */
  slack?: 'disconnected' | 'connected';
  /** Explicitly labeled Gmail fixture for Settings browser coverage. */
  email?: 'disconnected' | 'connected';
  /** Labeled two-team fixture for the role-template and invoice provenance UI. */
  partnerWorkflow?: boolean;
  /** Contract fixture for native execution over explicitly labeled sample inputs. */
  partnerWorkflowNative?: boolean;
  /** Explicit authorization view for the local multi-party fixture. */
  workflowRole?: PartnerWorkflowViewerRole;
  /** First-activation fixture: roles exist, but no native readiness has been saved yet. */
  workflowActivation?: 'success' | 'native-mismatch' | 'binding-drift';
}

type MockRequest = RequestEntity;

function request(id: string, kind: 'application' | 'invoice' | 'agreement', status: RequestEntity['status'], subject: string, label: string, extra: Record<string, unknown> = {}): MockRequest {
  return {
    id,
    kind,
    status,
    label,
    subject,
    title: kind === 'application' ? 'Partner Program application' : kind === 'invoice' ? 'Invoice INV-2026-014' : 'Services agreement AGR-2026-004',
    session_id: SESSION_A,
    run_id: RUN,
    created_at: iso(-5),
    version: 1,
    payload: extra,
    sources:
      kind === 'application'
        ? [
            { id: 'site', name: 'partner site', note: 'Applicant-supplied. Customer outcomes are not independently verified.' },
            { id: 'repo', name: 'GitHub repository', note: 'Public repository; last commit 9 days ago.' },
          ]
        : [],
    missing: kind === 'application' ? ['Customer impact', id === REQ_LEAH ? 'Delivery timeline' : 'Weekly capacity'] : [],
    note: null,
    decision_id: null,
    decided_at: null,
    decided_by_name: null,
    provenance: { kind: 'sample', source: 'browser_fixture', recorded_at: iso(-5) },
    presentation: { hidden: false, hidden_at: null, hidden_reason: null },
  };
}

export function createMockBackend(options: MockOptions = {}) {
  const seat = options.seat ?? 'admin';
  const setupOnly = options.memberInvitations === 'setup_only';
  const workflowRole = options.workflowRole ?? (seat === 'member' ? 'finance' : 'admin');
  const empty = options.data === 'empty';
  const approvalScenario = options.scenario === 'approvals' && !empty;
  const keyMode = options.providerKey ?? (empty ? 'none' : 'verified');
  let workspaceName = options.workspaceName?.trim() || 'Nous';
  const replyText =
    options.reply === 'markdown'
      ? [
          '### What is waiting on you',
          '',
          'Two applications, one invoice and an agreement. **Leah** and **Owen** both',
          'attached integration examples; the invoice is missing a `delivery_date`.',
          '',
          '| Request | Kind | Waiting on |',
          '| --- | --- | --- |',
          '| Leah Martinez | application | your decision |',
          '| Owen Reilly | application | your decision |',
          '| INV-2026-014 | invoice | a delivery date |',
          '',
          'What I did, in order:',
          '',
          '1. Read the partner criteria',
          '2. Checked each application against it',
          '3. Wrote a review note for each, *unsent*',
          '',
          '> Admission and access still need a person. I have proposed, not decided.',
          '',
          'The criterion I matched on:',
          '',
          '```json',
          '{ "criterion": "integration_example", "required": true }',
          '```',
          '',
          'Source: [the partner criteria](https://example.com/partner-criteria) — and a',
          'page that tried to be markup: <img src=x onerror="alert(1)">',
        ].join('\n')
      : 'Four requests are ready: Leah and Owen’s applications, Robin’s invoice, and the next workshop agreement. Noor’s feedback reply also needs a destination.';

  const demoProfileSources = [
    { id: 'linkedin', name: 'LinkedIn', note: 'Illustrative role history and program launch timeline.', url: 'https://www.linkedin.com/' },
    { id: 'github', name: 'GitHub', note: 'Illustrative curriculum repository and public contributions.', url: 'https://github.com/' },
    { id: 'youtube', name: 'YouTube', note: 'Illustrative bootcamp sessions and technical walkthroughs.', url: 'https://www.youtube.com/' },
    { id: 'x', name: 'X profile', note: 'Illustrative public writing about field engineering.', url: 'https://x.com/' },
  ];
  const invoiceFixture = options.partnerWorkflow
    ? {
        subject: 'Robin Studio',
        label: 'INV-SAMPLE-014',
        payload: {
          kind: 'invoice', number: 'INV-SAMPLE-014', total_minor: 120000, currency: 'USD', payee: { name: 'Robin Studio' }, payer: { name: 'Nous Research' }, issue_date: '2026-09-12', due_date: '2026-09-26',
          notes: 'Sample invoice for the local fixture. No provider call, payment, or email occurs.',
          lines: [{ id: 'l1', label: 'Partner enablement workshop', short: 'Workshop', qty: 1, amount_minor: 120000, date: '2026-09-08', source_ids: [mockUuid(619)] }],
          workflow_provenance: {
            handoff_id: mockUuid(610),
            input_provenance: 'sample',
            shared_partner: { id: mockUuid(611), name: 'Robin Studio', engagement_reference: 'ENG-SAMPLE-42' },
            source_sessions: [
              { role: 'partnerships', agent_name: 'Iris', session_id: SESSION_A, run_id: RUN, excerpt: 'Sample authorized engagement excerpt only.', simulated: true },
              { role: 'finance', agent_name: 'Ledger', session_id: SESSION_B, run_id: mockUuid(612), excerpt: 'Sample invoice fields matched the authorized amount.', simulated: true },
            ],
            source_record_revisions: { engagement: 1, invoice: 1 },
            checks: { duplicate: 'clear', engagement_match: 'matched', missing_context: [] },
          },
        },
      }
    : {
        subject: 'Robin Ellis',
        label: 'INV-2026-014',
        payload: {
          number: 'INV-2026-014', total_minor: 120000, currency: 'USD', issued: 'Oct 12, 2026', due: 'Oct 26, 2026',
          notes: 'Fictional demo invoice. No provider is connected.',
          lines: [
            { id: 'l1', label: 'Partner workshop · Oct 8', short: 'Workshop', qty: 1, amount_minor: 90000, date: 'Oct 8' },
            { id: 'l2', label: 'Resource pack & follow-up · Oct 9', short: 'Resource pack', qty: 1, amount_minor: 30000, date: 'Oct 9' },
          ],
        },
      };
  const legacyRequests: MockRequest[] = empty
    ? []
    : [
        request(REQ_LEAH, 'application', 'pending', 'Leah Martinez', 'Leah Martinez', {
          kind: 'application', applicant: { name: 'Leah Martinez' }, proposed_role: 'Delivery Partner', score: 82, score_max: 100,
          criteria: [
            { id: 'track-record', label: 'track-record', points: 28, points_max: 30, evidence: 'Created and led an FDE bootcamp for implementation teams.', source_ids: ['linkedin', 'youtube'] },
            { id: 'capacity', label: 'capacity', points: 22, points_max: 30, evidence: 'Published a six-week curriculum with recurring office hours.', source_ids: ['github', 'youtube'] },
            { id: 'fit', label: 'fit', points: 32, points_max: 40, evidence: 'Shares practical field-engineering guidance across public channels.', source_ids: ['github', 'x'] },
          ],
          sources: demoProfileSources,
          missing: ['Human review', 'Independent verification of demo claims'],
          benefits: ['Partner directory listing', 'Program Slack access', 'Quarterly review slot'],
        }),
        request(REQ_OWEN, 'application', 'pending', 'Owen Reilly', 'Owen Reilly', {
          kind: 'application', applicant: { name: 'Owen Reilly' }, proposed_role: 'Delivery Partner', score: 78, score_max: 100,
          criteria: [
            { id: 'track-record', label: 'track-record', points: 26, points_max: 30, evidence: 'Built a public integration guide used by partner engineers.', source_ids: ['linkedin', 'github'] },
            { id: 'capacity', label: 'capacity', points: 20, points_max: 30, evidence: 'Runs a recurring technical workshop and publishes the recordings.', source_ids: ['youtube'] },
            { id: 'fit', label: 'fit', points: 32, points_max: 40, evidence: 'Writes consistently about deployment and partner enablement.', source_ids: ['x', 'github'] },
          ],
          sources: demoProfileSources,
          missing: ['Human review', 'Independent verification of demo claims'],
          benefits: ['Partner directory listing', 'Program Slack access'],
        }),
        request(REQ_INVOICE, 'invoice', 'pending', invoiceFixture.subject, invoiceFixture.label, invoiceFixture.payload),
        request(REQ_AGREEMENT, 'agreement', 'pending', 'Robin Ellis', 'AGR-2026-004', { number: 'AGR-2026-004', sections: [['Scope', 'One partner workshop on Oct 22–23, with materials prepared in advance.'], ['Fees', 'USD 1,200, payable 14 days after an accepted delivery statement.'], ['Term', 'Effective on signature by both parties; either party may end it with 14 days notice.']] }),
      ];
  const approvalDemo = createApprovalDemoFixtures({
    communicationDraft: options.communicationDraft,
    workspaceId: WS,
    sessionId: SESSION_A,
    runId: mockUuid(1_030),
    requesterAgentId: AGENT,
    mayaUserId: USER,
    mayaMemberId: MAYA_MEMBER,
    alexUserId: MEMBER_USER,
    alexMemberId: ALEX_MEMBER,
    at: iso,
  });
  const approvalViews = approvalScenario ? approvalDemo.views : new Map<string, ApprovalView>();
  const requests: MockRequest[] = approvalScenario ? [...legacyRequests, ...approvalDemo.requests] : legacyRequests;
  if (options.partnerWorkflow && approvalScenario) {
    const requestId = APPROVAL_DEMO_REQUEST_IDS.record_change;
    const view = approvalViews.get(requestId);
    const row = requests.find((item) => item.id === requestId);
    if (view && row && view.payload.approval_type === 'record_change') {
      view.payload = {
        ...view.payload,
        summary: 'Authorize sample Robin Studio terms for an invoice-checking demonstration.',
        consequence: 'Approval records sample terms for one demonstration. It does not confirm an external agreement, sign an agreement, approve payment, or confirm delivery.',
        evidence: [{ id: 'sample-engagement-source', kind: 'source', label: 'Sample engagement terms.txt', ref: `attachment:${mockUuid(616)}` }],
        details: {
          system_id: 'enterprise-partner-records',
          system_label: 'Enterprise partner records',
          changes: [
            { record_id: 'partner:robin-studio', field: 'purpose', before: null, after: 'Partner enablement workshop' },
            { record_id: 'partner:robin-studio', field: 'authorized_total', before: null, after: 'USD 1,200.00' },
            { record_id: 'partner:robin-studio', field: 'invoice_scope', before: null, after: 'One invoice' },
            { record_id: 'partner:robin-studio', field: 'input_provenance', before: null, after: 'sample' },
          ],
          validation: ['Stored source is readable and unchanged', 'Alex Rivera is the named Finance reviewer'],
          rollback: 'Revoke this exact authorization revision before an invoice is accepted.',
        },
        context: { ...view.payload.context, target_member_ids: [ALEX_MEMBER], target_resource_ids: ['enterprise-partner-records'] },
        policy: {
          ...view.payload.policy,
          steps: view.payload.policy.steps.map((step, index) => index === 0 ? { ...step, label: 'Finance reviewer', reviewers: [{ kind: 'member' as const, member_id: ALEX_MEMBER }] } : step),
        },
      };
      view.steps = view.steps.map((step, index) => index === 0 ? { ...step, label: 'Finance reviewer', current_reviewer_member_ids: [ALEX_MEMBER] } : step);
      row.subject = 'Record Robin Studio engagement terms';
      row.label = 'Engagement terms';
      row.title = 'Record agreed engagement terms';
      row.payload = view.payload as unknown as Record<string, unknown>;
      row.approval = { ...row.approval!, current_reviewer_names: ['Alex Rivera'], current_steps: [{ label: 'Finance reviewer', approvals_recorded: 0, quorum: 1 }], pending_for_viewer: false, waiting_on_others: true };
      row.decision_summary = {
        ...row.decision_summary!,
        primary: view.payload.summary,
        consequence: view.payload.consequence,
        approval_requirement: { ...row.decision_summary!.approval_requirement, current: [{ label: 'Finance reviewer', approvals_recorded: 0, quorum: 1 }], pending_for_viewer: false, waiting_on_others: true },
      };
    }
  }

  const members: MemberEntity[] = [
    { id: MAYA_MEMBER, user_id: USER, name: 'Maya Chen', email: 'maya@nous.example', role: 'admin' as const, status: 'active' as const, reviewer_roles: ['access', 'workspace_owner'], joined_at: iso(-4000), version: 1 },
    ...(empty ? [] : [
      { id: ALEX_MEMBER, user_id: MEMBER_USER, name: 'Alex Rivera', email: 'alex@nous.example', role: 'admin' as const, status: 'active' as const, reviewer_roles: ['finance', 'agent_admin'], joined_at: iso(-5000), version: 1 },
    ]),
  ];
  // Pending invitations live here, not in the accepted-members mirror. Keeping
  // the mock shaped like the server prevents the Members fixture from teaching
  // the client two contradictory sources of truth.
  const invitations: InvitationEntity[] = empty
    ? []
    : [{
        id: mockUuid(210), email: 'lena@nous.example', role: 'member', status: 'pending', invited_at: iso(-4000),
        role_template_key: options.pausedMemberSetup ? 'partnerships-agent' : 'finance-agent',
        provisioning: {
          id: mockUuid(211), workspace_id: WS, revision: 1,
          preparation: options.pausedMemberSetup ? 'queued' : 'ready',
          delivery: options.pausedMemberSetup ? 'not_queued' : 'sent',
          membership: 'not_joined', cancellation: 'none', issue: null,
        },
        version: 1,
      }];
  const runtimeDiscoveryGrants: RuntimeDiscoveryGrant[] = [];

  const providerKeys: MaskedProviderKey[] =
    keyMode === 'none'
      ? []
      : [
          {
            id: KEY_ID,
            provider: 'nous_portal',
            label: 'Program key',
            last4: '9f2c',
            fingerprint_prefix: 'a41b93cd77e0',
            status: keyMode === 'invalid' ? 'invalid' : 'verified',
            // A Nous Portal key's `verified_models` stays empty: the list is
            // several hundred ids and lives in the catalog, so the row carries
            // a count and a date instead (decision R7).
            verified_models: [],
            synced_model_count: keyMode === 'invalid' ? null : 3,
            models_synced_at: keyMode === 'invalid' ? null : iso(-600),
            added_by: USER,
            created_at: iso(-6000),
            verified_at: keyMode === 'invalid' ? null : iso(-6000),
            rotated_at: null,
            revoked_at: null,
            replaces_key_id: null,
            credential_kind: 'api_key',
            oauth_expires_at: null,
          },
        ];

  const hasVerifiedKey = providerKeys.some((k) => k.status === 'verified' || k.status === 'verified_scoped');

  // Nous Portal rows only, because that is the only provider the Worker offers
  // and the only one `GET /w/:ws/catalog` returns (decision R12). A mock that
  // still listed DeepSeek and GPT rows would be a fixture teaching the client's
  // own scenarios about a screen the product no longer has.
  const catalog = [
    { model_id: 'nous:anthropic/claude-sonnet-5', label: 'Anthropic: Claude Sonnet 5', provider: 'nous_portal', effort: ['low', 'medium', 'high'], default_effort: 'medium', enabled: hasVerifiedKey, disabled_reason: hasVerifiedKey ? null : 'Connect Nous Portal in Settings to use this model.' },
    ...(options.recovery ? [{ model_id: RECOVERY_MODEL_ID, label: 'DeepSeek V4.1 Flash', provider: 'nous_portal', effort: ['low', 'high', 'max'], default_effort: 'low', enabled: hasVerifiedKey, disabled_reason: hasVerifiedKey ? null : 'Connect Nous Portal in Settings to use this model.' }] : []),
    { model_id: 'nous:google/gemini-3-flash', label: 'Google: Gemini 3 Flash', provider: 'nous_portal', effort: null, default_effort: null, enabled: hasVerifiedKey, disabled_reason: hasVerifiedKey ? null : 'Connect Nous Portal in Settings to use this model.' },
    { model_id: 'nous:stepfun/step-3.7-flash', label: 'StepFun: Step 3.7 Flash', provider: 'nous_portal', effort: null, default_effort: null, enabled: hasVerifiedKey, disabled_reason: hasVerifiedKey ? null : 'Connect Nous Portal in Settings to use this model.' },
    { model_id: 'nous:stepfun/step-3.7-flash:free', label: 'StepFun: Step 3.7 Flash', provider: 'nous_portal', effort: null, default_effort: null, enabled: hasVerifiedKey, disabled_reason: hasVerifiedKey ? null : 'Connect Nous Portal in Settings to use this model.' },
  ];

  /**
   * The same rows as `catalog`, in the shape `GET /w/:ws/catalog` answers, plus
   * one tool-less Nous Portal row so the model menu's vendor grouping and its
   * tools-required note have something to render in a mock build.
   */
  const catalogEntries = [
    ...catalog.map((row) => ({
      model_id: row.model_id,
      provider: row.provider,
      label: row.label,
      transport: 'nous_chat',
      effort_map: row.effort === null ? null : Object.fromEntries(row.effort.map((value) => [value, value])),
      default_effort: row.default_effort,
      pricing_per_million: row.model_id.endsWith(':free')
        ? { input: 0, output: 0, input_off_peak: null, output_off_peak: null, cached_input: null }
        : { input: 3, output: 15, input_off_peak: null, output_off_peak: null, cached_input: 0.3 },
      pricing_verified_on: '2026-09-15',
      enabled: row.enabled,
      disabled_code: row.enabled ? null : 'no_key',
      disabled_reason: row.disabled_reason,
      source: 'provider_list',
      context_length: 200_000,
      supports_tools: true,
      supports_reasoning: row.effort !== null,
    })),
    {
      model_id: 'nous:meta-llama/llama-4-70b-instruct',
      provider: 'nous_portal',
      label: 'Meta: Llama 4 70B Instruct',
      transport: 'nous_chat',
      effort_map: null,
      default_effort: null,
      pricing_per_million: { input: 0.27, output: 0.85, input_off_peak: null, output_off_peak: null, cached_input: null },
      pricing_verified_on: '2026-09-15',
      enabled: false,
      disabled_code: 'catalog',
      disabled_reason: 'This model has no tool calling, which every run needs.',
      source: 'provider_list',
      context_length: 131_072,
      supports_tools: false,
      supports_reasoning: false,
    },
  ];

  const sessions: MockSession[] = empty
    ? [{ id: SESSION_A, agent_id: AGENT, title: 'New session', mode: 'ask', model_id: DEFAULT_MODEL_ID, effort: DEFAULT_EFFORT, runtime: 'cloud', pinned: false, archived: false, focus_ref: null, status: 'Empty', last_activity_at: iso(0), share: null, context: null, version: 1 }]
    : [
        { id: SESSION_A, agent_id: AGENT, title: options.partnerWorkflow ? 'Robin Studio · invoice source' : 'Partner applications', mode: 'work', model_id: DEFAULT_MODEL_ID, effort: DEFAULT_EFFORT, runtime: 'cloud', pinned: options.partnerWorkflow ? false : true, archived: false, focus_ref: { section: 'agents', view: 'overview' }, status: options.partnerWorkflow ? 'Invoice received' : 'Needs review', last_activity_at: iso(0), share: null, context: { label: options.partnerWorkflow ? 'ENG-SAMPLE-42' : 'Partner Program', ref: { section: 'agents', view: 'overview' } }, version: 1 },
        { id: SESSION_B, agent_id: options.partnerWorkflow ? FINANCE_AGENT : AGENT, title: options.partnerWorkflow ? 'Robin Studio · Finance review' : 'Provider documents', mode: 'plan', model_id: DEFAULT_MODEL_ID, effort: DEFAULT_EFFORT, runtime: 'cloud', pinned: false, archived: false, focus_ref: null, status: options.partnerWorkflow ? 'Awaiting Finance review' : 'Drafts ready', last_activity_at: options.partnerWorkflow ? iso(1) : iso(-10), share: null, context: null, version: 1 },
      ];
  if (options.partnerWorkflow) {
    const visibleSessionId = workflowRole === 'partnerships' ? SESSION_A : workflowRole === 'finance' ? SESSION_B : null;
    sessions.splice(0, sessions.length, ...sessions.filter((session) => session.id === visibleSessionId));
  }

  const messages: Record<string, unknown[]> = {
    [SESSION_A]: empty
      ? []
      : options.partnerWorkflow
        ? [{ id: mockUuid(300), session_id: SESSION_A, seq: 1, role: 'user', kind: null, text: 'Sample fixture input — no model call: received INV-SAMPLE-014 for the authorized Robin Studio workshop.', blocks: [], status: 'complete', run_id: null, at: iso(-2) }]
      : [
          { id: mockUuid(300), session_id: SESSION_A, seq: 1, role: 'user', kind: null, text: 'What needs me before the partner work can move forward?', blocks: [], status: 'complete', run_id: null, at: iso(-2) },
          {
            id: mockUuid(301),
            session_id: SESSION_A,
            seq: 2,
            role: 'iris',
            kind: null,
            heading: approvalScenario ? 'Approval inbox is ready' : 'Four requests are ready',
            text: approvalScenario ? 'I prepared ten illustrative approval requests without making any external change. Maya has nine decisions; Alex owns the agent-configuration review. The plan requires Maya first and Alex second.' : replyText,
            blocks: [
              { type: 'card', title: 'Leah Martinez', subtitle: '82 / 100 · Awaiting your review', action: { label: 'Open request', command: { type: 'open_request', id: REQ_LEAH } } },
              ...(approvalScenario ? [
                { type: 'receipt', requestId: APPROVAL_DEMO_REQUEST_IDS.run_plan },
                { type: 'receipt', requestId: APPROVAL_DEMO_REQUEST_IDS.communication },
              ] : []),
              { type: 'card', title: 'Unblock Noor’s reply', subtitle: 'Add the destination; I’ll prepare the draft. Not an approval.', action: { label: 'Open context', command: { type: 'nav', object: { section: 'agents', view: 'context', field: 'destination' } } } },
              { type: 'sources', title: 'Sources', subtitle: 'Partner criteria.md · Feedback guide.md' },
            ],
            status: 'complete',
            run_id: RUN,
            worked_ms: 42000,
            steps: ['Read the four requests', 'Checked the program criteria', 'Prepared the evidence reports'],
            at: iso(-1),
          },
        ],
    [SESSION_B]: options.partnerWorkflow ? [{ id: mockUuid(302), session_id: SESSION_B, seq: 1, role: 'user', kind: null, text: 'Message from 🤖 Iris (@agent-partnerships): Sample fixture — no model call. Review INV-SAMPLE-014 against ENG-SAMPLE-42.', blocks: [], status: 'complete', run_id: null, at: iso(0) }] : [],
  };

  const documents = empty
    ? []
    : [
        { id: DOC_INVOICE, kind: 'invoice' as const, number: 'INV-2026-014', title: 'Invoice INV-2026-014', status: 'Draft · Not sent', request_id: REQ_INVOICE, pdf_status: 'preparing' as const, pdf_url: null, pdf_error: null, payload: {}, version: 1, created_at: iso(-3) },
      ];

  const agentFiles = empty
    ? []
    : [
        { id: mockUuid(60), name: 'Partner criteria.md', subtitle: 'Team Drive · Read only', extraction: 'ready' as const, extraction_error: null, body: 'Partner criteria\n\nTrack record (30)\nCapacity (30)\nFit (40)\n', version: 1 },
        { id: mockUuid(61), name: 'Feedback guide.md', subtitle: 'Team Drive · Read only', extraction: 'ready' as const, extraction_error: null, body: 'Feedback guide\n\nAcknowledge, capture reproduction steps, route to the owning team.\n', version: 1 },
        { id: mockUuid(62), name: 'Program overview.pdf', subtitle: 'Team Drive · Read only', extraction: 'extracting' as const, extraction_error: null, body: null, version: 1 },
      ];

  const storedSources: AttachmentDetail[] = agentFiles.map((file) => ({ id: file.id, name: file.name, kind: 'agent_file', size: 160, mime: file.name.endsWith('.pdf') ? 'application/pdf' : 'text/markdown', sha256: 'a'.repeat(64), status: 'ready', extraction_status: file.extraction === 'ready' ? 'ready' : 'pending', extraction_error: null, text_length: file.body?.length ?? null, token_estimate: 30, created_at: iso(), url: null, url_expires_at: null }));
  const librarySources: LibrarySource[] = empty ? [] : [{
    id: mockUuid(63), version_id: mockUuid(64), slug: 'partner-program-guide',
    title: 'Partner Program Guide',
    summary: 'Shared operating guide for partner research, engagement authorization, invoice intake, and Finance review.',
    version: 1, version_label: '0.1 draft', sha256: 'b'.repeat(64),
    content_markdown: '# Partner Program Guide\n\nDraft shared reference for Partnerships and Finance.\n\n## From prospect to invoice\n\nUse approved terms and identify missing evidence.',
    audiences: ['Finance', 'Partnerships'], created_at: iso(-5), updated_at: iso(-5), kind: 'library_source',
  }];
  const sharedIntelligenceAssessment = {
    status: 'complete' as const,
    composite_score: 83,
    route: 'standard_review' as const,
    axes: {
      usefulness: { score: 3, confidence: .91 }, novelty: { score: 2, confidence: .84 },
      corroboration: { score: 3, confidence: .88 }, urgency: { score: 2, confidence: .8 }, uncertainty: { score: .5, confidence: .86 },
    },
    evidence_count: 2, rubric_version: '1', model_id: 'jev-1.13.0', model_version: 'jev-1.13.0-20260901',
    state_sha256: 'c'.repeat(64), latency_ms: 184, failure_class: null,
    warnings: ['A completed runtime is not proof that the business outcome succeeded.', 'The 70-point, 0.55-confidence, two-run routing thresholds are provisional review aids, not validated quality gates.'],
  };
  let sharedIntelligenceGoals: SharedIntelligenceGoal[] = empty ? [] : [{
    id: mockUuid(625), scope: 'workspace' as const, team_id: null, team_name: null,
    title: 'Reduce partner review rework this quarter', detail: 'Make repeat partner reviews faster without weakening evidence or approval controls.',
    revision: 1, content_sha256: 'a'.repeat(64), active: true, created_at: iso(-40),
  }];
  const sharedIntelligenceTriageAssessment: SharedIntelligenceTriageAssessment = {
    status: 'complete' as const, priority_score: 86, recommendation: 'include' as const, confidence: .84,
    axes: {
      relevance: { score: 3, confidence: .9 }, impact: { score: 2.8, confidence: .86 }, novelty: { score: 2.2, confidence: .8 },
      corroboration: { score: 2.7, confidence: .88 }, urgency: { score: 2, confidence: .78 }, uncertainty: { score: .6, confidence: .8 }, sensitivity: { score: .3, confidence: .86 },
    },
    reason_codes: ['goal_aligned', 'high_impact', 'corroborated'], goal_snapshot: sharedIntelligenceGoals[0]!, comparison_snapshot: [],
    evidence_count: 2, rubric_version: '2', model_id: 'jev-1.13.0', model_version: 'jev-1.13.0-20260901',
    state_sha256: 'e'.repeat(64), latency_ms: 166, failure_class: null, assessed_at: iso(-4),
    warnings: ['Jev ranks human attention; it does not decide publication or prove that a business outcome succeeded.'],
  };
  const sharedEvidence = (index: number) => ({
    id: mockUuid(900 + index), run_id: mockUuid(910 + index), session_id: index === 0 ? SESSION_A : SESSION_B,
    source_message_id: mockUuid(920 + index), source_message_role: 'iris' as const,
    session_title: index === 0 ? 'Partner application review' : 'Partner evidence follow-up', run_ended_at: iso(-20 + index),
    source_sha256: String(index + 1).repeat(64).slice(0, 64), approved_excerpt: index === 0
      ? 'Separate an applicant claim from independently verified evidence before escalating the review.'
      : 'The second review was faster after the evidence source and review date were recorded explicitly.',
    excerpt_sha256: String(index + 3).repeat(64).slice(0, 64), provenance: 'verified_quote' as const,
    tool_names: ['partner_record_read'], step_labels: ['Checked source record'], outcome: 'runtime_completed' as const, revoked_at: null,
  });
  let sharedIntelligenceProposals: SharedIntelligenceProposal[] = empty ? [] : [{
    id: mockUuid(930), title: 'Record evidence provenance before escalation', goal: 'Make partner reviews reproducible across Partnerships',
    lesson: 'Separate claims from independently verified evidence, and record the source version and review date before escalating a mismatch.',
    rationale: 'Two completed reviews showed that explicit provenance reduced repeat checking without changing approval authority.',
    agent_id: AGENT, agent_name: 'Iris', audiences: [{ id: mockUuid(620), slug: 'partnerships', name: 'Partnerships' }],
    evidence: [sharedEvidence(0), sharedEvidence(1)], assessment: sharedIntelligenceAssessment, status: 'ready_for_review',
    approval_request_id: null, library_source_id: null, library_version_id: null, created_at: iso(-5), published_at: null, revoked_at: null,
    triage_status: 'private', triage_goal_id: null, triage_assessment: null, triage_submitted_at: null, triage_decided_at: null,
  }];
  const sharedIntelligence = (): SharedIntelligenceWorkspace => ({
    teams: empty ? [] : [{ id: mockUuid(620), slug: 'partnerships', name: 'Partnerships' }],
    goals: sharedIntelligenceGoals,
    eligible_runs: empty ? [] : [
      { id: mockUuid(910), agent_id: AGENT, agent_name: 'Iris', session_id: SESSION_A, session_title: 'Partner application review', ended_at: iso(-20), model_id: 'deepseek-flash', active_ms: 42_000, tool_names: ['partner_record_read'], step_labels: ['Checked source record'], output_preview: sharedEvidence(0).approved_excerpt },
      { id: mockUuid(911), agent_id: AGENT, agent_name: 'Iris', session_id: SESSION_B, session_title: 'Partner evidence follow-up', ended_at: iso(-19), model_id: 'deepseek-flash', active_ms: 31_000, tool_names: ['partner_record_read'], step_labels: ['Checked source record'], output_preview: sharedEvidence(1).approved_excerpt },
    ],
    discoveries: empty ? [] : [{
      id: 'f'.repeat(64), suggested_title: 'Review a repeatable evidence-provenance pattern', suggested_goal: 'Make partner reviews reproducible across Partnerships',
      suggested_lesson: 'Separate a claim from independently verified evidence before escalating the review.',
      suggested_rationale: 'A local scan found two owner-visible completed runs with the same observable review step. Confirm whether the quoted outcome is reusable.',
      source_run_ids: [mockUuid(910), mockUuid(911)],
      approved_excerpts: [{ run_id: mockUuid(910), approved_excerpt: sharedEvidence(0).approved_excerpt, provenance: 'verified_quote' }, { run_id: mockUuid(911), approved_excerpt: sharedEvidence(1).approved_excerpt, provenance: 'verified_quote' }],
      evidence_strength: 'unassessed', warnings: ['Unassessed possible pattern only. Edit and verify it before asking for scored review.', 'Frequency is not corroboration or priority. Runtime completion does not establish business success.'],
    }],
    proposals: sharedIntelligenceProposals,
    data_boundary: 'Only completed runs you own are shown. A proposal uses verified excerpts from final user-visible messages; private traces, tool arguments/results, hidden reasoning, credentials, and other members\' work stay out.',
  });
  const confirmedNotes: ContextNote[] = [];
  const agentPermissions: AgentPermissions = { agent_id: AGENT, revision: 0, operations: AGENT_OPERATION_CATALOG.map((operation) => ({ ...operation, tool_names: [...operation.tool_names], require_human_approval: false })), pending_approvals: [] };
  if (options.pendingAgentApproval) agentPermissions.pending_approvals.push({ id: mockUuid(890), operation_id: 'save_review_notes', tool_name: 'save_review_note', arguments: { note: 'Mock review: evidence is incomplete.' }, run_id: mockUuid(891), created_at: iso() });

  const contextFields: { id: string; field: string; label: string; value: string | null; scope: 'reply' | 'future' | null; version: number }[] = [
    { id: 'destination', field: 'destination', label: 'Feedback destination', value: null, scope: null, version: 1 },
  ];

  const instructions: InstructionVersion[] = empty
    ? [{ id: mockUuid(70), state: 'current' as const, text: 'Screen applications against the partner criteria and show the evidence you used.', before: null, provenance: null, created_at: iso(-9000), version: 1 }]
    : [
        { id: mockUuid(70), state: 'current' as const, text: 'Screen applications against the partner criteria and show the evidence you used.', before: null, provenance: null, created_at: iso(-9000), version: 1 },
        { id: mockUuid(71), state: 'proposed' as const, text: 'For future applications, show missing customer evidence first.', before: 'Screen applications against the partner criteria and show the evidence you used.', provenance: 'Proposed from this screening', created_at: iso(-1), version: 1 },
      ];

  const skills = [
    { id: 'managed:partner-program-screening', name: 'Partner program screening', version: 'v1.7.0', shared_by: 'Hermes Enterprise', description: 'Screen public partner prospects and prepare cited outreach drafts for human review.', detail: 'Adopted by Iris. Review rules are unchanged by configuration.', adopted: true },
    { id: 'feedback-synthesis', name: 'Feedback synthesis', version: 'v2', shared_by: 'Alex Rivera', description: 'Turn partner feedback into a routed, reviewable summary.', detail: null, adopted: false },
  ];
  let skillAssignment: EnterpriseSkillAssignment = {
    id: mockUuid(72),
    agent_id: AGENT,
    agent_name: 'Iris',
    team: null,
    skill_key: 'partner-program-screening',
    runtime_name: 'enterprise_bridge:partner-program-screening',
    name: 'Partner program screening',
    version: '1.7.0',
    artifact_digest: null,
    description: 'Screen public partner prospects and prepare cited outreach drafts for human review.',
    state: 'active',
    revision: 1,
    config: {
      source: 'agentcash_people', program_name: 'Hermes Partner Program', source_purpose: 'person_partner_research',
      organization_only: false, no_outreach: true, role_label: 'Hermes consultant', search_queries: [], intake_urls: [],
      keywords: ['Hermes', 'AI agents', 'consulting'], ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
      minimum_priority: 50, lookback_days: 365, max_candidates: 5, max_api_requests: 1, minimum_rate_remaining: 5,
      max_spend_usd: 0.15, people_search: { current_position_seniority_level: ['Founder'], person_skills: ['AI agents'], current_position_titles: ['Consultant'], person_locations: [], offset: 0, search_after: null },
    },
    capability_grants: ['partner.discovery.read', 'partner.review.prepare', 'partner.outreach.draft'],
    schedule: { enabled: true, interval_minutes: 360 },
    human_review_required: true,
    config_fields: [
      { path: 'program_name', label: 'Program name', description: 'The name Iris uses in prospect briefs and drafts.', kind: 'text', required: true, minimum: null, maximum: null, options: [] },
      { path: 'role_label', label: 'Partner profile', description: 'A short description of the partner role Iris is screening for.', kind: 'text', required: true, minimum: null, maximum: null, options: [] },
      { path: 'keywords', label: 'Signals and keywords', description: 'Evidence Iris should look for when ranking candidates.', kind: 'string_list', required: true, minimum: null, maximum: null, options: [] },
      { path: 'minimum_priority', label: 'Minimum priority', description: 'Only candidates at or above this score enter review.', kind: 'integer', required: true, minimum: 0, maximum: 100, options: [] },
      { path: 'max_candidates', label: 'Candidates per run', description: 'Maximum candidates per discovery run.', kind: 'integer', required: true, minimum: 1, maximum: 10, options: [] },
    ],
    updated_at: iso(),
  };

  const history = empty
    ? []
    : [
        { id: 'ev-1', kind: 'request.created', at: iso(-6), actor_name: 'Iris', actor_type: 'agent' as const, text: 'Iris screened Leah’s application', detail: 'Website, GitHub and demo checked.', status: 'Needs review', ref: { section: 'inbox', view: 'request', id: REQ_LEAH }, request_id: REQ_LEAH },
        { id: 'ev-2', kind: 'request.created', at: iso(-5), actor_name: 'Iris', actor_type: 'agent' as const, text: 'Iris prepared Robin’s invoice draft', detail: 'Delivery statement matched to the fee schedule.', status: 'Needs review', ref: { section: 'inbox', view: 'request', id: REQ_INVOICE }, request_id: REQ_INVOICE },
      ];

  const traces: TraceEntity[] = empty
    ? []
    : [
        {
          id: TRACE_LEAH,
          run_id: RUN,
          agent_id: AGENT,
          name: 'Leah Martinez',
          type: 'Application screening',
          status: 'Awaiting review',
          sub: '82 / 100',
          needs_you: true,
          ref: { section: 'agents', view: 'trace', id: TRACE_LEAH },
          steps: [
            { id: 'read', label: 'get_request', state: 'done' as const, tool_call_id: 'mock-call-get-request', detail: 'Leah Martinez · Partner Program application' },
            { id: 'criteria', label: 'get_document_text', state: 'done' as const, tool_call_id: 'mock-call-get-document', detail: 'Partner criteria.md' },
            { id: 'propose', label: 'propose_request', state: 'done' as const, tool_call_id: 'mock-call-propose-request', detail: '82 / 100 · Awaiting review' },
            { id: 'wait', label: 'Waiting for a human decision', state: 'active' as const, detail: null },
          ],
          allowed_tools: ['get_request', 'get_document_text', 'propose_request'],
          tool_calls: [
            { tool_call_id: 'mock-call-get-request', name: 'get_request', turn: 0, arguments: JSON.stringify({ request_id: REQ_LEAH }), result: JSON.stringify({ source: 'workspace.requests', untrusted: true, data: { label: 'Leah Martinez', status: 'pending' } }), truncated: false },
            { tool_call_id: 'mock-call-get-document', name: 'get_document_text', turn: 0, arguments: JSON.stringify({ document_id: mockUuid(60) }), result: JSON.stringify({ source: 'workspace.documents', untrusted: true, data: { name: 'Partner criteria.md', text: 'Track record (30) · Capacity (30) · Fit (40)' } }), truncated: false },
            { tool_call_id: 'mock-call-propose-request', name: 'propose_request', turn: 0, arguments: JSON.stringify({ kind: 'application', label: 'Leah Martinez' }), result: JSON.stringify({ source: 'workspace.requests', untrusted: true, data: { request_id: REQ_LEAH, status: 'pending' } }), truncated: false },
          ],
          fetched_urls: [],
          focus: [],
          version: 1,
        },
      ];

  if (options.activity) {
    traces.splice(0, traces.length, {
      id: TRACE_LEAH, run_id: RUN, agent_id: AGENT,
      name: 'Explain partner screening', type: 'Hermes Agent · work',
      status: 'completed', sub: '8s worked', needs_you: false,
      ref: { section: 'agents', view: 'trace', id: TRACE_LEAH },
      steps: [
        ...(options.activity === 'completed-tool' ? [{ id: 'read', label: 'get_document_text', state: 'done' as const, tool_call_id: 'mock-document' }] : []),
        { id: 'hermes', label: 'Thinking', state: 'done', tool_call_id: null },
      ],
      allowed_tools: [], version: 1,
    });
  }

  let recoveryView: AgentRecoveryView = {
    state: options.recovery ?? (empty || options.activity ? 'idle' : 'waiting'),
    run_id: empty ? null : options.recovery ? RUN : TRACE_LEAH,
    session_id: empty ? null : SESSION_A, attempt: empty ? null : 1,
    model_id: options.recovery ? RECOVERY_MODEL_ID : DEFAULT_MODEL_ID,
    message: 'No eligible pending work right now.', next_retry_at: null,
    can_retry: false, can_run_now: empty || Boolean(options.activity), can_cancel: false,
  };
  if (recoveryView.state === 'waiting') recoveryView.message = 'Waiting for the current request to be reviewed.';
  if (options.recovery) {
    recoveryView = {
      ...recoveryView,
      message: options.recovery === 'working' ? 'Iris is working on this task.'
        : options.recovery === 'blocked' ? 'Reconnect Nous Portal in Settings before retrying.'
        : options.recovery === 'idle' ? 'No eligible pending work right now.'
          : options.recovery === 'stopped' ? 'Automatic retry cancelled. You can resume this task when ready.'
            : 'The selected model is temporarily unavailable. Your completed work is saved.',
      can_retry: options.recovery === 'retryable' || options.recovery === 'retry_scheduled' || options.recovery === 'stopped',
      can_run_now: options.recovery === 'idle',
      can_cancel: options.recovery === 'retry_scheduled',
      next_retry_at: options.recovery === 'retry_scheduled' ? new Date(Date.now() + 90_000).toISOString() : null,
    };
    traces.splice(0, traces.length, {
      id: RUN, run_id: RUN, agent_id: AGENT, name: 'Automated partner screening', type: 'Hermes Agent · work',
      status: options.recovery === 'working' ? 'working' : options.recovery === 'idle' ? 'completed' : options.recovery === 'stopped' ? 'stopped' : 'error',
      sub: 'Attempt 1', needs_you: false, runtime_kind: 'hermes', model_id: RECOVERY_MODEL_ID,
      ref: { section: 'agents', view: 'trace', id: RUN }, steps: [], tool_calls: [], allowed_tools: [], version: 1,
    });
    messages[SESSION_A] = [];
    const session = sessions.find((item) => item.id === SESSION_A);
    if (session) {
      session.title = 'Automated partner screening'; session.status = traces[0]!.status;
      session.model_id = RECOVERY_MODEL_ID; session.effort = 'low';
    }
  }

  /**
   * The usage report, in the shape `GET /w/:ws/usage?range=` actually answers.
   *
   * It used to be the shape `entities.ts` sketched — `{ group, rows,
   * daily_token_cap }` — and the mock was the only thing producing it: the
   * live route answers `{ range, totals, by_day, by_session, by_key, caps }`
   * and the client's schema had never been pointed at it. Decision C25. The
   * disclaimer is the server's exact sentence, because the whole point of the
   * mock is that a response which does not satisfy the contract fails here.
   */
  const usageDays = empty
    ? []
    : [
        { day: '2026-10-10', input_tokens: 184_000, output_tokens: 22_400, cached_input_tokens: 0, reasoning_tokens: 0, total_tokens: 206_400, cost_usd_estimate: 0.061, calls: 42, errors: 0 },
        { day: '2026-10-11', input_tokens: 96_000, output_tokens: 12_100, cached_input_tokens: 0, reasoning_tokens: 0, total_tokens: 108_100, cost_usd_estimate: 0.032, calls: 21, errors: 1 },
        { day: '2026-10-12', input_tokens: 310_000, output_tokens: 41_800, cached_input_tokens: 0, reasoning_tokens: 0, total_tokens: 351_800, cost_usd_estimate: 0.104, calls: 64, errors: 0 },
      ];
  const usage = {
    range: '7d' as const,
    timezone: 'UTC',
    from: '2026-10-06T00:00:00.000Z',
    to: '2026-10-12T23:59:59.000Z',
    disclaimer:
      'Estimated, billed by your provider. These figures are our arithmetic over published prices; your provider invoices your own key and is the authority.',
    totals: usageDays.reduce(
      (acc, day) => ({
        input_tokens: acc.input_tokens + day.input_tokens,
        output_tokens: acc.output_tokens + day.output_tokens,
        cached_input_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: acc.total_tokens + day.total_tokens,
        cost_usd_estimate: Math.round((acc.cost_usd_estimate + day.cost_usd_estimate) * 1e6) / 1e6,
        calls: acc.calls + day.calls,
        errors: acc.errors + day.errors,
      }),
      { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, reasoning_tokens: 0, total_tokens: 0, cost_usd_estimate: 0, calls: 0, errors: 0 },
    ),
    by_day: usageDays,
    by_session: empty
      ? []
      : [{ session_id: mockUuid(20), title: 'Partner applications', runs: 3, total_tokens: 351_800, cost_usd_estimate: 0.104, last_call_at: '2026-10-12T16:04:00.000Z' }],
    by_key: empty
      ? []
      : [{ key_id: mockUuid(21), provider: 'nous_portal', label: 'Program key', last4: 'a1b2', status: 'verified', total_tokens: 666_300, cost_usd_estimate: 0.197, calls: 127 }],
    caps: {
      daily_token_cap: 500_000,
      tokens_today: empty ? 0 : 351_800,
      fraction_used: empty ? 0 : 0.704,
      warn: false,
      max_concurrent_runs: 3,
      active_runs: 0,
    },
  };

  /** `settingsView`, the shape `GET|PATCH /w/:ws/settings` answers. */
  const settingsView = {
    workspace_id: WS,
    role: seat === 'admin' ? 'admin' : 'member',
    defaults: { model_id: DEFAULT_MODEL_ID, effort: DEFAULT_EFFORT as string | null, runtime: 'cloud' },
    caps: { daily_token_cap: empty ? null : (500_000 as number | null), max_concurrent_runs: 3, tokens_today: empty ? 0 : 351_800, active_runs: 0, warn: false },
    timezone: 'UTC',
    flags: approvalScenario ? { approval_demo: true } : {} as Record<string, unknown>,
    fetch_url_allowlist: [] as string[],
    notifications: { approvals: true, blocked: true, digest: false },
    deletion: { requested_at: null as string | null, scheduled_at: null as string | null },
  };

  let slackConnected = options.slack === 'connected';
  let emailConnected = options.email === 'connected';
  let emailEvidenceConnected = options.email === 'connected';
  let importedEmailEvidence = 0;

  const dataPrivacy = {
    keys: providerKeys.map((key) => ({
      key_id: key.id,
      provider: key.provider,
      label: key.label,
      last4: key.last4,
      status: key.status,
      verified_at: key.verified_at,
      attestation: null,
      attested: false,
      warnings: key.provider === 'deepseek' ? [DEEPSEEK_WARNING] : [],
      real_data_allowed: false,
    })),
    retention: [
      { store: 'Requests, notes and documents', retention: 'until tombstoned', erasure: 'redact_subject' },
      { store: 'Turns, messages and stream events', retention: '90 days', erasure: 'redact_subject plus subject_key search' },
      { store: 'Uploads, extracted text and rendered documents', retention: 'until deleted', erasure: 'deleted by row' },
      { store: 'Nightly backup copy', retention: '30 days', erasure: 'expires on the bucket lifecycle rule' },
      { store: 'Workflow instance state', retention: '30 days after completion', erasure: 'ids only, by rule' },
      { store: 'Database point-in-time history', retention: '7 days', erasure: 'expires' },
      { store: 'Logs and error tracking', retention: '7 and 30 days', erasure: 'ids only; redaction tested' },
      { store: 'Identity provider (WorkOS)', retention: 'authentication data only', erasure: 'account deletion' },
    ],
    erasure: { tombstone: 'immediate', point_in_time_history_days: 7, backup_retention_days: 30, complete_after_days: 30, copy: ERASURE_COPY },
    residency: {
      identity_provider: 'WorkOS, United States, under Standard Contractual Clauses',
      database: 'the region this workspace’s Neon project was created in',
      objects: 'the R2 bucket jurisdiction, set at creation and unchangeable',
      processing:
        'Workers and Workflow steps run wherever the request lands. Workflow state, queues and logs have no documented jurisdiction control; the pilot data-processing agreement states this.',
    },
  };

  const viewerUserId = seat === 'member' ? MEMBER_USER : USER;
  const viewerMemberId = seat === 'member' ? ALEX_MEMBER : MAYA_MEMBER;
  const viewerName = seat === 'member' ? 'Alex Rivera' : 'Maya Chen';
  let partnerConfigured = options.partnerWorkflow === true || options.workflowActivation !== undefined;
  let partnerAdmissionEnabled = options.partnerWorkflow === true;
  let partnerProfilesVerified = options.partnerWorkflow === true;
  const sourceDigest = (23).toString(16).padStart(64, '0');
  const declaredUploads = new Map<string, { name: string; size: number; mime: string }>();
  const engagementHash = hashForMock(42);
  const partnerEngagements: PartnerEngagementSummary[] = options.partnerWorkflow ? [
    {
      id: mockUuid(613), revision: 1, authorization_hash: engagementHash, authorization_status: 'authorized',
      input_provenance: 'sample',
      partner: { id: mockUuid(611), name: 'Robin Studio' }, reference: 'ENG-SAMPLE-42',
      purpose: 'Partner enablement workshop', currency: 'USD', authorized_total_minor: 120000,
      valid_from: '2026-09-01', valid_until: '2026-10-31', one_invoice: true,
      source: { attachment_id: mockUuid(616), name: 'Sample engagement terms.txt', sha256: sourceDigest, created_at: iso(-180), author_name: 'Maya Chen', excerpt: 'Sample terms: one partner enablement workshop for USD 1,200.' },
    },
    {
      id: mockUuid(614), revision: 1, authorization_hash: hashForMock(43), authorization_status: 'authorized',
      input_provenance: 'sample',
      partner: { id: mockUuid(617), name: 'Northstar Labs' }, reference: 'ENG-SAMPLE-43',
      purpose: 'Partner technical review', currency: 'USD', authorized_total_minor: 80000,
      valid_from: '2026-09-01', valid_until: '2026-10-31', one_invoice: true,
      source: { attachment_id: mockUuid(618), name: 'Sample Northstar terms.md', sha256: sourceDigest, created_at: iso(-160), author_name: 'Maya Chen', excerpt: 'Sample terms: one technical review for USD 800.' },
    },
  ] : [];
  const partnerHandoffs: PartnerWorkflowHandoffV2[] = options.partnerWorkflow ? [
    {
      id: mockUuid(610), revision: 1, supersedes_handoff_id: null, superseded_by_handoff_id: null, current: true,
      partner_id: mockUuid(611), partner_name: 'Robin Studio', engagement_reference: 'ENG-SAMPLE-42',
      invoice_number: 'INV-SAMPLE-014', invoice_currency: 'USD', invoice_total_minor: 120000,
      source_session_id: SESSION_A, finance_session_id: SESSION_B, request_id: REQ_INVOICE,
      input_provenance: 'sample',
      outcome: { delivery: 'delivered', validation: 'passed', agent_explanation: 'completed', human_decision: 'pending', acknowledgment: 'pending' },
      result_kind: 'checks_passed', result_reason: 'All server checks passed. Finance must record the human decision.',
      checks: [
        { code: 'duplicate', status: 'passed', message: 'No unrelated invoice uses this engagement.' },
        { code: 'currency', status: 'passed', message: 'USD matches the authorized terms.' },
        { code: 'amount', status: 'passed', message: 'USD 1,200.00 matches the authorized total.' },
        { code: 'invoice_source', status: 'passed', message: 'The confirmed invoice source is readable and unchanged.' },
      ],
      acknowledgment: null, simulated: !options.partnerWorkflowNative, created_at: iso(-10), decided_at: null,
    },
    {
      id: mockUuid(615), revision: 1, supersedes_handoff_id: null, superseded_by_handoff_id: null, current: true,
      partner_id: mockUuid(617), partner_name: 'Northstar Labs', engagement_reference: 'ENG-SAMPLE-43',
      invoice_number: 'INV-SAMPLE-013', invoice_currency: 'USD', invoice_total_minor: 95000,
      source_session_id: SESSION_A, finance_session_id: SESSION_B, request_id: null,
      input_provenance: 'sample',
      outcome: { delivery: 'delivered', validation: 'needs_information', agent_explanation: 'completed', human_decision: 'not_ready', acknowledgment: 'pending' },
      result_kind: 'needs_information', result_reason: 'The invoice is USD 150.00 above the authorized amount. Submit a corrected source and confirmed fields.',
      checks: [
        { code: 'currency', status: 'passed', message: 'USD matches the authorized terms.' },
        { code: 'amount', status: 'needs_information', message: 'USD 950.00 exceeds the authorized USD 800.00 total.' },
      ],
      acknowledgment: null, simulated: true, created_at: iso(-20), decided_at: null,
    },
  ] : [];

  function workflowResult(handoff: PartnerWorkflowHandoffV2): PartnerHandoffResult {
    const engagement = partnerEngagements.find((item) => item.reference === handoff.engagement_reference) ?? partnerEngagements[0]!;
    return {
      kind: handoff.result_kind,
      handoff_id: handoff.id,
      handoff_revision: handoff.revision,
      supersedes_handoff_id: handoff.supersedes_handoff_id,
      engagement_record_id: engagement.id,
      engagement_revision: engagement.revision,
      authorization_hash: engagement.authorization_hash,
      request_id: handoff.request_id,
      input_provenance: handoff.input_provenance,
      source_versions: {
        engagement: engagement.source,
        invoice: { attachment_id: mockUuid(619), name: `${handoff.invoice_number}.pdf`, sha256: sourceDigest, created_at: handoff.created_at, author_name: handoff.partner_name, excerpt: `Sample invoice ${handoff.invoice_number}: ${moneyForMock(handoff.invoice_total_minor, handoff.invoice_currency)} for ${engagement.purpose}.` },
      },
      checks: handoff.checks,
      outcome: handoff.outcome,
      ...(handoff.result_kind === 'failed_processing' ? { failure_code: 'sample_processing_failure' } : {}),
    } as PartnerHandoffResult;
  }

  function approvalForViewer(source: ApprovalView): ApprovalView {
    const current = source.steps.filter((step) => step.status === 'current');
    const eligible = source.status === 'pending'
      ? current.filter((step) => step.current_reviewer_member_ids.includes(viewerMemberId)).map((step) => step.step_id)
      : [];
    const canDecide = eligible.length > 0;
    return {
      ...source,
      capabilities: source.status === 'changes_requested'
        ? { allowed_decisions: [], eligible_step_ids: [], can_route: false, can_submit_revision: seat === 'admin', reason: seat === 'admin' ? 'Submit a revised proposal for review.' : 'Waiting for a revised proposal.' }
        : source.status !== 'pending'
          ? { allowed_decisions: [], eligible_step_ids: [], can_route: false, can_submit_revision: false, reason: 'Review complete.' }
          : canDecide
            ? { allowed_decisions: ['approve', 'decline', 'request_changes'], eligible_step_ids: eligible, can_route: true, can_submit_revision: seat === 'admin' && source.payload.approval_type === 'communication' && source.payload.details.draft_only, reason: null }
            : { allowed_decisions: [], eligible_step_ids: [], can_route: false, can_submit_revision: false, reason: `Waiting for ${current.flatMap((step) => step.current_reviewer_member_ids).map((id) => source.identities.reviewers.find((reviewer) => reviewer.member_id === id)?.name).filter(Boolean).join(', ') || 'an eligible reviewer'}.` },
    };
  }

  function approvalProjection(view: ApprovalView) {
    const current = view.steps.filter((step) => step.status === 'current');
    const names = current
      .flatMap((step) => step.current_reviewer_member_ids)
      .map((id) => view.identities.reviewers.find((reviewer) => reviewer.member_id === id)?.name)
      .filter((name): name is string => !!name);
    const pendingForViewer = view.status === 'pending' && current.some((step) => step.current_reviewer_member_ids.includes(viewerMemberId));
    return {
      approval_type: view.payload.approval_type,
      authorization_status: view.status,
      authorization_revision: view.payload.authorization.revision,
      expires_at: view.payload.authorization.expires_at,
      pending_for_viewer: pendingForViewer,
      waiting_on_others: view.status === 'pending' && !pendingForViewer,
      current_reviewer_names: names,
      mode: view.payload.policy.mode,
      completed_steps: view.steps.filter((step) => step.status === 'approved').length,
      total_steps: view.steps.length,
      remaining_approvals: view.steps.filter((step) => !['approved', 'declined', 'changes_requested'].includes(step.status)).reduce((sum, step) => sum + Math.max(0, step.quorum - step.approvals_recorded), 0),
      current_steps: current.map((step) => ({ label: step.label, approvals_recorded: step.approvals_recorded, quorum: step.quorum })),
      effect_status: view.effect.status,
      work_status: view.work.status,
    };
  }

  function requestForViewer(row: MockRequest): MockRequest {
    const approval = approvalViews.get(row.id);
    if (approval) return { ...row, payload: approval.payload as unknown as Record<string, unknown>, approval: approvalProjection(approval) };
    const financeScoped = row.kind === 'invoice' && 'workflow_provenance' in row.payload;
    // Preserve the older Worker response shape for the existing legacy Member
    // browser fixture. The scoped Finance fixture exercises the new projection.
    if (!financeScoped && seat === 'member') return row;
    const pending = row.status === 'pending';
    const eligible = pending && (financeScoped ? seat === 'member' : seat === 'admin');
    return {
      ...row,
      decision_summary: {
        action: row.kind === 'application' ? 'Review applicant' : row.kind === 'invoice' ? 'Approve invoice draft' : 'Approve agreement draft',
        primary: row.kind === 'application'
          ? String(row.payload.proposed_role ?? 'Partner program application')
          : row.kind === 'invoice' ? `Invoice from ${row.subject ?? row.label}` : row.label,
        facts: [], consequence: null,
        approval_requirement: {
          mode: 'single', completed_steps: pending ? 0 : 1, total_steps: 1,
          remaining_approvals: pending ? 1 : 0,
          current: pending ? [{ label: financeScoped ? 'Finance reviewer' : 'Workspace Admin', approvals_recorded: 0, quorum: 1 }] : [],
          pending_for_viewer: eligible, waiting_on_others: pending && !eligible, expires_at: null,
        },
      },
    };
  }

  function approvalResult(view: ApprovalView, decision: 'approve' | 'decline' | 'request_changes', note: string | null, idempotencyKey: string): ApprovalView {
    const current = view.steps.find((step) => step.status === 'current' && step.current_reviewer_member_ids.includes(viewerMemberId));
    if (!current) return view;
    const recordedAt = iso(1);
    view.votes.push({
      id: mockUuid(1_300 + view.votes.length + [...approvalViews.keys()].indexOf(view.request_id) * 10),
      step_id: current.step_id,
      decision,
      authorization_revision: view.payload.authorization.revision,
      authorization_hash: view.payload.authorization.hash,
      reviewer_member_id: viewerMemberId,
      reviewer_user_id: viewerUserId,
      reviewer_name: viewerName,
      note,
      idempotency_key: idempotencyKey,
      recorded_at: recordedAt,
    });
    current.status = decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'changes_requested';
    current.approvals_recorded = decision === 'approve' ? current.quorum : 0;
    current.current_reviewer_member_ids = [];

    if (decision === 'approve') {
      const next = view.steps.find((step) => step.status === 'blocked');
      if (next) {
        next.status = 'current';
        const selector = view.payload.policy.steps.find((step) => step.id === next.step_id)?.reviewers[0];
        next.current_reviewer_member_ids = selector?.kind === 'member' ? [selector.member_id] : [ALEX_MEMBER];
        view.work = { status: 'waiting', continuation_id: null, reason: `Waiting for ${view.identities.reviewers.find((reviewer) => reviewer.member_id === next.current_reviewer_member_ids[0])?.name ?? 'the next reviewer'}.` };
      } else {
        view.status = 'approved';
        view.finalized_at = recordedAt;
        const hasEffect = view.effect.kind !== 'none';
        view.effect = hasEffect
          ? { ...view.effect, status: 'unavailable', reason: 'Illustrative demo only; no external provider is connected and no effect occurred.' }
          : { ...view.effect, status: 'not_required', reason: 'No external provider effect is required.' };
        const status = view.payload.approval_type === 'team_commitment' ? 'admitted' : view.payload.approval_type === 'deliverable' ? 'ready' : 'completed';
        view.work = { status, continuation_id: null, reason: status === 'admitted' ? 'The bounded task was admitted to the illustrative queue.' : status === 'ready' ? 'The dependent illustrative request is ready.' : 'Authorization recorded; no external work ran in this demo.' };
      }
    } else {
      view.status = decision === 'decline' ? 'declined' : 'changes_requested';
      view.finalized_at = recordedAt;
      view.effect = { ...view.effect, status: view.effect.kind === 'none' ? 'not_required' : 'cancelled', reason: decision === 'decline' ? 'Declined before any effect.' : 'Waiting for a revised authorization.' };
      view.work = { status: decision === 'decline' ? 'cancelled' : 'waiting', continuation_id: null, reason: decision === 'decline' ? 'Declined before work began.' : 'Waiting for a revised proposal.' };
    }
    return view;
  }

  let head = 100n;
  const listeners = new Set<(event: StreamEvent) => void>();
  const backlog: StreamEvent[] = [];

  function publish(event: StreamEvent): void {
    backlog.push(event);
    head = BigInt(event.id);
    if (!options.recovery && (event.kind === 'run.started' || event.kind === 'run.status')) {
      const status = event.kind === 'run.started' ? 'working' : event.payload.status;
      const recoveryState = status === 'working' ? 'working' : status === 'error' ? 'retryable' : status === 'stopped' ? 'stopped' : status === 'waiting' || status === 'stopping' ? 'waiting' : 'idle';
      recoveryView = {
        ...recoveryView, state: recoveryState, run_id: event.payload.run_id, session_id: event.session_id,
        attempt: event.payload.attempt, can_retry: recoveryState === 'retryable' || recoveryState === 'stopped',
        can_run_now: recoveryState === 'idle',
        message: recoveryState === 'working' ? 'Iris is working on the current task.' : recoveryState === 'waiting' ? 'Waiting for your input.' : recoveryState === 'idle' ? 'No eligible pending work right now.' : 'The task needs attention.',
      };
    }
    for (const listener of listeners) listener(event);
  }

  const bootstrap = () => {
    const activeRequests = requests.filter((row) => !row.presentation.hidden);
    return {
      workspace: {
        id: WS,
        name: workspaceName,
        jurisdiction: 'default',
        settings: { default_model_id: DEFAULT_MODEL_ID, default_effort: DEFAULT_EFFORT, default_runtime: 'cloud', daily_token_cap: 500_000, max_concurrent_runs: 3, timezone: 'UTC', flags: approvalScenario ? { approval_demo: true } : {} },
      },
      viewer: { user_id: viewerUserId, role: seat, reviewer_roles: seat === 'admin' ? ['access', 'workspace_owner'] : ['finance', 'agent_admin'] },
      agent: workflowRole === 'finance'
        ? { id: FINANCE_AGENT, name: 'Ledger', email: null, responsibility: 'Finance review', setup_step: null }
        : { id: AGENT, name: 'Iris', email: null, responsibility: 'Partner Program', setup_step: null },
      capabilities: {
        email_ingress: false,
        turn_attachments: Boolean(options.agentSettings),
        automated_triggers: false,
        member_invitations: setupOnly
          ? { mode: 'setup_only' as const, role_templates: ['partnerships-agent' as const] }
          : { mode: 'legacy_delivery' as const, role_templates: [] },
      },
      heads: { session: head.toString(), workspace: head.toString() },
      counts: {
        inbox: activeRequests.filter((r) => r.status === 'pending').length,
        pending_grants: 0,
        created_documents: documents.length,
        decisions: requests.filter((r) => r.status !== 'pending').length,
        pending_for_me: activeRequests.filter((row) => row.kind !== 'approval' ? row.status === 'pending' : requestForViewer(row).approval?.pending_for_viewer).length,
        pending_for_others: activeRequests.filter((row) => row.kind === 'approval' && requestForViewer(row).approval?.waiting_on_others).length,
      },
      sessions: sessions.map((s) => ({ id: s.id, agent_id: s.agent_id, title: s.title, mode: s.mode, model_id: s.model_id, effort: s.effort, pinned: s.pinned, archived: s.archived, focus_ref: s.focus_ref, status: s.status, last_activity_at: s.last_activity_at })),
      requests: activeRequests.map((r) => ({ id: r.id, kind: r.kind, status: r.status, label: r.label })),
      catalog,
    };
  };

  /** Run one contract scenario on the session socket, paced for a human. */
  function runScenario(scenario: Parameters<typeof mockRunStream>[0], sessionId: string): void {
    const events = mockRunStream(scenario, { workspaceId: WS, sessionId, runId: RUN, firstId: head + 1n, startedAt: new Date() });
    events.forEach((event, i) => {
      setTimeout(() => publish(event), 220 * (i + 1));
    });
  }

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const page = (items: unknown[]) => json({ items, cursor: null, total: items.length });
  const fail = (status: number, reason: string, message = reason) => json({ error: message, reason }, status);

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://mock.local');
    const path = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('hermes:mock-request', { detail: { path: url.pathname + url.search, method } }));
    }
    const body: Record<string, unknown> = typeof init?.body === 'string'
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : {};
    const p = (suffix: string) => path === `/w/${WS}${suffix}`;
    const match = (pattern: RegExp) => pattern.exec(path);

    if (seat !== 'admin' && path.startsWith(`/w/${WS}/admin/`)) return fail(403, 'admin_required');

    if (path === '/health') return json({ status: 'ok', version: 'mock', checks: [] });

    if (path === '/auth/session') {
      const user = { id: viewerUserId, name: viewerName, email: seat === 'admin' ? 'maya@nous.example' : 'alex@nous.example' };
      if (!url.searchParams.has('ws')) {
        return json({
          user,
          workspaces: [
            {
              id: WS,
              name: workspaceName,
              role: seat,
              members: members.map((member) => ({ id: member.user_id, name: member.name, avatar_url: null })).slice(0, 4),
              member_count: members.length,
            },
          ],
          authenticated_at: iso(0),
        });
      }
      return json({
        user: { ...user, role: seat },
        workspace: { id: WS, name: workspaceName },
        stream_heads: { workspace: head.toString() },
        hub_ticket: 'mock-ticket',
        expires_at: iso(600),
        authenticated_at: iso(0),
      });
    }

    if (p('/bootstrap')) return json(bootstrap());

    if (p(`/agents/${AGENT}/recovery`) && method === 'GET') return json(recoveryView);
    if (p(`/agents/${AGENT}/wake`) && method === 'POST') {
      // Keep submission observable to browser tests; this is a mock admission,
      // never an inference call or another paid discovery cycle.
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (body.action === 'cancel_retry' && recoveryView.can_cancel) {
        recoveryView = { ...recoveryView, state: 'stopped', next_retry_at: null, can_retry: true, can_cancel: false, message: 'Automatic retry cancelled. You can resume this task when ready.' };
      } else if (body.action === 'retry' && recoveryView.can_retry) {
        recoveryView = { ...recoveryView, state: 'queued', attempt: (recoveryView.attempt ?? 0) + 1, next_retry_at: null, can_retry: false, can_cancel: false, model_id: options.recovery ? RECOVERY_MODEL_ID : DEFAULT_MODEL_ID, message: 'Retry queued. Iris will continue the saved task.' };
        const trace = traces.find((item) => item.id === recoveryView.run_id);
        if (trace) { trace.status = 'queued'; trace.sub = `Attempt ${recoveryView.attempt}`; }
      }
      return json(recoveryView);
    }

    if (path === '/workspaces' && method === 'POST') {
      const name = String(body.name ?? '').trim();
      if (name.length < 2 || name.length > 80) return fail(422, 'bad_name', 'A workspace needs a name of 2 to 80 characters');
      workspaceName = name;
      try {
        sessionStorage.setItem(MOCK_WORKSPACE_NAME_KEY, workspaceName);
      } catch {
        /* The in-memory response is still complete when storage is unavailable. */
      }
      return json(bootstrap(), 201);
    }

    if (path.startsWith('/invitations/') && path.endsWith('/accept') && method === 'POST') {
      const token = decodeURIComponent(path.split('/')[2] ?? '');
      if (token !== 'inv_demo' && !invitations.some((row) => row.id === token)) return fail(404, 'invitation_unavailable', 'Invitation unavailable');
      return json(bootstrap());
    }

    // There is no `/bootstrap/client` any more: the Worker has no such route,
    // so the client composes the same object out of `/auth/session`,
    // `/members`, `/invitations` and `/provider-keys`, and so does this.
    if (p('/catalog')) {
      // The mock serves the *entry* shape, not bootstrap's trimmed one: the
      // model menu parses this against `catalogPageSchema`, and a bootstrap
      // row would fail the parse and send the menu to its fallback, which is
      // exactly the state the screen fixtures are not trying to photograph.
      const q = (new URL(path, 'https://mock.local').searchParams.get('q') ?? '').toLowerCase();
      const models = catalogEntries.filter(
        (row) => q === '' || row.model_id.toLowerCase().includes(q) || row.label.toLowerCase().includes(q),
      );
      return json({ models, total: models.length, next_cursor: null });
    }

    if (p('/events')) {
      const after = BigInt(url.searchParams.get('after') ?? '0');
      return json({ stream: url.searchParams.get('stream')?.startsWith('session') ? 'session' : 'workspace', after: after.toString(), head: head.toString(), resync: false, events: backlog.filter((e) => BigInt(e.id) > after) });
    }

    if (p('/sessions') && method === 'GET') return page(sessions);
    if (p('/sessions') && method === 'POST') {
      const created = { id: mockUuid(400 + sessions.length), agent_id: String(body.agent_id ?? AGENT), title: String(body.title ?? 'New session'), mode: String(body.mode ?? 'ask'), model_id: DEFAULT_MODEL_ID, effort: DEFAULT_EFFORT, runtime: 'cloud', pinned: false, archived: false, focus_ref: null, status: 'Empty', last_activity_at: iso(0), share: null, context: null, version: 1 };
      sessions.push(created);
      messages[created.id] = [];
      return json(created);
    }

    const sessionMatch = match(new RegExp(`^/w/${WS}/sessions/([^/]+)(/.*)?$`));
    if (sessionMatch) {
      const sessionId = sessionMatch[1]!;
      const rest = sessionMatch[2] ?? '';
      const row = sessions.find((s) => s.id === sessionId);
      if (rest === '/snapshot' && row) {
        const session = sessionFrom(sessionSchema.parse(row));
        session.messages = (messages[sessionId] ?? []).map((message) => messageSchema.parse(message));
        let snapshotState = { ...initialState(), sessions: { [sessionId]: session } };
        for (const event of backlog.filter((item) => item.session_id === sessionId)) {
          for (const action of actionsFor(event, snapshotState)) snapshotState = reduce(snapshotState, action);
        }
        const current = snapshotState.sessions[sessionId]!;
        const recovered = options.recovery && recoveryView.session_id === sessionId && recoveryView.run_id ? {
          id: recoveryView.run_id, session_id: sessionId, agent_id: row.agent_id, attempt: recoveryView.attempt ?? 1,
          status: recoveryView.state === 'working' || recoveryView.state === 'queued' ? 'working' : recoveryView.state === 'idle' ? 'completed' : recoveryView.state === 'stopped' ? 'stopped' : 'error',
          title: null, steps: [], queue: [], error: recoveryView.state === 'retryable' || recoveryView.state === 'blocked' ? { class: 'provider', retryable: recoveryView.can_retry, reason: 'provider_error', message: recoveryView.message } : null,
        } : null;
        const run = current.run ?? recovered;
        return json({ workspace_id: WS, session: row, watermark: head.toString(),
          messages: { items: current.messages, cursor: null, total: current.messages.length },
          run: run ? { ...run, model_id: row.model_id, effort: row.effort, started_at: current.run?.started_at ?? iso(), admitted_at: current.run?.started_at ?? iso(), execution_started_at: null, ended_at: null } : null,
          stream: current.stream && run ? { run_id: run.id, attempt: run.attempt, turn: current.stream.turn, step_attempt: current.stream.stepAttempt,
            message_id: null, text: current.stream.durableText, seq: current.stream.seq ?? -1, status: current.stream.status === 'streaming' ? 'streaming' : 'final' } : null,
          recovery: null,
        });
      }
      if (rest === '/messages') return page(url.searchParams.get('before') ? [] : messages[sessionId] ?? []);
      if (rest === '/turns') {
        if (!hasVerifiedKey) return fail(409, 'no_verified_key', 'Connect Nous Portal in Settings to start');
        runScenario('completed', sessionId);
        return json({ run_id: RUN, status: 'working', attempt: 1 }, 201);
      }
      // Every control is scoped to a run: `/runs/:runId/{stop,guide,queue,retry}`.
      if (rest.startsWith('/runs/')) {
        const control = rest.split('/')[3] ?? '';
        if (!control && options.recovery) return json({ run_id: RUN, attempt: recoveryView.attempt ?? 1, status: recoveryView.state === 'queued' || recoveryView.state === 'working' ? 'working' : recoveryView.state === 'idle' ? 'completed' : recoveryView.state === 'stopped' ? 'stopped' : 'error' });
        if (control === 'stop') {
          runScenario('stopped', sessionId);
          return json({ run_id: RUN, status: 'stopping', attempt: 1 });
        }
        if (control === 'retry') return json({ run_id: RUN, status: 'working', attempt: 2 }, 201);
        if (control === 'guide') return json({ guidance_id: mockUuid(700), status: 'queued' }, 201);
        if (control === 'queue') return json({ items: [] }, method === 'POST' ? 201 : 200);
        if (control === 'context') return json({ ok: true, key: String(body.key ?? '') });
      }
      if (rest === '/shares' && method === 'POST') {
        const share = { id: mockUuid(500), url: `${url.origin}/shared/mock-share-token`, audience: String(body.audience ?? 'Nous team'), message_cutoff_seq: 2, created_at: iso(0) };
        if (row) row.share = { id: share.id, url: share.url, audience: share.audience, created_at: share.created_at, messages: 2 };
        return json(share);
      }
      if (rest.startsWith('/shares/')) {
        if (row) row.share = null;
        return new Response(null, { status: 204 });
      }
      if (rest.startsWith('/queue/')) return new Response(null, { status: 204 });
      if (method === 'PATCH' && row) {
        const { expected_settings: _expected, ...patch } = body;
        Object.assign(row, patch);
        return json(row);
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
    }

    const requestMatch = match(new RegExp(`^/w/${WS}/requests/([^/]+)(/.*)?$`));
    if (requestMatch) {
      const id = requestMatch[1]!;
      const rest = requestMatch[2] ?? '';
      const row = requests.find((r) => r.id === id);
      const approval = approvalViews.get(id);
      const syncApprovalRow = (): void => {
        if (!row || !approval) return;
        row.status = approval.status === 'superseded' ? 'withdrawn' : approval.status;
        row.version += 1;
        row.payload = approval.payload as unknown as Record<string, unknown>;
        row.approval = approvalProjection(approval);
        row.decided_at = approval.finalized_at;
        row.decided_by_name = approval.votes.at(-1)?.reviewer_name ?? null;
      };
      if (rest.startsWith('/approval/evidence/') && method === 'GET') {
        if (options.communicationDraft && id === APPROVAL_DEMO_REQUEST_IDS.communication && decodeURIComponent(rest.slice('/approval/evidence/'.length)) === mockUuid(1900)) {
          return json({ id: mockUuid(1900), kind: 'partner_source', label: 'Illustrative partner source', note: 'Illustrative note from Iris about the pilot.', source_url: 'https://example.invalid/illustrative-pilot', fetched_at: iso(-60), source_updated_at: null, verified_at: null, sha256: (23).toString(16).padStart(64, '0'), facts: [{ label: 'Organization', value: 'Fictional Partner Cooperative' }, { label: 'Source excerpt', value: 'Illustrative stored fact: the cooperative runs small onboarding pilots.' }] });
        }
        return fail(404, 'approval_evidence_unavailable');
      }
      if (rest === '/approval' && method === 'GET') return approval ? json(approvalForViewer(approval)) : fail(404, 'not_found');
      if (rest === '/approval/decisions' && method === 'POST') {
        if (!approval || !row) return fail(404, 'not_found');
        const revision = Number(body.expected_authorization_revision);
        const authorizationHash = String(body.expected_authorization_hash ?? '');
        const idempotencyKey = String(body.idempotency_key ?? '');
        if (approval.votes.some((vote) => vote.idempotency_key === idempotencyKey)) return json(approvalForViewer(approval));
        if (revision !== approval.payload.authorization.revision || authorizationHash !== approval.payload.authorization.hash) return fail(409, 'stale_authorization', 'The authorization changed');
        const current = approval.steps.find((step) => step.status === 'current' && step.current_reviewer_member_ids.includes(viewerMemberId));
        if (!current) return fail(403, 'not_eligible', 'The current step belongs to another reviewer');
        const decision = body.decision === 'decline' ? 'decline' : body.decision === 'request_changes' ? 'request_changes' : 'approve';
        approvalResult(approval, decision, typeof body.note === 'string' ? body.note : null, idempotencyKey);
        syncApprovalRow();
        return json(approvalForViewer(approval));
      }
      if (rest === '/approval/revisions' && method === 'POST') {
        if (!approval || !row) return fail(404, 'not_found');
        if (seat !== 'admin' || !['pending', 'changes_requested'].includes(approval.status)) return fail(403, 'not_eligible', 'Only the proposal owner can revise this request');
        if (Number(body.expected_authorization_revision) !== approval.payload.authorization.revision || String(body.expected_authorization_hash ?? '') !== approval.payload.authorization.hash) return fail(409, 'stale_authorization', 'The authorization changed');
        const proposal = body.proposal as Record<string, unknown> | undefined;
        if (!proposal || proposal.approval_type !== approval.payload.approval_type) return fail(422, 'invalid_revision', 'The revised approval type must not change');
        const nextRevision = approval.payload.authorization.revision + 1;
        approval.payload = {
          ...proposal,
          context: approval.payload.context,
          policy: approval.payload.policy,
          resource_bindings: approval.payload.resource_bindings,
          authorization: { ...approval.payload.authorization, revision: nextRevision, hash: hashForMock(nextRevision + [...approvalViews.keys()].indexOf(id) * 100) },
        } as ApprovalView['payload'];
        approval.status = 'pending';
        approval.votes = [];
        approval.finalized_at = null;
        approval.steps = approval.payload.policy.steps.map((step, index) => ({
          step_id: step.id,
          label: step.label,
          order: step.order,
          status: index === 0 ? 'current' : 'blocked',
          approvals_recorded: 0,
          quorum: step.quorum,
          current_reviewer_member_ids: index === 0 && step.reviewers[0]?.kind === 'member' ? [step.reviewers[0].member_id] : [],
        }));
        approval.effect = approval.effect.kind === 'none'
          ? { ...approval.effect, status: 'not_required', reason: 'No external provider effect is required.' }
          : { ...approval.effect, status: 'unavailable', reason: 'Illustrative demo only; no external provider is connected and no effect occurred.' };
        approval.work = { status: 'waiting', continuation_id: null, reason: 'Waiting for authorization.' };
        syncApprovalRow();
        return json(approvalForViewer(approval));
      }
      if (rest === '/approval/route' && method === 'POST') {
        if (!approval || !row) return fail(404, 'not_found');
        if (Number(body.expected_authorization_revision) !== approval.payload.authorization.revision || String(body.expected_authorization_hash ?? '') !== approval.payload.authorization.hash) return fail(409, 'stale_authorization', 'The authorization changed');
        const step = approval.steps.find((item) => item.step_id === body.step_id && item.status === 'current');
        const reviewer = approval.identities.reviewers.find((item) => item.member_id === body.reviewer_member_id);
        if (!step || !step.current_reviewer_member_ids.includes(viewerMemberId) || !reviewer) return fail(403, 'not_eligible', 'This review cannot be routed by the viewer');
        step.current_reviewer_member_ids = [reviewer.member_id];
        approval.work = { status: 'waiting', continuation_id: null, reason: `Waiting for ${reviewer.name}.` };
        syncApprovalRow();
        return json(approvalForViewer(approval));
      }
      if (rest === '/presentation' && method === 'PATCH') {
        if (!row) return fail(404, 'not_found');
        const hidden = body.hidden;
        if (typeof hidden !== 'boolean') return fail(422, 'bad_presentation', 'hidden must be true or false');
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (hidden && reason.length < 5) return fail(422, 'hide_reason_required', 'A reason is required');
        const projected = requestForViewer(row);
        if (hidden && row.status === 'pending' && row.kind !== 'task' && projected.decision_summary?.approval_requirement.pending_for_viewer) {
          return fail(409, 'required_review_cannot_be_hidden', 'Decide or route this required review before hiding it');
        }
        row.presentation = hidden
          ? { hidden: true, hidden_at: iso(1), hidden_reason: reason.slice(0, 500) }
          : { hidden: false, hidden_at: null, hidden_reason: row.presentation.hidden_reason };
        return json(requestForViewer(row));
      }
      if (rest === '/decisions' && method === 'POST') {
        if (!row) return fail(404, 'not_found');
        const financeScoped = row.kind === 'invoice' && 'workflow_provenance' in row.payload;
        if (seat !== 'admin' && !(financeScoped && seat === 'member')) return fail(403, 'not_admin', 'Admin decision required');
        if (row.status !== 'pending') return fail(409, 'already_decided', 'Already decided');
        const decision = body.decision === 'decline' ? 'decline' : 'approve';
        const resulting = decision === 'decline' ? 'declined' : row.kind === 'application' ? 'admitted' : row.kind === 'invoice' ? 'created' : 'drafted';
        row.status = resulting;
        row.version += 1;
        row.decided_at = iso(1);
        row.decided_by_name = viewerName;
        if (id === REQ_INVOICE && options.partnerWorkflow) {
          const handoff = partnerHandoffs.find((item) => item.request_id === id && item.current);
          if (handoff) {
            handoff.outcome = {
              ...handoff.outcome,
              human_decision: decision === 'approve' ? 'approved' : 'declined',
              acknowledgment: 'delivered',
            };
            handoff.decided_at = iso(1);
            handoff.result_reason = decision === 'approve' ? 'Finance saved the invoice draft. No payment or email was sent.' : 'Finance declined the invoice draft.';
            handoff.acknowledgment = {
              handoff_id: handoff.id,
              partner_id: handoff.partner_id,
              partner_name: handoff.partner_name,
              engagement_reference: handoff.engagement_reference,
              outcome: decision === 'approve' ? 'invoice_draft_saved' : 'declined',
              result_code: decision === 'approve' ? 'approved' : 'declined',
              finance_reviewer_display: viewerName,
              recorded_at: iso(1),
              delivery_status: 'delivered',
            };
          }
        }
        const decisionId = mockUuid(600 + requests.indexOf(row));
        row.decision_id = decisionId;
        publish({
          id: (head + 1n).toString(),
          workspace_id: WS,
          session_id: null,
          kind: 'decision.recorded',
          schema_version: SCHEMA_VERSION,
          trace_id: 'trace-mock-decide',
          at: iso(1),
          payload: { request_id: id, decision_id: decisionId, decision, resulting_status: resulting, decided_by: viewerUserId, decided_at: iso(1), effect_ids: [] },
        } as StreamEvent);
        return json({ decision_id: decisionId, request_id: id, resulting_status: resulting, effect_ids: [] });
      }
      if (rest === '/notes' && method === 'POST') {
        if (!row) return fail(404, 'not_found');
        const note = typeof body.body === 'string' ? body.body.trim() : '';
        if (!note) return fail(422, 'empty_note', 'A note needs a body');
        row.note = note.slice(0, 4000);
        row.version += 1;
        return json(row, 201);
      }
      if (rest === '/effects') return page([]);
      if (!rest) return row ? json(requestForViewer(row)) : fail(404, 'not_found');
    }

    if (p('/requests')) {
      const visibility = url.searchParams.get('visibility') ?? 'active';
      const visible = requests.filter((row) => visibility === 'all' || row.presentation.hidden === (visibility === 'hidden'));
      return page(visible.map(requestForViewer));
    }
    if (p('/documents')) return page(documents);
    const documentMatch = match(new RegExp(`^/w/${WS}/documents/([^/]+)$`));
    if (documentMatch) {
      const row = documents.find((d) => d.id === documentMatch[1]);
      return row ? json(row) : fail(404, 'not_found');
    }
    if (p('/members') && method === 'GET') return page(seat === 'admin' ? members : members.map((member) => ({ ...member, email: '' })));
    const memberMatch = match(new RegExp(`^/w/${WS}/members/([^/]+)$`));
    if (memberMatch) {
      if (options.memberWrites === 'fail') return fail(503, 'fixture_write_failed', 'Member write fixture failed');
      const index = members.findIndex((row) => row.id === memberMatch[1]);
      if (index < 0) return fail(404, 'not_found');
      const row = members[index]!;
      if (method === 'PATCH') {
        row.role = body.role === 'admin' ? 'admin' : 'member';
        row.version += 1;
        return json(row);
      }
      if (method === 'DELETE') {
        members.splice(index, 1);
        return new Response(null, { status: 204 });
      }
    }
    if (p('/invitations') && method === 'GET') return seat === 'admin' ? page(invitations) : fail(403, 'admin_required');
    if (p('/invitations') && method === 'POST') {
      if (!setupOnly && body.role_template_key !== undefined) {
        return fail(409, 'member_setup_unavailable', 'Background member setup is not available in this deployment.');
      }
      if (setupOnly && body.role_template_key === 'finance-agent') {
        return fail(409, 'member_setup_role_unavailable', 'Finance agent setup is not available yet.');
      }
      if (options.memberWrites === 'fail') {
        return json({
          error: 'No verified Iris profile is available',
          reason: 'iris_capacity_unavailable',
          trace_id: mockUuid(399),
        }, 409);
      }
      const row: InvitationEntity = {
        id: mockUuid(220 + invitations.length), email: String(body.email ?? ''),
        role: body.role === 'admin' ? 'admin' : 'member', status: 'pending', invited_at: iso(0),
        delivery_status: setupOnly ? 'not_required' : 'queued',
        ...(setupOnly ? {
          role_template_key: 'partnerships-agent' as const,
          provisioning: {
            id: mockUuid(320 + invitations.length), workspace_id: WS, revision: 0,
            preparation: 'queued' as const, delivery: 'not_queued' as const,
            membership: 'not_joined' as const, cancellation: 'none' as const, issue: null,
          },
        } : {}),
        version: 1,
      };
      invitations.push(row);
      return json(row, 201);
    }
    const invitationMatch = match(new RegExp(`^/w/${WS}/invitations/([^/]+)/(resend|withdraw)$`));
    if (invitationMatch) {
      if (options.memberWrites === 'fail' && invitationMatch[2] === 'resend') {
        return json({
          error: 'No verified Iris profile is available',
          reason: 'iris_capacity_unavailable',
          trace_id: mockUuid(399),
        }, 409);
      }
      if (options.memberWrites === 'fail') return fail(503, 'fixture_write_failed', 'Invitation write fixture failed');
      const row = invitations.find((item) => item.id === invitationMatch[1]);
      if (!row) return fail(404, 'not_found');
      if (invitationMatch[2] === 'withdraw') {
        row.status = 'withdrawn';
        row.version += 1;
        return new Response(null, { status: 204 });
      }
      row.status = 'resent';
      row.version += 1;
      const successor: InvitationEntity = {
        ...row, id: mockUuid(220 + invitations.length), status: 'pending', invited_at: iso(0), version: 1,
        provisioning: row.provisioning ? {
          ...row.provisioning, revision: row.provisioning.revision + 1,
          preparation: 'queued', delivery: 'not_queued', cancellation: 'none', issue: null,
        } : undefined,
      };
      invitations.push(successor);
      return json(successor);
    }
    if (p('/history')) return page(history);
    if (p('/traces')) return page(traces);
    const traceMatch = match(new RegExp(`^/w/${WS}/traces/([^/]+)$`));
    if (traceMatch) {
      const row = traces.find((t) => t.id === traceMatch[1]);
      return row ? json(row) : fail(404, 'not_found');
    }
    const contextNoteMatch = match(new RegExp(`^/w/${WS}/agents/${AGENT}/context-notes(?:/([^/]+))?$`));
    if (contextNoteMatch) {
      if (method === 'GET') return page(confirmedNotes);
      if (seat !== 'admin') return fail(403, 'not_admin');
      if (options.agentSettings === 'fail') return fail(503, 'fixture_write_failed');
      const old = confirmedNotes.find((note) => note.id === contextNoteMatch[1]);
      if (method !== 'POST' && (!old || old.revision !== body.expected_revision)) return fail(409, 'stale_revision');
      if (method === 'DELETE') { confirmedNotes.splice(confirmedNotes.indexOf(old!), 1); return new Response(null, { status: 204 }); }
      const note: ContextNote = { id: old?.id ?? mockUuid(810 + confirmedNotes.length), agent_id: AGENT, title: String(body.title), text: String(body.text), revision: (old?.revision ?? 0) + 1, author_id: USER, author_name: 'Brian', created_at: old?.created_at ?? iso(), updated_at: iso(), origin: 'human', scope: 'future' };
      if (old) confirmedNotes.splice(confirmedNotes.indexOf(old), 1, note); else confirmedNotes.push(note);
      return json(note);
    }
    const permissionsMatch = match(new RegExp(`^/w/${WS}/agents/${AGENT}/permissions(?:/approvals/([^/]+))?$`));
    if (permissionsMatch) {
      if (method === 'GET') return json(agentPermissions);
      if (seat !== 'admin') return fail(403, 'not_admin');
      if (options.agentSettings === 'fail') return fail(503, 'fixture_write_failed');
      if (method === 'PATCH') {
        if (options.agentSettings === 'conflict' || body.revision !== agentPermissions.revision) return fail(409, 'stale_revision');
        const operation = agentPermissions.operations.find((row) => row.id === body.operation_id);
        if (!operation) return fail(400, 'unknown_operation');
        operation.require_human_approval = body.require_human_approval === true; agentPermissions.revision++;
      } else agentPermissions.pending_approvals = agentPermissions.pending_approvals.filter((row) => row.id !== permissionsMatch[1]);
      return json(agentPermissions);
    }
    if (p('/files') && method === 'GET') return page(storedSources);
    if (p('/library-sources') && method === 'GET') return page(librarySources);
    if (p('/shared-intelligence') && method === 'GET') return json(sharedIntelligence());
    if (p('/shared-intelligence/proposals') && method === 'POST') {
      const evidenceInput = Array.isArray(body.evidence) ? body.evidence as Array<{ run_id?: unknown; approved_excerpt?: unknown }> : [];
      const proposal: SharedIntelligenceProposal = {
        id: mockUuid(940 + sharedIntelligenceProposals.length), title: String(body.title ?? ''), goal: String(body.goal ?? ''),
        lesson: String(body.lesson ?? ''), rationale: String(body.rationale ?? ''), agent_id: String(body.agent_id ?? AGENT), agent_name: 'Iris',
        audiences: sharedIntelligence().teams.filter((team) => Array.isArray(body.team_ids) && body.team_ids.includes(team.id)),
        evidence: evidenceInput.map((item, index) => ({ ...sharedEvidence(index), run_id: String(item.run_id), approved_excerpt: String(item.approved_excerpt) })),
        assessment: { ...sharedIntelligenceAssessment, evidence_count: evidenceInput.length }, status: evidenceInput.length >= 2 ? 'ready_for_review' : 'needs_review',
        approval_request_id: null, library_source_id: null, library_version_id: null, created_at: iso(), published_at: null, revoked_at: null,
        triage_status: 'private', triage_goal_id: null, triage_assessment: null, triage_submitted_at: null, triage_decided_at: null,
      };
      sharedIntelligenceProposals = [proposal, ...sharedIntelligenceProposals];
      return json(proposal, 201);
    }
    const intelligenceMatch = match(new RegExp(`^/w/${WS}/shared-intelligence/proposals/([^/]+)/(submit|revoke|triage)$`));
    if (intelligenceMatch && method === 'POST') {
      const proposal = sharedIntelligenceProposals.find((item) => item.id === intelligenceMatch[1]);
      if (!proposal) return fail(404, 'not_found');
      if (intelligenceMatch[2] === 'submit' && proposal.triage_status !== 'included') return fail(409, 'shared_intelligence_admin_triage_required');
      const updated: SharedIntelligenceProposal = intelligenceMatch[2] === 'submit'
        ? { ...proposal, status: 'pending_review', approval_request_id: APPROVAL_DEMO_REQUEST_IDS.shared_learning }
        : intelligenceMatch[2] === 'triage'
          ? { ...proposal, triage_status: 'queued', triage_goal_id: String(body.goal_id), triage_assessment: sharedIntelligenceTriageAssessment, triage_submitted_at: iso(), triage_decided_at: null }
        : { ...proposal, status: 'revoked', revoked_at: iso() };
      sharedIntelligenceProposals = sharedIntelligenceProposals.map((item) => item.id === updated.id ? updated : item);
      return json(intelligenceMatch[2] === 'submit' ? { proposal: updated, approval_request_id: APPROVAL_DEMO_REQUEST_IDS.shared_learning } : updated);
    }
    if (p('/admin/shared-intelligence') && method === 'GET') {
      if (seat !== 'admin') return fail(403, 'admin_required');
      return json({
        teams: sharedIntelligence().teams, goals: sharedIntelligenceGoals,
        candidates: sharedIntelligenceProposals.filter((proposal) => proposal.triage_status !== 'private').map((proposal) => ({
          proposal, goal: proposal.triage_assessment?.goal_snapshot ?? sharedIntelligenceGoals[0],
          submitted_by: { id: USER, name: 'Brian' }, library_comparisons: [], assessment_stale: false, stale_reason: null, decision_note: null,
        })),
        data_boundary: 'Only owner-shared candidates and approved excerpts appear here. Raw provider turns, hidden reasoning, tool arguments/results, credentials, and other members\' private sessions remain excluded.',
      });
    }
    if (p('/admin/shared-intelligence/goals') && method === 'POST') {
      if (seat !== 'admin') return fail(403, 'admin_required');
      const goal = { id: mockUuid(626 + sharedIntelligenceGoals.length), scope: body.scope === 'team' ? 'team' as const : 'workspace' as const, team_id: body.team_id ? String(body.team_id) : null, team_name: body.team_id ? 'Partnerships' : null, title: String(body.title), detail: String(body.detail), revision: 1, content_sha256: 'b'.repeat(64), active: true, created_at: iso() };
      sharedIntelligenceGoals = [goal, ...sharedIntelligenceGoals];
      return json(goal, 201);
    }
    const triageDecisionMatch = match(new RegExp(`^/w/${WS}/admin/shared-intelligence/proposals/([^/]+)/decision$`));
    if (triageDecisionMatch && method === 'POST') {
      if (seat !== 'admin') return fail(403, 'admin_required');
      const proposal = sharedIntelligenceProposals.find((item) => item.id === triageDecisionMatch[1]);
      if (!proposal) return fail(404, 'not_found');
      const updated: SharedIntelligenceProposal = body.decision === 'include'
        ? { ...proposal, triage_status: 'included', triage_decided_at: iso(), status: 'pending_review', approval_request_id: APPROVAL_DEMO_REQUEST_IDS.shared_learning }
        : body.decision === 'exclude'
          ? { ...proposal, triage_status: 'excluded', triage_decided_at: iso() }
          : { ...proposal, triage_status: 'queued', triage_decided_at: null };
      sharedIntelligenceProposals = sharedIntelligenceProposals.map((item) => item.id === updated.id ? updated : item);
      return json({ candidate: { proposal: updated, goal: updated.triage_assessment?.goal_snapshot ?? sharedIntelligenceGoals[0], submitted_by: { id: USER, name: 'Brian' }, library_comparisons: [], assessment_stale: false, stale_reason: null, decision_note: body.note || null }, approval_request_id: body.decision === 'include' ? APPROVAL_DEMO_REQUEST_IDS.shared_learning : null });
    }
    const triageReassessMatch = match(new RegExp(`^/w/${WS}/admin/shared-intelligence/proposals/([^/]+)/reassess$`));
    if (triageReassessMatch && method === 'POST') {
      if (seat !== 'admin') return fail(403, 'admin_required');
      const proposal = sharedIntelligenceProposals.find((item) => item.id === triageReassessMatch[1]);
      const goal = sharedIntelligenceGoals.find((item) => item.id === body.goal_id);
      if (!proposal || !goal) return fail(404, 'not_found');
      const assessment = { ...sharedIntelligenceTriageAssessment, goal_snapshot: goal, assessed_at: iso() };
      const updated = { ...proposal, triage_goal_id: goal.id, triage_assessment: assessment, triage_submitted_at: iso() };
      sharedIntelligenceProposals = sharedIntelligenceProposals.map((item) => item.id === updated.id ? updated : item);
      return json({ proposal: updated, goal, submitted_by: { id: USER, name: 'Brian' }, library_comparisons: [], assessment_stale: false, stale_reason: null, decision_note: null });
    }
    const sourceMatch = match(new RegExp(`^/w/${WS}/files/([^/]+)$`));
    if (sourceMatch && method === 'DELETE') { const index = storedSources.findIndex((row) => row.id === sourceMatch[1]); if (index >= 0) storedSources.splice(index, 1); return new Response(null, { status: 204 }); }
    if (p('/context-fields')) return page(contextFields);
    const contextMatch = match(new RegExp(`^/w/${WS}/context-fields/([^/]+)$`));
    if (contextMatch && method === 'PATCH') {
      const field = contextFields[0]!;
      field.value = String(body.value ?? '');
      field.scope = (body.scope === 'future' ? 'future' : 'reply') as 'reply' | 'future';
      field.version += 1;
      return json(field);
    }
    if (p('/instructions')) {
      if (method === 'POST') {
        if (seat !== 'admin') return fail(403, 'not_admin');
        if (options.agentSettings === 'fail') return fail(503, 'fixture_write_failed');
        const current = instructions.find((row) => row.state === 'current');
        if (options.agentSettings === 'conflict' || body.expected_current_id !== (current?.id ?? null)) return fail(409, 'stale_revision');
        if (current) current.state = 'saved';
        const saved: InstructionVersion = { id: mockUuid(820 + instructions.length), state: 'current', text: String(body.text), before: current?.text ?? null, provenance: 'written by Brian', created_at: iso(), version: 1 };
        instructions.unshift(saved); return json(saved, 201);
      }
      return page(instructions);
    }
    if (p('/skills')) return page(skills);
    if (p('/partner-workflow/configure') && method === 'POST') {
      if (seat !== 'admin') return fail(403, 'forbidden_partner_workflow_action');
      partnerConfigured = true;
      return fetchImpl(new URL(`/w/${WS}/partner-workflow`, url.origin), { method: 'GET' });
    }
    if (p('/partner-workflow/admission') && method === 'POST') {
      if (seat !== 'admin') return fail(403, 'forbidden_partner_workflow_action');
      if (body.enabled === true && !partnerConfigured) return fail(409, 'workflow_not_configured', 'Configure both roles before enabling admission.');
      if (body.enabled === true && options.workflowActivation === 'native-mismatch') {
        return fail(409, 'workflow_readiness_incomplete', 'A native profile did not attest the reviewed skill and tool inventory.');
      }
      if (body.enabled === true && options.workflowActivation === 'binding-drift') {
        return fail(409, 'workflow_readiness_incomplete', 'A role assignment changed after native readiness was checked.');
      }
      if (body.enabled === true) partnerProfilesVerified = true;
      partnerAdmissionEnabled = body.enabled === true;
      return fetchImpl(new URL(`/w/${WS}/partner-workflow`, url.origin), { method: 'GET' });
    }
    if (p('/partner-workflow') && method === 'GET') {
      const configured = partnerConfigured;
      const canSeeWork = configured && (workflowRole === 'partnerships' || workflowRole === 'finance');
      return json({
        configured,
        admission_state: partnerAdmissionEnabled ? 'enabled' : 'disabled',
        viewer_role: configured ? workflowRole : seat === 'admin' ? 'admin' : 'unrelated',
        actions: {
          configure: seat === 'admin',
          set_admission: seat === 'admin',
          propose_engagement: configured && partnerAdmissionEnabled && workflowRole === 'partnerships',
          submit_invoice: configured && partnerAdmissionEnabled && workflowRole === 'partnerships',
          correct_invoice: configured && partnerAdmissionEnabled && workflowRole === 'partnerships',
          view_finance_review: configured && partnerAdmissionEnabled && workflowRole === 'finance',
        },
        teams: configured && workflowRole !== 'unrelated' ? [
          { id: mockUuid(620), slug: 'partnerships', name: 'Partnerships' },
          { id: mockUuid(621), slug: 'finance', name: 'Finance' },
        ] : [],
        agents: configured && workflowRole !== 'unrelated' ? [
          {
            id: AGENT, name: 'Iris', principal_user_id: USER, principal_name: 'Maya Chen',
            team: { id: mockUuid(620), slug: 'partnerships', name: 'Partnerships' },
            role_template: { key: 'partnerships-agent', name: 'Partnerships agent', version: '1.8.0' },
            skill_key: 'partner-program-screening', skill_name: 'Partner program screening', skill_version: '1.8.0',
            assignment_id: mockUuid(622), assignment_revision: 1, assignment_state: 'active', schedule_enabled: false,
            capabilities: ['partner.discovery.read', 'partner.review.prepare', 'partner.handoff.publish'],
          },
          {
            id: FINANCE_AGENT, name: 'Ledger', principal_user_id: MEMBER_USER, principal_name: 'Alex Rivera',
            team: { id: mockUuid(621), slug: 'finance', name: 'Finance' },
            role_template: { key: 'finance-agent', name: 'Finance agent', version: '1.0.1' },
            skill_key: 'partner-invoice-review', skill_name: 'Partner invoice review', skill_version: '1.0.1',
            assignment_id: mockUuid(623), assignment_revision: 1, assignment_state: 'active', schedule_enabled: false,
            capabilities: ['partner.shared.read', 'partner.invoice.read', 'partner.invoice.review.prepare'],
          },
        ] : [],
        readiness: workflowRole === 'unrelated' ? [] : configured ? [
          { role: 'partnerships', configured: true, assignment_state: 'active', native_status: partnerProfilesVerified ? 'ready' : 'not_ready', skill_key: 'partner-program-screening', skill_version: '1.8.0', artifact_digest: hashForMock(71), missing: partnerProfilesVerified ? [] : ['skill', 'tools', 'provider'] },
          { role: 'finance', configured: true, assignment_state: 'active', native_status: partnerProfilesVerified ? 'ready' : 'not_ready', skill_key: 'partner-invoice-review', skill_version: '1.0.1', artifact_digest: hashForMock(72), missing: partnerProfilesVerified ? [] : ['skill', 'tools', 'provider'] },
        ] : [
          { role: 'partnerships', configured: false, assignment_state: 'missing', native_status: 'unknown', skill_key: 'partner-program-screening', skill_version: null, artifact_digest: null, missing: ['principal', 'agent', 'assignment', 'skill', 'tools', 'provider'] },
          { role: 'finance', configured: false, assignment_state: 'missing', native_status: 'unknown', skill_key: 'partner-invoice-review', skill_version: null, artifact_digest: null, missing: ['principal', 'agent', 'assignment', 'skill', 'tools', 'provider'] },
        ],
        partner_options: canSeeWork ? [
          { id: mockUuid(611), name: 'Robin Studio', source: 'engagement' },
          { id: mockUuid(617), name: 'Northstar Labs', source: 'candidate' },
        ] : [],
        engagements: canSeeWork ? partnerEngagements : [],
        handoffs: canSeeWork ? partnerHandoffs : [],
        connector: {
          name: 'enterprise-partner-records', shared_code: true, enforcement: 'server',
          summary: 'Shared identity and approved engagement evidence only; private research and invoice data stay team-scoped.',
        },
      });
    }
    if (p('/partner-workflow/engagement-authorizations') && method === 'POST') {
      if (workflowRole !== 'partnerships') return fail(403, 'forbidden_partner_workflow_action');
      const inputProvenance = body.input_provenance === 'customer' ? 'customer' : 'sample';
      return json({ approval_request_id: APPROVAL_DEMO_REQUEST_IDS.record_change, authorization_revision: 1, authorization_hash: hashForMock(80), engagement_record_id: null, status: 'pending', input_provenance: inputProvenance, created: true }, 201);
    }
    if (p('/partner-workflow/invoice-intakes') && method === 'POST') {
      if (workflowRole !== 'partnerships') return fail(403, 'partnerships_principal_required');
      const id = mockUuid(630 + partnerHandoffs.length);
      const engagement = partnerEngagements.find((item) => item.id === body.engagement_record_id);
      const invoice = body.invoice as Record<string, unknown>;
      const inputProvenance = engagement?.input_provenance === 'sample' ? 'sample' : body.input_provenance === 'customer' ? 'customer' : 'sample';
      partnerHandoffs.unshift({
        id, revision: 1, supersedes_handoff_id: null, superseded_by_handoff_id: null, current: true,
        partner_id: engagement?.partner.id ?? mockUuid(611), partner_name: engagement?.partner.name ?? 'Sample partner',
        engagement_reference: engagement?.reference ?? 'ENG-SAMPLE', invoice_number: String(invoice.number ?? 'INV-SAMPLE'),
        invoice_currency: String(invoice.currency ?? 'USD'), invoice_total_minor: Number(invoice.total_minor ?? 0),
        source_session_id: SESSION_A, finance_session_id: SESSION_B, request_id: null,
        input_provenance: inputProvenance,
        outcome: { delivery: 'queued', validation: 'queued', agent_explanation: 'queued', human_decision: 'not_ready', acknowledgment: 'pending' },
        result_kind: 'pending_checks', result_reason: 'Sample invoice received. No model call was made in this fixture.', checks: [], acknowledgment: null,
        simulated: !options.partnerWorkflowNative, created_at: iso(0), decided_at: null,
      });
      return json({ intake_event_id: mockUuid(640), payload_hash: hashForMock(81), handoff_id: id, handoff_revision: 1, source_run_id: RUN, finance_run_id: null, input_provenance: inputProvenance, created: true }, 201);
    }
    const partnerHandoffMatch = match(new RegExp(`^/w/${WS}/partner-workflow/handoffs/([^/]+)/(result|corrections)$`));
    if (partnerHandoffMatch) {
      const handoff = partnerHandoffs.find((item) => item.id === partnerHandoffMatch[1]);
      if (!handoff) return fail(404, 'handoff_not_found');
      if (partnerHandoffMatch[2] === 'result' && method === 'GET') return json(workflowResult(handoff));
      if (partnerHandoffMatch[2] === 'corrections' && method === 'POST') {
        if (workflowRole !== 'partnerships') return fail(403, 'partnerships_principal_required');
        if (handoff.input_provenance === 'unknown') return fail(409, 'legacy_handoff_input_forbidden', 'Historical handoffs without provenance cannot be corrected.');
        if (handoff.input_provenance === 'sample' && body.input_provenance === 'customer') return fail(400, 'bad_invoice_correction', 'Sample lineage must remain sample.');
        const inputProvenance = handoff.input_provenance === 'sample' ? 'sample' : body.input_provenance === 'customer' ? 'customer' : 'sample';
        handoff.current = false;
        const successorId = mockUuid(650 + partnerHandoffs.length);
        handoff.superseded_by_handoff_id = successorId;
        handoff.outcome = { ...handoff.outcome, human_decision: 'superseded' };
        const invoice = body.invoice as Record<string, unknown>;
        const successor: PartnerWorkflowHandoffV2 = {
          ...handoff, id: successorId, revision: 1, supersedes_handoff_id: handoff.id, superseded_by_handoff_id: null, current: true,
          invoice_number: String(invoice.number ?? handoff.invoice_number), invoice_currency: String(invoice.currency ?? handoff.invoice_currency),
          invoice_total_minor: Number(invoice.total_minor ?? handoff.invoice_total_minor), request_id: REQ_INVOICE,
          input_provenance: inputProvenance,
          outcome: { delivery: 'delivered', validation: 'passed', agent_explanation: 'completed', human_decision: 'pending', acknowledgment: 'pending' },
          result_kind: 'checks_passed', result_reason: 'Sample corrected invoice passed deterministic checks. No model call was made in this fixture.',
          checks: [{ code: 'amount', status: 'passed', message: 'The corrected amount matches the authorized total.' }], simulated: !options.partnerWorkflowNative, created_at: iso(1), decided_at: null,
        };
        partnerHandoffs.unshift(successor);
        return json({ superseded_handoff_id: handoff.id, handoff_id: successor.id, handoff_revision: 1, intake_event_id: mockUuid(651), payload_hash: hashForMock(82), source_run_id: RUN, finance_run_id: mockUuid(652), input_provenance: inputProvenance, created: true }, 201);
      }
    }
    const skillAssignmentsMatch = match(new RegExp(`^/w/${WS}/agents/${AGENT}/skill-assignments(?:/([^/]+))?$`));
    if (skillAssignmentsMatch) {
      if (!skillAssignmentsMatch[1] && method === 'GET') return page([skillAssignment]);
      if (skillAssignmentsMatch[1] === skillAssignment.id && method === 'PATCH') {
        if (body.revision !== skillAssignment.revision) return fail(409, 'stale_revision');
        skillAssignment = {
          ...skillAssignment,
          ...(body.state ? { state: body.state as 'active' | 'paused' } : {}),
          ...(body.config && typeof body.config === 'object' ? { config: body.config as Record<string, unknown> } : {}),
          ...(body.schedule && typeof body.schedule === 'object' ? { schedule: body.schedule as EnterpriseSkillAssignment['schedule'] } : {}),
          revision: skillAssignment.revision + 1,
          updated_at: new Date().toISOString(),
        };
        return json(skillAssignment);
      }
      return fail(404, 'not_found');
    }
    if (p('/cloud/connection') && method === 'GET') {
      // Fixture-only: the mock never authorizes a real Cloud organization.
      return json({ status: 'not_connected', organization_name: null, automatic_setup_ready: false, available: false });
    }
    if (path.startsWith(`/w/${WS}/integrations/slack`)) {
      if (method === 'POST' && path.endsWith('/oauth/start')) {
        if (seat !== 'admin') return fail(403, 'admin_required');
        return json({ authorize_url: 'https://slack.com/oauth/v2/authorize?client_id=fixture', expires_at: iso(600) }, 201);
      }
      if (method === 'DELETE') {
        if (seat !== 'admin') return fail(403, 'admin_required');
        slackConnected = false;
        return json({ status: 'disconnected', remote_revocation: 'not_applicable' });
      }
      if (method === 'POST' && path.endsWith('/link-code')) {
        return json({ command: 'link hmx_fixture_only_not_a_credential', expires_at: iso(600) }, 201);
      }
      return json({
        configured: true,
        status: slackConnected ? 'connected' : 'disconnected',
        installation_kind: slackConnected ? 'workspace' : null,
        team_name: slackConnected ? 'Fixture workspace' : null,
        enterprise_name: null,
        connected_at: slackConnected ? iso(0) : null,
        granted_scopes: slackConnected && seat === 'admin' ? ['app_mentions:read', 'chat:write', 'im:history'] : [],
        agent: { id: AGENT, name: 'Iris' },
        can_manage: seat === 'admin',
        reconnect_required: false,
        behavior: { direct_messages: 'same_session', channel_messages: 'mention_required', channel_replies: 'threaded', approvals: 'hermes_inbox' },
      });
    }
    if (path.startsWith(`/w/${WS}/integrations/email/evidence`)) {
      if (method === 'POST' && path.endsWith('/gmail/oauth/start')) {
        emailEvidenceConnected = true;
        return json({ authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=evidence-fixture', expires_at: iso(600) }, 201);
      }
      if (method === 'POST' && path.endsWith('/threads')) {
        importedEmailEvidence += 1;
        return json({
          kind: 'mailbox_thread_snapshot',
          snapshot_id: mockUuid(970 + importedEmailEvidence),
          source_id: mockUuid(980 + importedEmailEvidence),
          version_id: mockUuid(990 + importedEmailEvidence),
          version: importedEmailEvidence,
          team_id: mockUuid(960),
          team_name: 'Partnerships',
          title: 'Re: Partner conversation',
          provider_thread_id: String(body.thread_id ?? 'fixture-thread'),
          message_count: 3,
          sha256: 'a'.repeat(64),
          imported_at: iso(0),
          created: true,
          events: { replies: 1, bounces: 0, unsubscribes: 1, sends_enqueued: 0 },
        }, 201);
      }
      return json({
        configured: true,
        status: emailEvidenceConnected ? 'connected' : 'disconnected',
        address: emailEvidenceConnected && seat === 'admin' ? 'iris-evidence@example.com' : null,
        connected_at: emailEvidenceConnected ? iso(0) : null,
        latest_import_at: seat === 'admin' && importedEmailEvidence ? iso(0) : null,
        imported_threads: seat === 'admin' ? importedEmailEvidence : 0,
        can_manage: seat === 'admin',
        authorization: 'separate_read_only',
        scope: 'gmail.readonly',
        selection: 'one_thread_per_import',
      });
    }
    if (path.startsWith(`/w/${WS}/integrations/email`)) {
      if (method === 'POST' && path.endsWith('/gmail/oauth/start')) {
        emailConnected = true;
        return json({ authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture', expires_at: iso(600) }, 201);
      }
      return json({
        configured: true,
        status: emailConnected ? 'connected' : 'disconnected',
        address: emailConnected && seat === 'admin' ? 'iris-partners@example.com' : null,
        connected_at: emailConnected ? iso(0) : null,
        pending_messages: emailConnected && seat === 'admin' ? 2 : 0,
        can_manage: seat === 'admin',
        mode: 'draft_only',
        discovery_enabled: true,
        discovery_interval_minutes: 360,
      });
    }
    if (p('/provider-connections/nous/start') && method === 'POST') {
      // The ordinary browser fixture has no hosted OAuth client. Returning the
      // same typed refusal as an unconfigured deployment exercises the real
      // manual workspace-key fallback without inventing an OAuth credential.
      return fail(503, 'oauth_not_configured', 'Hosted Nous sign-in is not configured in this fixture.');
    }
    if (p('/admin/runtime-discovery-grants')) {
      if (seat !== 'admin') return fail(403, 'admin_required', 'Admin required.');
      const stepUpSatisfied = typeof document === 'undefined' || document.cookie.includes('hermes_runtime_stepup=1');
      if (options.runtimeCapacityStepUp && !stepUpSatisfied) return fail(401, 'reauth_required', 'Recent sign-in required.');
      if (method === 'GET') return json({ grants: runtimeDiscoveryGrants }, 200, { 'cache-control': 'no-store' });
      if (method === 'POST') {
        const agentId = String(body.preflight_agent_id ?? '');
        const roleTemplateKey = body.role_template_key === 'finance-agent' ? 'finance-agent' as const : 'partnerships-agent' as const;
        const finance = roleTemplateKey === 'finance-agent';
        if (runtimeDiscoveryGrants.some((grant) => grant.preflight_agent_id === agentId && grant.status === 'prepared')) {
          return fail(409, 'discovery_grant_exists', 'An active credential exists.');
        }
        const created = {
          id: mockUuid(940 + runtimeDiscoveryGrants.length),
          preflight_agent_id: agentId,
          role_template_key: roleTemplateKey,
          role_template_version: '1.0.0' as const,
          bearer: 'd'.repeat(64),
          status: 'prepared' as const,
          expires_at: iso(24 * 60),
          created_at: iso(0),
        };
        runtimeDiscoveryGrants.unshift({
          id: created.id,
          preflight_agent_id: created.preflight_agent_id,
          role_template_key: created.role_template_key,
          role_template_version: created.role_template_version,
          role: finance ? 'Finance' : 'Partnerships P1.7',
          skill_key: finance ? 'partner-invoice-review' : 'partner-program-screening',
          skill_version: finance ? '1.0.1' : '1.7.0',
          assignment_revision: null,
          grant_revision: 1,
          linked_capacity_id: null,
          capacity_state: null,
          status: created.status,
          expires_at: created.expires_at,
          created_at: created.created_at,
        });
        return json(created, 201, { 'cache-control': 'no-store' });
      }
    }
    const runtimeGrantMatch = match(new RegExp(`^/w/${WS}/admin/runtime-discovery-grants/([^/]+)$`));
    if (runtimeGrantMatch && method === 'DELETE') {
      if (seat !== 'admin') return fail(403, 'admin_required', 'Admin required.');
      const row = runtimeDiscoveryGrants.find((grant) => grant.id === runtimeGrantMatch[1]);
      if (!row) return fail(404, 'not_found', 'Not found.');
      row.status = 'revoked';
      if (row.linked_capacity_id) row.capacity_state = 'quarantined';
      return json({ id: row.id, status: 'revoked' }, 200, { 'cache-control': 'no-store' });
    }
    if (p('/admin/hermes-capacity') && method === 'POST') {
      if (seat !== 'admin') return fail(403, 'admin_required', 'Admin required.');
      if (String(body.connector_url ?? '').includes('not-ready')) {
        return fail(409, 'capacity_not_ready', 'Fixture connector is not ready.');
      }
      const row = runtimeDiscoveryGrants.find((grant) =>
        grant.id === body.discovery_grant_id &&
        grant.preflight_agent_id === body.preflight_agent_id &&
        grant.status === 'prepared');
      if (!row) return fail(409, 'discovery_grant_unavailable', 'Credential unavailable.');
      const capacityId = mockUuid(980);
      row.linked_capacity_id = capacityId;
      row.capacity_state = 'available';
      row.status = 'linked';
      row.expires_at = null;
      return json({
        id: capacityId,
        cloud_agent_id: String(body.cloud_agent_id ?? ''),
        instance_name: String(body.instance_name ?? ''),
        preflight_agent_id: row.preflight_agent_id,
        state: 'available',
        plugin_version: '1.0.0-fixture',
        agentcash_enabled: row.role_template_key === 'partnerships-agent',
        agentcash_wallet_present: row.role_template_key === 'partnerships-agent',
        native_cron_disabled: true,
        verified_at: iso(0),
        discovery_grant_id: row.id,
        role_template_key: row.role_template_key,
        role_template_version: row.role_template_version,
      }, 201, { 'cache-control': 'no-store' });
    }
    if (p('/provider-keys') && method === 'GET') {
      if (seat !== 'admin') return fail(403, 'admin_required');
      if (options.providerKeysLocked) return fail(401, 'reauth_required', 'This action needs a recent sign-in.');
      return json({ keys: providerKeys });
    }
    if (p('/provider-keys') && method === 'POST') {
      // Explicit fake values let browser tests exercise both outcomes without
      // putting a real credential on the wire or making a paid provider call.
      const rejected = body.key === 'nous-invalid-test-key-0000';
      const status: MaskedProviderKey['status'] = rejected ? 'invalid' : 'verified';
      const added: MaskedProviderKey = { id: mockUuid(41), provider: (body.provider as MaskedProviderKey['provider']) ?? 'nous_portal', label: String(body.label ?? 'Nous Portal'), last4: '1234', fingerprint_prefix: 'bb0091fe22aa', status, verified_models: [], synced_model_count: rejected ? null : 3, models_synced_at: rejected ? null : iso(0), added_by: USER, created_at: iso(0), verified_at: rejected ? null : iso(0), rotated_at: null, revoked_at: null, replaces_key_id: null, credential_kind: 'api_key', oauth_expires_at: null };
      providerKeys.push(added);
      return json({ key: added, verification: { status, reason: rejected ? 'rejected' : 'verified' } }, 201);
    }
    if (path.startsWith(`/w/${WS}/provider-keys/`)) {
      const id = path.split('/')[4];
      const row = providerKeys.find((k) => k.id === id);
      if (method === 'DELETE') {
        if (row) row.revoked_at = iso(0);
        return json({ key: row ?? providerKeys[0], stopped_runs: [] });
      }
      if (row && path.endsWith('/verify')) {
        row.status = 'verified';
        row.verified_models = [];
        row.synced_model_count = 3;
        row.models_synced_at = iso(0);
        row.verified_at = iso(0);
        return json({ key_id: row.id, status: row.status, reason: 'ok' });
      }
      if (row && path.endsWith('/rotate')) {
        row.rotated_at = iso(0);
        return json({ key: row, replaces_key_id: row.id, verification: { status: row.status, reason: 'ok' } });
      }
      return json({ key: row ?? providerKeys[0], verification: { status: 'unverified', reason: 'unavailable' } });
    }
    // Uploads: declare, PUT the bytes at the dev-direct URL, complete.
    if ((p('/attachments') || p('/files')) && method === 'POST') {
      const attachment = { id: mockUuid(800), name: String(body.name ?? 'file.pdf'), size: Number(body.size ?? 1), mime: String(body.mime ?? 'application/pdf'), sha256: null, status: 'uploading' };
      declaredUploads.set(attachment.id, { name: attachment.name, size: attachment.size, mime: attachment.mime });
      return json(
        { attachment, upload: { method: 'PUT', url: `/w/${WS}/attachments/${attachment.id}/upload`, expires_at: iso(900), headers: {}, direct: true } },
        201,
      );
    }
    if (path.endsWith('/upload') && method === 'PUT') return json({ ok: true, size: 1 });
    if (path.endsWith('/complete') && method === 'POST') {
      const id = path.split('/')[4] ?? mockUuid(800);
      const upload = declaredUploads.get(id) ?? { name: 'Invoice.pdf', size: 1, mime: 'application/pdf' };
      if (path.includes('/files/')) storedSources.push({ id, ...upload, mime: 'text/plain', sha256: 'a'.repeat(64), status: 'ready', kind: 'agent_file', extraction_status: 'ready', extraction_error: null, text_length: 100, token_estimate: 25, created_at: iso(), url: null, url_expires_at: null });
      return json({ id, ...upload, sha256: (23).toString(16).padStart(64, '0'), status: 'ready' });
    }

    if (p('/usage')) return seat === 'admin' ? json(usage) : fail(403, 'admin_required');
    // Data and privacy, in the shape `GET /w/:ws/settings/data-privacy`
    // answers. The warnings and the erasure copy are the server's strings,
    // copied verbatim rather than paraphrased: this fixture exists so that a
    // client which stopped rendering them fails here.
    if (p('/settings/data-privacy')) return json(seat === 'admin' ? dataPrivacy : {
      ...dataPrivacy,
      keys: dataPrivacy.keys.map((key) => ({ ...key, label: 'Configured provider', last4: '', status: 'configured', verified_at: null, attestation: null, attested: false })),
    });
    if (p('/settings/undelete')) return json({ cancelled: true });
    if (p('/settings')) {
      if (method === 'PATCH') {
        const caps = body as { daily_token_cap?: unknown; max_concurrent_runs?: unknown; notifications?: Record<string, unknown> };
        if ('daily_token_cap' in caps) settingsView.caps.daily_token_cap = caps.daily_token_cap === null ? null : Number(caps.daily_token_cap);
        if ('max_concurrent_runs' in caps) settingsView.caps.max_concurrent_runs = Number(caps.max_concurrent_runs);
        if (caps.notifications) settingsView.notifications = { ...settingsView.notifications, ...(caps.notifications as Record<string, boolean>) };
      }
      return json(settingsView);
    }
    if (path === `/w/${WS}` && method === 'DELETE') {
      return json({ workspace_id: WS, requested_by: USER, instance_id: `workspace-deletion:${WS}`, scheduled_at: iso(60 * 24 * 7), grace_period_days: 7, members_evicted: members.length, copy: ERASURE_COPY });
    }
    if (path.startsWith(`/w/${WS}/agents/`)) return new Response(null, { status: 204 });
    if (path.startsWith('/shared/')) {
      if (path.endsWith('revoked')) return json({ session: { id: SESSION_A, title: 'Partner applications', workspace_name: 'Nous' }, messages: [], message_cutoff_seq: 0, revoked: true });
      return json({ session: { id: SESSION_A, title: 'Partner applications', workspace_name: 'Nous' }, messages: messages[SESSION_A] ?? [], message_cutoff_seq: 2, revoked: false });
    }
    if (path.startsWith(`/w/${WS}/messages/`)) return new Response(null, { status: 204 });
    return fail(404, 'no_mock_route', `mock backend has no route for ${method} ${path}`);
  };

  const socketFactory = (url: string): SocketLike => {
    const socket: SocketLike = { send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null };
    const listener = (event: StreamEvent): void => {
      const forSession = url.includes('/hub/session/');
      const sessionScoped = event.session_id !== null;
      if (forSession !== sessionScoped) return;
      // The hub's own frame shape: a batch, even when it holds one event.
      socket.onmessage?.({ data: JSON.stringify({ type: 'events', events: [event] }) });
    };
    listeners.add(listener);
    socket.close = () => listeners.delete(listener);
    setTimeout(() => socket.onopen?.({}), 0);
    return socket;
  };

  return { fetchImpl, socketFactory, workspaceId: WS, publish, runScenario };
}
