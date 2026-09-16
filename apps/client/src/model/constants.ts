// What survived of the demo's `fixtures.mjs`: the two UI vocabularies that are
// product copy rather than data. Everything else the demo kept in that file is
// now a server entity.
export const MODES = [
  { id: 'ask', label: 'Ask', note: 'Inspect and explain' },
  { id: 'plan', label: 'Plan', note: 'Prepare steps to review' },
  { id: 'work', label: 'Work', note: 'Act within permissions' },
] as const;
export type ModeId = (typeof MODES)[number]['id'];

/** Revision 4 adds Provider keys and Usage (client-port spec §2, `fixtures.mjs` row). */
export const SETTINGS_TABS = [
  'Organization',
  'Inbox rules',
  'Agents',
  'Slack',
  'Provider keys',
  'Usage',
  'Notifications',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** Copy strings from the spec's §7 table. Exact, and asserted by the e2e suite. */
export const EMPTY = {
  chatReady: (_agent: string) => 'What do you need help with?',
  /**
   * Names Nous Portal, because Nous Portal is the only key this product takes
   * (decision C55). The generic "a provider key" was honest when there were
   * four; with one it is a riddle whose answer is one screen away.
   */
  noKey: 'Connect Nous Portal in Settings to start',
  keyRejected: (provider: string) => `Your ${provider} key was rejected. Re-verify or rotate it`,
  sessions: 'No sessions yet',
  sessionsArchived: 'No archived sessions',
  overview: (agent: string) => `Nothing needs you yet. ${agent} works when you message it.`,
  inbox: 'No reviews waiting',
  inboxResolved: 'No decisions yet',
  requestMissing: 'Request not found',
  historyAll: 'No activity yet',
  historyDecisions: 'No decisions yet',
  historyBlocked: 'Nothing is blocked',
  traces: 'No runs yet.',
  traceMissing: 'This run is no longer available',
  context: 'No sources yet',
  skills: 'No change proposed',
  libraryUnavailable: 'Not available yet',
  invitations: 'No open invitations',
  noProvider: 'No provider configured',
  /** A key installed before this deployment narrowed to Nous Portal. */
  keyNotAllowed: 'No longer usable — only Nous Portal keys can be used',
  providerKeys: 'Connect Nous Portal to enable models',
  attach: 'No documents yet',
  adminOnly: 'Admin decision required',
  shareGone: 'This link is no longer available.',
  blockBroken: 'Could not display this block',
  reconnecting: 'Reconnecting…',
  redeploying: 'Redeploying. Runs resume in a moment.',
  signedOut: 'Signed out. Sign in again to continue — your draft is saved.',
  evicted: 'Your access to this workspace changed',
  pdfPreparing: 'PDF is being prepared',
  pdfFailed: (reason: string) => `Rendering failed: ${reason}`,
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
  { id: 'skills', label: 'Skills' },
  { id: 'documents', label: 'Documents' },
  { id: 'connections', label: 'Connections' },
  { id: 'intelligence', label: 'Shared Intelligence' },
] as const;

export const AGENT_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'context', label: 'Context' },
  { id: 'skills', label: 'Skills' },
  { id: 'traces', label: 'Traces' },
] as const;

/** localStorage keys. Drafts are scoped by workspace and user (spec §12.4). */
export const draftsKey = (workspaceId: string, userId: string) => `hermes:drafts:${workspaceId}:${userId}`;
export const activeSessionKey = (workspaceId: string) => `hermes:active-session:${workspaceId}`;
export const STEPUP_KEY = 'hermes:stepup';
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
