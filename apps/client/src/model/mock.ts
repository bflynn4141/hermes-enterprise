// Mock server mode: the whole client, exercised without the Worker.
//
//     MOCK=1 pnpm --filter @hermes/client build
//     MOCK=1 pnpm --filter @hermes/client dev
//
// It is a `fetch` and a `WebSocket` the adapter is handed instead of the real
// ones, so every byte still goes through the same REST client and the same zod
// parse. A mock response that does not satisfy the contract fails here, in the
// client, which is the point: the fixture and the server cannot drift quietly.
//
// The run stream comes from `packages/shared`'s `mockRunStream`, so the
// difficult sequences the reducer must survive — a retried step attempt, a
// stopped run, a request that is focused before it is created — are the
// contract's own scenarios rather than a second set invented here.
//
// `__MOCK__` is a build-time constant, so a production build drops this module
// entirely.
import { mockRunStream, mockUuid, SCHEMA_VERSION, type StreamEvent } from '@hermes/shared';
import type { MaskedProviderKey, Ref } from '@hermes/shared';
import type { SocketLike } from './hub.js';

const WS = mockUuid(1);
const USER = mockUuid(100);
const MEMBER_USER = mockUuid(101);
const AGENT = mockUuid(102);
const SESSION_A = mockUuid(2);
const SESSION_B = mockUuid(20);
const RUN = mockUuid(3);
const REQ_LEAH = mockUuid(11);
const REQ_OWEN = mockUuid(12);
const REQ_INVOICE = mockUuid(13);
const REQ_AGREEMENT = mockUuid(14);
const DOC_INVOICE = mockUuid(30);
const KEY_ID = mockUuid(40);
const TRACE_LEAH = mockUuid(50);

export const MOCK_WORKSPACE_ID = WS;

interface MockSession {
  id: string;
  title: string;
  mode: string;
  model_id: string;
  effort: string | null;
  runtime: string;
  pinned: boolean;
  archived: boolean;
  focus_ref: Ref | null;
  status: string;
  last_activity_at: string;
  share: { id: string; url: string; audience: string; created_at: string; messages: number } | null;
  context: { label: string; ref: Ref | null } | null;
  version: number;
}

const iso = (offsetMinutes = 0) => new Date(Date.UTC(2026, 9, 12, 9, 49 + offsetMinutes, 0)).toISOString();

interface MockOptions {
  /** `admin` is the first-run Admin seat; `member` exercises the Member copy. */
  seat?: 'admin' | 'member';
  /** `empty` renders every empty state; `seeded` is the October 12 workspace. */
  data?: 'seeded' | 'empty';
  /** No verified provider key: the composer greys and the banner shows. */
  providerKey?: 'verified' | 'none' | 'invalid';
}

interface MockRequest {
  id: string;
  kind: 'application' | 'invoice' | 'agreement';
  status: string;
  label: string;
  subject: string;
  title: string;
  session_id: string;
  run_id: string;
  created_at: string;
  version: number;
  payload: Record<string, unknown>;
  sources: { id: string; name: string; note: string }[];
  missing: string[];
  note: string | null;
  decision_id: string | null;
  decided_at: string | null;
  decided_by_name: string | null;
}

function request(id: string, kind: 'application' | 'invoice' | 'agreement', status: string, subject: string, label: string, extra: Record<string, unknown> = {}): MockRequest {
  return {
    id,
    kind,
    status,
    label,
    subject,
    title: kind === 'application' ? 'Partner Program application' : kind === 'invoice' ? 'Invoice INV-2026-014' : 'Services agreement AGR-2026-004',
    session_id: SESSION_A,
    run_id: RUN,
    created_at: iso(-5),
    version: 1,
    payload: extra,
    sources:
      kind === 'application'
        ? [
            { id: 'site', name: 'partner site', note: 'Applicant-supplied. Customer outcomes are not independently verified.' },
            { id: 'repo', name: 'GitHub repository', note: 'Public repository; last commit 9 days ago.' },
          ]
        : [],
    missing: kind === 'application' ? ['Customer impact', id === REQ_LEAH ? 'Delivery timeline' : 'Weekly capacity'] : [],
    note: null,
    decision_id: null,
    decided_at: null,
    decided_by_name: null,
  };
}

