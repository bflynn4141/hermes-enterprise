import { z } from 'zod';
export const walletEnrollmentInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace') }).strict(),
  z.object({ kind: z.literal('member'), member_id: z.uuid() }).strict(),
  z.object({ kind: z.literal('agent'), agent_id: z.uuid() }).strict(),
]);
export const walletRecordSchema = z.object({
  id: z.uuid(), kind: z.enum(['workspace', 'member', 'agent']),
  member_id: z.uuid().nullable(), agent_id: z.uuid().nullable(), label: z.string(),
  status: z.literal('awaiting_owner_enrollment'), address: z.null(), created_at: z.iso.datetime(),
});
export const walletOverviewSchema = z.object({
  enabled: z.boolean(), chain_id: z.literal(8453), asset: z.literal('USDC'),
  setup_status: z.enum(['not_configured', 'awaiting_owner_enrollment']),
  can_manage: z.boolean(), items: z.array(walletRecordSchema),
});
export type WalletRecord = z.infer<typeof walletRecordSchema>;
export type WalletOverview = z.infer<typeof walletOverviewSchema>;
export type WalletEnrollmentInput = z.infer<typeof walletEnrollmentInputSchema>;
