// Workspace roles: the jobs people and agents hold, as data.
//
// Roles-and-agents plan, piece 2 (docs/ROLES-AND-AGENTS-PLAN.md). A role is a
// named responsibility in one workspace. Holding one is what reviewer tags used
// to be: the Finance role is what lets a person decide partner invoices and
// confirm payments, the Access reviewer role what lets them grant access. So
// membership is stored where the tags were, as role slugs in
// `members.reviewer_roles`, and every existing check reads it unchanged.
//
// Many people may hold a role. Each agent still acts for one principal, and a
// handoff lane (Partnerships → Finance) still names one person and one agent
// per side; generalising lanes is piece 5.
import { z } from 'zod';
import { uuidSchema } from './events.js';

/**
 * The agent setups a role can give its agents. Skills are a vetted catalog the
 * runtime attests byte for byte, so this list lives in code, not in a form.
 */
export const ROLE_AGENT_TEMPLATES = ['partnerships-agent', 'finance-agent'] as const;
export type RoleAgentTemplate = (typeof ROLE_AGENT_TEMPLATES)[number];

/** Roles every workspace starts with; their slugs are referenced in code. */
export const BUILTIN_ROLE_SLUGS = ['partnerships', 'finance', 'access', 'legal', 'shared_intelligence_reviewer'] as const;
export type BuiltinRoleSlug = (typeof BUILTIN_ROLE_SLUGS)[number];

/** Lowercase, starting with a letter; underscores kept for existing tags. */
export const roleSlugSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);

const personSchema = z.object({
  user_id: uuidSchema,
  name: z.string().max(200),
}).strict();

export const workspaceRoleSchema = z.object({
  id: uuidSchema,
  slug: roleSlugSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  /** Built-in roles keep their name; their description is editable. */
  builtin: z.boolean(),
  agent_template: z.enum(ROLE_AGENT_TEMPLATES).nullable(),
  /** Everyone who holds the role, in name order. */
  members: z.array(personSchema).max(500),
  /** Agents bound to this role's handoff lane, with the person each acts for. */
  agents: z.array(z.object({ agent_id: uuidSchema, name: z.string().max(200), principal: personSchema }).strict()).max(50),
}).strict();
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const workspaceRoleListSchema = z.object({ items: z.array(workspaceRoleSchema).max(200) }).strict();
export type WorkspaceRoleList = z.infer<typeof workspaceRoleListSchema>;

export const workspaceRoleCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
}).strict();
export type WorkspaceRoleCreate = z.infer<typeof workspaceRoleCreateSchema>;

export const workspaceRolePatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
}).strict();
export type WorkspaceRolePatch = z.infer<typeof workspaceRolePatchSchema>;

/** Replaces who holds the role. */
export const workspaceRoleMembersSchema = z.object({
  user_ids: z.array(uuidSchema).max(500),
}).strict();
export type WorkspaceRoleMembers = z.infer<typeof workspaceRoleMembersSchema>;
