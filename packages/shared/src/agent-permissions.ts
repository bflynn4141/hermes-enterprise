// Supported tool-operation consent, separate from guarded business decisions.
import { z } from 'zod';

export const AGENT_OPERATION_CATALOG = [
  { id: 'read_partner_information', label: 'Read partner information', description: 'View candidates and supporting program records.', tool_names: ['list_partner_candidates', 'get_partner_candidate'] },
  { id: 'save_review_notes', label: 'Save review notes', description: 'Record findings on a partner review.', tool_names: ['save_review_note'] },
  { id: 'prepare_drafts', label: 'Prepare drafts', description: 'Prepare workspace requests or proposed instructions for review.', tool_names: ['propose_request', 'propose_instruction'] },
] as const;
export const operationPermissionPatchSchema = z.object({ revision: z.number().int().nonnegative(), operation_id: z.enum(['read_partner_information', 'save_review_notes', 'prepare_drafts']), require_human_approval: z.boolean() }).strict();
export const operationApprovalDecisionSchema = z.object({ decision: z.enum(['approved', 'denied']) }).strict();
export const agentPermissionsSchema = z.object({
  agent_id: z.uuid(), revision: z.number().int().nonnegative(),
  operations: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), tool_names: z.array(z.string()), require_human_approval: z.boolean() })),
  pending_approvals: z.array(z.object({ id: z.uuid(), operation_id: z.string(), tool_name: z.string(), arguments: z.record(z.string(), z.unknown()), run_id: z.uuid(), created_at: z.string() })),
  /**
   * False when an Admin governs another member's private agent: the switches
   * are theirs to change, but waiting actions carry that agent's run content
   * and stay with the people who may read it.
   */
  pending_approvals_visible: z.boolean().default(true),
});
export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;
export function agentOperationForTool(name: string) { return AGENT_OPERATION_CATALOG.find((operation) => (operation.tool_names as readonly string[]).includes(name)); }
