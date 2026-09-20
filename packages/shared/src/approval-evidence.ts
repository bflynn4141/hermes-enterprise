import { z } from 'zod';
import { uuidSchema } from './events.js';

/** A read-only projection of one stored record cited by the current approval. */
export const approvalEvidenceViewSchema = z.object({
  id: uuidSchema,
  kind: z.enum(['partner_source', 'contact_verification', 'mailbox_thread']),
  label: z.string().min(1).max(200),
  note: z.string().max(2000).nullable(),
  source_url: z.url().max(2000).nullable(),
  fetched_at: z.iso.datetime({ offset: true }).nullable(),
  source_updated_at: z.iso.datetime({ offset: true }).nullable(),
  verified_at: z.iso.datetime({ offset: true }).nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  facts: z.array(z.object({
    label: z.string().min(1).max(200),
    value: z.string().min(1).max(2000),
  }).strict()).max(40),
}).strict();

export type ApprovalEvidenceView = z.infer<typeof approvalEvidenceViewSchema>;
