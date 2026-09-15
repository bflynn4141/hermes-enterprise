import { describe, expect, it } from 'vitest';
import {
  CATALOG_SEED,
  DEFAULT_MODEL_ID,
  EFFECT_REQUIREMENTS,
  RESULTING_STATUS,
  agreementPayloadSchema,
  catalogRowSchema,
  invoicePayloadSchema,
  parseRequestPayload,
} from '../src/index.js';

const invoice = {
  kind: 'invoice' as const,
  number: 'PP-2026-014',
  currency: 'USD',
  payee: { name: 'Robin Ellis', email: 'robin@partner.example' },
  payer: { name: 'Nous Partner Program' },
  issue_date: '2026-10-12',
  due_date: '2026-10-26',
  work_period: { from: '2026-10-08', to: '2026-10-09' },
  lines: [
    { id: 'workshop', label: 'Implementation workshop', qty: 1, amount_minor: 90_000, date: '2026-10-08', source_ids: ['fee-schedule'] },
    { id: 'pack', label: 'Resource pack and follow-up', qty: 1, amount_minor: 30_000, date: '2026-10-09', source_ids: [] },
  ],
  total_minor: 120_000,
};

describe('document payloads', () => {
  it('accepts an invoice whose total matches its lines', () => {
    const parsed = invoicePayloadSchema.parse(invoice);
    expect(parsed.total_minor).toBe(120_000);
    expect(parsed.lines[0]?.source_ids).toEqual(['fee-schedule']);
  });

  it('rejects an invoice whose total does not match its lines', () => {
    const result = invoicePayloadSchema.safeParse({ ...invoice, total_minor: 100_000 });
    expect(result.success).toBe(false);
  });

  it('rejects a due date before the issue date', () => {
    expect(invoicePayloadSchema.safeParse({ ...invoice, due_date: '2026-10-01' }).success).toBe(false);
  });

  it('rejects an unknown field, so a tool cannot smuggle one past the viewer', () => {
    expect(invoicePayloadSchema.safeParse({ ...invoice, wire_instructions: 'IBAN ...' }).success).toBe(false);
  });

  it('accepts an agreement with numbered sections', () => {
    const parsed = agreementPayloadSchema.parse({
      kind: 'agreement',
      number: 'SA-2026-022',
      version_label: 'v1',
      parties: [{ name: 'Nous Partner Program' }, { name: 'Robin Ellis' }],
      sections: [{ id: '1', heading: '1. Services and delivery', body: 'One remote workshop on Oct 22.', source_ids: [] }],
    });
    expect(parsed.sections).toHaveLength(1);
  });

  it('dispatches on the request kind', () => {
    expect(parseRequestPayload('invoice', invoice).kind).toBe('invoice');
    expect(() => parseRequestPayload('agreement', invoice)).toThrow();
  });
});

describe('decision and effect tables', () => {
  it('keeps the demo mapping of kind plus decision to status', () => {
    expect(RESULTING_STATUS.application.approve).toBe('admitted');
    expect(RESULTING_STATUS.invoice.approve).toBe('created');
    expect(RESULTING_STATUS.agreement.approve).toBe('drafted');
    for (const kind of ['application', 'invoice', 'agreement'] as const) {
      expect(RESULTING_STATUS[kind].decline).toBe('declined');
    }
  });

  it('requires two finance reviewers for a payment', () => {
    expect(EFFECT_REQUIREMENTS.payment).toEqual({ requiredRole: 'finance', approvals: 2 });
  });
});

describe('catalog seed', () => {
  it('parses, has the four rows, and disables the two the pilot does not offer', () => {
    for (const row of CATALOG_SEED) expect(catalogRowSchema.parse(row)).toEqual(row);
    expect(CATALOG_SEED.map((r) => r.model_id)).toEqual([
      'deepseek-flash',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'gpt-5-5',
    ]);
    const disabled = CATALOG_SEED.filter((r) => r.disabled_reason !== null).map((r) => r.model_id);
    expect(disabled).toEqual(['claude-opus-4-7', 'gpt-5-5']);
    expect(CATALOG_SEED.find((r) => r.model_id === DEFAULT_MODEL_ID)?.disabled_reason).toBeNull();
  });

  it('records when each price was last verified', () => {
    for (const row of CATALOG_SEED) expect(row.pricing_verified_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
