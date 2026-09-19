import {
  HERMES_BOT_MODE_PROTOCOL,
  botModeProfileSchema,
  formatBotModeAgentMessage,
  invoicePayloadSchema,
  partnerInvoiceHandoffProjectionSchema,
  partnerWorkflowViewSchema,
  type PartnerInvoiceReviewHandoffInput,
  type PartnerQualificationInput,
  type PartnerWorkflowSetup,
  type PartnerWorkflowView,
} from '@hermes/shared';
import type { QueryResultRow } from 'pg';
import type { Tx } from '../db/client.js';
import type { Env } from '../env.js';
import { enqueueJob } from '../jobs.js';
import { resolveRuntimeBinding } from '../runtime/config.js';
import { submitTurn, type RunInstanceParams, type TurnSession } from '../runs/submit.js';
import {
  PARTNER_INVOICE_REVIEW_DEFINITION,
  PARTNER_PROGRAM_DEFINITION,
  PARTNER_PROGRAM_MULTI_PARTY_DEFINITION,
  enterpriseSkillDefinition,
  type EnterpriseSkillDefinition,
} from '../enterprise-skills/registry.js';
import {
  FINANCE_ROLE_INSTRUCTIONS,
  PARTNER_PROGRAM_BOOTSTRAP_INSTRUCTIONS,
} from '../enterprise-skills/role-instructions.js';

export class PartnerWorkflowError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'PartnerWorkflowError';
  }
}

const DEFAULT_PARTNERSHIPS_CONFIG = {
  source: 'github',
  program_name: 'Hermes Partner Program',
  source_purpose: 'organization_partner_research',
  organization_only: true,
  no_outreach: true,
  role_label: 'Hermes partner',
  search_queries: ['AI agent platform'],
  intake_urls: [],
  keywords: ['AI agents'],
  ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
  minimum_priority: 50,
  lookback_days: 365,
  max_candidates: 5,
  max_api_requests: 10,
  minimum_rate_remaining: 5,
  max_spend_usd: 0,
  people_search: {
    current_position_seniority_level: [], person_skills: [], current_position_titles: [],
    person_locations: [], offset: 0, search_after: null,
  },
};

const DEFAULT_FINANCE_CONFIG = { duplicate_window_days: 365, require_engagement_evidence: true };

const fallbackBotProfile = (agentId: string): string => botModeProfileSchema.parse(`agent-${agentId}`);

function botDisplayName(value: string): string {
  const safe = value.replace(/[:\n(]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
  return safe || 'Agent';
}

function financeReviewBotBody(input: {
  readonly handoffId: string;
  readonly partnerName: string;
  readonly engagementReference: string;
  readonly invoiceNumber: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly payeeName: string;
}): string {
  return [
    `Review authenticated Finance handoff ${input.handoffId}.`,
    `Partner: ${input.partnerName}. Engagement: ${input.engagementReference}.`,
    `Invoice: ${input.invoiceNumber}; ${input.currency} ${(input.totalMinor / 100).toFixed(2)}; payee ${input.payeeName}.`,
    'The server has frozen the source revisions and owns the authoritative duplicate, evidence, currency, and amount checks.',
    'Read the resulting Finance request if one exists, then explain the result concisely.',
    'Do not create, approve, pay, send, or message another agent. Do not acknowledge or reply to the sender.',
  ].join('\n');
}

const ROLE_SCOPES = {
  partnerships: {
    capabilities: [...PARTNER_PROGRAM_DEFINITION.defaultCapabilityGrants],
    resource_scope: {
      record_kinds: ['qualification', 'outreach_draft', 'engagement'],
      fields: ['partner_id', 'kind', 'revision', 'data', 'evidence_ids', 'source_session_id', 'source_run_id'],
      actions: ['list', 'read', 'write', 'publish_handoff'],
    },
  },
  finance: {
    capabilities: [...PARTNER_INVOICE_REVIEW_DEFINITION.defaultCapabilityGrants],
    resource_scope: {
      record_kinds: ['invoice', 'invoice_review', 'needs_information'],
      fields: ['partner_id', 'kind', 'revision', 'data', 'evidence_ids', 'source_session_id', 'source_run_id'],
      shared_fields: [
        'partner.id', 'partner.name', 'engagement.reference', 'engagement.summary',
        'engagement.currency', 'engagement.authorized_total_minor', 'engagement.evidence_ids',
        'engagement.source_record_id', 'engagement.source_record_revision',
        'invoice_record_id', 'invoice_record_revision', 'source_session.id', 'source_session.excerpt',
      ],
      actions: ['list', 'read', 'read_shared', 'write', 'prepare_review'],
    },
  },
} as const;

interface TeamRow extends QueryResultRow { id: string; slug: 'partnerships' | 'finance'; name: 'Partnerships' | 'Finance' }
interface ArtifactRow extends QueryResultRow { id: string; digest: string }

async function team(tx: Tx, workspaceId: string, slug: TeamRow['slug']): Promise<TeamRow> {
  const name = slug === 'partnerships' ? 'Partnerships' : 'Finance';
  const { rows } = await tx.query<TeamRow>(
    `INSERT INTO enterprise_teams (workspace_id, slug, name)
     VALUES ($1,$2,$3)
     ON CONFLICT (workspace_id, slug) DO UPDATE SET name=EXCLUDED.name
     RETURNING id, slug, name`,
    [workspaceId, slug, name],
  );
  const row = rows[0];
  if (!row) throw new PartnerWorkflowError('team_setup_failed', `Could not configure ${name}.`);
  return row;
}

async function artifact(tx: Tx, definition: EnterpriseSkillDefinition<Record<string, unknown>>): Promise<ArtifactRow> {
  const { rows } = await tx.query<ArtifactRow>(
    `SELECT id, digest FROM enterprise_skill_artifacts WHERE skill_key=$1 AND skill_version=$2`,
    [definition.key, definition.version],
  );
  const row = rows[0];
  if (!row || row.digest !== definition.artifactDigest) {
    throw new PartnerWorkflowError('skill_artifact_mismatch', `${definition.name} does not match the bundled artifact registry.`);
  }
  return row;
}

async function bindPrincipal(
  tx: Tx,
  workspaceId: string,
  teamId: string,
  agentId: string,
  principalUserId: string,
  roleTemplateKey: 'partnerships-agent' | 'finance-agent',
): Promise<void> {
  const valid = await tx.query(
    `SELECT 1
       FROM agents a
       JOIN members m ON m.workspace_id=a.workspace_id AND m.user_id=$3 AND m.status='active'
      WHERE a.workspace_id=$1 AND a.id=$2`,
    [workspaceId, agentId, principalUserId],
  );
  if (!valid.rows[0]) throw new PartnerWorkflowError('invalid_principal_binding', 'The agent and active employee must belong to this workspace.');
  const conflict = await tx.query<{ agent_id: string; principal_user_id: string; team_id: string }>(
    `SELECT agent_id, principal_user_id, team_id FROM enterprise_team_agents
      WHERE workspace_id=$1 AND (agent_id=$2 OR principal_user_id=$3) FOR UPDATE`,
    [workspaceId, agentId, principalUserId],
  );
  if (conflict.rows.some((row) => row.agent_id !== agentId || row.principal_user_id !== principalUserId || row.team_id !== teamId)) {
    throw new PartnerWorkflowError('principal_already_bound', 'Each employee and each agent may belong to only one Enterprise team.');
  }
  await tx.query(
    `INSERT INTO enterprise_team_agents
       (workspace_id, team_id, agent_id, principal_user_id, role_template_key, role_template_version)
     VALUES ($1,$2,$3,$4,$5,'1.0.0')
     ON CONFLICT (workspace_id, team_id, agent_id)
     DO UPDATE SET principal_user_id=EXCLUDED.principal_user_id,
                   role_template_key=EXCLUDED.role_template_key,
                   role_template_version=EXCLUDED.role_template_version`,
    [workspaceId, teamId, agentId, principalUserId, roleTemplateKey],
  );
}

async function assignRoleSkill(
  tx: Tx,
  workspaceId: string,
  teamId: string,
  agentId: string,
  assignedBy: string,
  definition: EnterpriseSkillDefinition<Record<string, unknown>>,
  artifactRow: ArtifactRow,
  defaultConfig: Record<string, unknown>,
): Promise<void> {
  const current = await tx.query<{
    id: string;
  }>(
    `SELECT id FROM enterprise_skill_assignments
      WHERE workspace_id=$1 AND agent_id=$2 AND skill_key=$3 FOR UPDATE`,
    [workspaceId, agentId, definition.key],
  );
  const row = current.rows[0];
  if (!row) {
    await tx.query(
      `INSERT INTO enterprise_skill_assignments
         (workspace_id, agent_id, team_id, artifact_id, skill_key, skill_version,
          state, config, capability_grants, schedule, approval_policy, assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7::jsonb,$8,
               '{"enabled":false,"interval_minutes":360}'::jsonb,
               '{"human_review_required":true}'::jsonb,$9)`,
      [workspaceId, agentId, teamId, artifactRow.id, definition.key, definition.version,
        JSON.stringify(definition.configSchema.parse(defaultConfig)), [...definition.defaultCapabilityGrants], assignedBy],
    );
    return;
  }
  // Applying a reviewed role template replaces semantic authority, config and
  // schedule. In particular, an invitation's compatibility profile must not
  // carry its discovery schedule into a Finance assignment.
  const grants = [...definition.defaultCapabilityGrants];
  const config = definition.configSchema.parse(defaultConfig);
  await tx.query(
    `UPDATE enterprise_skill_assignments
        SET team_id=$4,artifact_id=$5,skill_version=$6,state='active',config=$7::jsonb,
            capability_grants=$8,schedule='{"enabled":false,"interval_minutes":360}'::jsonb,
            approval_policy='{"human_review_required":true}'::jsonb,
            assigned_by=$9,revision=revision+1
      WHERE workspace_id=$1 AND agent_id=$2 AND id=$3
        AND (team_id IS DISTINCT FROM $4 OR artifact_id IS DISTINCT FROM $5
          OR skill_version IS DISTINCT FROM $6 OR state IS DISTINCT FROM 'active'
          OR config IS DISTINCT FROM $7::jsonb OR capability_grants IS DISTINCT FROM $8::text[]
          OR schedule IS DISTINCT FROM '{"enabled":false,"interval_minutes":360}'::jsonb
          OR approval_policy IS DISTINCT FROM '{"human_review_required":true}'::jsonb)`,
    [workspaceId, agentId, row.id, teamId, artifactRow.id, definition.version,
      JSON.stringify(config), grants, assignedBy],
  );
}

async function pauseOtherRoleSkills(
  tx: Tx,
  workspaceId: string,
  agentId: string,
  keepSkillKey: string,
): Promise<void> {
  await tx.query(
    `UPDATE enterprise_skill_assignments
        SET state='paused',schedule=jsonb_set(schedule,'{enabled}','false'::jsonb),revision=revision+1
      WHERE workspace_id=$1 AND agent_id=$2 AND skill_key<>$3
        AND (state<>'paused' OR COALESCE((schedule->>'enabled')::boolean,false))`,
    [workspaceId, agentId, keepSkillKey],
  );
}

async function bindConnector(
  tx: Tx,
  workspaceId: string,
  teamId: string,
  configuredBy: string,
  scope: typeof ROLE_SCOPES.partnerships | typeof ROLE_SCOPES.finance,
): Promise<void> {
  await tx.query(
    `INSERT INTO enterprise_connection_bindings
       (workspace_id, team_id, connector_key, state, capability_grants, capability_denies, resource_scope, created_by)
     VALUES ($1,$2,'enterprise-partner-records','active',$3,'{}',$4::jsonb,$5)
     ON CONFLICT (workspace_id, team_id, connector_key)
     DO UPDATE SET state='active', capability_grants=EXCLUDED.capability_grants,
                   resource_scope=EXCLUDED.resource_scope`,
    [workspaceId, teamId, [...scope.capabilities], JSON.stringify(scope.resource_scope), configuredBy],
  );
}

function invitationBootstrapSource(value: unknown, invitationId: string): boolean {
  if (!Array.isArray(value)) return false;
  // Invitations created before explicit provenance shipped used an empty
  // source list. The accepted invitation + owner + exact untouched bootstrap
  // fields below are the compatibility identity for those rows.
  if (value.length === 0) return true;
  return value.some((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
    const row = source as Record<string, unknown>;
    return row.kind === 'invitation_bootstrap' && row.invitation_id === invitationId
      && row.role_template_key === 'partner-program-compatibility'
      && row.role_template_version === '1.0.0';
  });
}

function financeRoleSource(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
    const row = source as Record<string, unknown>;
    return row.kind === 'enterprise_role_template'
      && row.role_template_key === 'finance-agent'
      && row.role_template_version === '1.0.0';
  });
}

