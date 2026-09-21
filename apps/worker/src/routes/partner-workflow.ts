import type { Context } from 'hono';
import {
  partnerEngagementAuthorizationInputSchema,
  partnerEngagementAuthorizationResultSchema,
  partnerHandoffResultSchema,
  partnerInvoiceCorrectionInputSchema,
  partnerInvoiceCorrectionResultSchema,
  partnerInvoiceIntakeInputSchema,
  partnerInvoiceIntakeResultSchema,
  partnerWorkflowAdmissionInputSchema,
  partnerWorkflowSetupSchema,
  partnerWorkflowViewV2Schema,
} from '@hermes/shared';
import { requireCsrf, requireOrigin } from '../auth.js';
import type { Env } from '../env.js';
import { configurePartnerWorkflow, PartnerWorkflowError } from '../partner-workflow/service.js';
import { resolveEnterpriseSkillAssignment } from '../enterprise-skills/service.js';
import { HermesClient } from '../runtime/client.js';
import { resolveRuntimeBinding } from '../runtime/config.js';
import {
  enterpriseReadinessToolNames,
  matchesExactManagedEnterpriseAttestation,
} from '../runtime/readiness.js';
import { updateHandoffAdmission } from '../handoffs/service.js';
import {
  correctPartnerInvoiceIntake,
  getPartnerHandoffResult,
  loadPartnerWorkflowViewV2,
  proposePartnerEngagementAuthorization,
  submitPartnerInvoiceIntake,
} from '../partner-workflow/v2.js';
import { inWorkspace, jsonBody, pathUuid, RouteError } from './tenant.js';

type AdmissionRole = 'partnerships' | 'finance';
const ADMISSION_SKILL_KEYS = {
  partnerships: 'partner-program-screening',
  finance: 'partner-invoice-review',
} as const;
const ADMISSION_ROLE_TEMPLATE_KEYS = {
  partnerships: 'partnerships-agent',
  finance: 'finance-agent',
} as const;

export function routeError(error: unknown): never {
  if (error instanceof PartnerWorkflowError) {
    const forbidden = ['forbidden_partner_workflow_action', 'partnerships_principal_required', 'run_grant_missing'];
    const notFound = ['handoff_not_found', 'partner_not_found', 'attachment_not_accessible'];
    const conflict = error.reason.endsWith('_mismatch') || [
      'principal_already_bound', 'idempotency_conflict', 'correction_successor_exists',
      'handoff_superseded', 'handoff_already_decided', 'workflow_admission_disabled',
      'workflow_readiness_incomplete', 'authorization_revoked', 'authorization_expired',
      'authorization_superseded', 'authorization_consumed',
      'input_provenance_mismatch', 'finance_instruction_conflict',
    ].includes(error.reason);
    throw new RouteError(error.message, error.reason,
      forbidden.includes(error.reason) ? 403 : notFound.includes(error.reason) ? 404 : conflict ? 409 : 422);
  }
  throw error;
}

export async function getPartnerWorkflow(c: Context<{ Bindings: Env }>): Promise<Response> {
  const view = await inWorkspace(c, async (work) => {
    try { return await loadPartnerWorkflowViewV2(work.tx, work.workspaceId, work.userId); }
    catch (error) { return routeError(error); }
  });
  return c.json(partnerWorkflowViewV2Schema.parse(view));
}

export async function configurePartnerWorkflowRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true }); requireCsrf(c);
  const parsed = partnerWorkflowSetupSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('The two employee/agent bindings are invalid.', 'bad_partner_workflow_setup', 422);
  const view = await inWorkspace(c, async (work) => {
    work.requireAdmin('applying employee role templates');
    try {
      await configurePartnerWorkflow(work.tx, work.workspaceId, work.userId, parsed.data);
      return await loadPartnerWorkflowViewV2(work.tx, work.workspaceId, work.userId);
    } catch (error) { return routeError(error); }
  });
  return c.json(partnerWorkflowViewV2Schema.parse(view), 201);
}

export async function proposePartnerEngagement(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true }); requireCsrf(c);
  const parsed = partnerEngagementAuthorizationInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('The engagement authorization input is invalid.', 'bad_engagement_authorization', 422);
  const result = await inWorkspace(c, async (work) => {
    try { return await proposePartnerEngagementAuthorization(work.tx, c.env, work.workspaceId, work.userId, parsed.data, work.jobs); }
    catch (error) { return routeError(error); }
  });
  const body = partnerEngagementAuthorizationResultSchema.parse(result);
  return c.json(body, body.created ? 201 : 200, { 'X-Hermes-Idempotent-Replay': String(!body.created) });
}

