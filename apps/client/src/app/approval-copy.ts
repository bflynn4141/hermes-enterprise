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
  communication: { label: 'Email', action: 'Approve and send', icon: 'inbox' },
  shared_learning: { label: 'Shared learning', action: 'Approve publication', icon: 'skill' },
  deliverable: { label: 'Deliverable', action: 'Accept result', icon: 'agreement' },
  data_disclosure: { label: 'Data disclosure', action: 'Allow sharing', icon: 'context' },
  record_change: { label: 'Record change', action: 'Approve change', icon: 'trace' },
  exception: { label: 'Exception', action: 'Allow exception', icon: 'admission' },
  agent_governance: { label: 'Agent settings', action: 'Approve settings', icon: 'settings' },
};

export function approvalType(request: RequestEntity): ApprovalType | null {
  return request.kind === 'approval' ? request.approval?.approval_type ?? null : null;
}

interface ReplyDetails {
  draft_only?: boolean;
  reply_to?: { caution?: boolean } | null;
  subject?: string | null;
}

/** The details of a suggested reply to a role-inbox email, or null for any other request. */
export function emailReplyDetails(request: RequestEntity): ReplyDetails | null {
  if (approvalType(request) !== 'communication') return null;
  const details = (request.payload as { details?: ReplyDetails } | null)?.details;
  return details?.reply_to ? details : null;
}

/** Whether the server flagged the sender of the email a suggested reply answers. */
export function emailReplyFlagged(request: RequestEntity): boolean {
  const reply = emailReplyDetails(request);
  if (!reply) return false;
  if (reply.reply_to?.caution) return true;
  // A flagged sender with nobody to second-check keeps the reply as a draft;
  // the server's cautions still travel as the evidence note.
  const evidence = (request.payload as { evidence?: { note?: unknown }[] } | null)?.evidence ?? [];
  return evidence.some((item) => typeof item.note === 'string' && item.note.length > 0);
}

export function approvalTypeLabel(request: RequestEntity): string {
  const type = approvalType(request);
  if (emailReplyDetails(request)) return 'Email reply';
  return type ? APPROVAL_META[type].label : 'Approval';
}

export function approvalActionLabel(request: RequestEntity): string {
  const type = approvalType(request);
  if (!type) return 'Review request';
  const reply = emailReplyDetails(request);
  if (reply) return reply.draft_only || reply.reply_to?.caution ? 'Approve reply' : 'Approve and send';
  const payload = request.payload as { details?: { draft_only?: boolean } };
  return type === 'communication' && payload.details?.draft_only === true ? 'Approve draft' : APPROVAL_META[type].action;
}

export function approvalPrimaryAction(view: ApprovalView): string {
  // A flagged sender's reply needs two people; the first press sends nothing.
  if (view.payload.approval_type === 'communication' && view.payload.details.reply_to) {
    return view.payload.details.draft_only || view.payload.details.reply_to.caution ? 'Approve reply' : 'Approve and send';
  }
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
  if (projection.authorization_status === 'approved' && (request.payload as { details?: { draft_only?: boolean } }).details?.draft_only === true && projection.approval_type === 'communication') return 'Approved · Nothing sent';
  if (projection.authorization_status === 'approved' && projection.effect_status === 'unavailable') return 'Approved · Nothing runs automatically';
  if (projection.authorization_status === 'approved' && projection.work_status === 'waiting') return 'Approved · Next step waiting';
  return approvalStatusLabel(projection.authorization_status);
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
  if (view.payload.approval_type === 'communication' && view.payload.details.reply_to) {
    const agent = view.identities.requester_agent.name;
    return view.payload.details.draft_only
      ? `${agent} suggested this reply. Approving saves it; Hermes won't send it.`
      : `${agent} suggested this reply. Nothing is sent until you approve it.`;
  }
  if (isCommunicationDraft(view)) return 'Approving saves this message. Nothing is sent.';
  const prompts: Record<ApprovalType, string> = {
    run_plan: 'Approve this plan and the spending limit below.',
    team_commitment: 'Accept the responsibility and scope below.',
    access: 'Approve the access below, and when it ends.',
    communication: 'Approve this exact message and who it goes to.',
    shared_learning: 'Approve sharing this with the team.',
    deliverable: 'Accept this result against what was asked for.',
    data_disclosure: 'Approve sharing the listed information with this recipient.',
    record_change: 'Approve the exact changes below.',
    exception: 'Approve this exception within its limits.',
    agent_governance: 'Approve these agent settings.',
  };
  return prompts[view.payload.approval_type];
}

