import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mockUuid, type Ref, type RequestEntity } from '@hermes/shared';
import type { Adapter } from '../../model/adapter.js';
import { createStore, initialState, reduce } from '../../model/store.js';
import { StoreProvider } from '../store-context.js';
import { InboxList } from './Inbox.js';

function request(id: number, subject: string, kind: RequestEntity['kind'], status: RequestEntity['status']): RequestEntity {
  return {
    id: mockUuid(id), kind, status, subject, label: subject, title: subject,
    session_id: null, run_id: null, created_at: '2026-09-15T12:00:00.000Z',
    version: 1, payload: {}, sources: [], missing: [],
  };
}

const requests = [
  request(101, 'Ada pending', 'application', 'pending'),
  request(102, 'Leah pending', 'application', 'pending'),
  request(103, 'Ada admitted', 'application', 'admitted'),
  request(104, 'Acme invoice', 'invoice', 'pending'),
  request(105, 'Acme agreement', 'agreement', 'pending'),
];

function render(ref: Ref): string {
  let state = reduce(initialState(), { type: 'nav/app', object: ref });
  for (const row of requests) state = reduce(state, { type: 'entity/upsert', kind: 'request', id: row.id, version: 1, data: row });
  state = reduce(state, { type: 'list/set', key: 'requests', ids: requests.map((row) => row.id) });
  return renderToStaticMarkup(
    <StoreProvider store={createStore(state)} adapter={{} as Adapter}>
      <InboxList />
    </StoreProvider>,
  );
}

describe('the Inbox renders the focused view', () => {
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