export async function createPartnerInvoiceIntake(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true }); requireCsrf(c);
  const parsed = partnerInvoiceIntakeInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('The confirmed invoice intake is invalid.', 'bad_invoice_intake', 422);
  const result = await inWorkspace(c, async (work) => {
    try { return await submitPartnerInvoiceIntake(work.tx, c.env, work.workspaceId, work.userId, parsed.data, work.jobs); }
    catch (error) { return routeError(error); }
  });
  const body = partnerInvoiceIntakeResultSchema.parse(result);
  return c.json(body, body.created ? 201 : 200, { 'X-Hermes-Idempotent-Replay': String(!body.created) });
}

export async function correctPartnerInvoice(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true }); requireCsrf(c);
  const handoffId = pathUuid(c, 'handoffId');
  const parsed = partnerInvoiceCorrectionInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('The corrected invoice intake is invalid.', 'bad_invoice_correction', 422);
  const result = await inWorkspace(c, async (work) => {
    try { return await correctPartnerInvoiceIntake(work.tx, c.env, work.workspaceId, work.userId, handoffId, parsed.data, work.jobs); }
    catch (error) { return routeError(error); }
  });
  const body = partnerInvoiceCorrectionResultSchema.parse(result);
  return c.json(body, body.created ? 201 : 200, { 'X-Hermes-Idempotent-Replay': String(!body.created) });
}

export async function getPartnerHandoffResultRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const handoffId = pathUuid(c, 'handoffId');
  const result = await inWorkspace(c, async (work) => {
    try { return await getPartnerHandoffResult(work.tx, work.workspaceId, handoffId, { userId: work.userId }); }
    catch (error) { return routeError(error); }
  });
  return c.json(partnerHandoffResultSchema.parse(result));
}

