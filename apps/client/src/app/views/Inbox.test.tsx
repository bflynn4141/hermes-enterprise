import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mockUuid, type EffectEntity, type Ref, type RequestEntity } from '@hermes/shared';
import type { Adapter } from '../../model/adapter.js';
import { createStore, initialState, reduce, type AppState } from '../../model/store.js';
import { StoreProvider } from '../store-context.js';
import { DocumentView, InboxList, LEGACY_EFFECT_HONESTY, LegacyEffectsPanel, RequestReview, SIMULATED_EFFECT_HONESTY, legacyEffectStatusLabel } from './Inbox.js';

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
    provenance: { kind: 'unknown', source: 'not_recorded', recorded_at: '2026-09-15T12:00:00.000Z' },
    presentation: { hidden: false, hidden_at: null, hidden_reason: null },
    decision_summary: {
      action: kind === 'application' ? 'Review applicant' : kind === 'invoice' ? 'Approve invoice draft' : 'Approve agreement draft',
      primary: subject,
      facts: [],
      consequence: null,
      approval_requirement: {
        mode: 'single', completed_steps: status === 'pending' ? 0 : 1, total_steps: 1,
        remaining_approvals: status === 'pending' ? 1 : 0,
        current: status === 'pending' ? [{ label: 'Workspace Admin', approvals_recorded: 0, quorum: 1 }] : [],
        pending_for_viewer: status === 'pending', waiting_on_others: false, expires_at: null,
      },
    },
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