async function applyFinanceRoleInstructions(
  tx: Tx,
  workspaceId: string,
  agentId: string,
  principalUserId: string,
  configuredBy: string,
): Promise<void> {
  const agent = (await tx.query<{
    responsibility: string | null; instructions_active: string | null;
    status: string; setup_step: string | null;
  }>(
    `SELECT responsibility,instructions_active,status,setup_step
       FROM agents WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [workspaceId, agentId],
  )).rows[0];
  if (!agent) throw new PartnerWorkflowError('invalid_principal_binding', 'The Finance agent no longer exists.');
  const latest = (await tx.query<{
    id: string; body: string; status: string; proposed_by: string | null; sources: unknown;
  }>(
    `SELECT id,body,status,proposed_by,sources
       FROM instruction_versions
      WHERE workspace_id=$1 AND agent_id=$2 AND status<>'discarded'
      ORDER BY created_at DESC,id DESC LIMIT 1`,
    [workspaceId, agentId],
  )).rows[0] ?? null;
  const acceptedInvitation = (await tx.query<{ id: string }>(
    `SELECT i.id
       FROM agent_owners ao
       JOIN members m ON m.workspace_id=ao.workspace_id AND m.id=ao.member_id
       JOIN invitations i ON i.workspace_id=m.workspace_id AND i.accepted_by=m.user_id
      WHERE ao.workspace_id=$1 AND ao.agent_id=$2 AND m.user_id=$3
        AND m.status='active' AND i.status='accepted'
      ORDER BY i.created_at DESC LIMIT 1`,
    [workspaceId, agentId, principalUserId],
  )).rows[0]?.id ?? null;

  const blank = !agent.instructions_active?.trim() && latest === null;
  const alreadyFinance = agent.instructions_active === FINANCE_ROLE_INSTRUCTIONS
    && latest?.status === 'saved'
    && latest.body === FINANCE_ROLE_INSTRUCTIONS
    && financeRoleSource(latest.sources);
  const exactInvitationBootstrap = Boolean(
    acceptedInvitation
    && agent.responsibility === 'Partner Program'
    && agent.instructions_active === PARTNER_PROGRAM_BOOTSTRAP_INSTRUCTIONS
    && agent.status === 'draft'
    && agent.setup_step === 'identity'
    && latest?.status === 'saved'
    && latest.body === PARTNER_PROGRAM_BOOTSTRAP_INSTRUCTIONS
    && latest.proposed_by === principalUserId
    && invitationBootstrapSource(latest.sources, acceptedInvitation!),
  );
  if (!blank && !alreadyFinance && !exactInvitationBootstrap) {
    throw new PartnerWorkflowError(
      'finance_instruction_conflict',
      'The Finance profile has custom or partially completed instructions. Use a dedicated empty profile or restore the untouched invitation profile before assigning the Finance role.',
    );
  }

  // Closing onboarding is safe only for the exact invitation bootstrap whose
  // purpose this role assignment replaces. A generic empty profile may accept
  // the Finance prompt, but its independent operational state is preserved.
  const replaceInvitationBootstrap = exactInvitationBootstrap;
  await tx.query(
    `UPDATE agents
        SET responsibility='Finance invoice review',instructions_active=$3,
            setup_step=CASE WHEN $4::boolean THEN NULL ELSE setup_step END,
            status=CASE WHEN $4::boolean AND EXISTS (
              SELECT 1 FROM agent_provisioning ap
               WHERE ap.workspace_id=$1 AND ap.agent_id=$2 AND ap.status<>'ready'
            ) THEN 'provisioning'
              WHEN $4::boolean THEN 'started'
              ELSE status END,
            started_at=CASE WHEN $4::boolean AND EXISTS (
              SELECT 1 FROM agent_provisioning ap
               WHERE ap.workspace_id=$1 AND ap.agent_id=$2 AND ap.status<>'ready'
            ) THEN NULL
              WHEN $4::boolean THEN COALESCE(started_at,now())
              ELSE started_at END
      WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, agentId, FINANCE_ROLE_INSTRUCTIONS, replaceInvitationBootstrap],
  );
  if (latest?.body !== FINANCE_ROLE_INSTRUCTIONS) {
    await tx.query(
      `INSERT INTO instruction_versions
         (workspace_id,agent_id,body,status,proposed_by,sources,saved_at)
       VALUES ($1,$2,$3,'saved',$4,$5::jsonb,now())`,
      [workspaceId, agentId, FINANCE_ROLE_INSTRUCTIONS, configuredBy, JSON.stringify([{
        kind: 'enterprise_role_template', role_template_key: 'finance-agent', role_template_version: '1.0.0',
        replaces_instruction_version_id: latest?.id ?? null,
      }])],
    );
  }
}

async function retireInvitationFirstSearch(
  tx: Tx,
  workspaceId: string,
  agentId: string,
): Promise<void> {
  const policyKey = `partner-first-search-${agentId}`;
  const pending = await tx.query<{ request_id: string }>(
    `SELECT ar.request_id
       FROM approval_requests ar
       JOIN approval_policies ap ON ap.workspace_id=ar.workspace_id AND ap.id=ar.policy_id
       JOIN requests r ON r.workspace_id=ar.workspace_id AND r.id=ar.request_id
      WHERE ar.workspace_id=$1 AND ar.requester_agent_id=$2 AND ar.status='pending'
        AND ap.key=$3 AND ap.version=1 AND ap.approval_type='run_plan'
        AND ap.requester_agent_id=$2
        AND r.status='pending' AND r.tool_call_id=ar.proposal_idempotency_key
        AND r.tool_call_id LIKE 'partner-first-search:%'
        AND r.payload #>> '{context,source,trigger,kind}'='member_agent_joined'
        AND r.payload #>> '{context,source,trigger,agent_id}'=$2::text
      FOR UPDATE OF ar,ap,r`,
    [workspaceId, agentId, policyKey],
  );
  const requestIds = pending.rows.map((row) => row.request_id);
  if (requestIds.length > 0) {
    await tx.query(
      `UPDATE approval_requests
          SET status='withdrawn',work_status='cancelled',
              work_reason='The agent was assigned to the Finance role before this search was approved.'
        WHERE workspace_id=$1 AND request_id=ANY($2::uuid[]) AND status='pending'`,
      [workspaceId, requestIds],
    );
    await tx.query(
      `UPDATE approval_revisions SET status='withdrawn'
        WHERE workspace_id=$1 AND request_id=ANY($2::uuid[]) AND status='pending'`,
      [workspaceId, requestIds],
    );
    await tx.query(
      `UPDATE requests SET status='withdrawn'
        WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND status='pending'`,
      [workspaceId, requestIds],
    );
  }
  await tx.query(
    `UPDATE approval_policies SET active=false
      WHERE workspace_id=$1 AND key=$2 AND version=1 AND approval_type='run_plan'
        AND requester_agent_id=$3 AND active`,
    [workspaceId, policyKey, agentId],
  );
}

