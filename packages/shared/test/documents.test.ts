import { describe, expect, it } from 'vitest';
import {
  CATALOG_SEED,
  PROVIDERS,
  TRANSPORTS,
  openRouterCatalogId,
  openRouterModelId,
  vendorPrefix,
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

// ---------------------------------------------------------------------------
// OpenRouter (decision R1)
// ---------------------------------------------------------------------------

describe('the OpenRouter additions to the catalog contract', () => {
  it('adds the provider and the transport without moving the existing ones', () => {
    // Order matters: `PROVIDERS` and `TRANSPORTS` are the source the SQL CHECK
    // constraints were written from, and a reordering would make a future
    // generated migration disagree with an applied one.
    expect(PROVIDERS.slice(0, 4)).toEqual(['deepseek', 'anthropic', 'openai', 'nous_portal']);
    expect(PROVIDERS).toContain('openrouter');
    expect(TRANSPORTS.slice(0, 3)).toEqual(['deepseek_chat', 'anthropic_messages', 'openai_responses']);
    expect(TRANSPORTS).toContain('openrouter_chat');
  });

  it('leaves the four seeded rows exactly as they were', () => {
    expect(CATALOG_SEED.map((r) => r.model_id)).toEqual([
      'deepseek-flash',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'gpt-5-5',
    ]);
    for (const row of CATALOG_SEED) expect(row.provider).not.toBe('openrouter');
  });

  it('accepts an OpenRouter-length model id, which the old 64-character cap refused', () => {
    const row = {
      ...CATALOG_SEED[0]!,
      model_id: openRouterCatalogId('cognitivecomputations/dolphin-mixtral-8x22b-instruct-preview-2026:extended'),
      provider: 'openrouter' as const,
      transport: 'openrouter_chat' as const,
    };
    expect(row.model_id.length).toBeGreaterThan(64);
    expect(catalogRowSchema.parse(row).model_id).toBe(row.model_id);
  });

  it('round-trips the prefix and groups by vendor', () => {
    expect(openRouterModelId(openRouterCatalogId('openai/gpt-5.5'))).toBe('openai/gpt-5.5');
    expect(openRouterModelId('gpt-5-5')).toBeNull();
    expect(vendorPrefix('openrouter:openai/gpt-5.5')).toBe('openai');
    expect(vendorPrefix('gpt-5-5')).toBe('native');
  });
});
