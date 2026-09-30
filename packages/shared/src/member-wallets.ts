import { z } from 'zod';

export const memberWalletOperationKindSchema = z.enum(['create_wallet', 'grant_payment_review', 'revoke_payment_review']);
export const memberWalletOperationStatusSchema = z.enum(['awaiting_owner_review', 'expired', 'cancelled', 'changed', 'submitting', 'outcome_unknown', 'completed', 'rejected']);
export const memberWalletProposalInputSchema = z.object({ kind: memberWalletOperationKindSchema }).strict();
const encoded = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const memberWalletStampSchema = z.object({
  credentialId: encoded.min(16).max(1366), authenticatorData: encoded.min(49).max(4096),
  clientDataJson: encoded.min(1).max(8192), signature: encoded.min(1).max(1024),
}).strict();
export const memberWalletSubmitSchema = z.object({
  proposal_hash: z.string().regex(/^[0-9a-f]{64}$/), stamp: memberWalletStampSchema,
}).strict();
export const memberWalletOperationSchema = z.object({
  id: z.uuid(), kind: memberWalletOperationKindSchema, status: memberWalletOperationStatusSchema,
  proposal_hash: z.string(), version: z.literal(1), expires_at: z.iso.datetime(), created_at: z.iso.datetime(),
  requested_by: z.uuid(), summary: z.string(),
  /** Present only for the current owner and only while the proposal is live. Never edit these bytes. */
  request: z.object({ body: z.string(), challenge: z.string(), rp_id: z.string(), credential_id: z.string() }).nullable(),
});
export const memberWalletAccessSchema = z.object({
  member_id: z.uuid(), wallet_status: z.enum(['not_created', 'awaiting_owner_review', 'ready']),
  address: z.string().nullable(), payment_review: z.object({ allowed: z.boolean().nullable(), confirmed_at: z.iso.datetime().nullable() }),
  owner: z.object({ member_id: z.uuid(), name: z.string(), is_current_user: z.boolean() }).nullable(),
  capability: z.object({ available: z.boolean(), reason: z.enum(['wallets_disabled', 'owner_setup_required', 'owner_operations_not_configured']).nullable() }),
  payment_capability: z.object({ available: z.literal(false), reason: z.literal('member_authenticator_and_policy_required') }),
  operation: memberWalletOperationSchema.nullable(), can_manage: z.boolean(),
});
export type MemberWalletAccess = z.infer<typeof memberWalletAccessSchema>;
export type MemberWalletOperation = z.infer<typeof memberWalletOperationSchema>;
export type MemberWalletStamp = z.infer<typeof memberWalletStampSchema>;
