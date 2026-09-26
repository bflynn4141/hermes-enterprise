// Approval routing copy: the words the Approvals page, the member dialogs and
// the Inbox use for who approves what (decision C93).
//
// Every "Can approve" answer goes through the shared `approvalsFor`, the same
// helper the server's checks are built on, so a summary here never promises
// what the decision route would refuse.
import { approvalsFor, type ApprovalRoute, type ApprovalRouteRule, type WorkspaceRole } from '@hermes/shared';

export const ADMIN_APPROVALS_VIEW = 'Approvals';

export const APPROVALS_SCOPE = 'Who approves business decisions and the actions that follow them. This is separate from the command safety checks Hermes agents ask for.';
export const APPROVALS_LIVE = 'Changes apply to work already waiting as well as new work.';
export const NO_APPROVER_MESSAGE = 'Choose at least one group who can approve.';

type RoleNames = ReadonlyMap<string, string>;

export const roleNameMap = (roles: readonly Pick<WorkspaceRole, 'slug' | 'name'>[]): Map<string, string> =>
  new Map(roles.map((role) => [role.slug, role.name]));

/** "Finance", "Admins or Finance", "Admins, Finance or Legal". */
export function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** The groups a rule lets approve, in the order the page lists them: Admins first, then roles. */
export function approverGroups(rule: Pick<ApprovalRouteRule, 'admins' | 'roles'>, names: RoleNames): string[] {
  return [...(rule.admins ? ['Admins'] : []), ...rule.roles.map((slug) => names.get(slug) ?? slug)];
}

/** What the requester switch means for this kind of approval, as a question. */
export const requesterQuestion = (kind: ApprovalRoute['kind']): string => kind === 'decision'
  ? 'Can the person whose agent prepared this approve it?'
  : 'Can the person who approved the request also do this?';

/** The one-line rule: "Finance · 2 different people", "Admins · the person whose agent prepared it can't approve it". */
export function ruleSummary(route: Pick<ApprovalRoute, 'kind' | 'rule'>, names: RoleNames): string {
  const groups = approverGroups(route.rule, names);
  const parts = [groups.length ? joinOr(groups) : 'Nobody'];
  if (route.kind === 'action' && route.rule.approvals_required > 1) parts.push(`${route.rule.approvals_required} different people`);
  if (!route.rule.allow_requester) {
    parts.push(route.kind === 'decision'
      ? 'the person whose agent prepared it can’t approve it'
      : 'the person who approved the request can’t also do this');
  }
  return parts.join(' · ');
}

export function splitRoutes<T extends Pick<ApprovalRoute, 'kind'>>(routes: readonly T[]): { decisions: T[]; actions: T[] } {
  return { decisions: routes.filter((route) => route.kind === 'decision'), actions: routes.filter((route) => route.kind === 'action') };
}

/** "Can approve: Pay an approved invoice, Sign an approved agreement", or "Nothing yet". */
export function canApproveLine(routes: readonly Pick<ApprovalRoute, 'key' | 'label' | 'rule'>[], person: { role: string; reviewer_roles: readonly string[] }): string {
  const labels = approvalsFor(routes, person).map((route) => route.label);
  return `Can approve: ${labels.length ? labels.join(', ') : 'Nothing yet'}`;
}

/** The approvals a role's holders can give because of that role, for Admin → Roles. */
export function approvalsForRole(routes: readonly Pick<ApprovalRoute, 'label' | 'rule'>[], slug: string): string[] {
  return routes.filter((route) => route.rule.roles.includes(slug)).map((route) => route.label);
}

/** Chosen roles nobody holds yet: the rule is valid, but work waits until someone does. */
export function unheldRoles(rule: Pick<ApprovalRouteRule, 'roles'>, roles: readonly Pick<WorkspaceRole, 'slug' | 'name' | 'members'>[]): string[] {
  return roles.filter((role) => rule.roles.includes(role.slug) && role.members.length === 0).map((role) => role.name);
}

export const unheldWarning = (name: string): string => `Nobody holds ${name} yet, so this will wait until someone does.`;

export const sameRule = (a: ApprovalRouteRule, b: ApprovalRouteRule): boolean =>
  a.admins === b.admins
  && a.approvals_required === b.approvals_required
  && a.allow_requester === b.allow_requester
  && a.roles.length === b.roles.length
  && a.roles.every((slug) => b.roles.includes(slug));

const reasonOf = (error: unknown): string | undefined => (error as { reason?: string } | null)?.reason;
export const needsSignIn = (error: unknown): boolean => reasonOf(error) === 'reauth_required';

/** A refused rule change, in the words an Admin would use. */
export function approvalRouteErrorMessage(error: unknown): string {
  switch (reasonOf(error)) {
    case 'reauth_required': return 'Changing who approves needs a recent sign-in.';
    case 'no_approver': return NO_APPROVER_MESSAGE;
    case 'decision_single_approver': return 'One person makes this decision.';
    case 'unknown_role': return 'One of those roles no longer exists. Reload and try again.';
    case 'bad_rule': return 'That rule is not valid. Nothing was changed.';
    case 'unknown_route': return 'This approval no longer exists. Reload and try again.';
    case 'admin_required': return 'Only an Admin changes who approves.';
    default: return 'Could not save. Nothing was changed. Try again.';
  }
}

/** A refused change to someone's roles, from the invite or Manage dialogs. */
export function memberRolesErrorMessage(error: unknown): string {
  switch (reasonOf(error)) {
    case 'reauth_required': return 'Changing roles needs a recent sign-in.';
    case 'self_change': return 'Another Admin changes your own roles.';
    case 'unknown_role': return 'One of those roles no longer exists. Reload and try again.';
    case 'too_many_roles': return 'A person can hold at most 32 roles.';
    default: return 'Could not change these roles. Nothing was changed. Try again.';
  }
}

/** "this needs Finance" → "This needs Finance." The server writes the sentence; the client finishes it. */
const sentence = (message: string): string => {
  const trimmed = message.trim();
  if (!trimmed) return trimmed;
  const capital = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

/**
 * Why the Inbox refused a decision or an action under the workspace's rules.
 * Null when the refusal is not about who may approve, so callers keep their
 * own copy for everything else.
 */
export function approvalRefusalMessage(error: unknown): string | null {
  const { reason, message } = (error ?? {}) as { reason?: string; message?: string };
  switch (reason) {
    case 'own_request': return 'Your agent prepared this, so someone else approves it.';
    case 'same_person': return 'You approved this request, so someone else carries it out.';
    case 'approver_required':
    case 'role_required':
      return message && /^this needs /i.test(message.trim()) ? sentence(message) : 'Someone with a different role approves this.';
    default: return null;
  }
}
