// Selectors over the entity cache. They replace the demo's fixture selectors
// (`pendingRequests`, `workspaceMembers`, `historyEvents`, …) one for one, so
// the views that consume them did not change shape when the data source did.
import type { Bootstrap, InvitationEntity, MaskedProviderKey, RequestEntity, MemberEntity } from '@hermes/shared';
import { listData, type AppState, type EntityKind } from '../model/store.js';

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
 * one the server never writes on this path. The mirror is still counted, so
 * that a status arriving from WorkOS is not silently dropped.
 */
export function memberCounts(state: AppState): { joined: number; invited: number } {
  const all = members(state);
  const pendingMembers = all.filter((m) => m.status === 'invited' || m.status === 'expired').length;
  return { joined: all.filter((m) => m.status === 'active').length, invited: openInvitations(state).length + pendingMembers };
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
 * with no verified key is an empty state ("Add your OpenRouter key in Settings to
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
  const payload = request.payload as { score?: number; total_minor?: number } | undefined;
  const money = payload?.total_minor ? `$${(payload.total_minor / 100).toLocaleString('en-US')}` : '$1,200';
  switch (request.status) {
    case 'pending':
      return request.kind === 'application' ? `${payload?.score ?? 0} / 100 · Awaiting your review` : request.kind === 'invoice' ? `${money} · Draft` : `${money} · Unsigned v1`;
    case 'declined':
      return 'Declined · No message sent';
    case 'admitted':
      return 'Admitted · Access pending';
    case 'created':
      return 'Created · Not sent · No money moved';
    case 'drafted':
      return 'Draft saved · Unsigned · Not sent';
    default:
      return request.status;
  }
}

export const agentName = (state: AppState): string => state.agent.name || 'Iris';
