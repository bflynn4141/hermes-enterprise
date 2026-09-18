import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mockUuid, type Ref, type RequestEntity } from '@hermes/shared';
import type { Adapter } from '../../model/adapter.js';
import { createStore, initialState, reduce } from '../../model/store.js';
import { StoreProvider } from '../store-context.js';
import { InboxList, RequestReview } from './Inbox.js';

function request(id: number, subject: string, kind: RequestEntity['kind'], status: RequestEntity['status']): RequestEntity {
  const payload = kind === 'application'
    ? {
        kind,
        applicant: { name: subject, email: `${subject.split(' ')[0]?.toLowerCase()}@example.test` },
        proposed_role: 'Technical Partner',
        score: 82,
        score_max: 100,
        criteria: [
          { id: 'track-record', label: 'track-record', points: 28, points_max: 30, evidence: 'Created their own FDE bootcamp.', source_ids: ['linkedin', 'youtube'] },
          { id: 'capacity', label: 'capacity', points: 22, points_max: 30, evidence: 'Published a six-week delivery curriculum.', source_ids: ['github'] },
          { id: 'fit', label: 'fit', points: 32, points_max: 40, evidence: 'Shares practical implementation guidance.', source_ids: ['x'] },
        ],
        sources: [
          { id: 'linkedin', name: 'LinkedIn', note: 'Illustrative role and program history.', url: 'https://www.linkedin.com/' },
          { id: 'github', name: 'GitHub', note: 'Illustrative public repositories.', url: 'https://github.com/' },
          { id: 'youtube', name: 'YouTube', note: 'Illustrative teaching material.', url: 'https://www.youtube.com/' },
          { id: 'x', name: 'X profile', note: 'Illustrative public writing.', url: 'https://x.com/' },
        ],
      }
    : kind === 'invoice'
      ? { kind, number: 'INV-42', currency: 'USD', payee: { name: 'Robin Studio' }, payer: { name: 'Nous Research' }, issue_date: '2026-09-15', due_date: '2026-09-30', lines: [{ id: 'line-1', label: 'Partner workshop', qty: 1, amount_minor: 120000, source_ids: [] }], total_minor: 120000 }
      : { kind, number: 'AGR-42', version_label: 'v3', parties: [{ name: 'Nous Research' }, { name: 'Robin Studio' }], sections: [{ id: 'scope', heading: 'Scope', body: 'One partner workshop.', source_ids: [] }] };
  const sources = kind === 'application' && Array.isArray(payload.sources)
    ? payload.sources.map(({ id: sourceId, name, note }) => ({ id: sourceId, name, note }))
    : [];
  return {
    id: mockUuid(id), kind, status, subject, label: subject, title: subject,
    session_id: null, run_id: null, created_at: '2026-09-15T12:00:00.000Z',
    version: 1, payload, sources, missing: [],
  };
}

const requests = [
  { ...request(101, 'Ada pending', 'application', 'pending'), triage: { status: 'complete' as const, band: 'urgent' as const, score: 91, confidence: .9, reason_codes: ['deadline'], assessed_at: '2026-09-15T12:01:00.000Z', rubric_version: '1', model_id: 'typesafe/jev' } },
  { ...request(102, 'Leah pending', 'application', 'pending'), created_at: '2026-09-15T13:00:00.000Z', triage: { status: 'complete' as const, band: 'normal' as const, score: 45, confidence: .8, reason_codes: ['goal'], assessed_at: '2026-09-15T13:01:00.000Z', rubric_version: '1', model_id: 'typesafe/jev' } },
  request(103, 'Ada admitted', 'application', 'admitted'),
  request(104, 'Acme invoice', 'invoice', 'pending'),
  request(105, 'Acme agreement', 'agreement', 'pending'),
  request(106, 'Saved invoice', 'invoice', 'created'),
  request(107, 'Saved agreement', 'agreement', 'drafted'),
];

function render(ref: Ref, selectedId?: string): string {
  let state = reduce(initialState(), { type: 'nav/app', object: ref });
  state = { ...state, user: { id: mockUuid(200), name: 'Maya Chen', email: 'maya@nous.research', role: 'admin' } };
  for (const row of requests) state = reduce(state, { type: 'entity/upsert', kind: 'request', id: row.id, version: 1, data: row });
  state = reduce(state, { type: 'list/set', key: 'requests', ids: requests.map((row) => row.id) });
  return renderToStaticMarkup(
    <StoreProvider store={createStore(state)} adapter={{} as Adapter}>
      {selectedId ? <RequestReview id={selectedId} /> : <InboxList />}
    </StoreProvider>,
  );
}

