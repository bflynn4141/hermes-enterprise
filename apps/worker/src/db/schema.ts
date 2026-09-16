// The Drizzle schema.
//
// It mirrors the hand-written SQL migrations; the SQL is the source of truth
// and this file is the typed view of it. That split is deliberate: the
// migrations carry row-level security, forced policies, partial unique indexes,
// triggers, grants and an expand/contract discipline, none of which survives a
// round trip through a schema generator. A test asserts that every table named
// here exists in the database with the columns declared here, so the two cannot
// drift silently.
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const now = (name: string) => ts(name).notNull().defaultNow();
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
});

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export const schemaMigrations = pgTable('schema_migrations', {
  filename: text('filename').primaryKey(),
  sha256: text('sha256').notNull(),
  appliedAt: now('applied_at'),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  workosUserId: text('workos_user_id').unique(),
  email: text('email').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
  deletedAt: ts('deleted_at'),
});

export const authSessions = pgTable('auth_sessions', {
  sid: text('sid').primaryKey(),
  userId: uuid('user_id').notNull(),
  authenticatedAt: ts('authenticated_at').notNull(),
  lastSeenAt: now('last_seen_at'),
  revokedAt: ts('revoked_at'),
  createdAt: now('created_at'),
});

export const workosEventsCursor = pgTable('workos_events_cursor', {
  id: smallint('id').primaryKey().default(1),
  afterId: text('after_id'),
  polledAt: ts('polled_at'),
  eventsSeen: bigint('events_seen', { mode: 'number' }).notNull().default(0),
});

export const rateCounters = pgTable(
  'rate_counters',
  {
    userId: uuid('user_id').notNull(),
    workspaceId: uuid('workspace_id'),
    action: text('action').notNull(),
    windowStart: ts('window_start').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.action, t.windowStart, t.workspaceId] })],
);