export async function configurePartnerWorkflow(
  tx: Tx,
  workspaceId: string,
  configuredBy: string,
  input: PartnerWorkflowSetup,
): Promise<PartnerWorkflowView> {
  const partnershipsTeam = await team(tx, workspaceId, 'partnerships');
  const financeTeam = await team(tx, workspaceId, 'finance');
  // `pg` clients serialize one transaction. Await each lookup so this remains
  // compatible with pg 9, which rejects overlapping `client.query` calls.
  const partnershipsArtifact = await artifact(tx, PARTNER_PROGRAM_MULTI_PARTY_DEFINITION);
  const financeArtifact = await artifact(tx, PARTNER_INVOICE_REVIEW_DEFINITION);
  for (const agentId of [input.partnerships.agent_id, input.finance.agent_id].sort()) {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`agent-setup:${agentId}`]);
  }
  await bindPrincipal(tx, workspaceId, partnershipsTeam.id, input.partnerships.agent_id, input.partnerships.principal_user_id, 'partnerships-agent');
  await bindPrincipal(tx, workspaceId, financeTeam.id, input.finance.agent_id, input.finance.principal_user_id, 'finance-agent');
  await applyFinanceRoleInstructions(
    tx, workspaceId, input.finance.agent_id, input.finance.principal_user_id, configuredBy,
  );
  // Applying the Finance role template is the explicit Admin action that
  // grants this human the existing Finance reviewer role. It does not grant
  // the agent approval authority; the guarded human route still records every
  // decision and downstream payment remains a separate two-reviewer effect.
  await tx.query(
    `UPDATE members
        SET reviewer_roles=(SELECT ARRAY(SELECT DISTINCT unnest(reviewer_roles || ARRAY['finance']::text[])))
      WHERE workspace_id=$1 AND user_id=$2 AND status='active'`,
    [workspaceId, input.finance.principal_user_id],
  );
  await pauseOtherRoleSkills(
    tx, workspaceId, input.partnerships.agent_id, PARTNER_PROGRAM_MULTI_PARTY_DEFINITION.key,
  );
  await pauseOtherRoleSkills(
    tx, workspaceId, input.finance.agent_id, PARTNER_INVOICE_REVIEW_DEFINITION.key,
  );
  await assignRoleSkill(tx, workspaceId, partnershipsTeam.id, input.partnerships.agent_id, configuredBy,
    PARTNER_PROGRAM_MULTI_PARTY_DEFINITION, partnershipsArtifact, DEFAULT_PARTNERSHIPS_CONFIG);
  await assignRoleSkill(tx, workspaceId, financeTeam.id, input.finance.agent_id, configuredBy,
    PARTNER_INVOICE_REVIEW_DEFINITION, financeArtifact, DEFAULT_FINANCE_CONFIG);
  await retireInvitationFirstSearch(tx, workspaceId, input.finance.agent_id);
  await bindConnector(tx, workspaceId, partnershipsTeam.id, configuredBy, ROLE_SCOPES.partnerships);
  await bindConnector(tx, workspaceId, financeTeam.id, configuredBy, ROLE_SCOPES.finance);
  const financeMember = await tx.query<{ id: string }>(
    `SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2 AND status='active'`,
    [workspaceId, input.finance.principal_user_id],
  );
  const financeMemberId = financeMember.rows[0]?.id;
  if (!financeMemberId) throw new PartnerWorkflowError('invalid_principal_binding', 'The Finance principal is not an active member.');
  await tx.query(
    `INSERT INTO approval_resources
       (workspace_id, resource_key, kind, label, owner_member_id, version, sha256, executor_available, active)
     VALUES ($1,'enterprise-partner-records','system','Authorized partner engagement records',$2,'engagement-authorization/v1',
             '21e2c6e6bf07bab2f7dd4dfa8163f5705cd3f9b853c0c43c32e9275ba14d5496',true,true)
     ON CONFLICT (workspace_id, resource_key)
     DO UPDATE SET owner_member_id=EXCLUDED.owner_member_id, version=EXCLUDED.version,
                   sha256=EXCLUDED.sha256, executor_available=true, active=true`,
    [workspaceId, financeMemberId],
  );
  await tx.query(
    `INSERT INTO approval_policies
       (workspace_id,key,version,approval_type,requester_agent_id,target_resource_ids,priority,
        mode,prevent_self_review,require_distinct_reviewers,max_duration_seconds,steps,active)
     VALUES ($1,'partner-engagement-authorization',1,'record_change',$2,
             ARRAY['enterprise-partner-records']::text[],1000,'sequential',true,true,604800,$3::jsonb,true)
     ON CONFLICT (workspace_id,key,version)
     DO UPDATE SET requester_agent_id=EXCLUDED.requester_agent_id,
                   target_resource_ids=EXCLUDED.target_resource_ids,steps=EXCLUDED.steps,active=true`,
    [workspaceId, input.partnerships.agent_id, JSON.stringify([{
      id: 'finance-review', label: 'Finance verifies the stated terms and provenance', order: 0,
      reviewers: [{ kind: 'member', member_id: financeMemberId }], quorum: 1,
    }])],
  );
  await tx.query(
    `INSERT INTO partner_workflow_settings (workspace_id,admission_state)
     VALUES ($1,'disabled') ON CONFLICT (workspace_id) DO NOTHING`,
    [workspaceId],
  );
  return loadPartnerWorkflowView(tx, workspaceId);
}

export async function loadPartnerWorkflowView(tx: Tx, workspaceId: string): Promise<PartnerWorkflowView> {
  const teams = await tx.query<TeamRow>(
    `SELECT id, slug, name FROM enterprise_teams WHERE workspace_id=$1 ORDER BY slug DESC`,
    [workspaceId],
  );
  const agents = await tx.query<{
    id: string; name: string; principal_user_id: string; principal_name: string;
    team_id: string; team_slug: TeamRow['slug']; team_name: TeamRow['name'];
    role_template_key: 'partnerships-agent' | 'finance-agent'; role_template_version: string;
    assignment_id: string; skill_key: 'partner-program-screening' | 'partner-invoice-review';
    skill_version: string; assignment_state: 'active' | 'paused'; assignment_revision: number;
    schedule: { enabled?: boolean }; capability_grants: string[];
  }>(
    `SELECT a.id, a.name, eta.principal_user_id, COALESCE(u.name,u.email) AS principal_name,
            et.id AS team_id, et.slug AS team_slug, et.name AS team_name,
            eta.role_template_key, eta.role_template_version,
            esa.id AS assignment_id, esa.skill_key, esa.skill_version,
            esa.state AS assignment_state, esa.revision AS assignment_revision,
            esa.schedule, esa.capability_grants
       FROM enterprise_team_agents eta
       JOIN enterprise_teams et ON et.workspace_id=eta.workspace_id AND et.id=eta.team_id
       JOIN agents a ON a.workspace_id=eta.workspace_id AND a.id=eta.agent_id
       JOIN users u ON u.id=eta.principal_user_id
       JOIN enterprise_skill_assignments esa
         ON esa.workspace_id=eta.workspace_id AND esa.agent_id=eta.agent_id AND esa.team_id=eta.team_id
      WHERE eta.workspace_id=$1
      ORDER BY et.slug DESC`,
    [workspaceId],
  );
  const handoffs = await tx.query<{
    id: string; status: PartnerWorkflowView['handoffs'][number]['status']; projection: Record<string, unknown>;
    source_session_id: string; finance_session_id: string | null; request_id: string | null;
    result_reason: string | null; simulated: boolean; created_at: Date; completed_at: Date | null;
    delivery_protocol: typeof HERMES_BOT_MODE_PROTOCOL | null;
    message_status: 'queued' | 'delivered' | 'failed' | null;
  }>(
    `SELECT h.id, h.status, h.projection, h.source_session_id,
            e.finance_session_id, e.request_id, h.result_reason, h.simulated, h.created_at, h.completed_at,
            pam.protocol AS delivery_protocol, pam.status AS message_status
       FROM partner_handoffs h
       LEFT JOIN partner_workflow_executions e ON e.handoff_id=h.id
       LEFT JOIN partner_agent_messages pam
         ON pam.workspace_id=h.workspace_id AND pam.handoff_id=h.id
        AND pam.direction='handoff_to_finance'
      WHERE h.workspace_id=$1 ORDER BY h.created_at DESC LIMIT 25`,
    [workspaceId],
  );
  return partnerWorkflowViewSchema.parse({
    configured: agents.rows.length === 2,
    teams: teams.rows,
    agents: agents.rows.map((row) => ({
      id: row.id,
      name: row.name,
      principal_user_id: row.principal_user_id,
      principal_name: row.principal_name,
      team: { id: row.team_id, slug: row.team_slug, name: row.team_name },
      role_template: {
        key: row.role_template_key,
        name: row.role_template_key === 'partnerships-agent' ? 'Partnerships agent' : 'Finance agent',
        version: row.role_template_version,
      },
      skill_key: row.skill_key,
      skill_name: row.skill_key === PARTNER_PROGRAM_DEFINITION.key
        ? PARTNER_PROGRAM_DEFINITION.name : PARTNER_INVOICE_REVIEW_DEFINITION.name,
      skill_version: row.skill_version,
      assignment_id: row.assignment_id,
      assignment_revision: row.assignment_revision,
      assignment_state: row.assignment_state,
      schedule_enabled: row.schedule.enabled === true,
      capabilities: row.capability_grants,
    })),
    handoffs: handoffs.rows.map((row) => {
      const projection = partnerInvoiceHandoffProjectionSchema.parse(row.projection);
      return {
        id: row.id,
        status: row.status,
        partner_id: projection.partner.id,
        partner_name: projection.partner.name,
        engagement_reference: projection.engagement.reference,
        source_session_id: row.source_session_id,
        finance_session_id: row.finance_session_id,
        invoice_request_id: row.request_id,
        delivery_protocol: row.delivery_protocol,
        message_status: row.message_status,
        result_reason: row.result_reason,
        simulated: row.simulated,
        created_at: row.created_at.toISOString(),
        completed_at: row.completed_at?.toISOString() ?? null,
      };
    }),
    connector: {
      name: 'enterprise-partner-records',
      shared_code: true,
      enforcement: 'server',
      summary: 'Shared identity and approved engagement evidence only; private research and invoice data stay team-scoped.',
    },
  });
}