describe('the Inbox renders the focused view', () => {
  it('defaults pending work to Priority and supports Recent ordering', () => {
    const priority = render({ section: 'inbox', view: 'list', filters: { status: 'pending', reviewer: 'all' } });
    expect(priority).toContain('aria-pressed="true">Priority');
    expect(priority.indexOf('Ada pending')).toBeLessThan(priority.indexOf('Leah pending'));
    expect(priority).toContain('>urgent<');
    expect(priority).toContain('Deadline');

    const recent = render({ section: 'inbox', view: 'list', filters: { status: 'pending', reviewer: 'all', sort: 'recent' } });
    expect(recent).toContain('aria-pressed="true">Recent');
    expect(recent.indexOf('Leah pending')).toBeLessThan(recent.indexOf('Ada pending'));
  });

  it('shows pending applications and the supplied case-insensitive search', () => {
    const html = render({ section: 'inbox', view: 'list', filters: { status: 'pending', kind: 'application', query: 'aDa' } });
    expect(html).toContain('Ada pending');
    expect(html).not.toContain('Leah pending');
    expect(html).not.toContain('Ada admitted');
    expect(html).not.toContain('Acme invoice');
    expect(html).toContain('value="aDa"');
    expect(html).toContain('value="application" selected=""');
  });

  it('shows resolved requests rather than retaining Needs review', () => {
    const html = render({ section: 'inbox', view: 'list', filters: { status: 'resolved' } });
    expect(html).toContain('Ada admitted');
    expect(html).not.toContain('Ada pending');
    expect(html).toContain('aria-label="Resolved requests"');
  });

  it('supports both document groups and individual document kinds', () => {
    const documents = render({ section: 'inbox', view: 'list', filters: { kind: 'documents' } });
    expect(documents).toContain('Acme invoice');
    expect(documents).toContain('Acme agreement');
    expect(documents).not.toContain('Ada pending');
    const invoices = render({ section: 'inbox', view: 'list', filters: { kind: 'invoice' } });
    expect(invoices).toContain('Acme invoice');
    expect(invoices).not.toContain('Acme agreement');
  });

  it('keeps the request queue beside an applicant preview and provides a return path', () => {
    const html = render({ section: 'inbox', view: 'request', id: requests[0]!.id }, requests[0]!.id);
    expect(html).toContain('aria-label="Back to Inbox"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('Iris screened this application');
    expect(html).toContain('Track Record');
    expect(html).toContain('Capacity');
    expect(html).toContain('Fit');
    expect(html).not.toContain('track-record');
    expect(html).toContain('Sources used');
    expect(html).toContain('LinkedIn');
    expect(html).toContain('GitHub');
    expect(html).toContain('YouTube');
    expect(html).toContain('X profile');
    expect(html).toContain('Main takeaway');
    expect(html).toContain('Created their own FDE bootcamp.');
    expect(html).toContain('Admit Ada');
    expect(html).toContain('Leah pending');
  });

  it('keeps a resolved request visible in its queue when opened from a deep link', () => {
    const html = render({ section: 'inbox', view: 'request', id: requests[2]!.id }, requests[2]!.id);
    expect(html).toContain('aria-label="Resolved requests"');
    expect(html).toContain('Ada admitted');
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain('Ada pending');
  });

  it('renders staged invoice and signature flows around the complete documents', () => {
    const invoice = render({ section: 'inbox', view: 'request', id: requests[3]!.id }, requests[3]!.id);
    expect(invoice).toContain('Invoice approval');
    expect(invoice).toContain('Invoice approval steps');
    expect(invoice).toContain('Review invoice');
    expect(invoice).toContain('Payment');
    expect(invoice).toContain('Confirm');
    expect(invoice).toContain('Full document');
    expect(invoice).toContain('Review payment');
    expect(invoice).toContain('Nothing is approved, signed, sent, or paid yet.');

    const agreement = render({ section: 'inbox', view: 'request', id: requests[4]!.id }, requests[4]!.id);
    expect(agreement).toContain('Signature approval');
    expect(agreement).toContain('Signature approval steps');
    expect(agreement).toContain('Review agreement');
    expect(agreement).toContain('Signature');
    expect(agreement).toContain('Full document');
    expect(agreement).toContain('Add signature');
    expect(agreement).toContain('Nothing is approved, signed, sent, or paid yet.');
  });

  it('keeps complete documents and authorization controls in resolved receipts', () => {
    const invoice = render({ section: 'inbox', view: 'request', id: requests[5]!.id }, requests[5]!.id);
    expect(invoice).toContain('Complete document');
    expect(invoice).toContain('Payment authorization');
    expect(invoice).toContain('Connect a bank account');
    expect(invoice).toContain('Save payment authorization');
    expect(invoice).toContain('Provider actions');

    const agreement = render({ section: 'inbox', view: 'request', id: requests[6]!.id }, requests[6]!.id);
    expect(agreement).toContain('Complete document');
    expect(agreement).toContain('Full legal name');
    expect(agreement).toContain('I agree to use this as my electronic signature');
    expect(agreement).toContain('Save signature authorization');
    expect(agreement).toContain('Provider actions');
  });

  it('distinguishes an empty filtered result from an empty Inbox', () => {
    const html = render({ section: 'inbox', view: 'list', filters: { query: 'No such request' } });
    expect(html).toContain('No matching requests');
    expect(html).toContain('Clear filters');
  });

  it('renders Rules without also showing the request list', () => {
    const html = render({ section: 'inbox', view: 'rules' });
    expect(html).toContain('Manual review');
    expect(html).not.toContain('Ada pending');
    expect(html).not.toContain('Search requests');
  });
});
