import { z } from 'zod';

export const runtimeCapacityRoleSchema = z.enum(['partnerships-agent', 'finance-agent']);
export const runtimeCapacityRoleVersionSchema = z.literal('1.0.0');

export const runtimeDiscoveryGrantStatusSchema = z.enum([
  'prepared',
  'linked',
  'consumed',
  'revoked',
  'expired',
]);

export const runtimeDiscoveryGrantSchema = z.object({
  id: z.uuid(),
  preflight_agent_id: z.uuid(),
  role_template_key: runtimeCapacityRoleSchema,
  role_template_version: runtimeCapacityRoleVersionSchema,
  role: z.string().min(1),
  skill_key: z.enum(['partner-program-screening', 'partner-invoice-review']),
  skill_version: z.enum(['1.7.0', '1.0.1']),
  assignment_revision: z.number().int().nonnegative().nullable(),
  grant_revision: z.number().int().positive(),
  linked_capacity_id: z.uuid().nullable(),
  capacity_state: z.enum(['available', 'reserved', 'assigning', 'assigned', 'quarantined']).nullable(),
  status: runtimeDiscoveryGrantStatusSchema,
  expires_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
}).strict();

export const runtimeDiscoveryGrantPageSchema = z.object({
  grants: z.array(runtimeDiscoveryGrantSchema),
}).strict();

export const runtimeDiscoveryGrantCreatedSchema = z.object({
  id: z.uuid(),
  preflight_agent_id: z.uuid(),
  role_template_key: runtimeCapacityRoleSchema,
  role_template_version: runtimeCapacityRoleVersionSchema,
  bearer: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.literal('prepared'),
  expires_at: z.iso.datetime(),
  created_at: z.iso.datetime(),
}).strict();

export const runtimeDiscoveryGrantInputSchema = z.object({
  preflight_agent_id: z.uuid(),
  role_template_key: runtimeCapacityRoleSchema,
}).strict();

export const runtimeDiscoveryGrantRevokedSchema = z.object({
  id: z.uuid(),
  status: z.literal('revoked'),
}).strict();

export const hermesCapacitySchema = z.object({
  id: z.uuid(),
  cloud_agent_id: z.string().min(1),
  instance_name: z.string().min(1),
  preflight_agent_id: z.uuid(),
  state: z.literal('available'),
  plugin_version: z.string().min(1),
  agentcash_enabled: z.boolean(),
  agentcash_wallet_present: z.boolean(),
  native_cron_disabled: z.boolean(),
  verified_at: z.iso.datetime(),
  discovery_grant_id: z.uuid(),
  role_template_key: runtimeCapacityRoleSchema,
  role_template_version: runtimeCapacityRoleVersionSchema,
}).strict();

export const hermesCapacityInputSchema = z.object({
  cloud_agent_id: z.string().trim().min(1).max(200),
  instance_name: z.string().trim().min(1).max(120),
  connector_url: z.url().max(2048).refine((raw) => {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  }, 'Use a clean HTTPS URL without credentials, query parameters, or a fragment.'),
  control_secret: z.string().min(24).max(500),
  preflight_agent_id: z.uuid(),
  discovery_grant_id: z.uuid(),
}).strict();

export type RuntimeDiscoveryGrant = z.infer<typeof runtimeDiscoveryGrantSchema>;
export type RuntimeDiscoveryGrantCreated = z.infer<typeof runtimeDiscoveryGrantCreatedSchema>;
export type RuntimeDiscoveryGrantInput = z.input<typeof runtimeDiscoveryGrantInputSchema>;
export type RuntimeCapacityRole = z.infer<typeof runtimeCapacityRoleSchema>;
export type HermesCapacity = z.infer<typeof hermesCapacitySchema>;
export type HermesCapacityInput = z.input<typeof hermesCapacityInputSchema>;

export function runtimeGrantStatusLabel(grant: Pick<RuntimeDiscoveryGrant, 'status' | 'capacity_state'>): string {
  switch (grant.status) {
    case 'prepared': return 'Prepared';
    case 'linked':
      switch (grant.capacity_state) {
        case 'available': return 'Verified and available';
        case 'reserved': return 'Reserved';
        case 'assigning': return 'Assigning';
        case 'assigned': return 'Assigned';
        case 'quarantined': return 'Quarantined';
        default: return 'Linked';
      }
    case 'consumed': return 'Assigned';
    case 'revoked': return 'Revoked';
    case 'expired': return 'Expired';
  }
}
