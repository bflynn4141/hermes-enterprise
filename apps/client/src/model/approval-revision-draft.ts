// One pending email rewrite across a sign-in redirect, never an action queue.
export const APPROVAL_REVISION_DRAFT_KEY = 'hermes:approval-revision-step-up';
export const APPROVAL_REVISION_DRAFT_TTL_MS = 15 * 60 * 1000;

interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ApprovalRevisionScope {
  viewerId: string;
  workspaceId: string;
  requestId: string;
  revision: number;
  hash: string;
  authorizationExpiresAt: string;
  canRevise: boolean;
}

export interface ApprovalRevisionDraft {
  subject: string;
  body: string;
  summary: string;
  changeNote: string;
}

export function revisionDraftStorage(): DraftStorage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; }
  catch { return null; }
}

export function clearApprovalRevisionDraft(storage: DraftStorage | null): void {
  try { storage?.removeItem(APPROVAL_REVISION_DRAFT_KEY); } catch { /* Restricted storage. */ }
}

export function saveApprovalRevisionDraft(storage: DraftStorage | null, scope: ApprovalRevisionScope, draft: ApprovalRevisionDraft, now = Date.now()): boolean {
  const expiresAt = Math.min(now + APPROVAL_REVISION_DRAFT_TTL_MS, Date.parse(scope.authorizationExpiresAt));
  if (!storage || !scope.viewerId || !scope.canRevise || !Number.isFinite(expiresAt) || expiresAt <= now) {
    clearApprovalRevisionDraft(storage);
    return false;
  }
  try {
    storage.setItem(APPROVAL_REVISION_DRAFT_KEY, JSON.stringify({ scope, draft, expiresAt }));
    return true;
  } catch { return false; }
}

/** Consume only after the server refetch confirms this viewer and exact binding. */
export function takeApprovalRevisionDraft(storage: DraftStorage | null, scope: ApprovalRevisionScope, now = Date.now()): ApprovalRevisionDraft | null {
  try {
    const raw = storage?.getItem(APPROVAL_REVISION_DRAFT_KEY);
    if (!raw) return null;
    clearApprovalRevisionDraft(storage);
    const saved = JSON.parse(raw) as { scope?: Partial<ApprovalRevisionScope>; draft?: Partial<ApprovalRevisionDraft>; expiresAt?: number };
    if (!scope.canRevise || !scope.viewerId || !Number.isFinite(Date.parse(scope.authorizationExpiresAt)) || Date.parse(scope.authorizationExpiresAt) <= now || !Number.isFinite(saved.expiresAt) || saved.expiresAt! <= now) return null;
    if (!saved.scope || !['viewerId', 'workspaceId', 'requestId', 'revision', 'hash'].every((key) => saved.scope![key as keyof ApprovalRevisionScope] === scope[key as keyof ApprovalRevisionScope])) return null;
    const draft = saved.draft;
    if (!draft || !Object.entries({ subject: 500, body: 20000, summary: 1000, changeNote: 2000 }).every(([key, max]) => typeof draft[key as keyof ApprovalRevisionDraft] === 'string' && draft[key as keyof ApprovalRevisionDraft]!.length <= max)) return null;
    return draft as ApprovalRevisionDraft;
  } catch { clearApprovalRevisionDraft(storage); return null; }
}