export async function setPartnerWorkflowAdmission(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true }); requireCsrf(c);
  const parsed = partnerWorkflowAdmissionInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('The admission setting is invalid.', 'bad_partner_workflow_admission', 422);
  if (!parsed.data.enabled) {
    const view = await inWorkspace(c, async (work) => {
      work.requireAdmin('disabling new partner workflow admission');
      await updateHandoffAdmission(work.tx, work.workspaceId, { admission_state: 'disabled', enabled_by: null });
      return loadPartnerWorkflowViewV2(work.tx, work.workspaceId, work.userId);
    });
    return c.json(partnerWorkflowViewV2Schema.parse(view));
  }

  const setup = await inWorkspace(c, async (work) => {
    work.requireAdmin('enabling new partner workflow admission');
    const roles = await work.tx.query<{
      role: AdmissionRole; team_id: string; agent_id: string; principal_user_id: string;
      role_template_key: string; role_template_version: string;
      assignment_id: string; skill_key: string;
    }>(
      `SELECT et.slug AS role,eta.team_id,eta.agent_id,eta.principal_user_id,
              eta.role_template_key,eta.role_template_version,
              esa.id AS assignment_id,esa.skill_key
         FROM enterprise_team_agents eta
         JOIN enterprise_teams et ON et.workspace_id=eta.workspace_id AND et.id=eta.team_id
         JOIN enterprise_skill_assignments esa
           ON esa.workspace_id=eta.workspace_id AND esa.agent_id=eta.agent_id AND esa.team_id=eta.team_id
          AND esa.skill_key=CASE et.slug
            WHEN 'partnerships' THEN 'partner-program-screening' ELSE 'partner-invoice-review' END
        WHERE eta.workspace_id=$1 AND et.slug IN ('partnerships','finance')`,
      [work.workspaceId],
    );
    if (roles.rows.length !== 2) throw new RouteError('Configure both roles before enabling admission.', 'workflow_not_configured', 409);
    return {
      workspaceId: work.workspaceId,
      roles: await Promise.all(roles.rows.map(async (role) => {
        if (role.skill_key !== ADMISSION_SKILL_KEYS[role.role]) {
          throw new RouteError(`${role.role} does not have the reviewed multi-party assignment.`, 'workflow_readiness_incomplete', 409);
        }
        if (role.role_template_key !== ADMISSION_ROLE_TEMPLATE_KEYS[role.role]
            || role.role_template_version !== '1.0.0') {
          throw new RouteError(`${role.role} does not have the reviewed employee role binding.`, 'workflow_readiness_incomplete', 409);
        }
        const resolved = await resolveEnterpriseSkillAssignment(
          work.tx, work.workspaceId, role.agent_id, role.skill_key,
        );
        if (!resolved.assignment || resolved.problem || !resolved.config ||
            resolved.assignment.id !== role.assignment_id) {
          throw new RouteError(`${role.role} does not have the reviewed multi-party assignment.`, 'workflow_readiness_incomplete', 409);
        }
        return {
          role: role.role,
          team_id: role.team_id,
          agent_id: role.agent_id,
          principal_user_id: role.principal_user_id,
          role_template_key: role.role_template_key,
          role_template_version: role.role_template_version,
          assignment: resolved.assignment,
          binding: await resolveRuntimeBinding(c.env, work.tx, work.workspaceId, role.agent_id),
        };
      })),
    };
  });

  const checkedAt = new Date().toISOString();
  const readiness = Object.fromEntries(await Promise.all(setup.roles.map(async (role) => {
    const client = new HermesClient(role.binding.baseUrl, role.binding.apiKey, undefined, role.binding.transport);
    const [capabilities, raw] = await Promise.all([client.capabilities(), client.enterpriseReadiness()]);
    if (!capabilities.durableIdempotency ||
        !matchesExactManagedEnterpriseAttestation(raw, role.assignment, {
          workspaceId: setup.workspaceId,
          agentId: role.agent_id,
          enterpriseUrl: c.env.HERMES_ENTERPRISE_PUBLIC_URL,
          pluginRevision: c.env.HERMES_ENTERPRISE_PLUGIN_REVISION,
          pluginArtifactDigest: c.env.HERMES_ENTERPRISE_PLUGIN_SHA256,
        })) {
      throw new RouteError(`${role.role} native profile has not attested the reviewed skill and tool inventory.`, 'workflow_readiness_incomplete', 409);
    }
    const skill = raw.skills![0]!;
    const tools = enterpriseReadinessToolNames(role.assignment);
    return [role.role, {
      agent_id: role.agent_id, assignment_id: role.assignment.id, assignment_revision: role.assignment.revision,
      skill_name: skill.name, skill_version: skill.version, artifact_digest: skill.artifactDigest,
      runtime_revision: raw.runtimeRevision!, plugin_version: raw.plugin!.version,
      enterprise_url: new URL(raw.enterpriseUrl).origin,
      plugin_revision: raw.plugin!.revision!, plugin_artifact_digest: raw.plugin!.artifactDigest!,
      tool_names: tools, checked_at: checkedAt,
    }];
  })));

  const view = await inWorkspace(c, async (work) => {
    work.requireAdmin('enabling new partner workflow admission');
    for (const role of setup.roles) {
      const current = await work.tx.query<{
        revision: number; skill_version: string; state: string; digest: string;
      }>(
        `SELECT esa.revision,esa.skill_version,esa.state,art.digest
           FROM enterprise_skill_assignments esa
           JOIN enterprise_skill_artifacts art ON art.id=esa.artifact_id
           JOIN enterprise_team_agents eta
             ON eta.workspace_id=esa.workspace_id AND eta.team_id=esa.team_id AND eta.agent_id=esa.agent_id
          JOIN enterprise_teams et
             ON et.workspace_id=eta.workspace_id AND et.id=eta.team_id
          WHERE esa.workspace_id=$1 AND esa.id=$2 AND eta.team_id=$3 AND eta.agent_id=$4
            AND eta.principal_user_id=$5 AND et.slug=$6
            AND eta.role_template_key=$7 AND eta.role_template_version=$8
          FOR UPDATE OF esa,eta`,
        [work.workspaceId, role.assignment.id, role.team_id, role.agent_id,
          role.principal_user_id, role.role, role.role_template_key, role.role_template_version],
      );
      const row = current.rows[0];
      if (!row || row.revision !== role.assignment.revision || row.skill_version !== role.assignment.version
          || row.state !== 'active' || row.digest !== role.assignment.artifact_digest) {
        throw new RouteError('A role assignment changed after native readiness was checked.', 'workflow_readiness_incomplete', 409);
      }
    }
    await updateHandoffAdmission(work.tx, work.workspaceId, {
      admission_state: 'enabled',
      enabled_by: work.userId,
      readiness,
      readiness_checked_at: new Date(checkedAt),
    });
    return loadPartnerWorkflowViewV2(work.tx, work.workspaceId, work.userId);
  });
  return c.json(partnerWorkflowViewV2Schema.parse(view));
}

/** Historical handoffs remain readable. Caller-authored recipient,
 * provenance and authority are no longer accepted for new work. */
export async function createPartnerInvoiceReviewHandoff(): Promise<never> {
  throw new RouteError(
    'Use a confirmed invoice intake; recipient, provenance and authority are server-derived.',
    'legacy_handoff_input_forbidden',
    422,
  );
}
