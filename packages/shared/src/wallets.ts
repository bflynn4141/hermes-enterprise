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
/**
 * Custody of the workspace's Turnkey sub-organization. `verified` means Hermes
 * read the provider back and found the Admin's passkey as the only root.
 */
export const walletRootStatusSchema = z.enum(['not_started', 'in_progress', 'needs_reconciliation', 'verified', 'needs_attention']);
export const walletRootSchema = z.object({
  status: walletRootStatusSchema,
  /** Provider setup is configured for this deployment. */
  available: z.boolean(),
  owner_name: z.string().nullable(),
  verified_at: z.iso.datetime().nullable(),
});
export const walletOverviewSchema = z.object({
  enabled: z.boolean(), chain_id: z.literal(8453), asset: z.literal('USDC'),
  setup_status: z.enum(['not_configured', 'awaiting_owner_enrollment']),
  can_manage: z.boolean(), items: z.array(walletRecordSchema),
  root: walletRootSchema,
});
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
/** What the browser needs to create the Admin's passkey. */
export const walletRootChallengeSchema = z.object({
  setup_id: z.uuid(),
  challenge: base64url.length(43),
  rp_id: z.string().min(1).max(253),
  user_handle: base64url.length(43),
  user_name: z.string().min(1).max(64),
  expires_at: z.iso.datetime(),
});
export const walletRootSubmitSchema = z.object({
  setup_id: z.uuid(),
  attestation: z.object({
    credential_id: base64url.min(16).max(1366),
    client_data_json: base64url.max(4096),
    attestation_object: base64url.max(65536),
    transports: z.array(z.enum(['internal', 'usb', 'nfc', 'ble', 'hybrid'])).max(5),
  }).strict(),
}).strict();
export const walletRootReconcileSchema = z.object({}).strict();
export type WalletRecord = z.infer<typeof walletRecordSchema>;
export type WalletOverview = z.infer<typeof walletOverviewSchema>;
export type WalletRoot = z.infer<typeof walletRootSchema>;
export type WalletRootChallenge = z.infer<typeof walletRootChallengeSchema>;
export type WalletRootSubmit = z.infer<typeof walletRootSubmitSchema>;
export type WalletEnrollmentInput = z.infer<typeof walletEnrollmentInputSchema>;
