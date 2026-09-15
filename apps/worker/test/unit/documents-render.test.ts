// The document template and the receipt sentences.
//
// Both are copy, and copy is where a product's promises actually live. The
// footer line and the "Access is pending" clause are the two places this system
// tells a reader what did *not* happen, so they are pinned here rather than
// left to whoever edits the template next.
import { describe, expect, it } from 'vitest';
import { agreementPayloadSchema, invoicePayloadSchema } from '@hermes/shared';
import {
  AGREEMENT_FOOTER,
  INVOICE_FOOTER,
  formatMoney,
  renderAgreementHtml,
  renderInvoiceHtml,
} from '../../src/documents/template.js';
import { plannedEffects } from '../../src/domain/effects.js';
import { receiptText, remainingSentence } from '../../src/runs/receipt.js';

const invoice = invoicePayloadSchema.parse({
  kind: 'invoice',
  number: 'INV-2026-014',
  currency: 'USD',
  payee: { name: 'Robin <script>alert(1)</script> Ellis' },
  payer: { name: 'Nous Research' },
  issue_date: '2026-09-01',
  due_date: '2026-09-30',
  lines: [{ id: 'l1', label: 'Workshop & delivery', qty: 2, amount_minor: 45000, source_ids: [] }],
  total_minor: 90000,
});

const agreement = agreementPayloadSchema.parse({
  kind: 'agreement',
  number: 'AGR-2026-004',
  version_label: 'v1',
  parties: [{ name: 'Nous Research' }, { name: 'Robin Ellis' }],
  sections: [{ id: 's1', heading: 'Scope & term', body: 'Two workshops.', source_ids: [] }],
});

describe('the document render', () => {
  it('escapes model-authored text rather than trusting a schema that checked shape', () => {
    const html = renderInvoiceHtml(invoice);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Workshop &amp; delivery');
  });

  it('says on the page itself that nothing was sent, paid or signed', () => {
    expect(renderInvoiceHtml(invoice)).toContain(INVOICE_FOOTER);
    expect(INVOICE_FOOTER).toBe('Not sent · No money moved');
    expect(renderAgreementHtml(agreement)).toContain(AGREEMENT_FOOTER);
    expect(AGREEMENT_FOOTER).toBe('Not sent · Unsigned');
  });

  it('divides minor units exactly once, at the last moment', () => {
    expect(formatMoney(90000, 'USD')).toMatch(/USD\s900\.00/);
    expect(formatMoney(1, 'USD')).toMatch(/USD\s0\.01/);
    // An unknown code is not a reason to fail a render.
    expect(formatMoney(90000, 'XTS')).toMatch(/XTS\s?900\.00/);
  });

  it('numbers an agreement’s sections so the reviewer and the file agree', () => {
    expect(renderAgreementHtml(agreement)).toContain('1. Scope &amp; term');
  });
});

describe('what a decision implies', () => {
  it('is nothing at all for a decline, in every kind', () => {
    for (const kind of ['application', 'invoice', 'agreement'] as const) {
      expect(plannedEffects(kind, 'decline')).toEqual([]);
    }
  });

  it('separates created from sent, and sent from paid', () => {
    expect(plannedEffects('application', 'approve').map((e) => e.kind)).toEqual(['access_grant']);
    expect(plannedEffects('invoice', 'approve').map((e) => e.kind)).toEqual(['email_send', 'payment']);
    expect(plannedEffects('agreement', 'approve').map((e) => e.kind)).toEqual(['signature', 'email_send']);
    // A payment needs two people; the number comes from the shared contract.
    expect(plannedEffects('invoice', 'approve').find((e) => e.kind === 'payment')?.approvalsRequired).toBe(2);
  });
});

describe('the receipt sentences', () => {
  it('counts down the way the demo did', () => {
    expect(remainingSentence(3)).toBe('Three requests remain.');
    expect(remainingSentence(1)).toBe('One request remains.');
    expect(remainingSentence(0)).toBe('No requests remain.');
  });

  it('names what did not happen, for every kind and both decisions', () => {
    expect(
      receiptText({ actor: 'Maya', kind: 'application', decision: 'approve', label: 'Leah Martinez', number: null, pending: 3 }),
    ).toEqual({
      human: 'Maya admitted Leah in Inbox',
      iris: 'Leah is admitted. Access is pending. Three requests remain.',
    });

    expect(
      receiptText({ actor: 'Maya', kind: 'invoice', decision: 'approve', label: 'Invoice', number: 'INV-1', pending: 0 }).iris,
    ).toBe('Invoice INV-1 is created in Library. Not sent. No money moved. No requests remain.');

    expect(
      receiptText({ actor: 'Maya', kind: 'agreement', decision: 'approve', label: 'Agreement', number: 'AGR-1', pending: 1 }).iris,
    ).toBe('Agreement AGR-1 is saved as an unsigned draft in Library. Not sent. One request remains.');

    expect(
      receiptText({ actor: 'Maya', kind: 'application', decision: 'decline', label: 'Owen Blake', number: null, pending: 2 }),
    ).toEqual({
      human: 'Maya declined Owen in Inbox',
      iris: 'Owen’s application is declined. No message was sent. Two requests remain.',
    });
  });
});
