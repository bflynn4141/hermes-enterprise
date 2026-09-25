// Walkthrough mode: one scripted Partnerships → Finance story, played through
// the mock backend so the real client renders every screen.
//
//     MOCK=1 pnpm --filter @hermes/client dev   then   /?walkthrough=1
//
// It exists to record a product walkthrough (`pnpm walkthrough:record`, see
// docs/WALKTHROUGH.md). Maya Chen runs Partnerships with her agent Scout; Alex
// Rivera runs Finance with Ledger. Maya asks Scout for workshop partners,
// approves one, and hands the terms to Finance. Alex asks Ledger for the
// services agreement and approves the draft. Maya then finds it in the Library,
// unsigned and ready for signature.
//
// The agent replies are scripted, keyed to where the story is rather than to
// the words typed, and every name, figure and document is fictional. The story
// lives in localStorage, so switching person (a page reload) keeps it.
import { formatBotModeAgentMessage, mockUuid, parseStreamEvent, SCHEMA_VERSION, type RequestEntity, type StreamEvent } from '@hermes/shared';

export type WalkthroughPerson = 'maya' | 'alex';

const STORAGE_KEY = 'hermes:walkthrough';

interface Beat {
  /** What the person typed, so a reload replays their own words. */
  prompt?: string;
  at: string;
}

export interface WalkthroughStory {
  person: WalkthroughPerson;
  shortlist?: Beat;
  approvedPartner?: Beat;
  handoff?: Beat;
  draft?: Beat;
  agreementApproved?: Beat;
}

export function readWalkthroughStory(): WalkthroughStory {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as WalkthroughStory) : null;
    if (parsed && (parsed.person === 'maya' || parsed.person === 'alex')) return parsed;
  } catch {
    /* A fresh story is the right fallback for unreadable storage. */
  }
  return { person: 'maya' };
}

export function writeWalkthroughStory(story: WalkthroughStory): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(story));
  } catch {
    /* The in-memory story still plays; only a reload would lose it. */
  }
}

export function resetWalkthroughStory(): void {
  writeWalkthroughStory({ person: 'maya' });
}

/** The account menu's person switch: save who is next, then reload as them. */
export function switchWalkthroughPerson(person: WalkthroughPerson): void {
  writeWalkthroughStory({ ...readWalkthroughStory(), person });
  window.location.reload();
}

export const WALKTHROUGH_PEOPLE: readonly { person: WalkthroughPerson; name: string; role: string }[] = [
  { person: 'maya', name: 'Maya Chen', role: 'Partnerships' },
  { person: 'alex', name: 'Alex Rivera', role: 'Finance' },
];

// ---------------------------------------------------------------------------
// Fixed ids, in their own range so they never meet the fixture's.
// ---------------------------------------------------------------------------

export const WALKTHROUGH_IDS = {
  scoutSession: mockUuid(8_001),
  ledgerSession: mockUuid(8_002),
  scoutOlder: [mockUuid(8_003), mockUuid(8_004)],
  ledgerOlder: [mockUuid(8_005), mockUuid(8_006)],
  shortlistRun: mockUuid(8_010),
  handoffRun: mockUuid(8_011),
  handoffCheckRun: mockUuid(8_012),
  draftRun: mockUuid(8_013),
  receiptRun: mockUuid(8_014),
  robin: mockUuid(8_020),
  leah: mockUuid(8_021),
  owen: mockUuid(8_022),
  agreement: mockUuid(8_023),
  agreementDoc: mockUuid(8_024),
  vendorInvoice: mockUuid(8_025),
  renewal: mockUuid(8_026),
} as const;

const AGREEMENT_NUMBER = 'AGR-2026-031';

export interface WalkthroughContext {
  workspaceId: string;
  scoutAgentId: string;
  ledgerAgentId: string;
  now: () => string;
}

// ---------------------------------------------------------------------------
// What each person sees, rebuilt from the story on every load.
// ---------------------------------------------------------------------------

interface SeedSession {
  id: string;
  agent_id: string;
  title: string;
  mode: string;
  status: string;
  last_activity_at: string;
  focus_ref: null;
  context: null;
}

