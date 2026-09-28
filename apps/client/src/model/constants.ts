// What survived of the demo's `fixtures.mjs`: the two UI vocabularies that are
// product copy rather than data. Everything else the demo kept in that file is
// now a server entity.
export const MODES = [
  { id: 'ask', label: 'Ask', note: 'Inspect and explain' },
  { id: 'plan', label: 'Plan', note: 'Prepare steps to review' },
  { id: 'work', label: 'Work', note: 'Act within permissions' },
] as const;
export type ModeId = (typeof MODES)[number]['id'];

/** Personal/member settings. Workspace controls live under the role-gated Admin section. */
export const SETTINGS_TABS = [
  'Notifications',
  'Slack account',
  'Data and privacy',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/**
 * Admin: three sections, each a row of page tabs (docs/DESIGN.md, Admin). Page
 * ids are stable route keys; labels are what people read. Pages that were
 * folded into another one keep working through ADMIN_VIEW_ALIASES.
 */
export const ADMIN_SETTINGS_GROUPS = [
  {
    label: 'Workspace',
    items: [
      { id: 'Organization', label: 'General' },
      { id: 'Roles', label: 'Roles' },
      { id: 'Approvals', label: 'Approvals' },
      { id: 'Usage', label: 'Usage' },
      { id: 'Data and privacy', label: 'Data & privacy' },
    ],
  },
  {
    label: 'Agents',
    items: [
      { id: 'All agents', label: 'Agents' },
      { id: 'Provider keys', label: 'Models' },
      { id: 'Runtime capacity', label: 'Capacity' },
      { id: 'intelligence', label: 'Shared Intelligence' },
    ],
  },
  {
    label: 'Connections',
    items: [
      { id: 'Slack', label: 'Slack', brand: 'slack' },
      { id: 'Email', label: 'Email', brand: 'gmail' },
    ],
  },
] as const;

/** Admin pages that were renamed or folded into another; an old link still lands on the page it meant. */
export const ADMIN_VIEW_ALIASES: Readonly<Record<string, string>> = {
  'Inbox rules': 'Approvals',
  // Agent defaults: the default model moved to Models, the limits to Usage.
  Agents: 'Provider keys',
  // Role inboxes now sit on the Email page, above the sending account.
  Inboxes: 'Email',
};

/** Every Admin page in rail order, flat. */
export const ADMIN_PAGES: readonly { readonly id: string; readonly label: string }[] =
  ADMIN_SETTINGS_GROUPS.flatMap((group): { id: string; label: string }[] => group.items.map((item) => ({ id: item.id, label: item.label })));
/** The section a page belongs to; an unknown page falls in the first. */
export const adminSectionOf = (id: string): (typeof ADMIN_SETTINGS_GROUPS)[number] =>
  ADMIN_SETTINGS_GROUPS.find((group) => group.items.some((item) => item.id === id)) ?? ADMIN_SETTINGS_GROUPS[0];
export const ADMIN_SETTINGS_VIEWS = ADMIN_SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => item.id));
export type AdminSettingsView = (typeof ADMIN_SETTINGS_VIEWS)[number];
export const ADMIN_SETTINGS_LABELS: Readonly<Record<string, string>> = Object.fromEntries([
  ...ADMIN_PAGES.map((page) => [page.id, page.label] as const),
  ...Object.entries(ADMIN_VIEW_ALIASES).map(([from, to]) => [from, ADMIN_PAGES.find((page) => page.id === to)?.label ?? to] as const),
]);

/**
 * What an empty conversation offers. Each one fills the composer and nothing
 * more: the person still decides to send. The first is the question the
 * seeded fixture answers, so the demo and the empty state agree.
 */
export const STARTERS = [
  'What needs me before the partner work can move forward?',
  'Screen the newest applicant',
  'Summarize what you did this week',
] as const;

