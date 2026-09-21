import type { ApprovalType, ApprovalView, RequestEntity } from '@hermes/shared';
import { STEP_UP_MAX_AGE_MS } from '../model/constants.js';

interface ApprovalMeta {
  label: string;
  action: string;
  icon: string;
}

export const APPROVAL_META: Record<ApprovalType, ApprovalMeta> = {
  run_plan: { label: 'Plan and budget', action: 'Approve plan', icon: 'loop' },
  team_commitment: { label: 'Team commitment', action: 'Accept task', icon: 'people' },
  access: { label: 'Temporary access', action: 'Allow access', icon: 'context' },
  communication: { label: 'Communication', action: 'Approve send', icon: 'inbox' },
  shared_learning: { label: 'Shared learning', action: 'Approve publication', icon: 'skill' },
  deliverable: { label: 'Deliverable', action: 'Accept result', icon: 'agreement' },
  data_disclosure: { label: 'Data disclosure', action: 'Allow sharing', icon: 'context' },
  record_change: { label: 'Record change', action: 'Approve change', icon: 'trace' },
  exception: { label: 'Exception', action: 'Allow exception', icon: 'admission' },
  agent_governance: { label: 'Agent governance', action: 'Approve configuration', icon: 'settings' },
};

export function approvalType(request: RequestEntity): ApprovalType | null {
  return request.kind === 'approval' ? request.approval?.approval_type ?? null : null;
}

export function approvalTypeLabel(request: RequestEntity): string {
  const type = approvalType(request);
  return type ? APPROVAL_META[type].label : 'Approval';
}

export function approvalActionLabel(request: RequestEntity): string {
  const type = approvalType(request);
  if (!type) return 'Review request';
  const payload = request.payload as { details?: { draft_only?: boolean } };
  return type === 'communication' && payload.details?.draft_only === true ? 'Approve draft' : APPROVAL_META[type].action;
}

export function approvalPrimaryAction(view: ApprovalView): string {
  if (isCommunicationDraft(view)) return 'Approve draft';
  if (view.payload.approval_type !== 'team_commitment'
    || view.payload.context.source.trigger?.kind !== 'member_agent_joined') {
    return APPROVAL_META[view.payload.approval_type].action;
  }
  const currentStep = view.steps.find((step) => step.status === 'current');
  return currentStep?.step_id === 'receiving-owner' ? 'Accept collaboration' : 'Approve proposal';
}

export function approvalIcon(request: RequestEntity): string {
  const type = approvalType(request);
  return type ? APPROVAL_META[type].icon : 'context';
}

export function approvalReviewerLabel(request: RequestEntity): string {
  const projection = request.approval;
  if (!projection) return 'Reviewer unavailable';
  if (projection.pending_for_viewer) return 'Needs your decision';
  if (projection.waiting_on_others) {
    return projection.current_reviewer_names.length > 0
      ? `Waiting for ${projection.current_reviewer_names.join(', ')}`
      : 'Waiting on others';
  }
  if (projection.authorization_status === 'approved' && (request.payload as { details?: { draft_only?: boolean } }).details?.draft_only === true && projection.approval_type === 'communication') return 'Draft approved · Nothing sent';
  if (projection.authorization_status === 'approved' && projection.effect_status === 'unavailable') return 'Approved · Effect unavailable';
  if (projection.authorization_status === 'approved' && projection.work_status === 'waiting') return 'Approved · Work waiting';
  return projection.authorization_status.replaceAll('_', ' ');
}

export function matchesReviewerFilter(request: RequestEntity, reviewer: 'for_me' | 'waiting' | 'all'): boolean {
  if (reviewer === 'all') return true;
  if (request.kind !== 'approval') {
    // Setup is actionable work, but does not require an approval vote. Older
    // responses without a summary retain the existing list behavior.
    const requirement = request.decision_summary?.approval_requirement;
    if (request.kind === 'task' || !requirement) return reviewer === 'for_me';
    return reviewer === 'for_me' ? requirement.pending_for_viewer : requirement.waiting_on_others;
  }
  return reviewer === 'for_me' ? request.approval?.pending_for_viewer === true : request.approval?.waiting_on_others === true;
}

export function approvalPreview(request: RequestEntity): string {
  const payload = request.payload as { summary?: unknown };
  const summary = typeof payload.summary === 'string' ? payload.summary : null;
  return summary ?? request.subject ?? request.label;
}

export function isCommunicationDraft(view: ApprovalView): boolean {
  return view.payload.approval_type === 'communication' && view.payload.details.draft_only;
}

