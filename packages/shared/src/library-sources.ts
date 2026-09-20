import { z } from 'zod';

/** A human-authored, versioned reference shared with explicit Enterprise teams. */
export const librarySourceSchema = z
  .object({
    id: z.uuid(),
    version_id: z.uuid(),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(500),
    version: z.number().int().positive(),
    version_label: z.string().trim().min(1).max(40),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    content_markdown: z.string().min(1).max(50_000),
    audiences: z.array(z.enum(['Partnerships', 'Finance'])).min(1).max(2),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    kind: z.literal('library_source'),
  })
  .strict();

export type LibrarySource = z.infer<typeof librarySourceSchema>;
