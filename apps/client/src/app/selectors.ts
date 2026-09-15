// Selectors over the entity cache. They replace the demo's fixture selectors
// (`pendingRequests`, `workspaceMembers`, `historyEvents`, …) one for one, so
// the views that consume them did not change shape when the data source did.
import type { Bootstrap, MaskedProviderKey, RequestEntity, MemberEntity } from '@hermes/shared';
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

export function memberCounts(state: AppState): { joined: number; invited: number } {
  const all = members(state);
  return { joined: all.filter((m) => m.status === 'active').length, invited: all.filter((m) => m.status === 'invited' || m.status === 'expired').length };
}

export const catalogRows = (state: AppState): Bootstrap['catalog'] =>
  Object.values(state.entities.catalog)
    .map((record) => record.data as Bootstrap['catalog'][number] | null)
    .filter((row): row is Bootstrap['catalog'][number] => row !== null);

export const providerKeys = (state: AppState): MaskedProviderKey[] => rows<MaskedProviderKey>(state, LIST_KEYS.providerKeys, 'provider_key');

/**
 * Whether the composer may send at all, and whose key was rejected. A workspace
 * with no verified key is an empty state ("Add a provider key in Settings to
 * start"), not an error: in M1 that is every workspace.
 */
export function hasVerifiedKey(state: AppState): { any: boolean; rejected: string | null } {
  const keys = providerKeys(state);
  const any = keys.some((key) => key.status === 'verified' || key.status === 'verified_scoped');
  const invalid = keys.find((key) => key.status === 'invalid');
  return { any, rejected: any ? null : invalid ? invalid.provider : null };
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