export async function snapshotPartnerRunGrants(
  tx: Tx,
  workspaceId: string,
  runId: string,
  agentId: string,
  handoffId: string | null = null,
): Promise<number> {
  const { rows } = await tx.query<{
    team_id: string; assignment_id: string; revision: number; artifact_id: string | null;
    artifact_digest: string | null; skill_key: string; skill_version: string; capability_grants: string[];
    binding_id: string; binding_grants: string[]; binding_denies: string[];
    resource_scope: { fields?: string[]; shared_fields?: string[]; actions?: string[] };
  }>(
    `SELECT eta.team_id, esa.id AS assignment_id, esa.revision, esa.artifact_id,
            art.digest AS artifact_digest, esa.skill_key, esa.skill_version, esa.capability_grants,
            ecb.id AS binding_id, ecb.capability_grants AS binding_grants,
            ecb.capability_denies AS binding_denies, ecb.resource_scope
       FROM runs r
       JOIN enterprise_team_agents eta
         ON eta.workspace_id=r.workspace_id AND eta.agent_id=r.agent_id
       JOIN enterprise_skill_assignments esa
         ON esa.workspace_id=eta.workspace_id AND esa.agent_id=eta.agent_id
        AND esa.team_id=eta.team_id AND esa.state='active'
       JOIN enterprise_skill_artifacts art ON art.id=esa.artifact_id
       JOIN enterprise_connection_bindings ecb
         ON ecb.workspace_id=eta.workspace_id AND ecb.team_id=eta.team_id
        AND ecb.connector_key='enterprise-partner-records' AND ecb.state='active'
      WHERE r.workspace_id=$1 AND r.id=$2 AND r.agent_id=$3`,
    [workspaceId, runId, agentId],
  );
  const row = rows[0];
  if (!row || !row.artifact_id || !row.artifact_digest) {
    throw new PartnerWorkflowError('run_grant_unavailable', 'This run has no active, artifact-bound partner connector assignment.');
  }
  const definition = enterpriseSkillDefinition(row.skill_key, row.skill_version);
  if (!definition || definition.artifactDigest !== row.artifact_digest) {
    throw new PartnerWorkflowError('skill_artifact_mismatch', 'The run skill artifact does not match this build.');
  }
  const grants = row.capability_grants.filter((capability) =>
    row.binding_grants.includes(capability) && !row.binding_denies.includes(capability));
  const fields = handoffId ? row.resource_scope.shared_fields ?? [] : row.resource_scope.fields ?? [];
  const resourceKind = handoffId ? 'handoff' : 'team_records';
  for (const capability of grants) {
    await tx.query(
      `INSERT INTO enterprise_run_grants
         (workspace_id, run_id, agent_id, team_id, assignment_id, assignment_revision,
          artifact_id, artifact_digest, connection_binding_id, capability,
          resource_kind, resource_id, allowed_fields, allowed_actions, effect)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'allow')
       ON CONFLICT DO NOTHING`,
      [workspaceId, runId, agentId, row.team_id, row.assignment_id, row.revision,
        row.artifact_id, row.artifact_digest, row.binding_id, capability,
        resourceKind, handoffId, fields, row.resource_scope.actions ?? []],
    );
  }
  return grants.length;
}

async function assertRunCapability(
  tx: Tx,
  workspaceId: string,
  runId: string,
  agentId: string,
  capability: string,
  action: string,
  resourceKind: 'team_records' | 'handoff',
  resourceId: string | null = null,
): Promise<{ team_id: string }> {
  const { rows } = await tx.query<{ team_id: string }>(
    `SELECT g.team_id
       FROM enterprise_run_grants g
       JOIN enterprise_skill_assignments esa ON esa.id=g.assignment_id
       JOIN enterprise_skill_artifacts art ON art.id=g.artifact_id
       JOIN enterprise_connection_bindings ecb ON ecb.id=g.connection_binding_id
      WHERE g.workspace_id=$1 AND g.run_id=$2 AND g.agent_id=$3
        AND g.capability=$4 AND g.effect='allow' AND g.revoked_at IS NULL
        AND g.resource_kind=$5 AND g.resource_id IS NOT DISTINCT FROM $6::uuid
        AND $7=ANY(g.allowed_actions)
        AND esa.state='active' AND esa.revision=g.assignment_revision
        AND esa.artifact_id=g.artifact_id AND art.digest=g.artifact_digest
        AND ecb.state='active' AND NOT (g.capability=ANY(ecb.capability_denies))
        AND NOT EXISTS (
          SELECT 1 FROM enterprise_run_grants deny
           WHERE deny.workspace_id=g.workspace_id AND deny.run_id=g.run_id
             AND deny.agent_id=g.agent_id AND deny.capability=g.capability
             AND deny.effect='deny' AND deny.revoked_at IS NULL
        )
      LIMIT 1`,
    [workspaceId, runId, agentId, capability, resourceKind, resourceId, action],
  );
  const row = rows[0];
  if (!row) throw new PartnerWorkflowError('connector_forbidden', 'The current run is not authorized for that partner-record action.');
  return row;
}

export async function listPartnerRecordsForRun(
  tx: Tx,
  context: { workspaceId: string; runId: string; agentId: string },
  kind: string | null = null,
): Promise<Record<string, unknown>[]> {
  const grant = await assertRunCapability(tx, context.workspaceId, context.runId, context.agentId,
    context.agentId ? 'partner.invoice.read' : '', 'list', 'team_records').catch(async (error) => {
      if (!(error instanceof PartnerWorkflowError)) throw error;
      return assertRunCapability(tx, context.workspaceId, context.runId, context.agentId,
        'partner.records.qualification.write', 'list', 'team_records');
    });
  const { rows } = await tx.query<Record<string, unknown> & QueryResultRow>(
    `SELECT id, kind, partner_id, revision, data, evidence_ids, source_session_id, source_run_id, created_at
       FROM partner_records
      WHERE workspace_id=$1 AND team_id=$2 AND ($3::text IS NULL OR kind=$3)
      ORDER BY created_at DESC LIMIT 100`,
    [context.workspaceId, grant.team_id, kind],
  );
  return rows;
}

export async function getPartnerRecordForRun(
  tx: Tx,
  context: { workspaceId: string; runId: string; agentId: string },
  recordId: string,
): Promise<Record<string, unknown> | null> {
  const candidates = ['partner.invoice.read', 'partner.records.qualification.write'];
  let teamId: string | null = null;
  for (const capability of candidates) {
    try {
      teamId = (await assertRunCapability(tx, context.workspaceId, context.runId, context.agentId,
        capability, 'read', 'team_records')).team_id;
      break;
    } catch (error) {
      if (!(error instanceof PartnerWorkflowError)) throw error;
    }
  }
  if (!teamId) throw new PartnerWorkflowError('connector_forbidden', 'The current run cannot read team partner records.');
  const { rows } = await tx.query<Record<string, unknown> & QueryResultRow>(
    `SELECT id, kind, partner_id, revision, data, evidence_ids, source_session_id, source_run_id, created_at
       FROM partner_records WHERE workspace_id=$1 AND team_id=$2 AND id=$3`,
    [context.workspaceId, teamId, recordId],
  );
  return rows[0] ?? null;
}

export async function readPartnerHandoffForRun(
  tx: Tx,
  context: { workspaceId: string; runId: string; agentId: string },
  handoffId: string,
): Promise<Record<string, unknown> | null> {
  const grant = await assertRunCapability(tx, context.workspaceId, context.runId, context.agentId,
    'partner.shared.read', 'read_shared', 'handoff', handoffId);
  const { rows } = await tx.query<{ projection: unknown }>(
    `SELECT projection FROM partner_handoffs
      WHERE workspace_id=$1 AND to_team_id=$2 AND id=$3`,
    [context.workspaceId, grant.team_id, handoffId],
  );
  return rows[0] ? partnerInvoiceHandoffProjectionSchema.parse(rows[0].projection) : null;
}

