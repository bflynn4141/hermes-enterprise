// Response shapes for the routes M1 actually serves.
//
// The bootstrap shape is the whole workspace state the client hydrates from. It
// is defined now, empty, so that the reducer port in M2 has a target and so the
// replay contract (`head` plus `after`) is exercised from the first route.
import { z } from 'zod';
import { streamEventSchema, streamIdSchema, uuidSchema } from './events.js';
import { memberRoleSchema, requestKindSchema, requestStatusSchema, sessionModeSchema } from './enums.js';
import { memberRoleTemplateSchema } from './member-provisioning.js';
import { refSchema } from './refs.js';

export const agentProvisioningStatusSchema = z.enum([
  'getting_ready', 'ready', 'retrying',
]);
export const agentProvisioningSchema = z.object({
  status: agentProvisioningStatusSchema,
  message: z.string().max(500),
  ready_at: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export const agentProvisioningResponseSchema = z.object({ provisioning: agentProvisioningSchema.nullable() }).strict();
export type AgentProvisioning = z.infer<typeof agentProvisioningSchema>;

export const healthSchema = z
  .object({
    status: z.enum(['ok', 'degraded', 'error']),
    version: z.string(),
    checks: z.array(
      z
        .object({
          name: z.string(),
          ok: z.boolean(),
          detail: z.string(),
          duration_ms: z.number().int().min(0),
        })
        .strict(),
    ),
  })
  .strict();
export type Health = z.infer<typeof healthSchema>;

/**
 * `POST /workspaces` creates the first agent as part of the same transaction.
 * Keeping the agent fields in this contract prevents onboarding from collecting
 * configuration that the server never receives.
 */
export const workspaceCreateInputSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    jurisdiction: z.enum(['default', 'eu']).optional(),
    agent: z
      .object({
        name: z.string().trim().min(1).max(80),
        instructions: z.string().trim().min(1).max(8000),
      })
      .strict(),
  })
  .strict();
export type WorkspaceCreateInput = z.infer<typeof workspaceCreateInputSchema>;

export const bootstrapSchema = z
  .object({
    workspace: z
      .object({
        id: uuidSchema,
        name: z.string(),
        jurisdiction: z.enum(['default', 'eu']),
        settings: z
          .object({
            default_model_id: z.string(),
            default_effort: z.string().nullable(),
            default_runtime: z.enum(['cloud', 'local']),
            daily_token_cap: z.number().int().min(0).nullable(),
            max_concurrent_runs: z.number().int().min(1),
            timezone: z.string(),
            flags: z.record(z.string(), z.boolean()),
          })
          .strict(),
      })
      .strict(),
    viewer: z
      .object({ user_id: uuidSchema, role: memberRoleSchema, reviewer_roles: z.array(z.string()) })
      .strict(),
    agent: z
      .object({
        id: uuidSchema,
        name: z.string().max(80),
        /** Null until HermesMail ingress is provisioned for this agent. */
        email: z.string().max(200).nullable(),
        responsibility: z.string().max(2000).nullable(),
        setup_step: z.string().max(32).nullable(),
        provisioning_status: agentProvisioningStatusSchema.nullable().optional(),
      })
      .strict()
      .nullable(),
    capabilities: z
      .object({
        email_ingress: z.boolean(),
        turn_attachments: z.boolean(),
        automated_triggers: z.boolean(),
        /**
         * Optional only for rolling compatibility with Workers deployed before
         * this contract existed. Absence means the old legacy-delivery route;
         * current Workers always advertise one of these two explicit modes.
         */
        member_invitations: z.discriminatedUnion('mode', [
          z.object({
            mode: z.literal('legacy_delivery'),
            role_templates: z.array(memberRoleTemplateSchema).max(0),
          }).strict(),
          z.object({
            mode: z.literal('setup_only'),
            role_templates: z.array(memberRoleTemplateSchema).min(1),
          }).strict(),
        ]).optional(),
      })
      .strict(),
    /** Replay cursors: the client asks for events after these. */
    heads: z.object({ session: streamIdSchema, workspace: streamIdSchema }).strict(),
    counts: z
      .object({
        inbox: z.number().int().min(0),
        pending_grants: z.number().int().min(0),
        created_documents: z.number().int().min(0),
        decisions: z.number().int().min(0),
        pending_for_me: z.number().int().min(0).optional(),
        pending_for_others: z.number().int().min(0).optional(),
      })
      .strict(),
    sessions: z.array(
      z
        .object({
          id: uuidSchema,
          agent_id: uuidSchema,
          title: z.string(),
          mode: sessionModeSchema,
          model_id: z.string(),
          effort: z.string().nullable(),
          runtime: z.enum(['local', 'cloud']).optional(),
          pinned: z.boolean(),
          archived: z.boolean(),
          focus_ref: refSchema.nullable(),
          status: z.string(),
          last_activity_at: z.iso.datetime({ offset: true }).nullable(),
        })
        .strict(),
    ),
    requests: z.array(
      z
        .object({ id: uuidSchema, kind: requestKindSchema, status: requestStatusSchema, label: z.string() })
        .strict(),
    ),
    catalog: z.array(
      z
        .object({
          model_id: z.string(),
          label: z.string(),
          provider: z.string(),
          effort: z.array(z.string()).nullable(),
          default_effort: z.string().nullable(),
          enabled: z.boolean(),
          disabled_reason: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type Bootstrap = z.infer<typeof bootstrapSchema>;

export const eventsPageSchema = z
  .object({
    stream: z.enum(['session', 'workspace']),
    after: streamIdSchema,
    head: streamIdSchema,
    /** True when the caller must refetch bootstrap instead of applying events. */
    resync: z.boolean(),
    events: z.array(streamEventSchema).max(1000),
  })
  .strict();
export type EventsPage = z.infer<typeof eventsPageSchema>;

export const errorBodySchema = z
  .object({
    error: z.string(),
    /** Stable machine-readable reason; the client keys copy off it. */
    reason: z.string(),
    trace_id: z.string().optional(),
  })
  .strict();
export type ErrorBody = z.infer<typeof errorBodySchema>;