export function createMockBackend(options: MockOptions = {}) {
  const seat = options.seat ?? 'admin';
  const empty = options.data === 'empty';
  const keyMode = options.providerKey ?? (empty ? 'none' : 'verified');

  const requests: MockRequest[] = empty
    ? []
    : [
        request(REQ_LEAH, 'application', 'pending', 'Leah Martinez', 'Leah Martinez', { score: 82, role: 'Delivery Partner', breakdown: [['Track record', 28, 30], ['Capacity', 22, 30], ['Fit', 32, 40]], benefits: ['Partner directory listing', 'Program Slack access', 'Quarterly review slot'] }),
        request(REQ_OWEN, 'application', 'pending', 'Owen Reilly', 'Owen Reilly', { score: 78, role: 'Delivery Partner', breakdown: [['Track record', 26, 30], ['Capacity', 20, 30], ['Fit', 32, 40]], benefits: ['Partner directory listing', 'Program Slack access'] }),
        request(REQ_INVOICE, 'invoice', 'pending', 'Robin Ellis', 'INV-2026-014', { number: 'INV-2026-014', total_minor: 120000, currency: 'USD', issued: 'Oct 12, 2026', due: 'Oct 26, 2026', lines: [{ id: 'l1', label: 'Partner workshop · Oct 8', short: 'Workshop', qty: 1, amount_minor: 90000, date: 'Oct 8' }, { id: 'l2', label: 'Resource pack & follow-up · Oct 9', short: 'Resource pack', qty: 1, amount_minor: 30000, date: 'Oct 9' }] }),
        request(REQ_AGREEMENT, 'agreement', 'pending', 'Robin Ellis', 'AGR-2026-004', { number: 'AGR-2026-004', sections: [['Scope', 'One partner workshop on Oct 22–23, with materials prepared in advance.'], ['Fees', 'USD 1,200, payable 14 days after an accepted delivery statement.'], ['Term', 'Effective on signature by both parties; either party may end it with 14 days notice.']] }),
      ];

  const members = [
    { id: mockUuid(200), user_id: USER, name: 'Maya Chen', email: 'maya@nous.example', role: 'admin' as const, status: 'active' as const, reviewer_roles: ['access'], joined_at: iso(-4000), version: 1 },
    ...(empty ? [] : [
      { id: mockUuid(201), user_id: MEMBER_USER, name: 'Alex Rivera', email: 'alex@nous.example', role: 'admin' as const, status: 'active' as const, reviewer_roles: ['finance'], joined_at: iso(-5000), version: 1 },
      { id: mockUuid(202), user_id: null, name: 'Lena Fischer', email: 'lena@nous.example', role: 'member' as const, status: 'invited' as const, reviewer_roles: [], joined_at: null, version: 1 },
    ]),
  ];

  const providerKeys: MaskedProviderKey[] =
    keyMode === 'none'
      ? []
      : [
          {
            id: KEY_ID,
            provider: 'deepseek',
            label: 'Program key',
            last4: '9f2c',
            fingerprint_prefix: 'a41b93cd77e0',
            status: keyMode === 'invalid' ? 'invalid' : 'verified',
            verified_models: keyMode === 'invalid' ? [] : ['deepseek-flash'],
            added_by: USER,
            created_at: iso(-6000),
            verified_at: keyMode === 'invalid' ? null : iso(-6000),
            rotated_at: null,
            revoked_at: null,
            replaces_key_id: null,
          },
        ];

  const hasVerifiedKey = providerKeys.some((k) => k.status === 'verified' || k.status === 'verified_scoped');

  const catalog = [
    { model_id: 'deepseek-flash', label: 'DeepSeek Flash', provider: 'deepseek', effort: ['low', 'high', 'max'], default_effort: 'high', enabled: hasVerifiedKey, disabled_reason: hasVerifiedKey ? null : 'No verified DeepSeek key' },
    { model_id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', effort: ['low', 'medium', 'high', 'max'], default_effort: 'high', enabled: false, disabled_reason: 'No verified Anthropic key' },
    { model_id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'anthropic', effort: null, default_effort: null, enabled: false, disabled_reason: 'Not enabled for the pilot: cost per run exceeds the pilot spend budget.' },
    { model_id: 'gpt-5-5', label: 'GPT-5.5', provider: 'openai', effort: null, default_effort: null, enabled: false, disabled_reason: 'Awaiting the M3 reasoning-replay engine test for the Responses transport.' },
  ];

  const sessions: MockSession[] = empty
    ? [{ id: SESSION_A, title: 'New session', mode: 'ask', model_id: 'deepseek-flash', effort: 'high', runtime: 'cloud', pinned: false, archived: false, focus_ref: null, status: 'Empty', last_activity_at: iso(0), share: null, context: null, version: 1 }]
    : [
        { id: SESSION_A, title: 'Partner applications', mode: 'work', model_id: 'deepseek-flash', effort: 'high', runtime: 'cloud', pinned: true, archived: false, focus_ref: { section: 'agents', view: 'overview' }, status: 'Needs review', last_activity_at: iso(0), share: null, context: { label: 'Partner Program', ref: { section: 'agents', view: 'overview' } }, version: 1 },
        { id: SESSION_B, title: 'Provider documents', mode: 'plan', model_id: 'deepseek-flash', effort: 'high', runtime: 'cloud', pinned: false, archived: false, focus_ref: null, status: 'Drafts ready', last_activity_at: iso(-10), share: null, context: null, version: 1 },
      ];

  const messages: Record<string, unknown[]> = {
    [SESSION_A]: empty
      ? []
      : [
          { id: mockUuid(300), session_id: SESSION_A, seq: 1, role: 'user', kind: null, text: 'What needs me before the partner work can move forward?', blocks: [], status: 'complete', run_id: null, at: iso(-2) },
          {
            id: mockUuid(301),
            session_id: SESSION_A,
            seq: 2,
            role: 'iris',
            kind: null,
            heading: 'Four requests are ready',
            text: 'Four requests are ready: Leah and Owen’s applications, Robin’s invoice, and the next workshop agreement. Noor’s feedback reply also needs a destination.',
            blocks: [
              { type: 'card', title: 'Leah Martinez', subtitle: '82 / 100 · Awaiting your review', action: { label: 'Open request', command: { type: 'open_request', id: REQ_LEAH } } },
              { type: 'card', title: 'Unblock Noor’s reply', subtitle: 'Add the destination; I’ll prepare the draft. Not an approval.', action: { label: 'Open context', command: { type: 'nav', object: { section: 'agents', view: 'context', field: 'destination' } } } },
              { type: 'sources', title: 'Sources', subtitle: 'Partner criteria.md · Feedback guide.md' },
            ],
            status: 'complete',
            run_id: RUN,
            worked_ms: 42000,
            steps: ['Read the four requests', 'Checked the program criteria', 'Prepared the evidence reports'],
            at: iso(-1),
          },
        ],
    [SESSION_B]: [],
  };

  const documents = empty
    ? []
    : [
        { id: DOC_INVOICE, kind: 'invoice' as const, number: 'INV-2026-014', title: 'Invoice INV-2026-014', status: 'Draft · Not sent', request_id: REQ_INVOICE, pdf_status: 'preparing' as const, pdf_url: null, pdf_error: null, payload: {}, version: 1, created_at: iso(-3) },
      ];

  const agentFiles = empty
    ? []
    : [
        { id: mockUuid(60), name: 'Partner criteria.md', subtitle: 'Team Drive · Read only', extraction: 'ready' as const, extraction_error: null, body: 'Partner criteria\n\nTrack record (30)\nCapacity (30)\nFit (40)\n', version: 1 },
        { id: mockUuid(61), name: 'Feedback guide.md', subtitle: 'Team Drive · Read only', extraction: 'ready' as const, extraction_error: null, body: 'Feedback guide\n\nAcknowledge, capture reproduction steps, route to the owning team.\n', version: 1 },
        { id: mockUuid(62), name: 'Program overview.pdf', subtitle: 'Team Drive · Read only', extraction: 'extracting' as const, extraction_error: null, body: null, version: 1 },
      ];

  const contextFields: { id: string; field: string; label: string; value: string | null; scope: 'reply' | 'future' | null; version: number }[] = [
    { id: 'destination', field: 'destination', label: 'Feedback destination', value: null, scope: null, version: 1 },
  ];

  const instructions = empty
    ? [{ id: mockUuid(70), state: 'current' as const, text: 'Screen applications against the partner criteria and show the evidence you used.', before: null, provenance: null, created_at: iso(-9000), version: 1 }]
    : [
        { id: mockUuid(70), state: 'current' as const, text: 'Screen applications against the partner criteria and show the evidence you used.', before: null, provenance: null, created_at: iso(-9000), version: 1 },
        { id: mockUuid(71), state: 'proposed' as const, text: 'For future applications, show missing customer evidence first.', before: 'Screen applications against the partner criteria and show the evidence you used.', provenance: 'Proposed from this screening', created_at: iso(-1), version: 1 },
      ];

  const skills = [
    { id: 'partner-operations', name: 'Partner operations', version: 'v3', shared_by: 'Maya Chen', description: 'How the Partner Program screens, drafts and routes partner work.', detail: 'Adopted by Iris. Review rules are unchanged by adoption.', adopted: true },
    { id: 'feedback-synthesis', name: 'Feedback synthesis', version: 'v2', shared_by: 'Alex Rivera', description: 'Turn partner feedback into a routed, reviewable summary.', detail: null, adopted: false },
  ];

  const history = empty
    ? []
    : [
        { id: 'ev-1', kind: 'request.created', at: iso(-6), actor_name: 'Iris', actor_type: 'agent' as const, text: 'Iris screened Leah’s application', detail: 'Website, GitHub and demo checked.', status: 'Needs review', ref: { section: 'inbox', view: 'request', id: REQ_LEAH }, request_id: REQ_LEAH },
        { id: 'ev-2', kind: 'request.created', at: iso(-5), actor_name: 'Iris', actor_type: 'agent' as const, text: 'Iris prepared Robin’s invoice draft', detail: 'Delivery statement matched to the fee schedule.', status: 'Needs review', ref: { section: 'inbox', view: 'request', id: REQ_INVOICE }, request_id: REQ_INVOICE },
      ];

  const traces = empty
    ? []
    : [
        {
          id: TRACE_LEAH,
          run_id: RUN,
          name: 'Leah Martinez',
          type: 'Application screening',
          status: 'Awaiting review',
          sub: '82 / 100',
          needs_you: true,
          ref: { section: 'agents', view: 'trace', id: TRACE_LEAH },
          steps: [
            { id: 'read', label: 'Read the application', state: 'done' as const, detail: 'partner site, GitHub repository' },
            { id: 'criteria', label: 'Read criteria', state: 'done' as const, detail: 'Partner criteria.md' },
            { id: 'score', label: 'Score against the criteria', state: 'done' as const, detail: '82 / 100' },
            { id: 'wait', label: 'Waiting for a human decision', state: 'active' as const, detail: null },
          ],
          allowed_tools: ['get_document_text', 'score_application', 'propose_request'],
          version: 1,
        },
      ];

  const usage = {
    group: 'day' as const,
    from: '2026-10-06',
    to: '2026-10-12',
    rows: empty
      ? []
      : [
          { key: '2026-10-10', label: 'Oct 10', input_tokens: 184_000, output_tokens: 22_400, estimated_cost_usd: 0.061, model_id: 'deepseek-flash' },
          { key: '2026-10-11', label: 'Oct 11', input_tokens: 96_000, output_tokens: 12_100, estimated_cost_usd: 0.032, model_id: 'deepseek-flash' },
          { key: '2026-10-12', label: 'Oct 12', input_tokens: 310_000, output_tokens: 41_800, estimated_cost_usd: 0.104, model_id: 'deepseek-flash' },
        ],
    daily_token_cap: 500_000,
    tokens_today: empty ? 0 : 351_800,
  };

  let head = 100n;
  const listeners = new Set<(event: StreamEvent) => void>();
  const backlog: StreamEvent[] = [];

  function publish(event: StreamEvent): void {
    backlog.push(event);
    head = BigInt(event.id);
    for (const listener of listeners) listener(event);
  }

  /** Run one contract scenario on the session socket, paced for a human. */
  function runScenario(scenario: Parameters<typeof mockRunStream>[0], sessionId: string): void {
    const events = mockRunStream(scenario, { workspaceId: WS, sessionId, runId: RUN, firstId: head + 1n });
    events.forEach((event, i) => {
      setTimeout(() => publish(event), 220 * (i + 1));
    });
  }

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const page = (items: unknown[]) => json({ items, cursor: null, total: items.length });
  const fail = (status: number, reason: string, message = reason) => json({ error: message, reason }, status);

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://mock.local');
    const path = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: Record<string, unknown> = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const p = (suffix: string) => path === `/w/${WS}${suffix}`;
    const match = (pattern: RegExp) => pattern.exec(path);

    if (path === '/health') return json({ status: 'ok', version: 'mock', checks: [] });

    if (path === '/auth/session')
      return json({
        user: { id: USER, name: seat === 'admin' ? 'Maya Chen' : 'Alex Rivera', email: seat === 'admin' ? 'maya@nous.example' : 'alex@nous.example', role: seat },
        workspace: { id: WS, name: 'Nous' },
        stream_heads: { workspace: head.toString() },
        hub_ticket: 'mock-ticket',
        expires_at: iso(600),
        authenticated_at: iso(0),
      });

    if (p('/bootstrap'))
      return json({
        workspace: {
          id: WS,
          name: 'Nous',
          jurisdiction: 'default',
          settings: { default_model_id: 'deepseek-flash', default_effort: 'high', default_runtime: 'cloud', daily_token_cap: 500_000, max_concurrent_runs: 3, timezone: 'UTC', flags: {} },
        },
        viewer: { user_id: USER, role: seat, reviewer_roles: seat === 'admin' ? ['access'] : [] },
        heads: { session: head.toString(), workspace: head.toString() },
        counts: { inbox: requests.filter((r) => r.status === 'pending').length, pending_grants: 0, created_documents: documents.length, decisions: 0 },
        sessions: sessions.map((s) => ({ id: s.id, title: s.title, mode: s.mode, model_id: s.model_id, effort: s.effort, pinned: s.pinned, archived: s.archived, focus_ref: s.focus_ref, status: s.status, last_activity_at: s.last_activity_at })),
        requests: requests.map((r) => ({ id: r.id, kind: r.kind, status: r.status, label: r.label })),
        catalog,
      });

    if (p('/bootstrap/client'))
      return json({
        members,
        invitations: empty ? [] : [{ id: mockUuid(210), email: 'lena@nous.example', role: 'member', status: 'pending', invited_at: iso(-4000), version: 1 }],
        provider_keys: providerKeys,
        agent: { id: AGENT, name: 'Iris', email: 'iris@nous.example', summary: 'Iris screens partner applications, prepares documents and routes feedback. Every admission, document, send, payment and signature waits for a human.', setup_step: null },
        hub_ticket: 'mock-ticket',
        csrf_token: 'mock-csrf',
      });

    if (p('/events')) {
      const after = BigInt(url.searchParams.get('after') ?? '0');
      return json({ stream: url.searchParams.get('stream')?.startsWith('session') ? 'session' : 'workspace', after: after.toString(), head: head.toString(), resync: false, events: backlog.filter((e) => BigInt(e.id) > after) });
    }

    if (p('/sessions') && method === 'GET') return page(sessions);
    if (p('/sessions') && method === 'POST') {
      const created = { id: mockUuid(400 + sessions.length), title: String(body.title ?? 'New session'), mode: String(body.mode ?? 'ask'), model_id: 'deepseek-flash', effort: 'high', runtime: 'cloud', pinned: false, archived: false, focus_ref: null, status: 'Empty', last_activity_at: iso(0), share: null, context: null, version: 1 };
      sessions.push(created);
      messages[created.id] = [];
      return json(created);
    }

    const sessionMatch = match(new RegExp(`^/w/${WS}/sessions/([^/]+)(/.*)?$`));
    if (sessionMatch) {
      const sessionId = sessionMatch[1]!;
      const rest = sessionMatch[2] ?? '';
      const row = sessions.find((s) => s.id === sessionId);
      if (rest === '/messages') return page(url.searchParams.get('before') ? [] : messages[sessionId] ?? []);
      if (rest === '/turns') {
        if (!hasVerifiedKey) return fail(409, 'no_verified_key', 'Add a provider key in Settings to start');
        runScenario('completed', sessionId);
        return json({ run_id: RUN, client_turn_id: String(body.client_turn_id ?? ''), duplicate: false });
      }
      if (rest === '/stop') {
        runScenario('stopped', sessionId);
        return new Response(null, { status: 204 });
      }
      if (rest === '/guide' || rest === '/queue') return new Response(null, { status: 204 });
      if (rest === '/shares' && method === 'POST') {
        const share = { id: mockUuid(500), url: `${url.origin}/shared/mock-share-token`, audience: String(body.audience ?? 'Nous team'), message_cutoff_seq: 2, created_at: iso(0) };
        if (row) row.share = { id: share.id, url: share.url, audience: share.audience, created_at: share.created_at, messages: 2 };
        return json(share);
      }
      if (rest.startsWith('/shares/')) {
        if (row) row.share = null;
        return new Response(null, { status: 204 });
      }
      if (rest.startsWith('/queue/')) return new Response(null, { status: 204 });
      if (method === 'PATCH' && row) {
        Object.assign(row, body);
        return json(row);
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
    }

    const requestMatch = match(new RegExp(`^/w/${WS}/requests/([^/]+)(/.*)?$`));
    if (requestMatch) {
      const id = requestMatch[1]!;
      const rest = requestMatch[2] ?? '';
      const row = requests.find((r) => r.id === id);
      if (rest === '/decisions' && method === 'POST') {
        if (seat !== 'admin') return fail(403, 'not_admin', 'Admin decision required');
        if (!row) return fail(404, 'not_found');
        if (row.status !== 'pending') return fail(409, 'already_decided', 'Already decided');
        const decision = body.decision === 'decline' ? 'decline' : 'approve';
        const resulting = decision === 'decline' ? 'declined' : row.kind === 'application' ? 'admitted' : row.kind === 'invoice' ? 'created' : 'drafted';
        row.status = resulting;
        row.version += 1;
        row.decided_at = iso(1);
        row.decided_by_name = 'Maya Chen';
        const decisionId = mockUuid(600 + requests.indexOf(row));
        row.decision_id = decisionId;
        publish({
          id: (head + 1n).toString(),
          workspace_id: WS,
          session_id: null,
          kind: 'decision.recorded',
          schema_version: SCHEMA_VERSION,
          trace_id: 'trace-mock-decide',
          at: iso(1),
          payload: { request_id: id, decision_id: decisionId, decision, resulting_status: resulting, decided_by: USER, decided_at: iso(1), effect_ids: [] },
        } as StreamEvent);
        return json({ decision_id: decisionId, request_id: id, resulting_status: resulting, effect_ids: [] });
      }
      if (rest === '/effects') return page([]);
      if (!rest) return row ? json(row) : fail(404, 'not_found');
    }

    if (p('/requests')) return page(requests);
    if (p('/documents')) return page(documents);
    const documentMatch = match(new RegExp(`^/w/${WS}/documents/([^/]+)$`));
    if (documentMatch) {
      const row = documents.find((d) => d.id === documentMatch[1]);
      return row ? json(row) : fail(404, 'not_found');
    }
    if (p('/members')) return page(members);
    if (p('/invitations')) return page(empty ? [] : [{ id: mockUuid(210), email: 'lena@nous.example', role: 'member', status: 'pending', invited_at: iso(-4000), version: 1 }]);
    if (p('/history')) return page(history);
    if (p('/traces')) return page(traces);
    const traceMatch = match(new RegExp(`^/w/${WS}/traces/([^/]+)$`));
    if (traceMatch) {
      const row = traces.find((t) => t.id === traceMatch[1]);
      return row ? json(row) : fail(404, 'not_found');
    }
    if (p('/agent-files')) return page(agentFiles);
    if (p('/context-fields')) return page(contextFields);
    const contextMatch = match(new RegExp(`^/w/${WS}/context-fields/([^/]+)$`));
    if (contextMatch && method === 'PATCH') {
      const field = contextFields[0]!;
      field.value = String(body.value ?? '');
      field.scope = (body.scope === 'future' ? 'future' : 'reply') as 'reply' | 'future';
      field.version += 1;
      return json(field);
    }
    if (p('/instructions')) return page(instructions);
    if (p('/skills')) return page(skills);
    if (p('/provider-keys') && method === 'GET') return json({ keys: providerKeys });
    if (p('/provider-keys') && method === 'POST') {
      providerKeys.push({ id: mockUuid(41), provider: (body.provider as MaskedProviderKey['provider']) ?? 'deepseek', label: String(body.label ?? 'New key'), last4: '1234', fingerprint_prefix: 'bb0091fe22aa', status: 'unverified', verified_models: [], added_by: USER, created_at: iso(0), verified_at: null, rotated_at: null, revoked_at: null, replaces_key_id: null });
      return json({ keys: providerKeys });
    }
    if (path.startsWith(`/w/${WS}/provider-keys/`)) {
      if (method === 'DELETE') return new Response(null, { status: 204 });
      const id = path.split('/')[4];
      const row = providerKeys.find((k) => k.id === id);
      if (row && path.endsWith('/verify')) {
        row.status = 'verified';
        row.verified_models = ['deepseek-flash'];
        row.verified_at = iso(0);
      }
      return json({ keys: providerKeys });
    }
    if (p('/usage')) return json(usage);
    if (p('/settings') || path.startsWith(`/w/${WS}/agents/`)) return new Response(null, { status: 204 });
    if (path.startsWith('/shared/')) {
      if (path.endsWith('revoked')) return json({ session: { id: SESSION_A, title: 'Partner applications', workspace_name: 'Nous' }, messages: [], message_cutoff_seq: 0, revoked: true });
      return json({ session: { id: SESSION_A, title: 'Partner applications', workspace_name: 'Nous' }, messages: messages[SESSION_A] ?? [], message_cutoff_seq: 2, revoked: false });
    }
    if (path.startsWith(`/w/${WS}/messages/`)) return new Response(null, { status: 204 });
    if (path === '/workspaces' && method === 'POST') return fail(501, 'not_implemented', 'Workspace creation is not available in mock mode');

    return fail(404, 'no_mock_route', `mock backend has no route for ${method} ${path}`);
  };

  const socketFactory = (url: string): SocketLike => {
    const socket: SocketLike = { send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null };
    const listener = (event: StreamEvent): void => {
      const forSession = url.includes('/hub/session/');
      const sessionScoped = event.session_id !== null;
      if (forSession !== sessionScoped) return;
      socket.onmessage?.({ data: JSON.stringify(event) });
    };
    listeners.add(listener);
    socket.close = () => listeners.delete(listener);
    setTimeout(() => socket.onopen?.({}), 0);
    return socket;
  };

  return { fetchImpl, socketFactory, workspaceId: WS, publish, runScenario };
}