function renderDocument(row: RequestEntity, role: 'admin' | 'member' = 'admin', readOnly = false, seed: (state: AppState) => AppState = (state) => state): string {
  const state = seed({
    ...initialState(),
    workspace: { ...initialState().workspace, id: mockUuid(1) },
    user: { id: mockUuid(200), name: 'Maya Chen', email: 'maya@nous.research', role },
  });
  const reviewer = row.payload.workflow_provenance ? 'Finance reviewer' : 'Workspace Admin';
  const requirement = row.decision_summary?.approval_requirement;
  const eligibleRole = reviewer === 'Finance reviewer' ? 'member' : 'admin';
  const requestWithEligibility: RequestEntity = {
    ...row,
    decision_summary: {
      action: row.decision_summary?.action ?? (row.kind === 'invoice' ? 'Approve invoice draft' : 'Approve agreement draft'),
      primary: row.decision_summary?.primary ?? row.label,
      facts: row.decision_summary?.facts ?? [],
      consequence: row.decision_summary?.consequence ?? null,
      approval_requirement: {
        mode: requirement?.mode ?? 'single',
        completed_steps: requirement?.completed_steps ?? (row.status === 'pending' ? 0 : 1),
        total_steps: requirement?.total_steps ?? 1,
        remaining_approvals: requirement?.remaining_approvals ?? (row.status === 'pending' ? 1 : 0),
        current: row.status === 'pending'
          ? (requirement?.current.length ? requirement.current.map((step) => ({ ...step, label: reviewer })) : [{ label: reviewer, approvals_recorded: 0, quorum: 1 }])
          : [],
        pending_for_viewer: row.status === 'pending' && role === eligibleRole,
        waiting_on_others: row.status === 'pending' && role !== eligibleRole,
        expires_at: requirement?.expires_at ?? null,
      },
    },
  };
  return renderToStaticMarkup(
    <StoreProvider store={createStore(state)} adapter={{} as Adapter}>
      <DocumentView request={requestWithEligibility} readOnly={readOnly} />
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

  it('starts invoice review with the actual draft decision and available source context', () => {
    const invoice = renderDocument(requests[3]!);
    expect(invoice).toContain('Your decision');
    expect(invoice).toContain('Approve invoice draft');
    expect(invoice).toContain('0 of 1 Admin approval');
    expect(invoice).toContain('You can approve');
    expect(invoice).toContain('Robin Studio');
    expect(invoice).toContain('Nous Research');
    expect(invoice).toContain('2026-09-30');
    expect(invoice).toContain('What is this for?');
    expect(invoice).toContain('Partner workshop');
    expect(invoice).toContain('No source messages linked.');
    expect(invoice).toContain('Full document');
    expect(invoice).toContain('No payment or email is sent.');
    expect(invoice).not.toContain('Review payment');
    expect(invoice).not.toContain('Payment authorization');
    expect(invoice).not.toContain('Connect a bank');
  });

  it('shows the agreement draft, all parties and supplied terms without a signature ceremony', () => {
    const base = requests[4]!;
    const agreement = renderDocument({ ...base, payload: { ...base.payload, parties: [{ name: 'Nous Research' }, { name: 'Robin Studio' }, { name: 'Third Party' }], effective_dates: { from: '2026-10-01', to: '2026-12-31' }, currency: 'EUR', total_minor: 120050 } });
    expect(agreement).toContain('Approve agreement draft');
    expect(agreement).toContain('Third Party');
    expect(agreement).toContain('2026-10-01');
    expect(agreement).toContain('2026-12-31');
    expect(agreement).toContain('EUR');
    expect(agreement).toContain('1,200.50');
    expect(agreement).toContain('One partner workshop.');
    expect(agreement).toContain('Nothing is signed or sent.');
    expect(agreement).not.toContain('Full legal name');
    expect(agreement).not.toContain('electronic signature');
    expect(agreement).not.toContain('Approve &amp; sign');
  });

  it('uses currency-aware invoice amounts and reports unresolved citations once, without ids or invented links', () => {
    const base = requests[3]!;
    const invoice = renderDocument({ ...base, payload: { ...base.payload, currency: 'GBP', lines: [{ id: 'line-1', label: 'Partner workshop', qty: 1, amount_minor: 120000, source_ids: ['message-1', 'https://unverified.example/source'] }] } });
    expect(invoice).toContain('GBP');
    expect(invoice).not.toContain('$1,200');
    expect(invoice).toContain('2 sources cited by this draft');
    expect(invoice.match(/Source no longer available/g)).toHaveLength(1);
    expect(invoice).not.toContain('message-1');
    expect(invoice).not.toContain('href="https://unverified.example/source"');
  });

  it('names an agreement section’s sources from the Library instead of printing ids', () => {
    const base = requests[4]!;
    const agreement = renderDocument({ ...base, payload: { ...base.payload, sections: [{ id: 'fees', heading: 'Fees', body: 'USD 1,200.', source_ids: [mockUuid(30), mockUuid(31)] }] } }, 'admin', false, (state) =>
      reduce(state, { type: 'entity/upsert', kind: 'document', id: mockUuid(30), version: 1, data: { id: mockUuid(30), kind: 'invoice', number: 'INV-42', title: 'Invoice INV-42', status: 'Draft', request_id: null, pdf_status: 'none', pdf_url: null, pdf_error: null, payload: {}, version: 1, created_at: '2026-09-15T12:00:00.000Z' } }));
    expect(agreement).toContain('2 sources');
    expect(agreement).toContain('Invoice INV-42');
    expect(agreement).toContain('Source no longer available');
    expect(agreement).not.toContain(mockUuid(30));
    expect(agreement).not.toContain(mockUuid(31));
    expect(agreement).not.toContain('not available here');
  });

  it('shows the scoped workflow excerpts and links only the Finance-owned source session', () => {
    const base = requests[3]!;
    const partnershipsSession = mockUuid(301);
    const financeSession = mockUuid(302);
    const invoice = renderDocument({
      ...base,
      payload: {
        ...base.payload,
        workflow_provenance: {
          handoff_id: mockUuid(303),
          shared_partner: { id: mockUuid(304), name: 'Robin Studio', engagement_reference: 'ENG-42' },
          source_sessions: [
            { role: 'partnerships', agent_name: 'Iris', session_id: partnershipsSession, run_id: mockUuid(305), excerpt: 'Approved engagement excerpt only.', simulated: true },
            { role: 'finance', agent_name: 'Ledger', session_id: financeSession, run_id: mockUuid(306), excerpt: 'Invoice matched the authorized amount.', simulated: true },
          ],
          source_record_revisions: { engagement: 1, invoice: 1 },
          checks: { duplicate: 'clear', engagement_match: 'matched', missing_context: [] },
        },
      },
    });
    expect(invoice).toContain('Workflow evidence (2 sources)');
    expect(invoice).toContain('Approved engagement excerpt only.');
    expect(invoice).toContain('Full Partnerships session remains private.');
    expect(invoice).toContain(`href="/workspace/${mockUuid(1)}/s/${financeSession}"`);
    expect(invoice).not.toContain(`href="/workspace/${mockUuid(1)}/s/${partnershipsSession}"`);
    expect(invoice).toContain('Simulated');
  });

  it('shows the actual legacy reviewer eligibility and does not give members a draft approval action', () => {
    const invoice = renderDocument(requests[3]!, 'member');
    expect(invoice).toContain('0 of 1 Admin approval');
    expect(invoice).toContain('Admin required');
    expect(invoice).not.toContain('>Approve invoice draft</button>');
  });

  it('keeps resolved documents read-only and preserves prior authorization text only as a note', () => {
    const note = 'Electronic signature authorization recorded for Maya on AGR-42 v3.';
    const agreement = renderDocument({ ...requests[6]!, note }, 'admin', true);
    expect(agreement).toContain('Saved unsigned');
    expect(agreement).toContain('Review note');
    expect(agreement).toContain(note);
    expect(agreement).not.toContain('Save signature authorization');
    expect(agreement).not.toContain('Signature authorized');
    expect(agreement).not.toContain('Full legal name');
    const invoice = renderDocument(requests[5]!, 'admin', true);
    expect(invoice).toContain('Saved in Library');
    expect(invoice).toContain('1 of 1 Admin approval');
    expect(invoice).not.toContain('Save payment authorization');
    expect(invoice).not.toContain('Connect a bank');
  });

  it('keeps the Finance reviewer and server-projected count on a resolved invoice', () => {
    const base = requests[5]!;
    const invoice = renderDocument({
      ...base,
      payload: {
        ...base.payload,
        workflow_provenance: {
          handoff_id: mockUuid(303),
          shared_partner: { id: mockUuid(304), name: 'Robin Studio', engagement_reference: 'ENG-42' },
          source_sessions: [],
        },
      },
      decision_summary: {
        ...base.decision_summary!,
        approval_requirement: {
          ...base.decision_summary!.approval_requirement,
          completed_steps: 2,
          total_steps: 2,
          current: [],
        },
      },
    }, 'member', true);
    expect(invoice).toContain('2 of 2 Finance review steps');
    expect(invoice).not.toContain('Admin approval');
  });

  it('does not describe a withdrawn draft as approved', () => {
    const invoice = renderDocument({ ...requests[3]!, status: 'withdrawn' }, 'admin', true);
    expect(invoice).toContain('Withdrawn');
    expect(invoice).toContain('No approval recorded');
    expect(invoice).not.toContain('1 of 1 Admin approval');
    expect(invoice).not.toContain('Downstream actions unavailable');
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


describe('legacy effect execute honesty', () => {
  const pending: EffectEntity = {
    id: mockUuid(501),
    request_id: mockUuid(101),
    kind: 'access_grant',
    status: 'pending',
    required_role: 'access',
    label: 'Grant workspace access',
    reason: null,
  };
  const unavailable: EffectEntity = {
    ...pending,
    id: mockUuid(502),
    status: 'unavailable',
    reason: 'Not executed. This legacy effect has no configured executor; no email, payment, access or signature action was completed.',
  };

  it('labels pending effects as having no executor and offers Record attempt, never Execute', () => {
    expect(legacyEffectStatusLabel(pending)).toContain('no executor');
    expect(legacyEffectStatusLabel(pending)).toBe('Pending · no executor · needs the access role');
    const html = renderToStaticMarkup(<LegacyEffectsPanel effects={[pending]} />);
    expect(html).toContain(LEGACY_EFFECT_HONESTY);
    expect(html).toContain('>Record attempt</button>');
    expect(html).not.toContain('>Execute</button>');
    expect(html).toContain('Pending · no executor · needs the access role');
  });

  it('keeps unavailable outcomes explicit before implying any external work happened', () => {
    expect(legacyEffectStatusLabel(unavailable)).toContain('nothing sent, paid, granted or signed');
    const html = renderToStaticMarkup(<LegacyEffectsPanel effects={[unavailable]} />);
    expect(html).toContain(LEGACY_EFFECT_HONESTY);
    expect(html).toContain('Unavailable · nothing sent, paid, granted or signed');
    expect(html).not.toContain('>Execute</button>');
    expect(html).not.toContain('>Record attempt</button>');
  });

  const simulated: EffectEntity = {
    ...pending,
    id: mockUuid(503),
    kind: 'payment',
    required_role: 'finance',
    label: 'Pay the invoice',
    status: 'simulated',
    reason: 'Simulated. No email, payment, access or signature action was completed; this environment invents the outcome so the flow can be followed to the end.',
    simulation: {
      reference: 'SIM-PAY-7F3A2C',
      summary: 'USD 900.00 to Robin Ellis · Settled',
      steps: [
        { label: 'Payment instruction created', at: '2026-09-20T11:59:51.000Z' },
        { label: 'Settled · SIM-PAY-7F3A2C', at: '2026-09-20T11:59:59.000Z' },
      ],
    },
  };

  it('offers Execute with a Simulated pill on the row when the Worker advertises the simulated executor', () => {
    const html = renderToStaticMarkup(<LegacyEffectsPanel effects={[pending]} executor="simulated" />);
    expect(html).toContain('>Execute</button>');
    expect(html).toContain('>Simulated</span>');
    expect(html).not.toContain(LEGACY_EFFECT_HONESTY);
    expect(legacyEffectStatusLabel(pending, 'simulated')).toBe('Waiting on the access role');
  });

  it('gives a saved invoice receipt actionable effect rows when the receipt owns the view', () => {
    const invoice = request(7, 'Robin Ellis', 'invoice', 'created');
    const store = createStore(initialState());
    const html = renderToStaticMarkup(
      <StoreProvider store={store} adapter={{} as Adapter}>
        <DocumentView
          request={invoice}
          readOnly
          effects={[{ ...pending, kind: 'payment', required_role: 'finance', label: 'Pay the invoice' }]}
          effectActions={{ busy: null, reauthed: false, notice: null, executor: 'simulated', onRecordAttempt: () => {} }}
        />
      </StoreProvider>,
    );
    expect(html).toContain('What this implies');
    expect(html).toContain('>Execute</button>');
    expect(html).toContain('>Simulated</span>');
    expect(html).not.toContain('Downstream actions unavailable');
  });

  it('labels a simulated outcome as simulated everywhere it appears and shows the invented timeline', () => {
    expect(legacyEffectStatusLabel(simulated)).toBe('USD 900.00 to Robin Ellis · Settled');
    const html = renderToStaticMarkup(<LegacyEffectsPanel effects={[simulated]} />);
    expect(html).toContain('>Simulated</span>');
    expect(html).toContain(`title="${SIMULATED_EFFECT_HONESTY}"`);
    expect(html).toContain('Settled · SIM-PAY-7F3A2C');
    expect(html).not.toMatch(/>Execute(d)?</);
    expect(html).not.toContain('Paid');
  });
});
