// What travels on the two queues.
//
// A queue message is a contract between two deploys: the producer may be a
// version behind the consumer for as long as the backlog takes to drain, and a
// message that no longer parses must be a visible failure rather than a
// `undefined` read three lines later. So both shapes are zod schemas and both
// consumers parse before doing anything.
import { attachmentKindSchema } from '@hermes/shared';
import { z } from 'zod';

export const extractMessageSchema = z
  .object({
    workspace_id: z.uuid(),
    /** Which table the id lives in; both use the same bucket and consumer. */
    kind: attachmentKindSchema,
    id: z.uuid(),
    storage_key: z.string().min(1).max(512),
    mime: z.string().max(128),
  })
  .strict();
export type ExtractMessage = z.infer<typeof extractMessageSchema>;

/**
 * M4 fills this in. It is declared now because the queue, its dead-letter queue
 * and the consumer that writes `render_status = 'failed'` are M1 and M3.5
 * respectively, and a DLQ consumer needs to know what it is holding to write a
 * reason onto the right row.
 */
export const renderMessageSchema = z
  .object({
    workspace_id: z.uuid(),
    document_id: z.uuid(),
    /** `renders` dedupes on `(document_id, version)`, per the plan. */
    version: z.number().int().min(1),
  })
  .strict();
export type RenderMessage = z.infer<typeof renderMessageSchema>;
