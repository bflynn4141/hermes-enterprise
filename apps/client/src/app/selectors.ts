import { approvalReviewerLabel } from './approval-copy.js';
// Selectors over the entity cache. They replace the demo's fixture selectors
// (`pendingRequests`, `workspaceMembers`, `historyEvents`, …) one for one, so
// the views that consume them did not change shape when the data source did.
import type { Bootstrap, InvitationEntity, MaskedProviderKey, RequestEntity, MemberEntity } from '@hermes/shared';
import { entityData, listData, type AppState, type EntityKind } from '../model/store.js';
import type { Ref } from '@hermes/shared';
import { ADMIN_SETTINGS_LABELS } from '../model/constants.js';

export const LIST_KEYS = {
  inboxNeedsReview: 'inbox:needs-review',
  inboxResolved: 'inbox:resolved',
  requests: 'requests',
  members: 'members',
  invitations: 'invitations',
  documents: 'documents',
  history: 'history',
  traces: 'traces',
  agentFiles: 'agent-files',
  contextFields: 'context-fields',
  instructions: 'instructions',
  skills: 'skills',
  providerKeys: 'provider-keys',
} as const;

export const rows = <T>(state: AppState, key: string, kind: EntityKind): T[] => listData<T>(state, key, kind);

export const requestsIn = (state: AppState, key: string): RequestEntity[] => rows<RequestEntity>(state, key, 'request');

export const pendingRequests = (state: AppState): RequestEntity[] => requestsIn(state, LIST_KEYS.requests).filter((r) => r.status === 'pending');
export const resolvedRequests = (state: AppState): RequestEntity[] => requestsIn(state, LIST_KEYS.requests).filter((r) => r.status !== 'pending');

export const members = (state: AppState): MemberEntity[] => rows<MemberEntity>(state, LIST_KEYS.members, 'member');

/** The invitations a person can still act on: sent, not yet accepted or withdrawn. */
export const openInvitations = (state: AppState): InvitationEntity[] =>
  rows<InvitationEntity>(state, LIST_KEYS.invitations, 'invitation').filter((row) => row.status === 'pending' || row.status === 'expired');

/**
 * "invited" counts the invitations list, not the membership mirror: a row in
 * `members` is a person who has accepted, so the mirror's `invited` status is
 * one the server normally never writes on this path. The mirror is still
 * counted so a transitional WorkOS status is not silently dropped, but the
 * same email appearing in both sources remains one invitation.
 */
export function memberCounts(state: AppState): { joined: number; invited: number } {
  const all = members(state);
  const invitedEmails = new Set(
    openInvitations(state).map((invitation) => invitation.email.trim().toLowerCase()),
  );
  for (const member of all) {
    if (member.status === 'invited' || member.status === 'expired') {
      invitedEmails.add(member.email.trim().toLowerCase());
    }
  }
  return { joined: all.filter((m) => m.status === 'active').length, invited: invitedEmails.size };
}

export const catalogRows = (state: AppState): Bootstrap['catalog'] =>
  Object.values(state.entities.catalog)
    .map((record) => record.data as Bootstrap['catalog'][number] | null)
    .filter((row): row is Bootstrap['catalog'][number] => row !== null);

export const providerKeys = (state: AppState): MaskedProviderKey[] => rows<MaskedProviderKey>(state, LIST_KEYS.providerKeys, 'provider_key');

/**
 * `wrangler dev` answers from `ScriptedProvider` (`MODEL_SCRIPTED=1`), so a run
 * there needs no provider key at all and greying the composer would make a
 * working development stack look broken. The mock bundle is excluded on
 * purpose: `?key=none` and `?key=invalid` are the fixtures the empty-state
 * scenarios assert the greyed composer against, and both are mock builds. A
 * production build folds this to `false` and drops the branch.
 */
const SCRIPTED_DEV = __AUTH_MODE__ === 'fake' && !__MOCK__;

/**
 * Whether the composer may send at all, and whose key was rejected. A workspace
 * with no verified key is an empty state ("Add your Nous Portal key in Settings to
 * start"), not an error: in M1 that is every workspace.
 *
 * `any` is what the composer disables itself on; `banner` is what the shell
 * shows. Scripted development can send without a key; hidden key details leave
 * availability unknown and let the run route enforce the actual requirement.
 */
export function hasVerifiedKey(state: AppState): { any: boolean; rejected: string | null; banner: boolean } {
  // Step-up protects key details, not conversation access. An unreadable list
  // cannot prove a key is missing; the run route still validates the real key.
  if (state.ui.providerKeysLocked) return { any: true, rejected: null, banner: false };
  const keys = providerKeys(state);
  const verified = keys.some((key) => key.status === 'verified' || key.status === 'verified_scoped');
  const invalid = keys.find((key) => key.status === 'invalid');
  return {
    any: verified || SCRIPTED_DEV,
    rejected: verified ? null : invalid ? invalid.provider : null,
    banner: !verified,
  };
}