export async function recordPartnerQualification(
  tx: Tx,
  workspaceId: string,
  agentId: string,
  input: PartnerQualificationInput,
): Promise<{ id: string; created: boolean }> {
  const grant = await assertRunCapability(tx, workspaceId, input.source_run_id, agentId,
    'partner.records.qualification.write', 'write', 'team_records');
  const candidate = await tx.query(
    `SELECT 1 FROM partner_candidates WHERE workspace_id=$1 AND agent_id=$2 AND id=$3`,
    [workspaceId, agentId, input.candidate_id],
  );
  const provenance = await tx.query(
    `SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id AND s.workspace_id=r.workspace_id
      WHERE r.workspace_id=$1 AND r.id=$2 AND r.agent_id=$3 AND s.id=$4 AND s.agent_id=$3`,
    [workspaceId, input.source_run_id, agentId, input.source_session_id],
  );
  if (!candidate.rows[0] || !provenance.rows[0]) {
    throw new PartnerWorkflowError('qualification_source_mismatch', 'Qualification must cite this agent’s stored candidate and source run.');
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO partner_records
       (workspace_id, team_id, owner_agent_id, kind, partner_id, data, evidence_ids,
        source_session_id, source_run_id, idempotency_key)
     VALUES ($1,$2,$3,'qualification',$4,$5::jsonb,$6,$7,$8,$9)
     ON CONFLICT (workspace_id, team_id, owner_agent_id, kind, idempotency_key) DO NOTHING
     RETURNING id`,
    [workspaceId, grant.team_id, agentId, input.candidate_id,
      JSON.stringify({ outcome: input.outcome, summary: input.summary, strengths: input.strengths, gaps: input.gaps, confidence: input.confidence }),
      input.evidence_ids, input.source_session_id, input.source_run_id, input.idempotency_key],
  );
  if (rows[0]) return { id: rows[0].id, created: true };
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM partner_records
      WHERE workspace_id=$1 AND team_id=$2 AND owner_agent_id=$3
        AND kind='qualification' AND idempotency_key=$4`,
    [workspaceId, grant.team_id, agentId, input.idempotency_key],
  );
  return { id: existing.rows[0]?.id ?? '', created: false };
}

export async function publishPartnerInvoiceReviewHandoff(
  tx: Tx,
  workspaceId: string,
  requestedBy: string,
  input: PartnerInvoiceReviewHandoffInput,
): Promise<{ handoffId: string; jobId: string | null; created: boolean }> {
  const roles = await tx.query<{
    team_id: string; slug: 'partnerships' | 'finance'; agent_id: string; principal_user_id: string;
  }>(
    `SELECT eta.team_id, et.slug, eta.agent_id, eta.principal_user_id
       FROM enterprise_team_agents eta
       JOIN enterprise_teams et ON et.workspace_id=eta.workspace_id AND et.id=eta.team_id
      WHERE eta.workspace_id=$1`,
    [workspaceId],
  );
  const partnerships = roles.rows.find((row) => row.slug === 'partnerships');
  const finance = roles.rows.find((row) => row.slug === 'finance');
  if (!partnerships || !finance) throw new PartnerWorkflowError('workflow_not_configured', 'Configure both employee role templates first.');
  const source = await tx.query(
    `SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id AND s.workspace_id=r.workspace_id
      WHERE r.workspace_id=$1 AND r.id=$2 AND r.agent_id=$3
        AND s.id=$4 AND s.agent_id=$3 AND s.owner_id=$5`,
    [workspaceId, input.source_run_id, partnerships.agent_id, input.source_session_id, partnerships.principal_user_id],
  );
  if (!source.rows[0]) throw new PartnerWorkflowError('handoff_source_mismatch', 'The handoff must come from the Partnerships employee’s agent session.');

  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM partner_handoffs
      WHERE workspace_id=$1 AND from_team_id=$2 AND idempotency_key=$3`,
    [workspaceId, partnerships.team_id, input.idempotency_key],
  );
  if (existing.rows[0]) return { handoffId: existing.rows[0].id, jobId: null, created: false };

  const engagement = await tx.query<{ id: string; revision: number }>(
    `INSERT INTO partner_records
       (workspace_id, team_id, owner_agent_id, kind, partner_id, data, evidence_ids,
        source_session_id, source_run_id, idempotency_key)
     VALUES ($1,$2,$3,'engagement',$4,$5::jsonb,$6,$7,$8,$9)
     RETURNING id, revision`,
    [workspaceId, partnerships.team_id, partnerships.agent_id, input.partner.id,
      JSON.stringify({ reference: input.engagement.reference, summary: input.engagement.summary,
        currency: input.engagement.currency, authorized_total_minor: input.engagement.authorized_total_minor }),
      input.engagement.evidence_ids, input.source_session_id, input.source_run_id,
      `${input.idempotency_key}:engagement`],
  );
  const invoice = await tx.query<{ id: string; revision: number }>(
    `INSERT INTO partner_records
       (workspace_id, team_id, owner_agent_id, kind, partner_id, data, evidence_ids,
        source_session_id, source_run_id, idempotency_key)
     VALUES ($1,$2,$3,'invoice',$4,$5::jsonb,$6,$7,$8,$9)
     RETURNING id, revision`,
    [workspaceId, finance.team_id, finance.agent_id, input.partner.id,
      JSON.stringify(invoicePayloadSchema.parse(input.invoice)), input.engagement.evidence_ids,
      input.source_session_id, input.source_run_id, `${input.idempotency_key}:invoice`],
  );
  const engagementRow = engagement.rows[0];
  const invoiceRow = invoice.rows[0];
  if (!engagementRow || !invoiceRow) throw new PartnerWorkflowError('handoff_record_failed', 'Could not freeze the invoice-review source records.');
  const projection = partnerInvoiceHandoffProjectionSchema.parse({
    partner: input.partner,
    engagement: {
      ...input.engagement,
      source_record_id: engagementRow.id,
      source_record_revision: engagementRow.revision,
    },
    invoice_record_id: invoiceRow.id,
    invoice_record_revision: invoiceRow.revision,
    source_session: {
      id: input.source_session_id,
      excerpt: `Engagement ${input.engagement.reference}: ${input.engagement.summary}`,
    },
  });
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO partner_handoffs
       (workspace_id, from_team_id, to_team_id, source_record_id, source_record_revision,
        invoice_record_id, invoice_record_revision, projection, source_session_id,
        requested_by, simulated, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
     RETURNING id`,
    [workspaceId, partnerships.team_id, finance.team_id, engagementRow.id, engagementRow.revision,
      invoiceRow.id, invoiceRow.revision, JSON.stringify(projection), input.source_session_id,
      requestedBy, input.simulated, input.idempotency_key],
  );
  const handoffId = inserted.rows[0]?.id;
  if (!handoffId) throw new PartnerWorkflowError('handoff_create_failed', 'Could not create the invoice-review handoff.');
  await tx.query(
    `INSERT INTO partner_workflow_executions (handoff_id, workspace_id, finance_agent_id)
     VALUES ($1,$2,$3)`,
    [handoffId, workspaceId, finance.agent_id],
  );
  const jobId = await enqueueJob(tx, workspaceId, 'partner_invoice_review', `partner-invoice-review:${handoffId}`, { handoff_id: handoffId });
  return { handoffId, jobId, created: true };
}

interface ReviewRow extends QueryResultRow {
  handoff_id: string; status: string; projection: unknown; simulated: boolean;
  source_record_id: string; source_record_revision: number;
  invoice_record_id: string; invoice_record_revision: number;
  source_session_id: string; finance_agent_id: string; finance_principal_id: string;
  invoice_data: unknown; invoice_current_revision: number; engagement_current_revision: number;
  finance_team_id: string; finance_agent_name: string;
  source_agent_id: string; source_agent_name: string;
}

interface ReviewAdmissionRow extends ReviewRow {
  finance_session_id: string | null;
  finance_run_id: string | null;
}

/**
 * Admit the visible Bot Mode-compatible Finance turn. The durable handoff and
 * deterministic checks remain authoritative; the model only inspects and
 * explains their result after the surrounding transaction commits.
 */