/** Copy strings from the spec's §7 table. Exact, and asserted by the e2e suite. */
export const EMPTY = {
  chatReady: (_agent: string) => 'What do you need help with?',
  /**
   * Names Nous Portal, because Nous Portal is the only key this product takes
   * (decision C55). The generic "a provider key" was honest when there were
   * four; with one it is a riddle whose answer is one screen away.
   */
  noKey: 'Connect Nous Portal in Settings to start',
  /** Takes the provider's display name (`providerName`), never its slug (docs/DESIGN.md). */
  keyRejected: (provider: string) => `Your ${provider} key stopped working. Check or replace it in Admin → Models`,
  sessions: 'No sessions yet',
  sessionsArchived: 'No archived sessions',
  overview: (agent: string, automated = false) => automated
    ? `${agent} checks for partner prospects automatically. Nothing needs your review yet.`
    : `Nothing needs you yet. ${agent} works when you message it.`,
  inbox: 'No reviews waiting',
  inboxResolved: 'No decisions yet',
  requestMissing: 'Request not found',
  historyAll: 'No activity yet',
  historyDecisions: 'No decisions yet',
  historyBlocked: 'Nothing is blocked',
  traces: 'No activity yet.',
  traceMissing: 'This run is no longer available',
  context: 'No sources yet',
  skills: 'No change proposed',
  libraryUnavailable: 'Not available yet',
  invitations: 'No open invitations',
  noProvider: 'No model available',
  /** A key installed before this deployment narrowed to Nous Portal. */
  keyNotAllowed: 'No longer usable — only Nous Portal keys can be used',
  providerKeys: 'Connect Nous Portal to enable models',
  attach: 'No documents yet',
  adminOnly: 'A workspace Admin records this decision',
  /** Admin-gated configuration, not a request decision. */
  adminRequired: 'Workspace Admin only',
  shareGone: 'This link is no longer available.',
  blockBroken: 'Could not display this block',
  reconnecting: 'Reconnecting…',
  redeploying: 'Hermes is updating. Your agents pick up again in a moment.',
  signedOut: 'Signed out. Sign in again to continue — your draft is saved.',
  evicted: 'Your access to this workspace changed',
  pdfPreparing: 'PDF is being prepared',
  /** The reason is the server's and stays in logs; the screen says what happened. */
  pdfFailed: (_reason: string) => 'The PDF couldn’t be made',
  /**
   * `pdf_status: 'none'` with a `pdf_error` is not "being prepared": it is the
   * server saying there will never be one in this build, because the PDF
   * renderer needs runtime WebAssembly and Workers refuse it (decision D7).
   * Saying "being prepared" would be a spinner for something nobody is doing.
   */
  pdfUnavailable: 'PDF unavailable',
  incomplete: 'Response may be incomplete. Retry',
} as const;

export const LIBRARY_TABS = [
  { id: 'handoffs', label: 'Handoffs' },
  { id: 'skills', label: 'Skills' },
  { id: 'documents', label: 'Documents' },
  { id: 'connections', label: 'Connections' },
  { id: 'intelligence', label: 'Shared Intelligence' },
] as const;

export const AGENT_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'context', label: 'Context' },
  { id: 'skills', label: 'Skills' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'traces', label: 'Activity' },
] as const;

/** localStorage keys. Drafts are scoped by workspace and user (spec §12.4). */
export const draftsKey = (workspaceId: string, userId: string) => `hermes:drafts:${workspaceId}:${userId}`;
export const activeSessionKey = (workspaceId: string) => `hermes:active-session:${workspaceId}`;
export const STEPUP_KEY = 'hermes:stepup';
/** Mirrors the Worker's `STEP_UP_MAX_AGE_SECONDS`: how old a sign-in may be for a decision route. */
export const STEP_UP_MAX_AGE_MS = 5 * 60 * 1000;
/**
 * The Iris panel's state and its remembered width, per workspace and user —
 * the same scoping as drafts, for the same reason: two people on one machine
 * are two people, and a width is a preference, not workspace data.
 */
export const irisPanelKey = (workspaceId: string, userId: string) => `hermes:iris-panel:${workspaceId}:${userId}`;
export const irisWidthKey = (workspaceId: string, userId: string) => `hermes:iris-width:${workspaceId}:${userId}`;
/** What the boolean used to be written under. Read once, then removed (decision C33). */
export const legacyIrisOpenKey = (workspaceId: string, userId: string) => `hermes:iris-open:${workspaceId}:${userId}`;


/**
 * The providers the Add-a-key dialog offers (decision R12).
 *
 * One entry, and the list rather than a hard-coded paragraph because the shape
 * is what a second allowed provider would need and because a unit test can
 * assert the list without rendering Settings. It is described the way it works:
 * an Admin who does not know that one key syncs several hundred models will not
 * understand why the menu suddenly got long.
 */
export const PROVIDER_CHOICES: readonly { id: string; label: string; note: string }[] = [
  {
    id: 'nous_portal',
    label: 'Nous Portal',
    note: 'One key for the current Nous Portal model catalog. Verification makes one minimal model request, then syncs the model menu.',
  },
];

/** What the dialog starts on. There is only one, so there is no dropdown. */
export const DEFAULT_PROVIDER = PROVIDER_CHOICES[0]!.id;
