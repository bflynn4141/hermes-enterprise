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
  'Provider keys',
  'Usage',
  'Notifications',
  'Data and privacy',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** Copy strings from the spec's §7 table. Exact, and asserted by the e2e suite. */
export const EMPTY = {
  chatReady: (agent: string) => `${agent} is ready. Describe what you need or attach a document.`,
  noKey: 'Add a provider key in Settings to start',
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
  providerKeys: 'No provider keys yet. Add a DeepSeek, Anthropic or OpenAI key to enable models',
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
