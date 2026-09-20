// Human-authored factual context is versioned separately from instructions.
import { z } from 'zod';
export const contextNoteInputSchema = z
  .object({ title: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(2000) })
  .strict();
export const contextNoteUpdateSchema = contextNoteInputSchema.extend({
  expected_revision: z.number().int().positive(),
});
export const contextNoteSchema = contextNoteInputSchema.extend({
  id: z.uuid(),
  agent_id: z.uuid(),
  revision: z.number().int().positive(),
  author_id: z.uuid().nullable(),
  author_name: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  origin: z.literal('human'),
  scope: z.literal('future'),
});
export type ContextNote = z.infer<typeof contextNoteSchema>;
export const selectedSourceSchema = z
  .object({
    id: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(['agent_file', 'library_source']),
  })
  .strict();
export const selectedSourcesSchema = z
  .array(selectedSourceSchema)
  .max(5)
  .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, 'Duplicate source');
export const MAX_CONTEXT_SOURCE_CHARS = 24000;
export const MAX_CONTEXT_NOTES = 20;
