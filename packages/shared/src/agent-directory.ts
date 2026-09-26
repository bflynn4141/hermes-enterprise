// The Admin agent directory: every agent in a workspace, described by what it
// is allowed to do, never by what it has done.
//
// An Admin governs agents (role, skills, which operations need a person's
// approval) but does not read another member's conversations. So this contract
// carries configuration and placement only. There is deliberately no field for
// sessions, messages, runs, traces, tool arguments or results, and the schema
// is strict so a server change cannot quietly add one.
import { z } from 'zod';
import { uuidSchema } from './events.js';

const personSchema = z.object({
  member_id: uuidSchema.nullable(),
  user_id: uuidSchema,
  name: z.string().max(200),
}).strict();

export const agentDirectoryRoleSchema = z.object({
  team: z.object({ slug: z.string().min(1).max(80), name: z.string().min(1).max(120) }).strict(),
  role_template_key: z.string().min(1).max(80),
  principal: personSchema,
}).strict();
export type AgentDirectoryRole = z.infer<typeof agentDirectoryRoleSchema>;

export const agentDirectorySkillSchema = z.object({
  assignment_id: uuidSchema,
  skill_key: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(32),
  state: z.enum(['active', 'paused']),
}).strict();

/**
 * Where the agent runs, as a label. Hostnames, connector URLs and credentials
 * stay on the server: an instance name is enough to tell two pools apart.
 */
export const agentDirectoryRuntimeSchema = z.object({
  /**
   * `cloud_capacity`: a Hermes Cloud instance from the workspace's registered
   * pool. `cloud_provisioned`: a Cloud instance created for this agent.
   * `deployment`: a runtime the operator configured for this deployment.
   */
  source: z.enum(['cloud_capacity', 'cloud_provisioned', 'deployment', 'none']),
  label: z.string().max(200).nullable(),
  state: z.enum(['connected', 'setting_up', 'failed', 'not_connected']),
}).strict();
export type AgentDirectoryRuntime = z.infer<typeof agentDirectoryRuntimeSchema>;

export const agentDirectoryEntrySchema = z.object({
  id: uuidSchema,
  name: z.string().max(120),
  responsibility: z.string().max(2000).nullable(),
  status: z.enum(['draft', 'provisioning', 'started']),
  context_scope: z.enum(['private', 'workspace']),
  owner: personSchema.nullable(),
  role: agentDirectoryRoleSchema.nullable(),
  skills: z.array(agentDirectorySkillSchema).max(40),
  runtime: agentDirectoryRuntimeSchema,
  approvals: z.object({
    revision: z.number().int().nonnegative(),
    /** Operations that currently wait for a person before the agent acts. */
    required: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(120) }).strict()).max(40),
  }).strict(),
  viewer: z.object({
    /** Role, skills and approval switches. Every Admin may change these. */
    can_configure: z.boolean(),
    /**
     * Whether this viewer may also read the agent's own work (pending action
     * arguments, sessions). False for another member's private agent, even
     * for an Admin.
     */
    can_view_conversations: z.boolean(),
  }).strict(),
}).strict();
export type AgentDirectoryEntry = z.infer<typeof agentDirectoryEntrySchema>;

export const agentDirectorySchema = z.object({
  items: z.array(agentDirectoryEntrySchema).max(500),
  total: z.number().int().nonnegative(),
}).strict();
export type AgentDirectory = z.infer<typeof agentDirectorySchema>;