export function approvalDecisionPrompt(view: ApprovalView): string {
  if (isCommunicationDraft(view)) return 'Approve this message as reviewed copy.';
  const prompts: Record<ApprovalType, string> = {
    run_plan: 'Authorize this plan within the limits below.',
    team_commitment: 'Accept the proposed responsibility and scope.',
    access: 'Authorize the access and expiry shown below.',
    communication: 'Authorize this exact message and recipients.',
    shared_learning: 'Authorize publication of this version.',
    deliverable: 'Accept this result against the requested criteria.',
    data_disclosure: 'Authorize sharing the listed data with this recipient.',
    record_change: 'Authorize the exact changes shown below.',
    exception: 'Authorize this exception within its stated limits.',
    agent_governance: 'Authorize this agent configuration.',
  };
  return prompts[view.payload.approval_type];
}

export function approvalEffectCopy(view: ApprovalView): string {
  if (isCommunicationDraft(view)) return 'Review copy only · Nothing is sent';
  if (view.effect.status === 'unavailable') return 'Records authorization · Execution unavailable';
  if (view.effect.status === 'executed') return 'External action completed';
  if (view.effect.kind !== 'none') return 'Records authorization · Execution is separate';
  if (view.payload.approval_type === 'run_plan') return 'Work can start after all required approvals';
  if (view.payload.approval_type === 'team_commitment') return 'Accepts responsibility · Work remains separate';
  if (view.payload.approval_type === 'deliverable') return 'Records acceptance of this result';
  return 'Records this authorization';
}

// ---------------------------------------------------------------------------
// Result copy: the server's enum values, said in words a reviewer would use.
// Unknown values (an older client against a newer Worker) fall back to the raw
// value with underscores removed rather than to an empty label.
// ---------------------------------------------------------------------------

const humanize = (value: string): string => {
  const words = value.replaceAll('_', ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown';
};

const AUTHORIZATION_LABELS: Record<string, string> = {
  pending: 'Waiting for review',
  approved: 'Approved',
  declined: 'Declined',
  changes_requested: 'Changes requested',
  expired: 'Expired',
  superseded: 'Superseded',
  withdrawn: 'Withdrawn',
};

const WORK_LABELS: Record<string, string> = {
  waiting: 'Waiting',
  ready: 'Ready to start',
  admitted: 'Work started',
  completed: 'No follow-on work',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
  refused: 'Refused',
};

const EFFECT_LABELS: Record<string, string> = {
  unavailable: 'No external effect',
  waiting: 'Waiting',
  not_required: 'Not required',
  executed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const approvalStatusLabel = (status: string): string => AUTHORIZATION_LABELS[status] ?? humanize(status);
export const approvalWorkLabel = (status: string): string => WORK_LABELS[status] ?? humanize(status);
export const approvalEffectLabel = (status: string): string => EFFECT_LABELS[status] ?? humanize(status);

const WORK_REASONS: Record<string, string> = {
  no_runtime_continuation_requested: 'This approval did not ask for any work to run afterwards.',
  approval_type_has_no_runtime_executor: 'The authorization is recorded; nothing runs automatically for this kind of approval.',
  reviewed_resource_is_mutable: 'A reviewed resource can still change, so work was not started. Submit a new revision with a fixed version.',
  resource_binding_hook_changed: 'A reviewed resource changed after approval, so work was not started. Submit a new revision.',
};

/** One plain sentence for a `work.reason`; a code the client does not know is humanized, a sentence is passed through. */
export function approvalWorkReason(reason: string | null): string | null {
  if (!reason) return null;
  const known = WORK_REASONS[reason];
  if (known) return known;
  return /^[a-z0-9_]+$/.test(reason) ? `${humanize(reason)}.` : reason;
}

export function formatMinor(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/** "Search started · $0.15 cap" once a run_plan continuation is actually admitted; null otherwise. */
export function approvalWorkStartedLine(view: ApprovalView): string | null {
  if (view.payload.approval_type !== 'run_plan' || view.work.status !== 'admitted') return null;
  const budget = view.payload.details.budget;
  return `Search started · ${formatMinor(budget.cap_minor, budget.currency)} cap`;
}

/**
 * Whether the decision routes would answer `reauth_required` right now. Null
 * (no `/auth/session` yet) is unknown, not stale: the 401 path stays the authority.
 */
export function decisionSignInStale(authenticatedAt: number | null, now = Date.now()): boolean {
  return authenticatedAt !== null && now - authenticatedAt > STEP_UP_MAX_AGE_MS;
}

export function requestActionLabel(request: RequestEntity): string {
  if (request.kind === 'approval') return approvalActionLabel(request);
  if (request.kind === 'invoice') return 'Approve invoice draft';
  if (request.kind === 'agreement') return 'Approve agreement draft';
  return 'Review request';
}