/** The status line under a request row, derived from the row, never stored. */
export function requestStatusLabel(request: RequestEntity): string {
  const payload = request.payload as { score?: number; total_minor?: number; currency?: string } | undefined;
  const money = typeof payload?.total_minor === 'number' && payload.currency
    ? `${payload.currency} ${(payload.total_minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;
  if (request.kind === 'approval' && request.approval) return approvalReviewerLabel(request);
  switch (request.status) {
    case 'pending':
      return request.kind === 'task' ? 'Ready to continue' : request.kind === 'application' ? `${payload?.score ?? 0} / 100 · Awaiting your review` : request.kind === 'invoice' ? [money, 'Invoice draft'].filter(Boolean).join(' · ') : 'Agreement draft · Unsigned';
    case 'declined':
      return 'Declined · No message sent';
    case 'admitted':
      return 'Admitted · Access pending';
    case 'created':
      return 'Invoice draft created · Not sent · No money moved';
    case 'drafted':
      return 'Draft saved · Unsigned · Not sent';
    case 'approved':
      return 'Approved · Execution separate';
    case 'changes_requested':
      return 'Changes requested · New version required';
    case 'expired':
      return 'Expired · No authorization';
    default:
      return request.status;
  }
}

export const agentName = (state: AppState): string => state.agent.name || 'Iris';

export const SECTION_LABEL: Record<string, string> = { agents: 'Agents', inbox: 'Inbox', members: 'Members', admin: 'Admin', history: 'History', library: 'Library', settings: 'Settings' };

/**
 * A ref in words: `[crumb, detail]`. Reads the entity cache rather than a
 * fixture map, so a ref whose entity has not arrived yet names its kind and
 * never "Request not found" as a first impression.
 */
export function describeRef(state: AppState, app: Ref): [string, string] {
  const agent = agentName(state);
  const section = app.section;
  const view = app.view;
  if (section === 'agents') {
    if (view === 'setup') return [agent, `${agent} / Ready to start`];
    if (view === 'trace') return [agent, `${agent} / Run detail`];
    if (view === 'traces') return [agent, `${agent} / Traces`];
    if (view === 'context') return [agent, app.field ? `${agent} / ${app.field}` : `${agent} / Context`];
    if (view === 'skills') return [agent, `${agent} / Skills`];
    if (view === 'permissions') return [agent, `${agent} / Permissions`];
    return [agent, `${agent} / Overview`];
  }
  if (section === 'inbox') {
    if (view === 'request') {
      const request = entityData<RequestEntity>(state, 'request', app.id);
      return [request?.kind === 'approval' ? 'Approval' : request?.kind === 'invoice' ? 'Invoice' : request?.kind === 'agreement' ? 'Agreement' : request?.label ?? 'Request', 'Review'];
    }
    const label = view === 'rules' ? 'Rules' : app.filters?.status === 'resolved' ? 'Resolved' : 'Needs review';
    return [label, label];
  }
  if (section === 'members') return ['Team', 'Members and invitations'];
  if (section === 'admin') {
    const label = ADMIN_SETTINGS_LABELS[app.view ?? 'Organization'] ?? 'Organization';
    return [label, label];
  }
  if (section === 'history') return ['History', { all: 'All activity', decisions: 'Decisions', blocked: 'Blocked' }[view ?? 'decisions'] ?? 'Decisions'];
  if (section === 'library') {
    const label = { handoffs: 'Handoffs', skills: 'Shared skills', documents: 'Documents', connections: 'Connections', intelligence: 'Shared Intelligence' }[view ?? 'handoffs'] ?? 'Handoffs';
    return [label, label];
  }
  if (section === 'settings') return [app.view ?? 'Notifications', app.view ?? 'Notifications'];
  return ['', ''];
}

/** One line for a link to a ref: "Inbox · Resolved", "Ada Ling · Review", "Members". */
export function refLinkLabel(state: AppState, app: Ref): string {
  const [crumb, detail] = describeRef(state, app);
  const section = SECTION_LABEL[app.section] ?? 'Agents';
  if (app.section === 'agents') return detail.replace(' / ', ' · ');
  if (app.section === 'inbox' && app.view === 'request') return `${crumb} · ${detail}`;
  if (app.section === 'members' || app.section === 'history') return crumb === section ? `${section} · ${detail}` : section === crumb ? section : `${section} · ${crumb}`;
  return crumb === section ? section : `${section} · ${crumb}`;
}
