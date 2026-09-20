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
  deliveryStatus: text('delivery_status').notNull().default('not_required'),
  deliveryError: text('delivery_error'),
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
  // 0024: Nous Portal is the product provider, and this row is a placeholder
  // until the first workspace catalog sync.
  defaultModelId: text('default_model_id').notNull().default('nous:anthropic/claude-sonnet-5'),
  defaultEffort: text('default_effort').default('medium'),
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
  contextScope: text('context_scope').notNull().default('private'),
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

export const agentProvisioning = pgTable('agent_provisioning', {
  workspaceId: uuid('workspace_id').notNull(),
  agentId: uuid('agent_id').primaryKey(),
  status: text('status').notNull().default('awaiting_onboarding'),
  cloudAgentId: text('cloud_agent_id'),
  instanceName: text('instance_name').notNull(),
  dashboardUrl: text('dashboard_url'),
  region: text('region').notNull().default('sjc'),
  model: text('model').notNull().default('z-ai/glm-5.2'),
  size: text('size').notNull().default('medium'),
  attempts: integer('attempts').notNull().default(0),
  errorCode: text('error_code'),
  errorDetail: text('error_detail'),
  requestedAt: ts('requested_at'),
  cloudCreatedAt: ts('cloud_created_at'),
  readyAt: ts('ready_at'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const agentRuntimeBindings = pgTable('agent_runtime_bindings', {
  workspaceId: uuid('workspace_id').notNull(),
  agentId: uuid('agent_id').primaryKey(),
  profile: text('profile').notNull(),
  baseUrl: text('base_url'),
  transport: text('transport').notNull().default('dashboard_connector'),
  assignment: text('assignment').notNull().default('provisioned'),
  agentcash: boolean('agentcash').notNull().default(false),
  ciphertext: bytea('ciphertext').notNull(),
  iv: bytea('iv').notNull(),
  wrappedDek: bytea('wrapped_dek').notNull(),
  wrapIv: bytea('wrap_iv').notNull(),
  kekVersion: integer('kek_version').notNull(),
  runtimeCredentialDigest: bytea('runtime_credential_digest'),
  runtimeAuthMode: text('runtime_auth_mode').notNull().default('legacy_hmac'),
  readyAt: ts('ready_at'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const hermesCloudCapacity = pgTable('hermes_cloud_capacity', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  cloudAgentId: text('cloud_agent_id').notNull(),
  instanceName: text('instance_name').notNull(),
  preflightAgentId: uuid('preflight_agent_id').notNull(),
  discoveryGrantId: uuid('discovery_grant_id'),
  dashboardUrl: text('dashboard_url'),
  connectorUrl: text('connector_url').notNull(),
  state: text('state').notNull().default('available'),
  reservedInvitationId: uuid('reserved_invitation_id'),
  assignedAgentId: uuid('assigned_agent_id'),
  ciphertext: bytea('ciphertext').notNull(),
  iv: bytea('iv').notNull(),
  wrappedDek: bytea('wrapped_dek').notNull(),
  wrapIv: bytea('wrap_iv').notNull(),
  kekVersion: integer('kek_version').notNull(),
  pluginVersion: text('plugin_version').notNull(),
  agentcashEnabled: boolean('agentcash_enabled').notNull().default(false),
  agentcashWalletPresent: boolean('agentcash_wallet_present').notNull().default(false),
  nativeCronDisabled: boolean('native_cron_disabled').notNull().default(false),
  readinessCheckedAt: ts('readiness_checked_at').notNull(),
  lastHealthCheckedAt: ts('last_health_checked_at').notNull(),
  assignedAt: ts('assigned_at'),
  quarantinedAt: ts('quarantined_at'),
  quarantineReason: text('quarantine_reason'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const runtimeDiscoveryGrants = pgTable('runtime_discovery_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  createdBy: uuid('created_by'),
  credentialDigest: bytea('credential_digest').notNull(),
  roleTemplateKey: text('role_template_key').notNull(),
  skillKey: text('skill_key').notNull(),
  skillVersion: text('skill_version').notNull(),
  runtimeName: text('runtime_name').notNull(),
  artifactDigest: text('artifact_digest').notNull(),
  assignmentId: uuid('assignment_id'),
  assignmentRevision: integer('assignment_revision'),
  configDigest: text('config_digest').notNull(),
  grantRevision: integer('grant_revision').notNull().default(1),
  linkedCapacityId: uuid('linked_capacity_id'),
  expiresAt: ts('expires_at'),
  revokedAt: ts('revoked_at'),
  consumedAt: ts('consumed_at'),
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

export const agentOperationPolicies = pgTable('agent_operation_policies', {
  agentId: uuid('agent_id').primaryKey(), workspaceId: uuid('workspace_id').notNull(),
  revision: integer('revision').notNull().default(0), operations: jsonb('operations').notNull().default({}), updatedAt: now('updated_at'),
});
export const agentOperationApprovals = pgTable('agent_operation_approvals', {
  id: uuid('id').primaryKey().defaultRandom(), workspaceId: uuid('workspace_id').notNull(), agentId: uuid('agent_id').notNull(),
  runId: uuid('run_id').notNull(), toolCallId: text('tool_call_id').notNull(), operationId: text('operation_id').notNull(),
  toolName: text('tool_name').notNull(), arguments: jsonb('arguments').notNull(), policyRevision: integer('policy_revision').notNull(),
  status: text('status').notNull().default('pending'), decidedBy: uuid('decided_by'), decidedAt: ts('decided_at'), createdAt: now('created_at'),
});
export const agentOperationPolicyRevisions = pgTable('agent_operation_policy_revisions', {
  workspaceId: uuid('workspace_id').notNull(), agentId: uuid('agent_id').notNull(), revision: integer('revision').notNull(),
  operationId: text('operation_id').notNull(), requireHumanApproval: boolean('require_human_approval').notNull(),
  changedBy: uuid('changed_by').notNull(), createdAt: now('created_at'),
}, table => [primaryKey({columns:[table.agentId,table.revision]})]);
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

export const agentContextNotes = pgTable('agent_context_notes', {
  id: uuid('id').primaryKey().defaultRandom(), workspaceId: uuid('workspace_id').notNull(), agentId: uuid('agent_id').notNull(),
  title: text('title').notNull(), text: text('text').notNull(), revision: integer('revision').notNull().default(1),
  authorId: uuid('author_id'), createdAt: now('created_at'), updatedAt: now('updated_at'),
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

export const enterpriseSkillAssignments = pgTable(
  'enterprise_skill_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    teamId: uuid('team_id'),
    artifactId: uuid('artifact_id'),
    skillKey: text('skill_key').notNull(),
    skillVersion: text('skill_version').notNull(),
    state: text('state').notNull().default('active'),
    config: jsonb('config').notNull().default({}),
    capabilityGrants: text('capability_grants').array().notNull().default([]),
    schedule: jsonb('schedule').notNull().default({ enabled: true, interval_minutes: 360 }),
    approvalPolicy: jsonb('approval_policy').notNull().default({ human_review_required: true }),
    revision: integer('revision').notNull().default(1),
    assignedBy: uuid('assigned_by'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('enterprise_skill_assignments_agent_key').on(t.workspaceId, t.agentId, t.skillKey)],
);

export const enterpriseSkillAssignmentRevisions = pgTable(
  'enterprise_skill_assignment_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assignmentId: uuid('assignment_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id'),
    artifactId: uuid('artifact_id'),
    revision: integer('revision').notNull(),
    skillVersion: text('skill_version').notNull(),
    state: text('state').notNull(),
    config: jsonb('config').notNull(),
    capabilityGrants: text('capability_grants').array().notNull().default([]),
    schedule: jsonb('schedule').notNull(),
    approvalPolicy: jsonb('approval_policy').notNull(),
    changedBy: uuid('changed_by'),
    createdAt: now('created_at'),
  },
  (t) => [unique('enterprise_skill_assignment_revisions_key').on(t.assignmentId, t.revision)],
);

export const enterpriseTeams = pgTable(
  'enterprise_teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [unique('enterprise_teams_workspace_slug_key').on(t.workspaceId, t.slug)],
);

export const enterpriseTeamAgents = pgTable(
  'enterprise_team_agents',
  {
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    principalUserId: uuid('principal_user_id').notNull(),
    roleTemplateKey: text('role_template_key').notNull(),
    roleTemplateVersion: text('role_template_version').notNull().default('1.0.0'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.teamId, t.agentId] }),
    unique('enterprise_team_agents_one_team_key').on(t.workspaceId, t.teamId),
    unique('enterprise_team_agents_one_agent_key').on(t.workspaceId, t.agentId),
    unique('enterprise_team_agents_one_principal_key').on(t.workspaceId, t.principalUserId),
  ],
);

export const enterpriseSkillArtifacts = pgTable(
  'enterprise_skill_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skillKey: text('skill_key').notNull(),
    skillVersion: text('skill_version').notNull(),
    digest: text('digest').notNull(),
    manifest: jsonb('manifest').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [unique('enterprise_skill_artifacts_version_key').on(t.skillKey, t.skillVersion)],
);

export const enterpriseConnectionBindings = pgTable(
  'enterprise_connection_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id').notNull(),
    connectorKey: text('connector_key').notNull(),
    state: text('state').notNull().default('active'),
    capabilityGrants: text('capability_grants').array().notNull().default([]),
    capabilityDenies: text('capability_denies').array().notNull().default([]),
    resourceScope: jsonb('resource_scope').notNull(),
    createdBy: uuid('created_by'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('enterprise_connection_bindings_key').on(t.workspaceId, t.teamId, t.connectorKey)],
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
    recoveryNextAt: ts('recovery_next_at'),
    recoveryNotBefore: ts('recovery_not_before'),
    recoveryCancelled: boolean('recovery_cancelled').notNull().default(false),
    recoveryBlockedReason: text('recovery_blocked_reason'),
    recoveryInput: text('recovery_input'),
    recoveryHistory: jsonb('recovery_history').notNull().default([]),
    runtimeKind: text('runtime_kind').notNull().default('legacy'),
    runtimeProfile: text('runtime_profile'),
    runtimeRunId: text('runtime_run_id'),
    runtimeSessionId: text('runtime_session_id'),
    runtimeAttempt: integer('runtime_attempt'),
    runtimeRequest: jsonb('runtime_request'),
    contextSnapshot: jsonb('context_snapshot'),
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
    instructionSnapshot: text('instruction_snapshot'),
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

export const runSweepObservations = pgTable('run_sweep_observations', {
  runId: uuid('run_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  attempt: integer('attempt').notNull(),
  workflowInstanceId: text('workflow_instance_id'),
  runStatus: text('run_status').notNull(),
  progressAt: ts('progress_at').notNull(),
  firstMissingAt: now('first_missing_at'),
});

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
// Approval continuations and their model-call reservations (0023)
// ---------------------------------------------------------------------------

export const approvalContinuations = pgTable(
  'approval_continuations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    requestId: uuid('request_id').notNull(),
    authorizationRevision: integer('authorization_revision').notNull(),
    authorizationHash: text('authorization_hash').notNull(),
    agentId: uuid('agent_id').notNull(),
    runtimeProfile: text('runtime_profile').notNull(),
    sessionId: uuid('session_id').notNull(),
    sourceRunId: uuid('source_run_id'),
    sourceToolCallId: text('source_tool_call_id'),
    continuationPayload: jsonb('continuation_payload').notNull(),
    dependencyRequestIds: uuid('dependency_request_ids').array().notNull().default([]),
    state: text('state').notNull().default('pending_authorization'),
    expiresAt: ts('expires_at').notNull(),
    admittedRunId: uuid('admitted_run_id'),
    blockedReason: text('blocked_reason'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
    admittedAt: ts('admitted_at'),
  },
  (t) => [unique('approval_continuations_revision').on(t.requestId, t.authorizationRevision)],
);

export const approvalRuntimeBudgets = pgTable(
  'approval_runtime_budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    continuationId: uuid('continuation_id').notNull().unique(),
    requestId: uuid('request_id').notNull(),
    authorizationRevision: integer('authorization_revision').notNull(),
    authorizationHash: text('authorization_hash').notNull(),
    modelId: text('model_id').notNull(),
    currency: text('currency').notNull().default('USD'),
    costCapUsd: numeric('cost_cap_usd', { precision: 14, scale: 8 }).notNull(),
    totalTokenCap: bigint('total_token_cap', { mode: 'number' }).notNull(),
    callCap: integer('call_cap').notNull(),
    maxOutputTokensPerCall: integer('max_output_tokens_per_call').notNull(),
    maxParallelCalls: integer('max_parallel_calls').notNull().default(1),
    retryCap: integer('retry_cap').notNull().default(0),
    reservedCostUsd: numeric('reserved_cost_usd', { precision: 14, scale: 8 }).notNull().default('0'),
    actualCostUsd: numeric('actual_cost_usd', { precision: 14, scale: 8 }).notNull().default('0'),
    reservedTokens: bigint('reserved_tokens', { mode: 'number' }).notNull().default(0),
    actualTokens: bigint('actual_tokens', { mode: 'number' }).notNull().default(0),
    callsReserved: integer('calls_reserved').notNull().default(0),
    callsReconciled: integer('calls_reconciled').notNull().default(0),
    state: text('state').notNull().default('active'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('approval_runtime_budgets_revision').on(t.requestId, t.authorizationRevision)],
);

export const approvalModelReservations = pgTable('approval_model_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  budgetId: uuid('budget_id').notNull(),
  runId: uuid('run_id').notNull(),
  modelId: text('model_id').notNull(),
  inputTokenBound: bigint('input_token_bound', { mode: 'number' }).notNull(),
  outputTokenBound: integer('output_token_bound').notNull(),
  reservedCostUsd: numeric('reserved_cost_usd', { precision: 14, scale: 8 }).notNull(),
  actualInputTokens: bigint('actual_input_tokens', { mode: 'number' }),
  actualOutputTokens: bigint('actual_output_tokens', { mode: 'number' }),
  actualCachedInputTokens: bigint('actual_cached_input_tokens', { mode: 'number' }),
  actualCostUsd: numeric('actual_cost_usd', { precision: 14, scale: 8 }),
  status: text('status').notNull().default('reserved'),
  createdAt: now('created_at'),
  reconciledAt: ts('reconciled_at'),
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

export const requestTriageAssessments = pgTable(
  'request_triage_assessments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    requestId: uuid('request_id').notNull(),
    requestVersion: integer('request_version').notNull(),
    stateHash: text('state_hash').notNull(),
    rubricVersion: text('rubric_version').notNull(),
    summaryVersion: text('summary_version').notNull(),
    provider: text('provider').notNull().default('typesafe_api'),
    modelId: text('model_id').notNull().default('jev-latest'),
    modelVersion: text('model_version'),
    status: text('status').notNull().default('pending'),
    priorityScore: numeric('priority_score', { precision: 5, scale: 2 }),
    priorityBand: text('priority_band'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    signals: jsonb('signals').notNull().default({}),
    reasonCodes: jsonb('reason_codes').notNull().default([]),
    failureClass: text('failure_class'),
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: now('created_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [unique('request_triage_assessments_revision_key').on(t.requestId, t.stateHash, t.rubricVersion, t.modelId)],
);

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

/** Explicitly simulated first-run walkthrough; separate from real model runs. */
export const onboardingSampleRuns = pgTable(
  'onboarding_sample_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    createdBy: uuid('created_by').notNull(),
    sessionId: uuid('session_id'),
    setupAttemptId: uuid('setup_attempt_id').notNull(),
    status: text('status').notNull().default('running'),
    simulated: boolean('simulated').notNull().default(true),
    startedAt: now('started_at'),
    completedAt: ts('completed_at'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('onboarding_sample_runs_creator_agent_key').on(t.workspaceId, t.createdBy, t.agentId)],
);

export const onboardingSampleApplications = pgTable(
  'onboarding_sample_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    runId: uuid('run_id').notNull(),
    sampleKey: text('sample_key').notNull(),
    displayName: text('display_name').notNull(),
    state: text('state').notNull().default('received'),
    payload: jsonb('payload').notNull(),
    requestId: uuid('request_id').unique(),
    receivedAt: ts('received_at').notNull(),
    researchingAt: ts('researching_at'),
    screenedAt: ts('screened_at'),
    needsReviewAt: ts('needs_review_at'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('onboarding_sample_applications_key').on(t.runId, t.sampleKey)],
);

export const onboardingSampleEvents = pgTable(
  'onboarding_sample_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    runId: uuid('run_id').notNull(),
    applicationId: uuid('application_id'),
    eventKey: text('event_key').notNull(),
    kind: text('kind').notNull(),
    state: text('state'),
    requestId: uuid('request_id'),
    detail: text('detail').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [unique('onboarding_sample_events_key').on(t.runId, t.eventKey)],
);

export const partnerScreeningRuns = pgTable(
  'partner_screening_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    createdBy: uuid('created_by').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('running'),
    source: text('source').notNull(),
    authentication: text('authentication').notNull(),
    configSnapshot: jsonb('config_snapshot').notNull(),
    apiRequestsMax: integer('api_requests_max').notNull(),
    apiRequestsUsed: integer('api_requests_used').notNull().default(0),
    agentCashToolCallId: text('agentcash_tool_call_id'),
    rateLimits: jsonb('rate_limits').notNull().default([]),
    candidatesDiscovered: integer('candidates_discovered').notNull().default(0),
    monetaryCostUsd: numeric('monetary_cost_usd', { precision: 7, scale: 3 }).notNull().default('0'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    startedAt: now('started_at'),
    completedAt: ts('completed_at'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('partner_screening_runs_idempotency').on(t.workspaceId, t.agentId, t.idempotencyKey)],
);

export const partnerSourceArtifacts = pgTable(
  'partner_source_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    runId: uuid('run_id').notNull(),
    source: text('source').notNull(),
    artifactKey: text('artifact_key').notNull(),
    kind: text('kind').notNull(),
    sourceUrl: text('source_url').notNull(),
    sourceUpdatedAt: ts('source_updated_at'),
    fetchedAt: ts('fetched_at').notNull(),
    sha256: text('sha256').notNull(),
    content: jsonb('content').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [unique('partner_source_artifacts_run_key').on(t.runId, t.artifactKey)],
);

export const partnerCandidates = pgTable(
  'partner_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    source: text('source').notNull(),
    sourceKey: text('source_key').notNull(),
    displayName: text('display_name').notNull(),
    profileUrl: text('profile_url').notNull(),
    deterministicPriority: integer('deterministic_priority').notNull(),
    priorityBreakdown: jsonb('priority_breakdown').notNull(),
    confidence: text('confidence').notNull(),
    evidenceGaps: text('evidence_gaps').array().notNull().default([]),
    sourceUpdatedAt: ts('source_updated_at'),
    latestRunId: uuid('latest_run_id').notNull(),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('partner_candidates_source_key').on(t.workspaceId, t.agentId, t.source, t.sourceKey)],
);

export const partnerScreeningRunCandidates = pgTable(
  'partner_screening_run_candidates',
  {
    workspaceId: uuid('workspace_id').notNull(),
    runId: uuid('run_id').notNull(),
    candidateId: uuid('candidate_id').notNull(),
    deterministicPriority: integer('deterministic_priority').notNull(),
    priorityBreakdown: jsonb('priority_breakdown').notNull(),
    confidence: text('confidence').notNull(),
    evidenceGaps: text('evidence_gaps').array().notNull().default([]),
    artifactIds: uuid('artifact_ids').array().notNull().default([]),
    createdAt: now('created_at'),
  },
);

export const partnerContactEnrichments = pgTable(
  'partner_contact_enrichments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    candidateId: uuid('candidate_id').notNull(),
    runId: uuid('run_id').notNull(),
    runtimeRunId: text('runtime_run_id').notNull(),
    status: text('status').notNull().default('enrichment_reserved'),
    pendingKind: text('pending_kind'),
    pendingToolCallId: text('pending_tool_call_id'),
    enrichmentToolCallId: text('enrichment_tool_call_id'),
    verificationToolCallId: text('verification_tool_call_id'),
    verificationPollCount: integer('verification_poll_count').notNull().default(0),
    contactData: jsonb('contact_data').notNull().default({ professional_emails: [], phones: [], social_profiles: [] }),
    preferredEmail: text('preferred_email'),
    verificationStatus: text('verification_status'),
    verificationScore: numeric('verification_score', { precision: 5, scale: 2 }),
    verificationChecks: jsonb('verification_checks').notNull().default({}),
    draftEligible: boolean('draft_eligible').notNull().default(false),
    verificationJobId: text('verification_job_id'),
    verificationPollUrl: text('verification_poll_url'),
    verificationRetryAfterSeconds: integer('verification_retry_after_seconds'),
    monetaryCostUsd: numeric('monetary_cost_usd', { precision: 6, scale: 2 }).notNull().default('0'),
    fetchedAt: ts('fetched_at'),
    verifiedAt: ts('verified_at'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('partner_contact_enrichments_run_key').on(t.workspaceId, t.runId)],
);

export const partnerEngagements = pgTable('partner_engagements', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  candidateId: uuid('candidate_id').notNull(),
  requestId: uuid('request_id').notNull(),
  stage: text('stage').notNull(),
  lastOutreachAt: ts('last_outreach_at'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const partnerRecords = pgTable(
  'partner_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id').notNull(),
    ownerAgentId: uuid('owner_agent_id').notNull(),
    kind: text('kind').notNull(),
    partnerId: uuid('partner_id').notNull(),
    revision: integer('revision').notNull().default(1),
    data: jsonb('data').notNull(),
    evidenceIds: text('evidence_ids').array().notNull().default([]),
    sourceSessionId: uuid('source_session_id').notNull(),
    sourceRunId: uuid('source_run_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('partner_records_idempotency_key').on(t.workspaceId, t.teamId, t.ownerAgentId, t.kind, t.idempotencyKey)],
);

export const partnerHandoffs = pgTable(
  'partner_handoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    fromTeamId: uuid('from_team_id').notNull(),
    toTeamId: uuid('to_team_id').notNull(),
    sourceRecordId: uuid('source_record_id').notNull(),
    sourceRecordRevision: integer('source_record_revision').notNull(),
    invoiceRecordId: uuid('invoice_record_id').notNull(),
    invoiceRecordRevision: integer('invoice_record_revision').notNull(),
    projection: jsonb('projection').notNull(),
    sourceSessionId: uuid('source_session_id').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    status: text('status').notNull().default('queued'),
    resultReason: text('result_reason'),
    simulated: boolean('simulated').notNull().default(false),
    idempotencyKey: text('idempotency_key').notNull(),
    revision: integer('revision').notNull().default(1),
    lineageRootId: uuid('lineage_root_id'),
    supersedesHandoffId: uuid('supersedes_handoff_id'),
    supersededByHandoffId: uuid('superseded_by_handoff_id'),
    payloadHash: text('payload_hash'),
    inputProvenance: text('input_provenance'),
    deliveryStatus: text('delivery_status').notNull().default('queued'),
    validationStatus: text('validation_status').notNull().default('queued'),
    agentExplanationStatus: text('agent_explanation_status').notNull().default('queued'),
    humanDecisionStatus: text('human_decision_status').notNull().default('not_ready'),
    acknowledgmentStatus: text('acknowledgment_status').notNull().default('pending'),
    checks: jsonb('checks').notNull().default([]),
    completedAt: ts('completed_at'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('partner_handoffs_idempotency_key').on(t.workspaceId, t.fromTeamId, t.idempotencyKey)],
);

export const enterpriseRunGrants = pgTable('enterprise_run_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  runId: uuid('run_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  teamId: uuid('team_id').notNull(),
  assignmentId: uuid('assignment_id').notNull(),
  assignmentRevision: integer('assignment_revision').notNull(),
  artifactId: uuid('artifact_id').notNull(),
  artifactDigest: text('artifact_digest').notNull(),
  connectionBindingId: uuid('connection_binding_id').notNull(),
  capability: text('capability').notNull(),
  resourceKind: text('resource_kind').notNull(),
  resourceId: uuid('resource_id'),
  allowedFields: text('allowed_fields').array().notNull().default([]),
  allowedActions: text('allowed_actions').array().notNull().default([]),
  effect: text('effect').notNull(),
  createdAt: now('created_at'),
  revokedAt: ts('revoked_at'),
});

export const partnerWorkflowExecutions = pgTable('partner_workflow_executions', {
  handoffId: uuid('handoff_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  financeAgentId: uuid('finance_agent_id').notNull(),
  financeSessionId: uuid('finance_session_id'),
  financeRunId: uuid('finance_run_id'),
  requestId: uuid('request_id'),
  resultRecordId: uuid('result_record_id'),
  status: text('status').notNull().default('queued'),
  resultReason: text('result_reason'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const partnerAgentMessages = pgTable(
  'partner_agent_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    handoffId: uuid('handoff_id').notNull(),
    direction: text('direction').notNull(),
    protocol: text('protocol').notNull(),
    senderAgentId: uuid('sender_agent_id').notNull(),
    recipientAgentId: uuid('recipient_agent_id').notNull(),
    senderProfile: text('sender_profile').notNull(),
    recipientProfile: text('recipient_profile').notNull(),
    senderDisplay: text('sender_display').notNull(),
    recipientDisplay: text('recipient_display').notNull(),
    body: text('body').notNull(),
    wireText: text('wire_text').notNull(),
    status: text('status').notNull().default('queued'),
    recipientSessionId: uuid('recipient_session_id'),
    recipientRunId: uuid('recipient_run_id'),
    createdAt: now('created_at'),
    deliveredAt: ts('delivered_at'),
  },
  (t) => [unique('partner_agent_messages_delivery_key').on(t.workspaceId, t.handoffId, t.direction)],
);

export const requestAudiences = pgTable(
  'request_audiences',
  {
    workspaceId: uuid('workspace_id').notNull(),
    requestId: uuid('request_id').notNull(),
    userId: uuid('user_id').notNull(),
    purpose: text('purpose').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.userId] })],
);

export const partnerWorkflowSettings = pgTable('partner_workflow_settings', {
  workspaceId: uuid('workspace_id').primaryKey(),
  admissionState: text('admission_state').notNull().default('disabled'),
  enabledBy: uuid('enabled_by'),
  enabledAt: ts('enabled_at'),
  readiness: jsonb('readiness').notNull().default({}),
  readinessCheckedAt: ts('readiness_checked_at'),
  updatedAt: now('updated_at'),
});

export const partnerRecordRevisions = pgTable(
  'partner_record_revisions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    recordId: uuid('record_id').notNull(),
    revision: integer('revision').notNull(),
    data: jsonb('data').notNull(),
    evidenceIds: text('evidence_ids').array().notNull().default([]),
    sourceSessionId: uuid('source_session_id').notNull(),
    sourceRunId: uuid('source_run_id').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [primaryKey({ columns: [t.recordId, t.revision] })],
);

export const partnerEngagementAuthorizations = pgTable(
  'partner_engagement_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    approvalRequestId: uuid('approval_request_id').notNull(),
    authorizationRevision: integer('authorization_revision').notNull(),
    authorizationHash: text('authorization_hash').notNull(),
    inputProvenance: text('input_provenance').notNull(),
    reviewerUserId: uuid('reviewer_user_id').notNull(),
    engagementRecordId: uuid('engagement_record_id'),
    partnerId: uuid('partner_id').notNull(),
    partnerName: text('partner_name').notNull(),
    engagementReference: text('engagement_reference').notNull(),
    purpose: text('purpose').notNull(),
    currency: text('currency').notNull(),
    authorizedTotalMinor: integer('authorized_total_minor').notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validUntil: date('valid_until', { mode: 'string' }).notNull(),
    oneInvoice: boolean('one_invoice').notNull(),
    permittedEvidenceExcerpt: text('permitted_evidence_excerpt').notNull(),
    sourceAttachmentId: uuid('source_attachment_id').notNull(),
    sourceSha256: text('source_sha256').notNull(),
    sourceName: text('source_name').notNull(),
    sourceCreatedAt: ts('source_created_at').notNull(),
    sourceAuthorName: text('source_author_name'),
    sourceSessionId: uuid('source_session_id').notNull(),
    sourceRunId: uuid('source_run_id').notNull(),
    status: text('status').notNull().default('pending'),
    consumedHandoffId: uuid('consumed_handoff_id'),
    createdAt: now('created_at'),
    authorizedAt: ts('authorized_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [unique('partner_engagement_authorizations_approval_key').on(
    t.workspaceId, t.approvalRequestId, t.authorizationRevision, t.authorizationHash,
  )],
);

export const partnerInvoiceIntakes = pgTable(
  'partner_invoice_intakes',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    handoffId: uuid('handoff_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    inputProvenance: text('input_provenance').notNull(),
    engagementRecordId: uuid('engagement_record_id').notNull(),
    expectedEngagementRevision: integer('expected_engagement_revision').notNull(),
    expectedAuthorizationHash: text('expected_authorization_hash').notNull(),
    invoiceSourceAttachmentId: uuid('invoice_source_attachment_id').notNull(),
    invoiceSourceSha256: text('invoice_source_sha256').notNull(),
    invoiceSourceName: text('invoice_source_name').notNull(),
    invoiceSourceCreatedAt: ts('invoice_source_created_at').notNull(),
    invoiceSourceAuthorName: text('invoice_source_author_name'),
    invoiceSourceExcerpt: text('invoice_source_excerpt').notNull(),
    invoicePayload: jsonb('invoice_payload').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    sourceSessionId: uuid('source_session_id').notNull(),
    sourceRunId: uuid('source_run_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [unique('partner_invoice_intakes_idempotency_key').on(t.workspaceId, t.requestedBy, t.idempotencyKey)],
);

export const partnerDecisionAcknowledgments = pgTable(
  'partner_decision_acknowledgments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    handoffId: uuid('handoff_id').notNull(),
    decisionId: uuid('decision_id').notNull(),
    partnerId: uuid('partner_id').notNull(),
    partnerName: text('partner_name').notNull(),
    engagementReference: text('engagement_reference').notNull(),
    outcome: text('outcome').notNull(),
    resultCode: text('result_code').notNull(),
    financeReviewerDisplay: text('finance_reviewer_display').notNull(),
    recordedAt: ts('recorded_at').notNull(),
    deliveryStatus: text('delivery_status').notNull().default('pending'),
    deliveredAt: ts('delivered_at'),
    createdAt: now('created_at'),
  },
  (t) => [
    unique('partner_decision_acknowledgments_decision_key').on(t.workspaceId, t.decisionId),
    unique('partner_decision_acknowledgments_handoff_key').on(t.workspaceId, t.handoffId),
  ],
);

export const outboundEmailAccounts = pgTable('outbound_email_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  provider: text('provider').notNull(),
  address: text('address').notNull(),
  status: text('status').notNull().default('disconnected'),
  ciphertext: bytea('ciphertext'),
  iv: bytea('iv'),
  wrappedDek: bytea('wrapped_dek'),
  wrapIv: bytea('wrap_iv'),
  kekVersion: integer('kek_version'),
  scope: text('scope'),
  tokenExpiresAt: ts('token_expires_at'),
  watchExpiresAt: ts('watch_expires_at'),
  historyId: text('history_id'),
  connectedBy: uuid('connected_by'),
  lastError: text('last_error'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const outboundEmailOutbox = pgTable('outbound_email_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  requestId: uuid('request_id').notNull(),
  authorizationRevision: integer('authorization_revision').notNull(),
  authorizationHash: text('authorization_hash').notNull(),
  candidateId: uuid('candidate_id'),
  accountId: uuid('account_id'),
  recipientIndex: integer('recipient_index').notNull(),
  senderAddress: text('sender_address').notNull(),
  recipientName: text('recipient_name').notNull(),
  recipientAddress: text('recipient_address').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  state: text('state').notNull(),
  providerDraftId: text('provider_draft_id'),
  providerMessageId: text('provider_message_id'),
  providerThreadId: text('provider_thread_id'),
  providerResponse: jsonb('provider_response'),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'),
  sentAt: ts('sent_at'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const contactSuppressions = pgTable('contact_suppressions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  address: text('address').notNull(),
  reason: text('reason').notNull(),
  sourceMessageId: text('source_message_id'),
  createdBy: uuid('created_by'),
  createdAt: now('created_at'),
});

export const partnerDiscoveryCursors = pgTable('partner_discovery_cursors', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  source: text('source').notNull(),
  nextOffset: integer('next_offset').notNull().default(0),
  searchAfter: text('search_after'),
  pageSize: integer('page_size').notNull(),
  lastRunId: uuid('last_run_id'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const gmailOauthStates = pgTable('gmail_oauth_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  requestedBy: uuid('requested_by').notNull(),
  stateDigest: text('state_digest').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  expiresAt: ts('expires_at').notNull(),
  consumedAt: ts('consumed_at'),
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
  agentId: uuid('agent_id'),
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
  credentialKind: text('credential_kind').notNull().default('api_key'),
  oauthClientId: text('oauth_client_id'),
  oauthScope: text('oauth_scope'),
  oauthExpiresAt: ts('oauth_expires_at'),
  oauthAccountUserId: text('oauth_account_user_id'),
  oauthAccountEmail: text('oauth_account_email'),
  oauthOrganizationId: text('oauth_organization_id'),
  oauthOrganizationName: text('oauth_organization_name'),
  oauthOrganizationSlug: text('oauth_organization_slug'),
  oauthAccountVerifiedAt: ts('oauth_account_verified_at'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const providerOauthSessions = pgTable('provider_oauth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  provider: text('provider').notNull(),
  connectionId: uuid('connection_id'),
  initiatedBy: uuid('initiated_by').notNull(),
  clientId: text('client_id').notNull(),
  scope: text('scope').notNull(),
  portalBaseUrl: text('portal_base_url').notNull(),
  verificationUri: text('verification_uri').notNull(),
  userCode: text('user_code').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  iv: bytea('iv').notNull(),
  wrappedDek: bytea('wrapped_dek').notNull(),
  wrapIv: bytea('wrap_iv').notNull(),
  kekVersion: integer('kek_version').notNull(),
  pollIntervalSeconds: integer('poll_interval_seconds').notNull(),
  nextPollAt: ts('next_poll_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  status: text('status').notNull().default('pending'),
  completedAt: ts('completed_at'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

// Slack is a transport into an existing agent/profile. The installation is
// workspace-wide; a linked Slack user is resolved to their active member and
// established agent binding before a private Hermes session can be opened.
export const slackOauthStates = pgTable('slack_oauth_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  requestedBy: uuid('requested_by').notNull(),
  stateDigest: text('state_digest').notNull().unique(),
  redirectUri: text('redirect_uri').notNull(),
  expiresAt: ts('expires_at').notNull(),
  consumedAt: ts('consumed_at'),
  createdAt: now('created_at'),
});

export const slackInstallations = pgTable('slack_installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  installedBy: uuid('installed_by').notNull(),
  slackInstallKey: text('slack_install_key').notNull(),
  slackAppId: text('slack_app_id').notNull(),
  slackEnterpriseId: text('slack_enterprise_id'),
  slackEnterpriseName: text('slack_enterprise_name'),
  slackTeamId: text('slack_team_id'),
  slackTeamName: text('slack_team_name'),
  isEnterpriseInstall: boolean('is_enterprise_install').notNull().default(false),
  slackBotUserId: text('slack_bot_user_id').notNull(),
  slackAuthedUserId: text('slack_authed_user_id'),
  grantedScopes: text('granted_scopes').array().notNull().default([]),
  ciphertext: bytea('ciphertext').notNull(),
  iv: bytea('iv').notNull(),
  wrappedDek: bytea('wrapped_dek').notNull(),
  wrapIv: bytea('wrap_iv').notNull(),
  kekVersion: integer('kek_version').notNull(),
  tokenExpiresAt: ts('token_expires_at'),
  status: text('status').notNull().default('connected'),
  lastErrorCode: text('last_error_code'),
  remoteRevocationPending: boolean('remote_revocation_pending').notNull().default(false),
  connectedAt: now('connected_at'),
  revokedAt: ts('revoked_at'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const slackInstallationDirectory = pgTable('slack_installation_directory', {
  slackInstallKey: text('slack_install_key').primaryKey(),
  targetWorkspaceId: uuid('target_workspace_id').notNull(),
  installationId: uuid('installation_id').notNull().unique(),
  updatedAt: now('updated_at'),
});

export const slackUserLinks = pgTable('slack_user_links', {
  workspaceId: uuid('workspace_id').notNull(),
  installationId: uuid('installation_id').notNull(),
  slackUserId: text('slack_user_id').notNull(),
  userId: uuid('user_id').notNull(),
  linkedBy: uuid('linked_by'),
  revokedAt: ts('revoked_at'),
  linkedAt: now('linked_at'),
}, (t) => [primaryKey({ columns: [t.installationId, t.slackUserId] })]);

export const slackLinkCodes = pgTable('slack_link_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  installationId: uuid('installation_id').notNull(),
  userId: uuid('user_id').notNull(),
  codeDigest: text('code_digest').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  consumedBySlackUser: text('consumed_by_slack_user'),
  consumedAt: ts('consumed_at'),
  createdAt: now('created_at'),
});

export const slackConversations = pgTable('slack_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  installationId: uuid('installation_id').notNull(),
  slackChannelId: text('slack_channel_id').notNull(),
  conversationKey: text('conversation_key').notNull(),
  conversationKind: text('conversation_kind').notNull(),
  agentId: uuid('agent_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  ownerId: uuid('owner_id').notNull(),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const slackEvents = pgTable('slack_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  installationId: uuid('installation_id').notNull(),
  slackEventId: text('slack_event_id').notNull().unique(),
  eventType: text('event_type').notNull(),
  payloadSha256: text('payload_sha256').notNull(),
  retryNum: integer('retry_num'),
  status: text('status').notNull().default('received'),
  runId: uuid('run_id'),
  errorCode: text('error_code'),
  receivedAt: now('received_at'),
  processedAt: ts('processed_at'),
});

export const slackRunDeliveries = pgTable('slack_run_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  installationId: uuid('installation_id').notNull(),
  sourceEventId: uuid('source_event_id').notNull().unique(),
  runId: uuid('run_id').notNull().unique(),
  slackChannelId: text('slack_channel_id').notNull(),
  slackThreadTs: text('slack_thread_ts').notNull(),
  status: text('status').notNull().default('pending'),
  slackMessageTs: text('slack_message_ts'),
  attempts: integer('attempts').notNull().default(0),
  lastErrorCode: text('last_error_code'),
  approvalNotifiedAt: ts('approval_notified_at'),
  approvalClientMsgId: uuid('approval_client_msg_id').notNull().defaultRandom(),
  deliveredAt: ts('delivered_at'),
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
  agent_provisioning: agentProvisioning,
  agent_runtime_bindings: agentRuntimeBindings,
  hermes_cloud_capacity: hermesCloudCapacity,
  runtime_discovery_grants: runtimeDiscoveryGrants,
  agent_capabilities: agentCapabilities,
  agent_operation_policies: agentOperationPolicies,
  agent_operation_approvals: agentOperationApprovals,
  agent_operation_policy_revisions: agentOperationPolicyRevisions,
  agent_files: agentFiles,
  agent_context_notes: agentContextNotes,
  agent_context_fields: agentContextFields,
  instruction_versions: instructionVersions,
  skill_versions: skillVersions,
  agent_skills: agentSkills,
  enterprise_skill_assignments: enterpriseSkillAssignments,
  enterprise_skill_assignment_revisions: enterpriseSkillAssignmentRevisions,
  enterprise_teams: enterpriseTeams,
  enterprise_team_agents: enterpriseTeamAgents,
  enterprise_skill_artifacts: enterpriseSkillArtifacts,
  enterprise_connection_bindings: enterpriseConnectionBindings,
  enterprise_run_grants: enterpriseRunGrants,
  sessions,
  session_shares: sessionShares,
  messages,
  message_feedback: messageFeedback,
  runs,
  run_sweep_observations: runSweepObservations,
  run_steps: runSteps,
  run_turns: runTurns,
  run_queue: runQueue,
  model_calls: modelCalls,
  approval_continuations: approvalContinuations,
  approval_runtime_budgets: approvalRuntimeBudgets,
  approval_model_reservations: approvalModelReservations,
  requests,
  request_triage_assessments: requestTriageAssessments,
  onboarding_sample_runs: onboardingSampleRuns,
  onboarding_sample_applications: onboardingSampleApplications,
  onboarding_sample_events: onboardingSampleEvents,
  partner_screening_runs: partnerScreeningRuns,
  partner_source_artifacts: partnerSourceArtifacts,
  partner_candidates: partnerCandidates,
  partner_contact_enrichments: partnerContactEnrichments,
  partner_engagements: partnerEngagements,
  partner_records: partnerRecords,
  partner_handoffs: partnerHandoffs,
  partner_workflow_executions: partnerWorkflowExecutions,
  partner_agent_messages: partnerAgentMessages,
  request_audiences: requestAudiences,
  partner_workflow_settings: partnerWorkflowSettings,
  partner_record_revisions: partnerRecordRevisions,
  partner_engagement_authorizations: partnerEngagementAuthorizations,
  partner_invoice_intakes: partnerInvoiceIntakes,
  partner_decision_acknowledgments: partnerDecisionAcknowledgments,
  partner_discovery_cursors: partnerDiscoveryCursors,
  outbound_email_accounts: outboundEmailAccounts,
  outbound_email_outbox: outboundEmailOutbox,
  contact_suppressions: contactSuppressions,
  gmail_oauth_states: gmailOauthStates,
  partner_screening_run_candidates: partnerScreeningRunCandidates,
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
  slack_oauth_states: slackOauthStates,
  slack_installations: slackInstallations,
  slack_installation_directory: slackInstallationDirectory,
  slack_user_links: slackUserLinks,
  slack_link_codes: slackLinkCodes,
  slack_conversations: slackConversations,
  slack_events: slackEvents,
  slack_run_deliveries: slackRunDeliveries,
  provider_oauth_sessions: providerOauthSessions,
  session_drafts: sessionDrafts,
  workspace_directory: workspaceDirectory,
  member_directory: memberDirectory,
  invitation_directory: invitationDirectory,
  share_directory: shareDirectory,
  job_ready: jobReady,
  platform_counters: platformCounters,
  validator_runs: validatorRuns,
} as const;
