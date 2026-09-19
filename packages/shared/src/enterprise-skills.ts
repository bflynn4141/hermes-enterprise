import { z } from 'zod';
import { uuidSchema } from './events.js';

export const enterpriseSkillConfigFieldSchema = z.object({
  path: z.string().min(1).max(160).regex(/^[a-z][a-z0-9_.]*$/),
  label: z.string().min(1).max(120),
  description: z.string().max(500),
  kind: z.enum(['text', 'string_list', 'integer', 'select']),
  required: z.boolean(),
  minimum: z.number().int().nullable(),
  maximum: z.number().int().nullable(),
  options: z.array(z.object({ value: z.string().max(120), label: z.string().max(120) }).strict()).max(20),
}).strict();
export type EnterpriseSkillConfigField = z.infer<typeof enterpriseSkillConfigFieldSchema>;

export const enterpriseSkillScheduleSchema = z.object({
  enabled: z.boolean(),
  interval_minutes: z.number().int().min(5).max(1440),
}).strict();
export type EnterpriseSkillSchedule = z.infer<typeof enterpriseSkillScheduleSchema>;

export const enterpriseSkillAssignmentSchema = z.object({
  id: uuidSchema,
  agent_id: uuidSchema,
  agent_name: z.string().min(1).max(120).nullable().default(null),
  team: z.object({
    id: uuidSchema,
    slug: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
  }).strict().nullable().default(null),
  skill_key: z.string().min(1).max(120),
  runtime_name: z.string().min(1).max(180),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(32),
  artifact_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable().default(null),
  description: z.string().max(2000),
  state: z.enum(['active', 'paused']),
  revision: z.number().int().positive(),
  config: z.record(z.string(), z.unknown()),
  capability_grants: z.array(z.string().min(1).max(120)).max(64),
  schedule: enterpriseSkillScheduleSchema,
  human_review_required: z.boolean(),
  config_fields: z.array(enterpriseSkillConfigFieldSchema).max(40),
  updated_at: z.iso.datetime({ offset: true }),
}).strict();
export type EnterpriseSkillAssignment = z.infer<typeof enterpriseSkillAssignmentSchema>;

export const enterpriseSkillAssignmentPageSchema = z.object({
  items: z.array(enterpriseSkillAssignmentSchema).max(100),
  cursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
}).strict();

export const enterpriseSkillAssignmentUpdateSchema = z.object({
  revision: z.number().int().positive(),
  state: z.enum(['active', 'paused']).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  schedule: enterpriseSkillScheduleSchema.optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== 'revision'), { message: 'at least one assignment field is required' });
export type EnterpriseSkillAssignmentUpdate = z.infer<typeof enterpriseSkillAssignmentUpdateSchema>;

export const enterpriseSkillAssignmentCreateSchema = z.object({
  skill_key: z.string().min(1).max(120),
  skill_version: z.string().min(1).max(32),
  team_id: uuidSchema,
  config: z.record(z.string(), z.unknown()),
  capability_grants: z.array(z.string().min(1).max(120)).max(64),
  schedule: enterpriseSkillScheduleSchema.default({ enabled: false, interval_minutes: 360 }),
}).strict();
export type EnterpriseSkillAssignmentCreate = z.infer<typeof enterpriseSkillAssignmentCreateSchema>;
