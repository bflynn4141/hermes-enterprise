// Uploads: what an attachment is on the wire.
//
// Additive to `entities.ts`, which already had `attachmentRefSchema` (the
// compact form a message carries) and `attachmentPresignSchema` (a viewer URL).
// What was missing is the row itself, and the shape the engine's turns route
// accepts when a turn names attachment ids:
//
//     { id, name, size, mime, sha256, status }
//
// One schema, used by the upload route's response, by the metadata route and by
// whatever the turn echoes back, so a client that can render one can render all
// three. `agent_files` (Context sources) reuse the same storage and extraction
// path and therefore the same shape, with `kind` saying which table the row
// lives in.
import { z } from 'zod';
import { uuidSchema } from './events.js';

/**
 * The three types a workspace may upload. The list is short on purpose: every
 * one of them has a text extraction path, and a type with no extraction path is
 * a file the agent can see the name of and nothing else.
 */
export const ATTACHMENT_MIMES = ['application/pdf', 'text/markdown', 'text/plain'] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIMES)[number];
export const attachmentMimeSchema = z.enum(ATTACHMENT_MIMES);

/** 20 MB, the plan's cutoff, and the same number the `extract` consumer refuses above. */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** How long a presigned PUT is good for. */
export const ATTACHMENT_PRESIGN_SECONDS = 15 * 60;

/** How long a presigned GET for the viewer is good for. Shorter: it is a read. */
export const ATTACHMENT_VIEW_SECONDS = 5 * 60;

/**
 * `uploading` is a row with no bytes behind it yet; `ready` means the object
 * was streamed back, sniffed against the declared type and hashed. Nothing
 * reads an attachment that is not `ready`.
 */
export const ATTACHMENT_STATUSES = ['uploading', 'ready', 'failed', 'deleted'] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];
export const attachmentStatusSchema = z.enum(ATTACHMENT_STATUSES);

/** Extraction is a separate state machine: bytes can be fine and the text not. */
export const ATTACHMENT_EXTRACTION_STATUSES = ['pending', 'ready', 'failed'] as const;
export type AttachmentExtractionStatus = (typeof ATTACHMENT_EXTRACTION_STATUSES)[number];
export const attachmentExtractionStatusSchema = z.enum(ATTACHMENT_EXTRACTION_STATUSES);

/** Which table the row lives in. Both use the same bucket and the same queue. */
export const attachmentKindSchema = z.enum(['attachment', 'agent_file']);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

/** The shape a turn accepts and a list renders. */
export const attachmentSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(255),
    size: z.number().int().min(0).max(ATTACHMENT_MAX_BYTES),
    mime: attachmentMimeSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    status: attachmentStatusSchema,
  })
  .strict();
export type Attachment = z.infer<typeof attachmentSchema>;

/** Everything the viewer and the Context list show, on top of the wire shape. */
export const attachmentDetailSchema = attachmentSchema
  .extend({
    kind: attachmentKindSchema,
    extraction_status: attachmentExtractionStatusSchema,
    extraction_error: z.string().max(1000).nullable(),
    text_length: z.number().int().min(0).nullable(),
    token_estimate: z.number().int().min(0).nullable(),
    created_at: z.iso.datetime({ offset: true }),
    /** A short-lived presigned GET, when one could be minted. */
    url: z.string().max(2000).nullable(),
    url_expires_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type AttachmentDetail = z.infer<typeof attachmentDetailSchema>;

/**
 * What `POST /attachments` answers: the row, plus where to put the bytes.
 *
 * `method` is always PUT. `url` is a presigned S3 URL in a deployed
 * environment and this Worker's own dev-only direct-upload route when the S3
 * credentials are absent, which is why the client is told the URL rather than
 * constructing one.
 */
export const attachmentUploadSchema = z
  .object({
    attachment: attachmentSchema,
    upload: z
      .object({
        method: z.literal('PUT'),
        url: z.string().max(2000),
        expires_at: z.iso.datetime({ offset: true }),
        headers: z.record(z.string(), z.string()),
        /** true when the URL is this Worker's dev-only route, not R2's. */
        direct: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;

/** The declaration the client sends. `size` is checked against the object later. */
export const attachmentDeclarationSchema = z
  .object({
    name: z.string().min(1).max(255),
    size: z.number().int().min(1).max(ATTACHMENT_MAX_BYTES),
    mime: attachmentMimeSchema,
    session_id: uuidSchema.nullish(),
    agent_id: uuidSchema.nullish(),
  })
  .strict();
export type AttachmentDeclaration = z.infer<typeof attachmentDeclarationSchema>;

/**
 * The cap on one `get_document_text` call.
 *
 * A tool result is model input, and 20 MB of extracted text is not a tool
 * result, it is a bill. The tool pages instead: each call returns at most this
 * many estimated tokens and the offset to ask for next.
 */
export const MAX_DOCUMENT_TEXT_TOKENS = 6000;

/** Four characters to a token. Deliberately crude; it only has to bound a page. */
export const CHARS_PER_TOKEN = 4;

export const documentTextSchema = z
  .object({
    id: uuidSchema,
    name: z.string().max(255),
    text: z.string(),
    /** Character offset this page starts at. */
    offset: z.number().int().min(0),
    /** Character offset to pass for the next page, or null at the end. */
    next_offset: z.number().int().min(0).nullable(),
    token_estimate: z.number().int().min(0),
    total_length: z.number().int().min(0),
    truncated: z.boolean(),
  })
  .strict();
export type DocumentText = z.infer<typeof documentTextSchema>;