export function approvalEffectCopy(view: ApprovalView): string {
  if (isCommunicationDraft(view)) return view.payload.approval_type === 'communication' && view.payload.details.reply_to ? 'Approving saves the reply · Nothing is sent' : 'Approving saves the email · Nothing is sent';
  if (view.effect.status === 'simulated') return 'Test mode · Nothing was sent';
  if (view.payload.approval_type === 'communication' && view.payload.details.reply_to) {
    if (view.status !== 'pending') return 'Your decision is saved · Sending is shown below';
    return view.payload.details.reply_to.caution
      ? 'Two people approve this reply · It goes only to the sender'
      : 'Sends when you approve · Only to the sender';
  }
  if (view.effect.status === 'unavailable') return 'Your decision is saved · Nothing runs automatically';
  if (view.effect.status === 'executed') return 'Done';
  if (view.effect.kind !== 'none') return 'Your decision is saved · The action happens separately';
  if (view.payload.approval_type === 'run_plan') return 'Work starts once everyone has approved';
  if (view.payload.approval_type === 'team_commitment') return 'Accepts the responsibility · The work happens separately';
  if (view.payload.approval_type === 'deliverable') return 'Saves that you accepted this result';
  return 'Saves your decision';
}

// ---------------------------------------------------------------------------
// Result copy: the server's enum values, said in words a reviewer would use.
// Unknown values (an older client against a newer Worker) fall back to a
// neutral word, never to the raw value (docs/DESIGN.md).
// ---------------------------------------------------------------------------

const unknownState = (): string => 'Updated';

const AUTHORIZATION_LABELS: Record<string, string> = {
  pending: 'Waiting for review',
  approved: 'Approved',
  declined: 'Declined',
  changes_requested: 'Changes requested',
  expired: 'Expired',
  superseded: 'Replaced by a newer version',
  withdrawn: 'Withdrawn',
};

const WORK_LABELS: Record<string, string> = {
  waiting: 'Waiting',
  ready: 'Ready to start',
  admitted: 'Work started',
  completed: 'Nothing else to do',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
  refused: 'Not started',
};

const EFFECT_LABELS: Record<string, string> = {
  unavailable: 'Nothing runs automatically',
  waiting: 'Waiting',
  not_required: 'Not required',
  executed: 'Done',
  // Outside production a reply to a role inbox is delivered by a simulator
  // (C98, D12); the label never says "sent".
  simulated: 'Test mode · nothing sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const approvalStatusLabel = (status: string): string => AUTHORIZATION_LABELS[status] ?? unknownState();
export const approvalWorkLabel = (status: string): string => WORK_LABELS[status] ?? unknownState();
export const approvalEffectLabel = (status: string): string => EFFECT_LABELS[status] ?? unknownState();

const WORK_REASONS: Record<string, string> = {
  no_runtime_continuation_requested: 'This approval did not ask for any work to run afterwards.',
  approval_type_has_no_runtime_executor: 'The authorization is recorded; nothing runs automatically for this kind of approval.',
  reviewed_resource_is_mutable: 'A reviewed resource can still change, so work was not started. Submit a new revision with a fixed version.',
  resource_binding_hook_changed: 'A reviewed resource changed after approval, so work was not started. Submit a new revision.',
};

/** One plain sentence for a `work.reason`; an unknown code is not shown, a sentence is passed through. */
export function approvalWorkReason(reason: string | null): string | null {
  if (!reason) return null;
  const known = WORK_REASONS[reason];
  if (known) return known;
  return /^[a-z0-9_:.-]+$/.test(reason) ? null : reason;
}

/**
 * What happened to the approved action, for the result block. The server's
 * `effect.reason` is operator detail (it can name a simulated delivery id),
 * so the reviewer gets a sentence chosen from the effect's state instead.
 */
export function approvalEffectSentence(view: ApprovalView): string {
  if (view.payload.illustrative && ['unavailable', 'not_required', 'waiting'].includes(view.effect.status)) {
    return 'Illustrative demo only: nothing happened outside Hermes.';
  }
  const reply = view.payload.approval_type === 'communication' && Boolean(view.payload.details.reply_to);
  switch (view.effect.status) {
    case 'simulated': return 'This is a test workspace, so nothing was actually sent.';
    case 'executed': return reply ? 'The reply was sent.' : 'Done.';
    case 'waiting': return reply ? 'Waiting for a connected Google or Microsoft account to send from.' : 'Waiting to run.';
    case 'failed': return reply ? 'The reply could not be sent. Nothing went out.' : 'This did not run.';
    case 'unavailable': return 'Nothing runs automatically for this kind of request.';
    case 'not_required': return 'Nothing else needs to happen.';
    case 'cancelled': return 'Cancelled before it ran.';
    default: return 'What happens next is shown here.';
  }
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