export const catalog = pgTable('catalog', {
  modelId: text('model_id').primaryKey(),
  provider: text('provider').notNull(),
  label: text('label').notNull(),
  transport: text('transport').notNull(),
  effortMap: jsonb('effort_map'),
  defaultEffort: text('default_effort'),
  pricingPerMillion: jsonb('pricing_per_million').notNull(),
  pricingVerifiedOn: date('pricing_verified_on').notNull(),
  disabledReason: text('disabled_reason'),
  // 0015. `seed` rows are the four a migration wrote; `provider_list` rows were
  // synced from a provider's own list endpoint (OpenRouter).
  source: text('source').notNull().default('seed'),
  contextLength: integer('context_length'),
  supportsTools: boolean('supports_tools').notNull().default(true),
  supportsReasoning: boolean('supports_reasoning').notNull().default(false),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

// ---------------------------------------------------------------------------
// Workspace and membership
// ---------------------------------------------------------------------------

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  workosOrganizationId: text('workos_organization_id').unique(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  jurisdiction: text('jurisdiction').notNull().default('default'),
  deletionScheduledAt: ts('deletion_scheduled_at'),
  // M5a. `DELETE /w/:ws` revokes access now and schedules the destruction for
  // seven days later, so the three columns separate "who asked, and when" from
  // "when it happens" from "which Workflow instance is holding the sleep".
  deletionRequestedAt: ts('deletion_requested_at'),
  deletionRequestedBy: uuid('deletion_requested_by'),
  deletionInstanceId: text('deletion_instance_id'),
  createdBy: uuid('created_by'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull(),
    reviewerRoles: text('reviewer_roles').array().notNull().default([]),
    workosMembershipId: text('workos_membership_id').unique(),
    status: text('status').notNull().default('active'),
    joinedAt: now('joined_at'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('members_workspace_user_key').on(t.workspaceId, t.userId), index('members_user_idx').on(t.userId)],
);

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  email: text('email').notNull(),
  role: text('role').notNull(),
  workosInvitationId: text('workos_invitation_id').unique(),
  tokenHash: text('token_hash'),
  expiresAt: ts('expires_at').notNull(),
  status: text('status').notNull().default('pending'),
  acceptedBy: uuid('accepted_by'),
  supersededBy: uuid('superseded_by'),
  invitedBy: uuid('invited_by'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const userNotificationSettings = pgTable(
  'user_notification_settings',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    approvals: boolean('approvals').notNull().default(true),
    blocked: boolean('blocked').notNull().default(true),
    digest: boolean('digest').notNull().default(false),
    previous: jsonb('previous'),
    updatedAt: now('updated_at'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const workspaceSettings = pgTable('workspace_settings', {
  workspaceId: uuid('workspace_id').primaryKey(),
  // 0016: OpenRouter is the only provider this product offers, and the row the
  // id names is a placeholder until the first catalog sync (decision R12).
  defaultModelId: text('default_model_id').notNull().default('openrouter:anthropic/claude-sonnet-5'),
  defaultEffort: text('default_effort').default('high'),
  defaultRuntime: text('default_runtime').notNull().default('cloud'),
  dailyTokenCap: bigint('daily_token_cap', { mode: 'number' }),
  maxConcurrentRuns: integer('max_concurrent_runs').notNull().default(3),
  flags: jsonb('flags').notNull().default({}),
  timezone: text('timezone').notNull().default('UTC'),
  updatedAt: now('updated_at'),
});

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  name: text('name').notNull(),
  responsibility: text('responsibility'),
  instructionsActive: text('instructions_active'),
  status: text('status').notNull().default('draft'),
  setupStep: text('setup_step'),
  startedAt: ts('started_at'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const agentOwners = pgTable('agent_owners', {
  workspaceId: uuid('workspace_id').notNull(),
  agentId: uuid('agent_id').primaryKey(),
  memberId: uuid('member_id').notNull(),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const agentCapabilities = pgTable('agent_capabilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  scope: text('scope'),
  toolNames: text('tool_names').array().notNull().default([]),
  position: integer('position').notNull().default(0),
  createdAt: now('created_at'),
});

export const agentFiles = pgTable('agent_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  agentId: uuid('agent_id'),
  name: text('name').notNull(),
  storageKey: text('storage_key'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  sha256: text('sha256'),
  mime: text('mime'),
  extractionStatus: text('extraction_status').notNull().default('pending'),
  extractionError: text('extraction_error'),
  // Added by 0009, so one extraction consumer can write to this table and to
  // `attachments` without knowing which it is holding.
  textLength: integer('text_length'),
  tokenEstimate: integer('token_estimate'),
  uploadedBy: uuid('uploaded_by'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const agentContextFields = pgTable(
  'agent_context_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    key: text('key').notNull(),
    value: text('value'),
    scope: text('scope').notNull().default('reply'),
    setBy: uuid('set_by'),
    runId: uuid('run_id'),
    toolCallId: text('tool_call_id'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('agent_context_fields_key').on(t.agentId, t.key)],
);

export const instructionVersions = pgTable('instruction_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('proposed'),
  proposedBy: uuid('proposed_by'),
  runId: uuid('run_id'),
  toolCallId: text('tool_call_id'),
  sources: jsonb('sources').notNull().default([]),
  createdAt: now('created_at'),
  savedAt: ts('saved_at'),
});

export const skillVersions = pgTable(
  'skill_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    skillKey: text('skill_key').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    body: text('body'),
    procedure: jsonb('procedure').notNull().default([]),
    sharedBy: uuid('shared_by'),
    createdAt: now('created_at'),
  },
  (t) => [unique('skill_versions_key').on(t.workspaceId, t.skillKey, t.version)],
);

export const agentSkills = pgTable(
  'agent_skills',
  {
    workspaceId: uuid('workspace_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    skillVersionId: uuid('skill_version_id').notNull(),
    adoptedBy: uuid('adopted_by'),
    adoptedAt: now('adopted_at'),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillVersionId] })],
);

// ---------------------------------------------------------------------------
// Sessions and messages
// ---------------------------------------------------------------------------

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  agentId: uuid('agent_id'),
  ownerId: uuid('owner_id').notNull(),
  title: text('title').notNull().default('New session'),
  subtitle: text('subtitle'),
  mode: text('mode').notNull().default('work'),
  modelId: text('model_id').notNull(),
  effort: text('effort'),
  runtime: text('runtime').notNull().default('cloud'),
  pinned: boolean('pinned').notNull().default(false),
  archived: boolean('archived').notNull().default(false),
  readOnly: boolean('read_only').notNull().default(false),
  carried: jsonb('carried'),
  focusRef: jsonb('focus_ref'),
  context: jsonb('context'),
  nextSeq: integer('next_seq').notNull().default(0),
  lastActivityAt: now('last_activity_at'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const sessionShares = pgTable('session_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  audience: text('audience').notNull(),
  messageCutoffSeq: integer('message_cutoff_seq').notNull(),
  revokedAt: ts('revoked_at'),
  createdAt: now('created_at'),
});

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    seq: integer('seq').notNull(),
    role: text('role').notNull(),
    kind: text('kind'),
    text: text('text').notNull().default(''),
    blocks: jsonb('blocks').notNull().default([]),
    snapshots: jsonb('snapshots'),
    workedMs: integer('worked_ms'),
    status: text('status').notNull().default('complete'),
    clientId: text('client_id'),
    runId: uuid('run_id'),
    turn: integer('turn'),
    createdAt: now('created_at'),
  },
  (t) => [unique('messages_seq_key').on(t.sessionId, t.seq), index('messages_session_idx').on(t.sessionId, t.seq)],
);

export const messageFeedback = pgTable(
  'message_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    messageId: uuid('message_id').notNull(),
    userId: uuid('user_id').notNull(),
    rating: text('rating').notNull(),
    note: text('note'),
    createdAt: now('created_at'),
  },
  (t) => [unique('message_feedback_key').on(t.messageId, t.userId)],
);

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    agentId: uuid('agent_id'),
    runtimeKind: text('runtime_kind').notNull().default('legacy'),
    runtimeProfile: text('runtime_profile'),
    runtimeRunId: text('runtime_run_id'),
    runtimeSessionId: text('runtime_session_id'),
    runtimeAttempt: integer('runtime_attempt'),
    runtimeRequest: jsonb('runtime_request'),
    runtimeRequestAttempt: integer('runtime_request_attempt'),
    runtimeStartedAt: ts('runtime_started_at'),
    runtimeWaitStartedAt: ts('runtime_wait_started_at'),
    runtimeWaitMs: bigint('runtime_wait_ms', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull().default('working'),
    waitingFor: text('waiting_for'),
    waitingLabel: text('waiting_label'),
    activeMs: integer('active_ms').notNull().default(0),
    interrupted: boolean('interrupted').notNull().default(false),
    instructionVersionId: uuid('instruction_version_id'),
    skillVersionIds: uuid('skill_version_ids').array().notNull().default([]),
    maxTurns: integer('max_turns').notNull().default(12),
    modelId: text('model_id').notNull(),
    effort: text('effort'),
    error: jsonb('error'),
    traceId: text('trace_id'),
    workflowInstanceId: text('workflow_instance_id'),
    attempt: integer('attempt').notNull().default(1),
    stopRequested: boolean('stop_requested').notNull().default(false),
    engineVersion: integer('engine_version').notNull().default(1),
    clientTurnId: text('client_turn_id').notNull(),
    /**
     * The session's mode, copied at creation (migration 0011). Read from here
     * and never from the session: flipping the selector mid-run must change the
     * next run, not this one.
     */
    mode: text('mode'),
    startedAt: now('started_at'),
    endedAt: ts('ended_at'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('runs_client_turn_key').on(t.sessionId, t.clientTurnId)],
);

export const runSteps = pgTable(
  'run_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    runId: uuid('run_id').notNull(),
    turn: integer('turn').notNull().default(0),
    stepId: text('step_id').notNull(),
    label: text('label').notNull(),
    state: text('state').notNull().default('todo'),
    toolCallId: text('tool_call_id'),
    stepAttempt: integer('step_attempt').notNull().default(1),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    createdAt: now('created_at'),
  },
  (t) => [unique('run_steps_key').on(t.runId, t.turn, t.stepId)],
);

export const runTurns = pgTable(
  'run_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    runId: uuid('run_id').notNull(),
    turn: integer('turn').notNull(),
    seq: integer('seq').notNull().default(0),
    role: text('role').notNull(),
    providerMessage: jsonb('provider_message').notNull(),
    subjectId: uuid('subject_id'),
    toolCallId: text('tool_call_id'),
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: now('created_at'),
  },
  (t) => [unique('run_turns_key').on(t.runId, t.turn, t.seq)],
);

export const runQueue = pgTable('run_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  runId: uuid('run_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  text: text('text').notNull(),
  status: text('status').notNull().default('queued'),
  position: integer('position').notNull().default(0),
  createdBy: uuid('created_by'),
  createdAt: now('created_at'),
});

export const modelCalls = pgTable('model_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  runId: uuid('run_id'),
  turn: integer('turn'),
  modelId: text('model_id').notNull(),
  provider: text('provider').notNull(),
  keyId: uuid('key_id'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
  reasoningTokens: integer('reasoning_tokens').notNull().default(0),
  costUsdEstimate: numeric('cost_usd_estimate', { precision: 12, scale: 6 }).notNull().default('0'),
  latencyMs: integer('latency_ms'),
  status: text('status').notNull().default('ok'),
  traceId: text('trace_id'),
  createdAt: now('created_at'),
});

// ---------------------------------------------------------------------------
// Requests, decisions, effects, documents
// ---------------------------------------------------------------------------

export const requests = pgTable('requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  kind: text('kind').notNull(),
  subjectKey: text('subject_key'),
  subjectId: uuid('subject_id'),
  label: text('label').notNull().default(''),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'),
  runId: uuid('run_id'),
  sessionId: uuid('session_id'),
  toolCallId: text('tool_call_id'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const decisions = pgTable('decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  requestId: uuid('request_id').notNull().unique(),
  decision: text('decision').notNull(),
  resultingStatus: text('resulting_status').notNull(),
  decidedBy: uuid('decided_by').notNull(),
  sid: text('sid'),
  note: text('note'),
  decidedAt: now('decided_at'),
});

export const effects = pgTable('effects', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  decisionId: uuid('decision_id').notNull(),
  requestId: uuid('request_id').notNull(),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('pending'),
  requiredRole: text('required_role').notNull(),
  approvalsRequired: integer('approvals_required').notNull().default(1),
  assigneeId: uuid('assignee_id'),
  executedBy: uuid('executed_by'),
  executedAt: ts('executed_at'),
  enforcementResult: jsonb('enforcement_result'),
  cancelledReason: text('cancelled_reason'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const requestNotes = pgTable('request_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  requestId: uuid('request_id').notNull(),
  body: text('body').notNull(),
  authorType: text('author_type').notNull().default('user'),
  authorId: uuid('author_id'),
  runId: uuid('run_id'),
  toolCallId: text('tool_call_id'),
  createdAt: now('created_at'),
});

export const approvalResources = pgTable('approval_resources', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  resourceKey: text('resource_key').notNull(),
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  ownerMemberId: uuid('owner_member_id').notNull(),
  version: text('version'),
  sha256: text('sha256'),
  executorAvailable: boolean('executor_available').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const approvalPolicies = pgTable('approval_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  key: text('key').notNull(),
  version: integer('version').notNull().default(1),
  approvalType: text('approval_type').notNull(),
  requesterAgentId: uuid('requester_agent_id'),
  targetResourceIds: text('target_resource_ids').array().notNull().default([]),
  maxBudgetMinor: bigint('max_budget_minor', { mode: 'number' }),
  priority: integer('priority').notNull().default(0),
  mode: text('mode').notNull(),
  preventSelfReview: boolean('prevent_self_review').notNull().default(true),
  requireDistinctReviewers: boolean('require_distinct_reviewers').notNull().default(true),
  maxDurationSeconds: integer('max_duration_seconds').notNull().default(604800),
  steps: jsonb('steps').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const approvalRequests = pgTable('approval_requests', {
  requestId: uuid('request_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  policyId: uuid('policy_id').notNull(),
  policyVersion: integer('policy_version').notNull(),
  authorizationRevision: integer('authorization_revision').notNull().default(1),
  authorizationHash: text('authorization_hash').notNull(),
  status: text('status').notNull().default('pending'),
  expiresAt: ts('expires_at').notNull(),
  requesterAgentId: uuid('requester_agent_id').notNull(),
  requesterMemberId: uuid('requester_member_id'),
  requesterUserId: uuid('requester_user_id'),
  sourceSessionId: uuid('source_session_id'),
  sourceRunId: uuid('source_run_id'),
  proposalIdempotencyKey: text('proposal_idempotency_key').notNull(),
  proposalIdempotencyHash: text('proposal_idempotency_hash').notNull(),
  effectKind: text('effect_kind').notNull(),
  effectStatus: text('effect_status').notNull().default('not_required'),
  effectReason: text('effect_reason'),
  workStatus: text('work_status').notNull().default('waiting'),
  workReason: text('work_reason'),
  continuationId: uuid('continuation_id'),
  finalizationJobId: uuid('finalization_job_id'),
  finalizedAt: ts('finalized_at'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const approvalRevisions = pgTable('approval_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  requestId: uuid('request_id').notNull(),
  revision: integer('revision').notNull(),
  authorizationHash: text('authorization_hash').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'),
  createdByType: text('created_by_type').notNull(),
  createdByUserId: uuid('created_by_user_id'),
  createdByAgentId: uuid('created_by_agent_id'),
  supersededAt: ts('superseded_at'),
  createdAt: now('created_at'),
});

export const approvalVotes = pgTable('approval_votes', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  requestId: uuid('request_id').notNull(),
  revision: integer('revision').notNull(),
  authorizationHash: text('authorization_hash').notNull(),
  stepId: text('step_id').notNull(),
  decision: text('decision').notNull(),
  reviewerMemberId: uuid('reviewer_member_id').notNull(),
  reviewerUserId: uuid('reviewer_user_id').notNull(),
  note: text('note'),
  idempotencyKey: text('idempotency_key').notNull(),
  recordedAt: now('recorded_at'),
});

export const approvalRoutes = pgTable('approval_routes', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  requestId: uuid('request_id').notNull(),
  revision: integer('revision').notNull(),
  stepId: text('step_id').notNull(),
  reviewerMemberId: uuid('reviewer_member_id').notNull(),
  routedByMemberId: uuid('routed_by_member_id').notNull(),
  reason: text('reason').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  createdAt: now('created_at'),
});

export const approvalCommands = pgTable('approval_commands', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  requestId: uuid('request_id').notNull(),
  operation: text('operation').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  commandHash: text('command_hash').notNull(),
  createdAt: now('created_at'),
});

/**
 * An uploaded file, and the account of the object behind it (0009).
 *
 * `status` is about the bytes and `extraction_status` is about the text, and
 * they are separate because a perfectly good PDF can still refuse to yield
 * text, and the reviewer has to be told which of the two happened.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    sessionId: uuid('session_id'),
    turnId: uuid('turn_id'),
    name: text('name').notNull(),
    /** `w/{workspace}/uploads/{id}`; the workspace is in the key for erasure. */
    storageKey: text('storage_key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mime: text('mime').notNull(),
    sha256: text('sha256'),
    status: text('status').notNull().default('uploading'),
    statusReason: text('status_reason'),
    extractionStatus: text('extraction_status').notNull().default('pending'),
    extractionError: text('extraction_error'),
    textLength: integer('text_length'),
    tokenEstimate: integer('token_estimate'),
    uploadedBy: uuid('uploaded_by'),
    createdAt: now('created_at'),
    completedAt: ts('completed_at'),
    deletedAt: ts('deleted_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('attachments_storage_key').on(t.storageKey)],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    requestId: uuid('request_id').notNull(),
    kind: text('kind').notNull(),
    version: integer('version').notNull().default(1),
    supersedesId: uuid('supersedes_id'),
    payload: jsonb('payload').notNull(),
    storageKey: text('storage_key'),
    renderStatus: text('render_status').notNull().default('pending'),
    renderError: text('render_error'),
    // Separate from `render_status` because in this build they disagree: the
    // HTML render is real and the PDF is not (docs/DECISIONS.md, D-7).
    pdfStatus: text('pdf_status').notNull().default('none'),
    pdfError: text('pdf_error'),
    createdBy: uuid('created_by'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('documents_version_key').on(t.requestId, t.version)],
);

// ---------------------------------------------------------------------------
// Outbox, audit, jobs, sync, keys
// ---------------------------------------------------------------------------

export const streamEvents = pgTable(
  'stream_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    sessionId: uuid('session_id'),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    traceId: text('trace_id'),
    createdAt: now('created_at'),
  },
  (t) => [index('stream_events_workspace_idx').on(t.workspaceId, t.id)],
);

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  actorType: text('actor_type').notNull(),
  actorUserId: uuid('actor_user_id'),
  kind: text('kind').notNull(),
  requestId: uuid('request_id'),
  runId: uuid('run_id'),
  sessionId: uuid('session_id'),
  decisionId: uuid('decision_id'),
  effectId: uuid('effect_id'),
  documentId: uuid('document_id'),
  memberId: uuid('member_id'),
  invitationId: uuid('invitation_id'),
  subjectId: uuid('subject_id'),
  keyId: uuid('key_id'),
  createdAt: now('created_at'),
});

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    payload: jsonb('payload').notNull().default({}),
    attempts: integer('attempts').notNull().default(0),
    nextAt: now('next_at'),
    lockedUntil: ts('locked_until'),
    doneAt: ts('done_at'),
    lastError: text('last_error'),
    createdAt: now('created_at'),
  },
  (t) => [unique('jobs_key').on(t.kind, t.key)],
);

export const workosSync = pgTable('workos_sync', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: uuid('resource_id'),
  workosId: text('workos_id'),
  direction: text('direction').notNull(),
  status: text('status').notNull().default('pending'),
  payload: jsonb('payload').notNull().default({}),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const workspaceProviderKeys = pgTable('workspace_provider_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  provider: text('provider').notNull(),
  label: text('label').notNull().default(''),
  ciphertext: bytea('ciphertext').notNull(),
  iv: bytea('iv').notNull(),
  wrappedDek: bytea('wrapped_dek').notNull(),
  wrapIv: bytea('wrap_iv').notNull(),
  kekVersion: integer('kek_version').notNull(),
  fingerprint: text('fingerprint').notNull(),
  last4: text('last4').notNull(),
  status: text('status').notNull().default('unverified'),
  verifiedModels: text('verified_models').array().notNull().default([]),
  attestation: jsonb('attestation'),
  addedBy: uuid('added_by'),
  verifiedAt: ts('verified_at'),
  rotatedAt: ts('rotated_at'),
  revokedAt: ts('revoked_at'),
  replacesKeyId: uuid('replaces_key_id'),
  // 0015. OpenRouter verifies against hundreds of ids; the row carries how many
  // were synced and when, not the list.
  syncedModelCount: integer('synced_model_count'),
  modelsSyncedAt: ts('models_synced_at'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

// ---------------------------------------------------------------------------
// M2: drafts, and the two platform tables the Cron and the auth callback need
// ---------------------------------------------------------------------------

export const sessionDrafts = pgTable('session_drafts', {
  workspaceId: uuid('workspace_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  userId: uuid('user_id').notNull(),
  text: text('text').notNull().default(''),
  updatedAt: now('updated_at'),
}, (t) => [primaryKey({ columns: [t.sessionId, t.userId] })]);

/** Ids only: which workspace is this WorkOS organization? See 0008. */
export const workspaceDirectory = pgTable('workspace_directory', {
  workspaceId: uuid('workspace_id').primaryKey(),
  workosOrganizationId: text('workos_organization_id'),
  createdAt: now('created_at'),
});

/**
 * Counts only: the platform-wide instance cap's hourly bucket, and any future
 * platform counter. Outside row-level security, like the other platform tables
 * and for the same reason (0012).
 */
export const platformCounters = pgTable(
  'platform_counters',
  {
    bucket: text('bucket').notNull(),
    windowStart: ts('window_start').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] })],
);

/** One row per nightly validation. Counts and ids only; see 0012. */
export const validatorRuns = pgTable('validator_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  startedAt: now('started_at'),
  finishedAt: ts('finished_at'),
  workspaces: integer('workspaces').notNull().default(0),
  runsChecked: integer('runs_checked').notNull().default(0),
  violations: integer('violations').notNull().default(0),
  decisionsChecked: integer('decisions_checked').notNull().default(0),
  forgedDecisions: integer('forged_decisions').notNull().default(0),
  ok: boolean('ok').notNull().default(true),
  detail: jsonb('detail').notNull().default({}),
});

/**
 * Ids, a role and a display name: which workspaces is this person in? Asked by
 * `GET /auth/session` before any tenant key exists, and maintained by a trigger
 * on `members` so no route can forget it. Outside row-level security, like the
 * other platform tables (0013).
 */
export const memberDirectory = pgTable(
  'member_directory',
  {
    userId: uuid('user_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    role: text('role').notNull(),
    workspaceName: text('workspace_name').notNull().default(''),
    joinedAt: now('joined_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })],
);

/**
 * Which workspace is this invitation token for? Asked by
 * `POST /invitations/:token/accept`, which cannot know its tenant until it has
 * the answer. One row per token an invitation is reachable by; maintained by a
 * trigger on `invitations`, and a row disappears the moment the invitation
 * stops being `pending` (0013).
 */
export const invitationDirectory = pgTable('invitation_directory', {
  token: text('token').primaryKey(),
  invitationId: uuid('invitation_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  createdAt: now('created_at'),
});

/**
 * Which workspace is this share token for?
 *
 * The share half of `invitation_directory`, and for the same reason:
 * `GET /shared/:token` cannot know its tenant until it has the answer, and
 * `session_shares` is FORCEd. One row per live share; the trigger on
 * `session_shares` removes it the moment the share is revoked (0014).
 */
export const shareDirectory = pgTable('share_directory', {
  tokenHash: text('token_hash').primaryKey(),
  shareId: uuid('share_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  createdAt: now('created_at'),
});

/** Ids only: which workspaces have a job due? See 0008. */
export const jobReady = pgTable('job_ready', {
  jobId: uuid('job_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  nextAt: now('next_at'),
});

/**
 * Every table in the schema, for the drift test. A table added to the SQL and
 * forgotten here (or the other way round) fails that test.
 */
export const ALL_TABLES = {
  schema_migrations: schemaMigrations,
  users,
  auth_sessions: authSessions,
  workos_events_cursor: workosEventsCursor,
  rate_counters: rateCounters,
  catalog,
  workspaces,
  members,
  invitations,
  user_notification_settings: userNotificationSettings,
  workspace_settings: workspaceSettings,
  agents,
  agent_owners: agentOwners,
  agent_capabilities: agentCapabilities,
  agent_files: agentFiles,
  agent_context_fields: agentContextFields,
  instruction_versions: instructionVersions,
  skill_versions: skillVersions,
  agent_skills: agentSkills,
  sessions,
  session_shares: sessionShares,
  messages,
  message_feedback: messageFeedback,
  runs,
  run_steps: runSteps,
  run_turns: runTurns,
  run_queue: runQueue,
  model_calls: modelCalls,
  requests,
  decisions,
  effects,
  request_notes: requestNotes,
  approval_resources: approvalResources,
  approval_policies: approvalPolicies,
  approval_requests: approvalRequests,
  approval_revisions: approvalRevisions,
  approval_votes: approvalVotes,
  approval_routes: approvalRoutes,
  approval_commands: approvalCommands,
  attachments,
  documents,
  stream_events: streamEvents,
  events,
  jobs,
  workos_sync: workosSync,
  workspace_provider_keys: workspaceProviderKeys,
  session_drafts: sessionDrafts,
  workspace_directory: workspaceDirectory,
  member_directory: memberDirectory,
  invitation_directory: invitationDirectory,
  share_directory: shareDirectory,
  job_ready: jobReady,
  platform_counters: platformCounters,
  validator_runs: validatorRuns,
} as const;