export async function preparePartnerInvoiceReviewModelTurn(
  tx: Tx,
  env: Env,
  workspaceId: string,
  handoffId: string,
  jobIds: string[],
): Promise<RunInstanceParams | null> {
  const { rows } = await tx.query<ReviewAdmissionRow>(
    `SELECT h.id AS handoff_id, h.status, h.projection, h.simulated,
            h.source_record_id, h.source_record_revision,
            h.invoice_record_id, h.invoice_record_revision, h.source_session_id,
            e.finance_agent_id, e.finance_session_id, e.finance_run_id,
            finance_eta.principal_user_id AS finance_principal_id,
            invoice.data AS invoice_data, invoice.revision AS invoice_current_revision,
            engagement.revision AS engagement_current_revision,
            finance_eta.team_id AS finance_team_id, finance_agent.name AS finance_agent_name,
            source_eta.agent_id AS source_agent_id, source_agent.name AS source_agent_name
       FROM partner_handoffs h
       JOIN partner_workflow_executions e ON e.handoff_id=h.id AND e.workspace_id=h.workspace_id
       JOIN enterprise_team_agents finance_eta
         ON finance_eta.workspace_id=h.workspace_id AND finance_eta.agent_id=e.finance_agent_id
        AND finance_eta.team_id=h.to_team_id
       JOIN agents finance_agent
         ON finance_agent.workspace_id=finance_eta.workspace_id AND finance_agent.id=finance_eta.agent_id
       JOIN enterprise_team_agents source_eta
         ON source_eta.workspace_id=h.workspace_id AND source_eta.team_id=h.from_team_id
       JOIN agents source_agent
         ON source_agent.workspace_id=source_eta.workspace_id AND source_agent.id=source_eta.agent_id
       JOIN partner_records invoice ON invoice.workspace_id=h.workspace_id AND invoice.id=h.invoice_record_id
       JOIN partner_records engagement ON engagement.workspace_id=h.workspace_id AND engagement.id=h.source_record_id
      WHERE h.workspace_id=$1 AND h.id=$2 FOR UPDATE OF h, e`,
    [workspaceId, handoffId],
  );
  const row = rows[0];
  if (!row) throw new PartnerWorkflowError('handoff_not_found', 'No such invoice-review handoff.');
  if (row.simulated) return null;
  if (['completed', 'needs_information', 'stale', 'failed'].includes(row.status)) return null;
  // Do not spend a model call explaining a handoff whose frozen records have
  // already changed. processPartnerInvoiceReview records the stale result.
  if (row.invoice_current_revision !== row.invoice_record_revision
      || row.engagement_current_revision !== row.source_record_revision) return null;

  const projection = partnerInvoiceHandoffProjectionSchema.parse(row.projection);
  const invoice = invoicePayloadSchema.parse(row.invoice_data);
  const sourceProfile = botModeProfileSchema.parse(env.AGENT_RUNTIME === 'hermes'
    ? (await resolveRuntimeBinding(env, tx, workspaceId, row.source_agent_id)).profile
    : fallbackBotProfile(row.source_agent_id));
  const financeBinding = env.AGENT_RUNTIME === 'hermes'
    ? await resolveRuntimeBinding(env, tx, workspaceId, row.finance_agent_id)
    : null;
  const financeProfile = botModeProfileSchema.parse(financeBinding?.profile ?? fallbackBotProfile(row.finance_agent_id));

  let session: TurnSession | undefined;
  if (row.finance_session_id) {
    session = (await tx.query<TurnSession>(
      `SELECT id, agent_id, owner_id, read_only, mode, model_id, effort
         FROM sessions WHERE workspace_id=$1 AND id=$2 AND agent_id=$3 AND owner_id=$4`,
      [workspaceId, row.finance_session_id, row.finance_agent_id, row.finance_principal_id],
    )).rows[0];
    if (!session) throw new PartnerWorkflowError('finance_session_mismatch', 'The Finance review session no longer matches its principal and agent.');
  } else {
    const settings = await tx.query<{ default_model_id: string; default_effort: string | null; default_runtime: string }>(
      `SELECT default_model_id, default_effort, default_runtime FROM workspace_settings WHERE workspace_id=$1`,
      [workspaceId],
    );
    const defaults = settings.rows[0];
    if (!defaults) throw new PartnerWorkflowError('workspace_settings_missing', 'Workspace runtime settings are missing.');
    const runtime = financeBinding
      ? (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/])/.test(financeBinding.baseUrl) ? 'local' : 'cloud')
      : defaults.default_runtime;
    session = (await tx.query<TurnSession>(
      `INSERT INTO sessions
         (workspace_id, owner_id, agent_id, title, mode, model_id, effort, runtime, context)
       VALUES ($1,$2,$3,$4,'work',$5,$6,$7,$8::jsonb)
       RETURNING id, agent_id, owner_id, read_only, mode, model_id, effort`,
      [workspaceId, row.finance_principal_id, row.finance_agent_id,
        `Invoice review · ${projection.partner.name}`, defaults.default_model_id,
        defaults.default_effort, runtime,
        JSON.stringify({ workflow: 'partner_invoice_review', handoff_id: handoffId, simulated: false })],
    )).rows[0];
    if (!session) throw new PartnerWorkflowError('finance_session_failed', 'Could not create the Finance review session.');
    await tx.query(
      `UPDATE partner_workflow_executions SET finance_session_id=$2, status='processing' WHERE handoff_id=$1`,
      [handoffId, session.id],
    );
  }

  const senderDisplay = botDisplayName(row.source_agent_name);
  const recipientDisplay = botDisplayName(row.finance_agent_name);
  const proposedBody = financeReviewBotBody({
    handoffId,
    partnerName: projection.partner.name,
    engagementReference: projection.engagement.reference,
    invoiceNumber: invoice.number,
    currency: invoice.currency,
    totalMinor: invoice.total_minor,
    payeeName: invoice.payee.name,
  });
  const proposedWire = formatBotModeAgentMessage({ display: senderDisplay, profile: sourceProfile, body: proposedBody });
  const inserted = await tx.query<{
    id: string; sender_profile: string; sender_display: string; wire_text: string;
  }>(
    `INSERT INTO partner_agent_messages
       (workspace_id, handoff_id, direction, protocol, sender_agent_id, recipient_agent_id,
        sender_profile, recipient_profile, sender_display, recipient_display, body, wire_text,
        recipient_session_id)
     VALUES ($1,$2,'handoff_to_finance',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (workspace_id, handoff_id, direction) DO NOTHING
     RETURNING id, sender_profile, sender_display, wire_text`,
    [workspaceId, handoffId, HERMES_BOT_MODE_PROTOCOL, row.source_agent_id, row.finance_agent_id,
      sourceProfile, financeProfile, senderDisplay, recipientDisplay, proposedBody, proposedWire, session.id],
  );
  const message = inserted.rows[0] ?? (await tx.query<{
    id: string; sender_profile: string; sender_display: string; wire_text: string;
  }>(
    `SELECT id, sender_profile, sender_display, wire_text
       FROM partner_agent_messages
      WHERE workspace_id=$1 AND handoff_id=$2 AND direction='handoff_to_finance'`,
    [workspaceId, handoffId],
  )).rows[0];
  if (!message) throw new PartnerWorkflowError('agent_message_failed', 'Could not persist the Finance agent handoff message.');

  const submitted = await submitTurn({
    tx,
    env,
    workspaceId,
    userId: row.finance_principal_id,
    session,
    clientTurnId: `partner-invoice-review:${handoffId}`,
    text: message.wire_text,
    jobIds,
    turnAuthor: {
      id: `bot:${botModeProfileSchema.parse(message.sender_profile)}`,
      name: botDisplayName(message.sender_display),
      is_bot: true,
    },
  });
  await tx.query(
    `UPDATE partner_agent_messages
        SET status='delivered', recipient_session_id=$2, recipient_run_id=$3,
            delivered_at=COALESCE(delivered_at,now())
      WHERE id=$1`,
    [message.id, session.id, submitted.run.id],
  );
  await tx.query(
    `UPDATE partner_workflow_executions
        SET finance_session_id=$2, finance_run_id=$3, status='processing'
      WHERE handoff_id=$1`,
    [handoffId, session.id, submitted.run.id],
  );
  await tx.query(
    `UPDATE partner_handoffs
        SET delivery_status='delivered',validation_status='checking',agent_explanation_status='running'
      WHERE workspace_id=$1 AND id=$2 AND superseded_by_handoff_id IS NULL`,
    [workspaceId, handoffId],
  );
  if (!submitted.duplicate) return submitted.create;
  if (['completed', 'error', 'stopped'].includes(submitted.run.status)) return null;
  const trace = await tx.query<{ trace_id: string }>(
    `SELECT trace_id FROM runs WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, submitted.run.id],
  );
  const traceId = trace.rows[0]?.trace_id;
  if (!traceId) throw new PartnerWorkflowError('finance_run_trace_missing', 'The Finance review run has no trace identity.');
  return {
    runId: submitted.run.id,
    workspaceId,
    sessionId: submitted.run.session_id,
    attempt: submitted.run.attempt,
    engineVersion: submitted.run.engine_version,
    traceId,
  };
}

export async function processPartnerInvoiceReview(
  tx: Tx,
  workspaceId: string,
  handoffId: string,
): Promise<'completed' | 'needs_information' | 'stale'> {
  const { rows } = await tx.query<ReviewRow>(
    `SELECT h.id AS handoff_id, h.status, h.projection, h.simulated,
            h.source_record_id, h.source_record_revision,
            h.invoice_record_id, h.invoice_record_revision, h.source_session_id,
            e.finance_agent_id, eta.principal_user_id AS finance_principal_id,
            invoice.data AS invoice_data, invoice.revision AS invoice_current_revision,
            engagement.revision AS engagement_current_revision,
            eta.team_id AS finance_team_id, a.name AS finance_agent_name,
            source_eta.agent_id AS source_agent_id, source_agent.name AS source_agent_name
       FROM partner_handoffs h
       JOIN partner_workflow_executions e ON e.handoff_id=h.id AND e.workspace_id=h.workspace_id
       JOIN enterprise_team_agents eta
         ON eta.workspace_id=h.workspace_id AND eta.agent_id=e.finance_agent_id AND eta.team_id=h.to_team_id
       JOIN agents a ON a.workspace_id=eta.workspace_id AND a.id=eta.agent_id
       JOIN enterprise_team_agents source_eta
         ON source_eta.workspace_id=h.workspace_id AND source_eta.team_id=h.from_team_id
       JOIN agents source_agent
         ON source_agent.workspace_id=source_eta.workspace_id AND source_agent.id=source_eta.agent_id
       JOIN partner_records invoice ON invoice.workspace_id=h.workspace_id AND invoice.id=h.invoice_record_id
       JOIN partner_records engagement ON engagement.workspace_id=h.workspace_id AND engagement.id=h.source_record_id
      WHERE h.workspace_id=$1 AND h.id=$2 FOR UPDATE OF h, e`,
    [workspaceId, handoffId],
  );
  const row = rows[0];
  if (!row) throw new PartnerWorkflowError('handoff_not_found', 'No such invoice-review handoff.');
  if (['completed', 'needs_information', 'stale'].includes(row.status)) return row.status as 'completed' | 'needs_information' | 'stale';
  if (row.invoice_current_revision !== row.invoice_record_revision
      || row.engagement_current_revision !== row.source_record_revision) {
    await tx.query(
      `UPDATE partner_handoffs
          SET status='stale',result_reason='Source record changed after handoff.',completed_at=now(),
              validation_status='stale',human_decision_status='not_ready',
              checks=$2::jsonb
        WHERE id=$1`,
      [handoffId, JSON.stringify([{
        code: 'engagement_authorization', status: 'stale',
        message: 'A frozen source record changed after the handoff was confirmed.',
      }])],
    );
    await tx.query(
      `UPDATE partner_workflow_executions SET status='stale', result_reason='Source record changed after handoff.' WHERE handoff_id=$1`,
      [handoffId],
    );
    return 'stale';
  }
  const governed = (await tx.query<{
    payload_hash: string; intake_payload_hash: string; expected_authorization_hash: string;
    authorization_hash: string; authorization_status: string; approval_status: string;
    valid_from: string; valid_until: string; engagement_source_status: string;
    engagement_source_deleted_at: Date | null; engagement_source_sha256: string;
    recorded_engagement_sha256: string; invoice_source_status: string;
    invoice_source_deleted_at: Date | null; invoice_source_sha256: string; recorded_invoice_sha256: string;
  }>(
    `SELECT h.payload_hash,pii.payload_hash AS intake_payload_hash,pii.expected_authorization_hash,
            pea.authorization_hash,pea.status AS authorization_status,approval.status AS approval_status,
            pea.valid_from::text,pea.valid_until::text,
            engagement_source.status AS engagement_source_status,
            engagement_source.deleted_at AS engagement_source_deleted_at,
            engagement_source.sha256 AS engagement_source_sha256,pea.source_sha256 AS recorded_engagement_sha256,
            invoice_source.status AS invoice_source_status,invoice_source.deleted_at AS invoice_source_deleted_at,
            invoice_source.sha256 AS invoice_source_sha256,pii.invoice_source_sha256 AS recorded_invoice_sha256
       FROM partner_handoffs h
       JOIN partner_invoice_intakes pii ON pii.workspace_id=h.workspace_id AND pii.handoff_id=h.id
       JOIN partner_engagement_authorizations pea
         ON pea.workspace_id=h.workspace_id AND pea.engagement_record_id=h.source_record_id
       JOIN approval_requests approval
         ON approval.workspace_id=pea.workspace_id AND approval.request_id=pea.approval_request_id
       JOIN attachments engagement_source
         ON engagement_source.workspace_id=h.workspace_id AND engagement_source.id=pea.source_attachment_id
       JOIN attachments invoice_source
         ON invoice_source.workspace_id=h.workspace_id AND invoice_source.id=pii.invoice_source_attachment_id
      WHERE h.workspace_id=$1 AND h.id=$2
      FOR SHARE OF pea,approval,engagement_source,invoice_source`,
    [workspaceId, handoffId],
  )).rows[0];
  const hasGovernedIntake = (await tx.query(
    `SELECT 1 FROM partner_invoice_intakes WHERE workspace_id=$1 AND handoff_id=$2`, [workspaceId, handoffId],
  )).rows[0];
  if (hasGovernedIntake) {
    const today = new Date().toISOString().slice(0, 10);
    const valid = governed && governed.payload_hash === governed.intake_payload_hash
      && governed.expected_authorization_hash === governed.authorization_hash
      && governed.authorization_status === 'authorized' && governed.approval_status === 'approved'
      && today >= governed.valid_from && today <= governed.valid_until
      && governed.engagement_source_status === 'ready' && !governed.engagement_source_deleted_at
      && governed.engagement_source_sha256 === governed.recorded_engagement_sha256
      && governed.invoice_source_status === 'ready' && !governed.invoice_source_deleted_at
      && governed.invoice_source_sha256 === governed.recorded_invoice_sha256;
    if (!valid) {
      const reason = 'Governed authorization or frozen source changed before Finance review.';
      await tx.query(
        `UPDATE partner_handoffs
            SET status='stale',result_reason=$2,completed_at=now(),validation_status='stale',
                human_decision_status='not_ready',checks=$3::jsonb
          WHERE id=$1`,
        [handoffId, reason, JSON.stringify([{
          code: 'engagement_authorization', status: 'stale', message: reason,
        }])],
      );
      await tx.query(
        `UPDATE partner_workflow_executions SET status='stale',result_reason=$2 WHERE handoff_id=$1`,
        [handoffId, reason],
      );
      return 'stale';
    }
  }
  const projection = partnerInvoiceHandoffProjectionSchema.parse(row.projection);
  const invoice = invoicePayloadSchema.parse(row.invoice_data);
  const settings = await tx.query<{ default_model_id: string; default_effort: string | null; default_runtime: string }>(
    `SELECT default_model_id, default_effort, default_runtime FROM workspace_settings WHERE workspace_id=$1`,
    [workspaceId],
  );
  const defaults = settings.rows[0];
  if (!defaults) throw new PartnerWorkflowError('workspace_settings_missing', 'Workspace runtime settings are missing.');
  const execution = await tx.query<{ finance_session_id: string | null; finance_run_id: string | null; request_id: string | null }>(
    `SELECT finance_session_id, finance_run_id, request_id FROM partner_workflow_executions WHERE handoff_id=$1`,
    [handoffId],
  );
  let sessionId = execution.rows[0]?.finance_session_id ?? null;
  let runId = execution.rows[0]?.finance_run_id ?? null;
  if (!sessionId || !runId) {
    if (!row.simulated) {
      throw new PartnerWorkflowError(
        'finance_model_run_required',
        'A non-simulated invoice handoff must be admitted through the Finance model-run bridge.',
      );
    }
    const session = await tx.query<{ id: string }>(
      `INSERT INTO sessions
         (workspace_id, owner_id, agent_id, title, mode, model_id, effort, runtime, context)
       VALUES ($1,$2,$3,$4,'work',$5,$6,$7,$8::jsonb)
       RETURNING id`,
      [workspaceId, row.finance_principal_id, row.finance_agent_id,
        `Invoice review · ${projection.partner.name}`, defaults.default_model_id,
        defaults.default_effort, defaults.default_runtime,
        JSON.stringify({ workflow: 'partner_invoice_review', handoff_id: handoffId, simulated: row.simulated })],
    );
    sessionId = session.rows[0]?.id ?? null;
    if (!sessionId) throw new PartnerWorkflowError('finance_session_failed', 'Could not create the Finance review session.');
    const run = await tx.query<{ id: string }>(
      `INSERT INTO runs
         (workspace_id, session_id, agent_id, status, model_id, effort, client_turn_id,
          trace_id, ended_at)
       VALUES ($1,$2,$3,'completed',$4,$5,$6,$7,now())
       RETURNING id`,
      [workspaceId, sessionId, row.finance_agent_id, defaults.default_model_id, defaults.default_effort,
        `partner-invoice-review:${handoffId}`, `partner-invoice-review:${handoffId}`],
    );
    runId = run.rows[0]?.id ?? null;
    if (!runId) throw new PartnerWorkflowError('finance_run_failed', 'Could not create the Finance review run.');
    const sourceProfile = fallbackBotProfile(row.source_agent_id);
    const financeProfile = fallbackBotProfile(row.finance_agent_id);
    const senderDisplay = botDisplayName(row.source_agent_name);
    const recipientDisplay = botDisplayName(row.finance_agent_name);
    const body = financeReviewBotBody({
      handoffId,
      partnerName: projection.partner.name,
      engagementReference: projection.engagement.reference,
      invoiceNumber: invoice.number,
      currency: invoice.currency,
      totalMinor: invoice.total_minor,
      payeeName: invoice.payee.name,
    });
    const wireText = formatBotModeAgentMessage({ display: senderDisplay, profile: sourceProfile, body });
    await tx.query(
      `INSERT INTO partner_agent_messages
         (workspace_id, handoff_id, direction, protocol, sender_agent_id, recipient_agent_id,
          sender_profile, recipient_profile, sender_display, recipient_display, body, wire_text,
          status, recipient_session_id, recipient_run_id, delivered_at)
       VALUES ($1,$2,'handoff_to_finance',$3,$4,$5,$6,$7,$8,$9,$10,$11,'delivered',$12,$13,now())
       ON CONFLICT (workspace_id, handoff_id, direction) DO NOTHING`,
      [workspaceId, handoffId, HERMES_BOT_MODE_PROTOCOL, row.source_agent_id, row.finance_agent_id,
        sourceProfile, financeProfile, senderDisplay, recipientDisplay, body, wireText, sessionId, runId],
    );
    await tx.query(
      `INSERT INTO messages (workspace_id, session_id, seq, role, text, blocks, status, run_id, turn)
       VALUES
         ($1,$2,0,'user',$3,'[]'::jsonb,'complete',$4,0),
         ($1,$2,1,'iris',$5,'[]'::jsonb,'complete',$4,0)`,
      [workspaceId, sessionId,
        wireText,
        runId,
        '[Simulated deterministic review] Checked the frozen invoice and the explicitly shared engagement projection. No model call, payment, or email was made.'],
    );
    await tx.query(`UPDATE sessions SET next_seq=2, last_activity_at=now() WHERE id=$1`, [sessionId]);
    await tx.query(
      `UPDATE partner_workflow_executions
          SET finance_session_id=$2, finance_run_id=$3, status='processing'
        WHERE handoff_id=$1`,
      [handoffId, sessionId, runId],
    );
  }
  await snapshotPartnerRunGrants(tx, workspaceId, runId, row.finance_agent_id, handoffId);
  await assertRunCapability(tx, workspaceId, runId, row.finance_agent_id,
    'partner.shared.read', 'read_shared', 'handoff', handoffId);
  await assertRunCapability(tx, workspaceId, runId, row.finance_agent_id,
    'partner.invoice.read', 'read', 'handoff', handoffId);
  await assertRunCapability(tx, workspaceId, runId, row.finance_agent_id,
    'partner.invoice.review.prepare', 'prepare_review', 'handoff', handoffId);

  const duplicateWindow = await tx.query<{ days: number }>(
    `SELECT COALESCE((config->>'duplicate_window_days')::int,365) AS days
       FROM enterprise_skill_assignments
      WHERE workspace_id=$1 AND agent_id=$2 AND skill_key='partner-invoice-review'`,
    [workspaceId, row.finance_agent_id],
  );
  const duplicate = await tx.query(
    `SELECT 1 FROM partner_records
      WHERE workspace_id=$1 AND team_id=$2 AND kind='invoice' AND id<>$3
        AND data->>'number'=$4
        AND lower(data->'payee'->>'name')=lower($5)
        AND (data->>'total_minor')::bigint=$6
        AND created_at >= now() - ($7 || ' days')::interval
      LIMIT 1`,
    [workspaceId, row.finance_team_id, row.invoice_record_id, invoice.number, invoice.payee.name,
      invoice.total_minor, String(duplicateWindow.rows[0]?.days ?? 365)],
  );
  const missing: string[] = [];
  if (projection.engagement.evidence_ids.length === 0) missing.push('engagement evidence');
  if (invoice.currency !== projection.engagement.currency) missing.push('invoice currency does not match the engagement');
  if (invoice.total_minor !== projection.engagement.authorized_total_minor) missing.push('invoice total does not match the authorized engagement amount');
  if (duplicate.rows[0]) missing.push('possible duplicate invoice');
  if (missing.length > 0) {
    const checks = [
      { code: 'engagement_authorization', status: 'passed', message: 'The handoff is bound to the frozen engagement revision.' },
      { code: 'engagement_validity', status: 'passed', message: 'The recorded engagement was valid when the intake was confirmed.' },
      { code: 'engagement_source', status: projection.engagement.evidence_ids.length ? 'passed' : 'needs_information',
        message: projection.engagement.evidence_ids.length ? 'Engagement evidence is frozen.' : 'Engagement evidence is missing.' },
      { code: 'invoice_source', status: 'passed', message: 'The invoice record is frozen to this handoff.' },
      { code: 'currency', status: invoice.currency === projection.engagement.currency ? 'passed' : 'needs_information',
        message: invoice.currency === projection.engagement.currency ? 'Invoice currency matches.' : 'Invoice currency does not match the engagement.' },
      { code: 'amount', status: invoice.total_minor === projection.engagement.authorized_total_minor ? 'passed' : 'needs_information',
        message: invoice.total_minor === projection.engagement.authorized_total_minor ? 'Invoice total matches.' : 'Invoice total does not match the authorized amount.' },
      { code: 'duplicate', status: duplicate.rows[0] ? 'needs_information' : 'passed',
        message: duplicate.rows[0] ? 'A possible duplicate invoice exists.' : 'No duplicate invoice was found in the configured window.' },
    ];
    const result = await tx.query<{ id: string }>(
      `INSERT INTO partner_records
         (workspace_id, team_id, owner_agent_id, kind, partner_id, data, evidence_ids,
          source_session_id, source_run_id, idempotency_key)
       VALUES ($1,$2,$3,'needs_information',$4,$5::jsonb,$6,$7,$8,$9)
       ON CONFLICT (workspace_id, team_id, owner_agent_id, kind, idempotency_key)
       DO UPDATE SET data=EXCLUDED.data, revision=partner_records.revision+1
       RETURNING id`,
      [workspaceId, row.finance_team_id, row.finance_agent_id, projection.partner.id,
        JSON.stringify({ handoff_id: handoffId, missing }), projection.engagement.evidence_ids,
        sessionId, runId, `invoice-review:${handoffId}:needs-information`],
    );
    const reason = missing.join('; ');
    await tx.query(
      `UPDATE partner_handoffs
          SET status='needs_information',result_reason=$2,completed_at=now(),validation_status='needs_information',
              human_decision_status='not_ready',checks=$3::jsonb,
              agent_explanation_status=CASE WHEN $4::boolean THEN 'completed' ELSE agent_explanation_status END
        WHERE id=$1`,
      [handoffId, reason, JSON.stringify(checks), row.simulated],
    );
    await tx.query(
      `UPDATE partner_workflow_executions
          SET status='needs_information', result_reason=$2, result_record_id=$3
        WHERE handoff_id=$1`,
      [handoffId, reason, result.rows[0]?.id ?? null],
    );
    return 'needs_information';
  }

  const financeSessionExcerpt = `Invoice ${invoice.number}: ${invoice.currency} ${(invoice.total_minor / 100).toFixed(2)} from ${invoice.payee.name}.`;
  const passedChecks = [
    { code: 'engagement_authorization', status: 'passed', message: 'The exact Finance-authorized engagement is current.' },
    { code: 'engagement_validity', status: 'passed', message: 'The engagement is within its recorded validity period.' },
    { code: 'engagement_source', status: 'passed', message: 'The authorized engagement evidence is frozen.' },
    { code: 'invoice_source', status: 'passed', message: 'The confirmed invoice source is frozen.' },
    { code: 'currency', status: 'passed', message: 'Invoice currency matches the engagement.' },
    { code: 'amount', status: 'passed', message: 'Invoice total matches the authorized amount.' },
    { code: 'duplicate', status: 'passed', message: 'No duplicate invoice was found in the configured window.' },
  ];
  const payload = invoicePayloadSchema.parse({
    ...invoice,
    workflow_provenance: {
      handoff_id: handoffId,
      shared_partner: {
        id: projection.partner.id,
        name: projection.partner.name,
        engagement_reference: projection.engagement.reference,
      },
      source_sessions: [
        {
          role: 'partnerships', agent_name: 'Iris', session_id: projection.source_session.id,
          run_id: (await tx.query<{ source_run_id: string }>(`SELECT source_run_id FROM partner_records WHERE id=$1`, [row.source_record_id])).rows[0]!.source_run_id,
          excerpt: projection.source_session.excerpt, simulated: row.simulated,
        },
        {
          role: 'finance', agent_name: row.finance_agent_name, session_id: sessionId,
          run_id: runId, excerpt: financeSessionExcerpt, simulated: row.simulated,
        },
      ],
      source_record_revisions: { engagement: row.source_record_revision, invoice: row.invoice_record_revision },
      checks: { duplicate: 'clear', engagement_match: 'matched', missing_context: [] },
    },
  });
  const request = await tx.query<{ id: string }>(
    `INSERT INTO requests
       (workspace_id, kind, subject_key, label, payload, status, run_id, session_id, tool_call_id)
     VALUES ($1,'invoice',$2,$3,$4::jsonb,'pending',$5,$6,$7)
     ON CONFLICT (workspace_id, subject_key) WHERE subject_key LIKE 'partner-invoice-handoff:%'
     DO NOTHING RETURNING id`,
    [workspaceId, `partner-invoice-handoff:${handoffId}`, `${projection.partner.name} · ${invoice.number}`,
      JSON.stringify(payload), runId, sessionId, `partner-invoice-review:${handoffId}`],
  );
  let requestId = request.rows[0]?.id;
  if (!requestId) {
    requestId = (await tx.query<{ id: string }>(
      `SELECT id FROM requests WHERE workspace_id=$1 AND subject_key=$2`,
      [workspaceId, `partner-invoice-handoff:${handoffId}`],
    )).rows[0]?.id;
  }
  if (!requestId) throw new PartnerWorkflowError('invoice_request_failed', 'Could not prepare the Finance decision.');
  await tx.query(
    `INSERT INTO request_audiences (workspace_id, request_id, user_id, purpose)
     VALUES ($1,$2,$3,'owner') ON CONFLICT (request_id,user_id) DO NOTHING`,
    [workspaceId, requestId, row.finance_principal_id],
  );
  const review = await tx.query<{ id: string }>(
    `INSERT INTO partner_records
       (workspace_id, team_id, owner_agent_id, kind, partner_id, data, evidence_ids,
        source_session_id, source_run_id, idempotency_key)
     VALUES ($1,$2,$3,'invoice_review',$4,$5::jsonb,$6,$7,$8,$9)
     ON CONFLICT (workspace_id, team_id, owner_agent_id, kind, idempotency_key)
     DO NOTHING RETURNING id`,
    [workspaceId, row.finance_team_id, row.finance_agent_id, projection.partner.id,
      JSON.stringify({ handoff_id: handoffId, request_id: requestId, checks: payload.workflow_provenance?.checks }),
      projection.engagement.evidence_ids, sessionId, runId, `invoice-review:${handoffId}:completed`],
  );
  const reviewId = review.rows[0]?.id ?? (await tx.query<{ id: string }>(
    `SELECT id FROM partner_records WHERE workspace_id=$1 AND team_id=$2
      AND owner_agent_id=$3 AND kind='invoice_review' AND idempotency_key=$4`,
    [workspaceId, row.finance_team_id, row.finance_agent_id, `invoice-review:${handoffId}:completed`],
  )).rows[0]?.id ?? null;
  await tx.query(
    `UPDATE partner_handoffs
        SET status='completed',result_reason='Prepared for Finance human review.',completed_at=now(),
            validation_status='passed',human_decision_status='pending',checks=$2::jsonb,
            agent_explanation_status=CASE WHEN $3::boolean THEN 'completed' ELSE agent_explanation_status END
      WHERE id=$1`,
    [handoffId, JSON.stringify(passedChecks), row.simulated],
  );
  await tx.query(
    `UPDATE partner_workflow_executions
        SET status='completed', result_reason='Prepared for Finance human review.',
            request_id=$2, result_record_id=$3
      WHERE handoff_id=$1`,
    [handoffId, requestId, reviewId],
  );
  await tx.query(
    `INSERT INTO events (workspace_id, actor_type, agent_id, kind, request_id, session_id, run_id)
     VALUES ($1,'agent',$2,'request.created',$3,$4,$5)`,
    [workspaceId, row.finance_agent_id, requestId, sessionId, runId],
  );
  return 'completed';
}