export interface WalkthroughSeed {
  sessions: SeedSession[];
  messages: Record<string, unknown[]>;
  requests: RequestEntity[];
  documents: {
    id: string; kind: 'agreement'; number: string; title: string; status: string; request_id: string;
    pdf_status: 'none'; pdf_url: null; pdf_error: null; payload: Record<string, unknown>; version: number; created_at: string;
  }[];
  activeSessionId: string;
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function session(id: string, agentId: string, title: string, status: string, at: string): SeedSession {
  return { id, agent_id: agentId, title, mode: 'work', status, last_activity_at: at, focus_ref: null, context: null };
}

function userMessage(sessionId: string, seq: number, text: string, at: string) {
  return { id: mockUuid(8_100 + seq + (sessionId === WALKTHROUGH_IDS.ledgerSession ? 50 : 0)), session_id: sessionId, seq, role: 'user', kind: null, text, blocks: [], status: 'complete', run_id: null, at };
}

function agentMessage(sessionId: string, seq: number, runId: string, reply: ScriptedReply, at: string) {
  return {
    id: mockUuid(8_200 + seq + (sessionId === WALKTHROUGH_IDS.ledgerSession ? 50 : 0)), session_id: sessionId, seq, role: 'iris', kind: null,
    text: reply.text, blocks: reply.blocks, status: 'complete', run_id: runId,
    worked_ms: reply.workedMs, steps: reply.tools.map((tool) => tool.name), at,
  };
}

export function walkthroughSeed(ctx: WalkthroughContext, story: WalkthroughStory): WalkthroughSeed {
  const ids = WALKTHROUGH_IDS;
  return story.person === 'maya' ? mayaSeed(ctx, story, ids) : alexSeed(ctx, story, ids);
}

function mayaSeed(ctx: WalkthroughContext, story: WalkthroughStory, ids: typeof WALKTHROUGH_IDS): WalkthroughSeed {
  const main: unknown[] = [];
  let seq = 0;
  if (story.shortlist) {
    main.push(userMessage(ids.scoutSession, ++seq, story.shortlist.prompt ?? SHORTLIST_PROMPT, story.shortlist.at));
    main.push(agentMessage(ids.scoutSession, ++seq, ids.shortlistRun, shortlistReply(), story.shortlist.at));
  }
  if (story.handoff) {
    main.push(userMessage(ids.scoutSession, ++seq, story.handoff.prompt ?? HANDOFF_PROMPT, story.handoff.at));
    main.push(agentMessage(ids.scoutSession, ++seq, ids.handoffRun, handoffReply(), story.handoff.at));
  }
  if (story.agreementApproved) {
    main.push(userMessage(ids.scoutSession, ++seq, formatBotModeAgentMessage({ display: 'Ledger', profile: 'agent-finance', body: FINANCE_RECEIPT }), story.agreementApproved.at));
    main.push(agentMessage(ids.scoutSession, ++seq, ids.receiptRun, receiptReply(), story.agreementApproved.at));
  }
  const requests: RequestEntity[] = story.shortlist
    ? candidates(ctx, story).map((candidate) => candidateRequest(ctx, candidate, story))
    : [];
  requests.push(renewalRequest(ctx));
  return {
    sessions: [
      session(ids.scoutSession, ctx.scoutAgentId, story.shortlist ? 'November workshop partners' : 'New session', story.agreementApproved ? 'Agreement ready' : story.handoff ? 'With Finance' : story.shortlist ? 'Needs review' : 'Empty', story.agreementApproved?.at ?? story.handoff?.at ?? story.shortlist?.at ?? ctx.now()),
      session(ids.scoutOlder[0]!, ctx.scoutAgentId, 'Q3 partner check-ins', 'Done', hoursAgo(26)),
      session(ids.scoutOlder[1]!, ctx.scoutAgentId, 'Partner criteria refresh', 'Done', hoursAgo(74)),
    ],
    messages: {
      [ids.scoutSession]: main,
      [ids.scoutOlder[0]!]: [
        userMessage(ids.scoutOlder[0]!, 1, 'Which partners haven’t sent their Q3 updates yet?', hoursAgo(26)),
        { ...agentMessage(ids.scoutOlder[0]!, 2, mockUuid(8_030), { text: 'Two partners are still missing Q3 updates: **Northwind Labs** and **Harbor AI**. I drafted a short reminder for each; they are waiting in your Inbox and nothing has been sent.', blocks: [], tools: [{ name: 'list_partner_candidates', ms: 0 }], workedMs: 21_000 }, hoursAgo(26)), id: mockUuid(8_031) },
      ],
      [ids.scoutOlder[1]!]: [],
    },
    requests,
    documents: story.agreementApproved ? [agreementDocument(ctx, story.agreementApproved.at)] : [],
    activeSessionId: ids.scoutSession,
  };
}

function alexSeed(ctx: WalkthroughContext, story: WalkthroughStory, ids: typeof WALKTHROUGH_IDS): WalkthroughSeed {
  const main: unknown[] = [];
  let seq = 0;
  if (story.handoff) {
    main.push(userMessage(ids.ledgerSession, ++seq, formatBotModeAgentMessage({ display: 'Scout', profile: 'agent-partnerships', body: PARTNERSHIPS_HANDOFF }), story.handoff.at));
    main.push(agentMessage(ids.ledgerSession, ++seq, ids.handoffCheckRun, handoffCheckReply(), story.handoff.at));
  }
  if (story.draft) {
    main.push(userMessage(ids.ledgerSession, ++seq, story.draft.prompt ?? DRAFT_PROMPT, story.draft.at));
    main.push(agentMessage(ids.ledgerSession, ++seq, ids.draftRun, draftReply(), story.draft.at));
  }
  const requests: RequestEntity[] = [vendorInvoiceRequest(ctx)];
  if (story.draft) requests.push(agreementRequest(ctx, story));
  const sessions = [
    session(ids.ledgerOlder[0]!, ctx.ledgerAgentId, 'September vendor invoices', 'Done', hoursAgo(20)),
    session(ids.ledgerOlder[1]!, ctx.ledgerAgentId, 'Q4 budget check', 'Done', hoursAgo(52)),
  ];
  if (story.handoff) {
    sessions.unshift(session(ids.ledgerSession, ctx.ledgerAgentId, 'Robin Studio · Services agreement', story.agreementApproved ? 'Approved' : story.draft ? 'Needs review' : 'From Partnerships', story.agreementApproved?.at ?? story.draft?.at ?? story.handoff.at));
  }
  return {
    sessions,
    messages: {
      ...(story.handoff ? { [ids.ledgerSession]: main } : {}),
      [ids.ledgerOlder[0]!]: [
        userMessage(ids.ledgerOlder[0]!, 1, 'Anything odd in the September vendor invoices?', hoursAgo(20)),
        { ...agentMessage(ids.ledgerOlder[0]!, 2, mockUuid(8_032), { text: 'One thing: **Northwind Cloud** billed USD 2,340 against a USD 1,950 purchase order. I put it in your Inbox with both documents side by side. The other 14 invoices match their orders.', blocks: [], tools: [{ name: 'list_requests', ms: 0 }], workedMs: 33_000 }, hoursAgo(20)), id: mockUuid(8_033) },
      ],
      [ids.ledgerOlder[1]!]: [],
    },
    requests,
    documents: story.agreementApproved ? [agreementDocument(ctx, story.agreementApproved.at)] : [],
    activeSessionId: story.handoff ? ids.ledgerSession : ids.ledgerOlder[0]!,
  };
}

// ---------------------------------------------------------------------------
// The script: prompts, replies and the tools each run shows.
// ---------------------------------------------------------------------------

/** Used only if a reload lost what the person actually typed. */
export const SHORTLIST_PROMPT = 'Can you pull together a shortlist of partners who could run hands-on Hermes Agent workshops for our dev teams in November? Ideally people who have taught agent tooling before. Budget is around $15k.';
export const HANDOFF_PROMPT = 'Robin Studio looks great. Let’s go with them for Nov 18–19 at $14,500. Can you send it over to Finance so they can get the agreement started?';
export const DRAFT_PROMPT = 'Thanks, looks good. Can you draft the services agreement from our standard template? Net 30 after delivery, and keep the usual IP and confidentiality terms.';

const PARTNERSHIPS_HANDOFF = 'Maya Chen approved Robin Studio for the November developer workshops. Terms: a two-day hands-on workshop on Nov 18–19, USD 14,500 flat. Robin’s quote and Maya’s approval are attached. Please prepare the services agreement for Finance review.';
const FINANCE_RECEIPT = `Alex Rivera approved the services agreement for Robin Studio (${AGREEMENT_NUMBER}). It is saved in the Library, unsigned and ready for signature.`;

interface ScriptedReply {
  text: string;
  blocks: Record<string, unknown>[];
  /** Tool calls in order; `ms` is how long each one stays active on screen. */
  tools: { name: string; ms: number }[];
  workedMs: number;
}

function shortlistReply(): ScriptedReply {
  return {
    text: [
      'I found three partners worth your time. I scored each one against the Partner Program criteria and checked their public work.',
      '',
      '| Partner | Score | Why |',
      '| --- | --- | --- |',
      '| **Robin Studio** | 91 | 12 agent workshops this year, free Nov 18–19, quoted $14,500 |',
      '| **Leah Martinez** | 84 | Excellent teaching reviews, but only free in early December |',
      '| **Owen Reilly** | 76 | Strong integration guides, quoted $19,000, over budget |',
      '',
      '**Robin Studio looks like the best fit.** Their curriculum covers tool calling and evals, and they have already published Hermes Agent examples. I haven’t contacted anyone. All three are in your Inbox for review.',
    ].join('\n'),
    blocks: [],
    tools: [
      { name: 'list_partner_candidates', ms: 1_900 },
      { name: 'get_document_text', ms: 1_500 },
      { name: 'web_search', ms: 2_600 },
      { name: 'web_extract', ms: 2_100 },
      { name: 'get_partner_candidate', ms: 1_700 },
      { name: 'propose_request', ms: 1_400 },
    ],
    workedMs: 47_000,
  };
}

function handoffReply(): ScriptedReply {
  return {
    text: [
      'Done. I sent Finance the approved terms for Robin Studio:',
      '',
      '- **Scope:** two-day hands-on Hermes Agent workshop, Nov 18–19',
      '- **Fee:** USD 14,500, flat',
      '- **Evidence:** Robin’s quote and your approval',
      '',
      'Ledger has the handoff, and Alex Rivera is the Finance reviewer. Finance sees only the partner, the terms and the evidence; this conversation stays with Partnerships. I’ll let you know when the agreement is ready.',
    ].join('\n'),
    blocks: [{ type: 'card', title: 'Robin Studio · Sent to Finance', subtitle: 'USD 14,500 · Waiting on Alex Rivera' }],
    tools: [
      { name: 'get_request', ms: 1_500 },
      { name: 'get_document_text', ms: 1_300 },
      { name: 'propose_request', ms: 1_800 },
    ],
    workedMs: 19_000,
  };
}

function handoffCheckReply(): ScriptedReply {
  return {
    text: [
      'I checked the Robin Studio handoff before you got here.',
      '',
      '- **Budget:** USD 14,500 fits the Partnerships Q4 budget, with USD 38,200 left before this commitment.',
      '- **Vendor:** Robin Studio LLC is new to us, so we need a W-9 before the first payment.',
      '- **Duplicates:** no other open engagement or invoice for Robin Studio.',
      '',
      'The terms match Maya’s approval. I can draft the services agreement when you’re ready.',
    ].join('\n'),
    blocks: [],
    tools: [{ name: 'get_request', ms: 0 }, { name: 'get_workspace_context', ms: 0 }, { name: 'list_requests', ms: 0 }],
    workedMs: 24_000,
  };
}

function draftReply(): ScriptedReply {
  return {
    text: [
      'The services agreement for Robin Studio is ready for your approval.',
      '',
      '- **Scope:** two-day hands-on Hermes Agent workshop for up to 40 engineers, Nov 18–19',
      '- **Fee:** USD 14,500 flat, invoiced after delivery, net 30',
      '- **IP and confidentiality:** our standard template language, unchanged',
      '- **Before payment:** Robin Studio sends a W-9',
      '',
      'Everything matches what Maya approved. It stays a draft until you approve it, and nothing is signed or sent.',
    ].join('\n'),
    blocks: [],
    tools: [
      { name: 'get_request', ms: 1_400 },
      { name: 'get_document_text', ms: 2_000 },
      { name: 'get_workspace_context', ms: 1_600 },
      { name: 'propose_request', ms: 1_900 },
    ],
    workedMs: 38_000,
  };
}

function receiptReply(): ScriptedReply {
  return {
    text: [
      '**The Robin Studio agreement is ready to sign.** Alex approved it in Finance with the terms you set: Nov 18–19, USD 14,500 flat, net 30 after delivery.',
      '',
      'Next, you and Robin sign it. I can draft the cover email to Robin whenever you want to send it.',
    ].join('\n'),
    blocks: [{
      type: 'card',
      title: `Services agreement ${AGREEMENT_NUMBER}`,
      subtitle: 'Robin Studio · Approved by Finance · Ready for signature',
      action: { label: 'Open agreement', command: { type: 'open_document', id: WALKTHROUGH_IDS.agreementDoc } },
    }],
    tools: [{ name: 'get_request', ms: 0 }],
    workedMs: 9_000,
  };
}

// ---------------------------------------------------------------------------
// Requests and the agreement document.
// ---------------------------------------------------------------------------

interface Candidate {
  id: string;
  name: string;
  score: number;
  role: string;
  criteria: { id: string; label: string; points: number; points_max: number; evidence: string; source_ids: string[] }[];
  missing: string[];
  sources: { id: string; name: string; note: string; url: string }[];
}

function candidates(_ctx: WalkthroughContext, _story: WalkthroughStory): Candidate[] {
  return [
    {
      id: WALKTHROUGH_IDS.robin, name: 'Robin Studio', score: 91, role: 'Workshop partner',
      criteria: [
        { id: 'track-record', label: 'track-record', points: 28, points_max: 30, evidence: 'Ran 12 hands-on agent workshops for developer teams this year, covering tool calling and evals.', source_ids: ['site', 'youtube'] },
        { id: 'capacity', label: 'capacity', points: 27, points_max: 30, evidence: 'Two facilitators free on Nov 18–19; quoted USD 14,500 for two days.', source_ids: ['quote'] },
        { id: 'fit', label: 'fit', points: 36, points_max: 40, evidence: 'Publishes open Hermes Agent examples and teaches with open-weight models.', source_ids: ['github'] },
      ],
      missing: ['Reference call'],
      sources: [
        { id: 'site', name: 'robinstudio.example', note: 'Workshop catalog and past client list.', url: 'https://robinstudio.example/' },
        { id: 'github', name: 'GitHub · robin-studio/agent-workshops', note: 'Public curriculum, updated last week.', url: 'https://github.com/' },
        { id: 'youtube', name: 'YouTube', note: 'Two recorded workshop sessions.', url: 'https://www.youtube.com/' },
        { id: 'quote', name: 'Quote from Robin Ellis', note: 'Emailed quote for a two-day workshop.', url: 'https://robinstudio.example/quote' },
      ],
    },
    {
      id: WALKTHROUGH_IDS.leah, name: 'Leah Martinez', score: 84, role: 'Workshop partner',
      criteria: [
        { id: 'track-record', label: 'track-record', points: 27, points_max: 30, evidence: 'Created and led an FDE bootcamp for implementation teams.', source_ids: ['linkedin', 'youtube'] },
        { id: 'capacity', label: 'capacity', points: 21, points_max: 30, evidence: 'Next open dates are Dec 2–3, after the November window.', source_ids: ['linkedin'] },
        { id: 'fit', label: 'fit', points: 36, points_max: 40, evidence: 'Strong teaching reviews from engineering audiences.', source_ids: ['youtube'] },
      ],
      missing: ['November availability'],
      sources: [
        { id: 'linkedin', name: 'LinkedIn', note: 'Role history and bootcamp timeline.', url: 'https://www.linkedin.com/' },
        { id: 'youtube', name: 'YouTube', note: 'Bootcamp sessions and walkthroughs.', url: 'https://www.youtube.com/' },
      ],
    },
    {
      id: WALKTHROUGH_IDS.owen, name: 'Owen Reilly', score: 76, role: 'Workshop partner',
      criteria: [
        { id: 'track-record', label: 'track-record', points: 25, points_max: 30, evidence: 'Wrote integration guides used by partner engineers; three live workshops.', source_ids: ['github'] },
        { id: 'capacity', label: 'capacity', points: 22, points_max: 30, evidence: 'Available in November; quoted USD 19,000.', source_ids: ['x'] },
        { id: 'fit', label: 'fit', points: 29, points_max: 40, evidence: 'Focuses on deployment more than hands-on agent building.', source_ids: ['github', 'x'] },
      ],
      missing: ['Quote is over budget'],
      sources: [
        { id: 'github', name: 'GitHub', note: 'Integration guides and sample apps.', url: 'https://github.com/' },
        { id: 'x', name: 'X profile', note: 'Public writing on deployment.', url: 'https://x.com/' },
      ],
    },
  ];
}

function baseRequest(ctx: WalkthroughContext, fields: Pick<RequestEntity, 'id' | 'kind' | 'status' | 'label' | 'subject' | 'title' | 'session_id' | 'run_id' | 'created_at' | 'payload'> & Partial<RequestEntity>): RequestEntity {
  return {
    version: 1, sources: [], missing: [], note: null, decision_id: null, decided_at: null, decided_by_name: null,
    provenance: { kind: 'operational', source: 'walkthrough', recorded_at: fields.created_at },
    presentation: { hidden: false, hidden_at: null, hidden_reason: null },
    triage: { status: 'complete', band: 'normal', score: 60, confidence: 0.8, reason_codes: ['goal'], assessed_at: fields.created_at, rubric_version: 'v1', model_id: 'nous:anthropic/claude-sonnet-5' },
    ...fields,
  } as RequestEntity;
}

function candidateRequest(ctx: WalkthroughContext, candidate: Candidate, story: WalkthroughStory): RequestEntity {
  const approved = candidate.id === WALKTHROUGH_IDS.robin && story.approvedPartner;
  const at = story.shortlist?.at ?? ctx.now();
  return baseRequest(ctx, {
    id: candidate.id, kind: 'application', status: approved ? 'admitted' : 'pending',
    label: candidate.name, subject: candidate.name, title: 'Partner Program application',
    session_id: WALKTHROUGH_IDS.scoutSession, run_id: WALKTHROUGH_IDS.shortlistRun, created_at: at,
    decided_at: approved ? story.approvedPartner!.at : null, decided_by_name: approved ? 'Maya Chen' : null,
    payload: {
      kind: 'application', applicant: { name: candidate.name }, proposed_role: candidate.role, score: candidate.score, score_max: 100,
      criteria: candidate.criteria, sources: candidate.sources, missing: candidate.missing,
      benefits: ['Partner directory listing', 'Workshop co-marketing', 'Quarterly review slot'],
    },
    sources: candidate.sources.map(({ id, name, note }) => ({ id, name, note })),
    missing: candidate.missing,
    triage: { status: 'complete', band: candidate.score >= 90 ? 'high' : 'normal', score: candidate.score, confidence: 0.86, reason_codes: candidate.score >= 90 ? ['goal', 'deadline'] : ['goal'], assessed_at: at, rubric_version: 'v1', model_id: 'nous:anthropic/claude-sonnet-5' },
    decision_summary: {
      action: 'Review applicant', primary: candidate.role, facts: [], consequence: null,
      approval_requirement: { mode: 'single', completed_steps: approved ? 1 : 0, total_steps: 1, remaining_approvals: approved ? 0 : 1, current: approved ? [] : [{ label: 'Workspace Admin', approvals_recorded: 0, quorum: 1 }], pending_for_viewer: !approved, waiting_on_others: false, expires_at: null },
    },
  });
}

function renewalRequest(ctx: WalkthroughContext): RequestEntity {
  const at = hoursAgo(5);
  return baseRequest(ctx, {
    id: WALKTHROUGH_IDS.renewal, kind: 'application', status: 'pending', label: 'Harbor AI', subject: 'Harbor AI', title: 'Partner Program renewal',
    session_id: WALKTHROUGH_IDS.scoutOlder[0]!, run_id: mockUuid(8_030), created_at: at,
    payload: {
      kind: 'application', applicant: { name: 'Harbor AI' }, proposed_role: 'Renewal · Integration partner', score: 72, score_max: 100,
      criteria: [
        { id: 'track-record', label: 'track-record', points: 24, points_max: 30, evidence: 'Shipped two customer integrations this year.', source_ids: ['site'] },
        { id: 'capacity', label: 'capacity', points: 20, points_max: 30, evidence: 'Q3 update still missing.', source_ids: [] },
        { id: 'fit', label: 'fit', points: 28, points_max: 40, evidence: 'Integration work matches the program focus.', source_ids: ['site'] },
      ],
      sources: [{ id: 'site', name: 'harbor-ai.example', note: 'Partner page.', url: 'https://harbor-ai.example/' }],
      missing: ['Q3 update'],
    },
    missing: ['Q3 update'],
    triage: { status: 'complete', band: 'low', score: 40, confidence: 0.8, reason_codes: ['routine'], assessed_at: at, rubric_version: 'v1', model_id: 'nous:anthropic/claude-sonnet-5' },
    decision_summary: {
      action: 'Review applicant', primary: 'Renewal · Integration partner', facts: [], consequence: null,
      approval_requirement: { mode: 'single', completed_steps: 0, total_steps: 1, remaining_approvals: 1, current: [{ label: 'Workspace Admin', approvals_recorded: 0, quorum: 1 }], pending_for_viewer: true, waiting_on_others: false, expires_at: null },
    },
  });
}

function vendorInvoiceRequest(ctx: WalkthroughContext): RequestEntity {
  const at = hoursAgo(20);
  return baseRequest(ctx, {
    id: WALKTHROUGH_IDS.vendorInvoice, kind: 'invoice', status: 'pending', label: 'INV-NW-2291', subject: 'Northwind Cloud', title: 'Invoice INV-NW-2291',
    session_id: WALKTHROUGH_IDS.ledgerOlder[0]!, run_id: mockUuid(8_032), created_at: at,
    payload: {
      kind: 'invoice', number: 'INV-NW-2291', total_minor: 234_000, currency: 'USD', payee: { name: 'Northwind Cloud' }, payer: { name: 'Nous Research, Inc.' },
      issue_date: 'Sep 30, 2026', due_date: 'Oct 30, 2026', notes: 'Billed USD 2,340 against purchase order PO-1187 for USD 1,950.',
      lines: [{ id: 'l1', label: 'GPU hours · September', short: 'GPU hours', qty: 1, amount_minor: 234_000, date: 'Sep 30' }],
    },
    triage: { status: 'complete', band: 'normal', score: 55, confidence: 0.8, reason_codes: ['risk'], assessed_at: at, rubric_version: 'v1', model_id: 'nous:anthropic/claude-sonnet-5' },
    decision_summary: {
      action: 'Approve invoice draft', primary: 'Invoice from Northwind Cloud', facts: [], consequence: null,
      approval_requirement: { mode: 'single', completed_steps: 0, total_steps: 1, remaining_approvals: 1, current: [{ label: 'Finance reviewer', approvals_recorded: 0, quorum: 1 }], pending_for_viewer: true, waiting_on_others: false, expires_at: null },
    },
  });
}

function agreementPayload(): Record<string, unknown> {
  return {
    kind: 'agreement',
    number: AGREEMENT_NUMBER,
    version_label: 'v1 · Standard services template',
    parties: [
      { name: 'Nous Research, Inc.', email: 'finance@nous.example' },
      { name: 'Robin Studio LLC', email: 'robin@robinstudio.example' },
    ],
    effective_dates: { from: 'Nov 1, 2026', to: 'Dec 31, 2026' },
    total_minor: 1_450_000,
    currency: 'USD',
    sections: [
      { id: 'services', heading: 'Services', body: 'Robin Studio will design and deliver a two-day, hands-on Hermes Agent workshop for up to 40 Nous engineers on November 18–19, 2026, including exercises, a take-home lab and a written summary of outcomes.' },
      { id: 'fees', heading: 'Fees and payment', body: 'Nous will pay a flat fee of USD 14,500. Robin Studio will invoice after delivery, and payment is due net 30 from receipt of a valid invoice. A completed W-9 is required before payment.' },
      { id: 'expenses', heading: 'Expenses', body: 'The fee includes preparation and materials. No travel is expected; any expense needs written approval in advance.' },
      { id: 'ip', heading: 'Intellectual property', body: 'Nous owns the workshop recordings and any materials created specifically for Nous. Robin Studio keeps its existing curriculum and grants Nous a license to use it internally.' },
      { id: 'confidentiality', heading: 'Confidentiality', body: 'Each party will protect the other’s confidential information, use it only to perform this agreement, and keep doing so for three years after it ends.' },
      { id: 'term', heading: 'Term and termination', body: 'Effective on signature by both parties through December 31, 2026. Either party may end it with 14 days’ written notice; Nous pays for work already delivered.' },
    ],
    workflow_provenance: {
      input_provenance: 'customer',
      shared_partner: { name: 'Robin Studio', engagement_reference: 'ENG-2026-118' },
      source_sessions: [
        { role: 'partnerships', agent_name: 'Scout', session_id: WALKTHROUGH_IDS.scoutSession, run_id: WALKTHROUGH_IDS.handoffRun, excerpt: 'Maya Chen approved Robin Studio: two-day workshop, Nov 18–19, USD 14,500 flat.', simulated: false },
        { role: 'finance', agent_name: 'Ledger', session_id: WALKTHROUGH_IDS.ledgerSession, run_id: WALKTHROUGH_IDS.draftRun, excerpt: 'Drafted from the standard services template with the approved terms. Budget and duplicate checks passed.', simulated: false },
      ],
    },
  };
}

function agreementRequest(ctx: WalkthroughContext, story: WalkthroughStory): RequestEntity {
  const approved = Boolean(story.agreementApproved);
  return baseRequest(ctx, {
    id: WALKTHROUGH_IDS.agreement, kind: 'agreement', status: approved ? 'drafted' : 'pending',
    label: AGREEMENT_NUMBER, subject: 'Robin Studio', title: `Services agreement ${AGREEMENT_NUMBER}`,
    session_id: WALKTHROUGH_IDS.ledgerSession, run_id: WALKTHROUGH_IDS.draftRun, created_at: story.draft?.at ?? ctx.now(),
    decided_at: story.agreementApproved?.at ?? null, decided_by_name: approved ? 'Alex Rivera' : null,
    payload: agreementPayload(),
    triage: { status: 'complete', band: 'high', score: 82, confidence: 0.9, reason_codes: ['deadline', 'impact'], assessed_at: story.draft?.at ?? ctx.now(), rubric_version: 'v1', model_id: 'nous:anthropic/claude-sonnet-5' },
    decision_summary: {
      action: 'Approve agreement draft', primary: `Services agreement with Robin Studio`, facts: [], consequence: null,
      approval_requirement: { mode: 'single', completed_steps: approved ? 1 : 0, total_steps: 1, remaining_approvals: approved ? 0 : 1, current: approved ? [] : [{ label: 'Finance reviewer', approvals_recorded: 0, quorum: 1 }], pending_for_viewer: !approved, waiting_on_others: false, expires_at: null },
    },
  });
}

function agreementDocument(_ctx: WalkthroughContext, at: string): WalkthroughSeed['documents'][number] {
  return {
    id: WALKTHROUGH_IDS.agreementDoc, kind: 'agreement', number: AGREEMENT_NUMBER, title: `Services agreement ${AGREEMENT_NUMBER} · Robin Studio`,
    status: 'Approved · Unsigned', request_id: WALKTHROUGH_IDS.agreement, pdf_status: 'none', pdf_url: null, pdf_error: null,
    payload: agreementPayload(), version: 1, created_at: at,
  };
}

// ---------------------------------------------------------------------------
// Turns: which beat a sent message plays, and the events that play it.
// ---------------------------------------------------------------------------

export interface WalkthroughTurn {
  runId: string;
  reply: ScriptedReply;
  /** Requests the run proposes; they appear as receipts under the reply. */
  requests: RequestEntity[];
  /** Session title once the run has one. */
  title?: string;
  /** The story after this turn completes. */
  next: WalkthroughStory;
}

export function walkthroughTurn(ctx: WalkthroughContext, story: WalkthroughStory, prompt: string): WalkthroughTurn {
  const at = ctx.now();
  if (story.person === 'maya' && !story.shortlist) {
    const next = { ...story, shortlist: { prompt, at } };
    return { runId: WALKTHROUGH_IDS.shortlistRun, reply: shortlistReply(), requests: candidates(ctx, next).map((candidate) => candidateRequest(ctx, candidate, next)), title: 'November workshop partners', next };
  }
  if (story.person === 'maya' && !story.handoff) {
    return { runId: WALKTHROUGH_IDS.handoffRun, reply: handoffReply(), requests: [], next: { ...story, handoff: { prompt, at } } };
  }
  if (story.person === 'alex' && story.handoff && !story.draft) {
    const next = { ...story, draft: { prompt, at } };
    return { runId: WALKTHROUGH_IDS.draftRun, reply: draftReply(), requests: [agreementRequest(ctx, next)], next };
  }
  return {
    runId: mockUuid(8_300 + Math.floor(Math.random() * 600)),
    reply: { text: 'Got it. I’ll keep that in mind for this work.', blocks: [], tools: [{ name: 'get_workspace_context', ms: 1_200 }], workedMs: 4_000 },
    requests: [],
    next: story,
  };
}

/** The story after a decision the person made in the Inbox. */
export function walkthroughDecision(ctx: WalkthroughContext, story: WalkthroughStory, requestId: string, approved: boolean): WalkthroughStory {
  if (!approved) return story;
  if (requestId === WALKTHROUGH_IDS.robin) return { ...story, approvedPartner: { at: ctx.now() } };
  if (requestId === WALKTHROUGH_IDS.agreement) return { ...story, agreementApproved: { at: ctx.now() } };
  return story;
}

export function walkthroughDocumentFor(ctx: WalkthroughContext, requestId: string, at: string): WalkthroughSeed['documents'][number] | null {
  return requestId === WALKTHROUGH_IDS.agreement ? agreementDocument(ctx, at) : null;
}

/**
 * One run as timed events: the tool calls tick through, then the reply
 * streams in a few words at a time, then it finalizes. `delayMs` is when each
 * event is published, relative to the turn being accepted.
 */
export function walkthroughRunEvents(
  ctx: WalkthroughContext,
  sessionId: string,
  turn: WalkthroughTurn,
  firstId: bigint,
  clientTurnId: string,
): { event: StreamEvent; delayMs: number }[] {
  const out: { event: StreamEvent; delayMs: number }[] = [];
  let id = firstId;
  let clock = 0;
  const started = Date.now();
  const push = (kind: string, payload: unknown, delayMs: number, sessionScoped = true): void => {
    clock += delayMs;
    out.push({
      event: parseStreamEvent({
        id: id.toString(), workspace_id: ctx.workspaceId, session_id: sessionScoped ? sessionId : null, kind,
        schema_version: SCHEMA_VERSION, trace_id: `walkthrough-${turn.runId.slice(-4)}`,
        at: new Date(started + clock).toISOString(), payload,
      }),
      delayMs: clock,
    });
    id += 1n;
  };
  const { runId, reply } = turn;
  const messageId = mockUuid(8_400 + Number(firstId % 500n));
  push('run.started', {
    run_id: runId, session_id: sessionId, attempt: 1, engine_version: 1, client_turn_id: clientTurnId,
    mode: 'work', model_id: 'nous:anthropic/claude-sonnet-5', effort: 'medium', title: turn.title ?? null, steps: [],
  }, 250);
  push('run.status', { run_id: runId, attempt: 1, status: 'working' }, 700);
  reply.tools.forEach((tool, index) => {
    const stepId = `tool-${index}`;
    push('run.step', { run_id: runId, attempt: 1, turn: 0, step_id: stepId, label: tool.name, state: 'active', tool_call_id: `call-${index}` }, index === 0 ? 900 : 350);
    push('run.step', { run_id: runId, attempt: 1, turn: 0, step_id: stepId, label: tool.name, state: 'done', tool_call_id: `call-${index}` }, tool.ms);
  });
  push('message.reset', { run_id: runId, turn: 0, attempt: 1, step_attempt: 1, message_id: messageId }, 600);
  // A few words per delta, at a steady model-like pace.
  const words = reply.text.split(/(?<=\s)/);
  let seq = 0;
  for (let index = 0; index < words.length; index += 4) {
    push('message.delta', { message_id: messageId, run_id: runId, turn: 0, attempt: 1, step_attempt: 1, seq: seq++, delta: words.slice(index, index + 4).join('') }, 70);
  }
  push('message.final', {
    message_id: messageId, session_id: sessionId, run_id: runId, turn: 0, attempt: 1,
    text: reply.text, blocks: reply.blocks, worked_ms: reply.workedMs,
  }, 300);
  push('run.status', { run_id: runId, attempt: 1, status: 'completed', active_ms: reply.workedMs }, 100);
  for (const request of turn.requests) {
    push('request.created', { request_id: request.id, kind: request.kind, status: request.status, label: request.label, run_id: runId, session_id: sessionId }, 250, false);
  }
  return out;
}
