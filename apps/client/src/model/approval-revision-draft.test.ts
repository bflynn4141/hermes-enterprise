import { describe, expect, it } from 'vitest';
import { APPROVAL_REVISION_DRAFT_KEY, APPROVAL_REVISION_DRAFT_TTL_MS, clearApprovalRevisionDraft, saveApprovalRevisionDraft, takeApprovalRevisionDraft } from './approval-revision-draft.js';

const now = Date.parse('2026-09-18T12:00:00Z');
const scope = { viewerId: 'viewer-1', workspaceId: 'workspace-1', requestId: 'request-1', revision: 2, hash: 'sha256:reviewed', authorizationExpiresAt: '2026-09-19T12:00:00Z', canRevise: true };
const draft = { subject: 'Shorter invitation', body: 'Hi Taylor, one week?', summary: 'Shortened pilot', changeNote: 'Removed a week.' };
function storage() {
  const entries = new Map<string, string>();
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
}

describe('email revision across step-up', () => {
  it('restores fields once after an exact refetch, with no stored action to replay', () => {
    const store = storage();
    expect(saveApprovalRevisionDraft(store, scope, draft, now)).toBe(true);
    expect(store.getItem(APPROVAL_REVISION_DRAFT_KEY)).not.toContain('decision');
    expect(takeApprovalRevisionDraft(store, scope, now + 1000)).toEqual(draft);
    expect(takeApprovalRevisionDraft(store, scope, now + 1000)).toBeNull();
  });

  it.each([{ viewerId: 'another-account' }, { workspaceId: 'another-workspace' }, { requestId: 'another-request' }, { revision: 3 }, { hash: 'sha256:changed' }, { canRevise: false }])('discards a scope or eligibility mismatch: %j', (change) => {
    const store = storage();
    saveApprovalRevisionDraft(store, scope, draft, now);
    expect(takeApprovalRevisionDraft(store, { ...scope, ...change }, now)).toBeNull();
    expect(store.getItem(APPROVAL_REVISION_DRAFT_KEY)).toBeNull();
  });

  it('expires at the shorter of fifteen minutes and the authorization expiry', () => {
    const store = storage();
    saveApprovalRevisionDraft(store, scope, draft, now);
    expect(takeApprovalRevisionDraft(store, scope, now + APPROVAL_REVISION_DRAFT_TTL_MS)).toBeNull();
    const expiring = { ...scope, authorizationExpiresAt: new Date(now + 1000).toISOString() };
    saveApprovalRevisionDraft(store, expiring, draft, now);
    expect(takeApprovalRevisionDraft(store, expiring, now + 1000)).toBeNull();
    expect(store.getItem(APPROVAL_REVISION_DRAFT_KEY)).toBeNull();
  });

  it('clears cancellation/success and tolerates unavailable or malformed storage', () => {
    const store = storage();
    saveApprovalRevisionDraft(store, scope, draft, now);
    clearApprovalRevisionDraft(store);
    expect(takeApprovalRevisionDraft(store, scope, now)).toBeNull();
    store.setItem(APPROVAL_REVISION_DRAFT_KEY, '{broken');
    expect(takeApprovalRevisionDraft(store, scope, now)).toBeNull();
    expect(saveApprovalRevisionDraft(null, scope, draft, now)).toBe(false);
  });
});
