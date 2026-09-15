// Document payload schemas.
//
// `propose_request` must emit a payload matching the schema for its kind, or
// the tool returns a validation error and no row is written. The reason is not
// tidiness: the invoice viewer lets the human select a line and ask about it,
// and the agreement viewer renders numbered sections, so a payload the client
// cannot render is a request the human cannot review — and an unreviewable
// request is an unmakeable decision.
//
// Money is stored in minor units (cents) as an integer. Floating point dollars
// would make 1200.00 and 1199.999999 the same approval.
import { z } from 'zod';
import { REQUEST_KINDS, type RequestKind } from './enums.js';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected an ISO 8601 date (YYYY-MM-DD)');

/** ISO 4217, upper case. The pilot only ever renders; it never converts. */
const currency = z.string().regex(/^[A-Z]{3}$/, 'expected an ISO 4217 currency code');

const party = z
  .object({
    name: z.string().min(1).max(200),
    email: z.email().max(320).optional(),
    address: z.string().max(500).optional(),
  })
  .strict();

export const invoiceLineSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(300),
    /** Short label for the composer chip when a line is selected. */
    short: z.string().min(1).max(80).optional(),
    qty: z.number().int().positive().max(10_000),
    /** Minor units, e.g. 90000 for $900.00. */
    amount_minor: z.number().int().min(0).max(1_000_000_000),
    date: isoDate.optional(),
    /** Where the line came from, so the reviewer can check it. */
    source_ids: z.array(z.string().min(1).max(64)).max(20).default([]),
  })
  .strict();

export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

export const invoicePayloadSchema = z
  .object({
    kind: z.literal('invoice'),
    number: z.string().min(1).max(64),
    currency,
    payee: party,
    payer: party,
    issue_date: isoDate,
    due_date: isoDate,
    work_period: z.object({ from: isoDate, to: isoDate }).strict().optional(),
    lines: z.array(invoiceLineSchema).min(1).max(200),
    total_minor: z.number().int().min(0).max(1_000_000_000),
    notes: z.string().max(4000).optional(),
  })
  .strict()
  .refine(
    (v) => v.lines.reduce((sum, line) => sum + line.qty * line.amount_minor, 0) === v.total_minor,
    { message: 'total_minor must equal the sum of qty * amount_minor over the lines', path: ['total_minor'] },
  )
  .refine((v) => v.due_date >= v.issue_date, {
    message: 'due_date cannot precede issue_date',
    path: ['due_date'],
  });

export type InvoicePayload = z.infer<typeof invoicePayloadSchema>;

export const agreementSectionSchema = z
  .object({
    id: z.string().min(1).max(64),
    heading: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000),
    source_ids: z.array(z.string().min(1).max(64)).max(20).default([]),
  })
  .strict();

export const agreementPayloadSchema = z
  .object({
    kind: z.literal('agreement'),
    number: z.string().min(1).max(64),
    version_label: z.string().min(1).max(32),
    parties: z.array(party).min(2).max(10),
    effective_dates: z.object({ from: isoDate, to: isoDate }).strict().optional(),
    currency: currency.optional(),
    total_minor: z.number().int().min(0).max(1_000_000_000).optional(),
    sections: z.array(agreementSectionSchema).min(1).max(100),
  })
  .strict();

export type AgreementPayload = z.infer<typeof agreementPayloadSchema>;

/**
 * An application is a request too, but it produces no document; its payload is
 * the evidence report the human reads before admitting. Scores are integers out
 * of a stated maximum so the UI never invents a denominator, and every criterion
 * cites its sources. `missing` is what the model could not find: naming it is
 * what lets the reviewer see the gap instead of trusting the total.
 */
export const applicationPayloadSchema = z
  .object({
    kind: z.literal('application'),
    applicant: z
      .object({ name: z.string().min(1).max(200), email: z.email().max(320).optional(), title: z.string().max(200).optional() })
      .strict(),
    proposed_role: z.string().min(1).max(120),
    score: z.number().int().min(0).max(100),
    score_max: z.number().int().positive().max(1000).default(100),
    criteria: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            label: z.string().min(1).max(120),
            points: z.number().int().min(0).max(1000),
            points_max: z.number().int().positive().max(1000),
            evidence: z.string().max(4000).default(''),
            source_ids: z.array(z.string().min(1).max(64)).max(20).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    sources: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(200),
            note: z.string().max(2000).default(''),
            url: z.url().max(2048).optional(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    missing: z.array(z.string().min(1).max(200)).max(50).default([]),
  })
  .strict();

export type ApplicationPayload = z.infer<typeof applicationPayloadSchema>;

export const documentPayloadSchema = z.discriminatedUnion('kind', [
  invoicePayloadSchema,
  agreementPayloadSchema,
]);
export type DocumentPayload = z.infer<typeof documentPayloadSchema>;

export const requestPayloadSchema = z.discriminatedUnion('kind', [
  applicationPayloadSchema,
  invoicePayloadSchema,
  agreementPayloadSchema,
]);
export type RequestPayload = z.infer<typeof requestPayloadSchema>;

const PAYLOAD_BY_KIND = {
  application: applicationPayloadSchema,
  invoice: invoicePayloadSchema,
  agreement: agreementPayloadSchema,
} as const satisfies Record<RequestKind, unknown>;

/** Validate a proposed payload against the schema for its request kind. */
export function parseRequestPayload(kind: RequestKind, payload: unknown): RequestPayload {
  if (!REQUEST_KINDS.includes(kind)) throw new Error(`unknown request kind: ${String(kind)}`);
  return PAYLOAD_BY_KIND[kind].parse(payload) as RequestPayload;
}

export const DOCUMENT_RENDER_STATUSES = ['pending', 'ready', 'failed', 'missing'] as const;
export type DocumentRenderStatus = (typeof DOCUMENT_RENDER_STATUSES)[number];
