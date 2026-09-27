// The Roles checklist and "Can approve" line shared by the Invite member and
// Manage dialogs (decision C93). The line is computed with the shared
// `approvalsFor`, from the draft, so an Admin sees what a choice grants before
// saving it.
import type { ApprovalRoute, WorkspaceRole } from '@hermes/shared';
import { sortRoles } from './AdminRoles.js';
import { canApproveLine, memberRolesErrorMessage } from './approval-routes.js';
import './admin-approvals.css';

export function RoleChecklist({ roles, selected, onChange, disabled = false }: {
  roles: readonly WorkspaceRole[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  return <fieldset className="member-approvals-roles">
    <legend>Roles</legend>
    {sortRoles(roles).map((role) => <label key={role.id} className="member-approvals-role">
      <input
        type="checkbox"
        disabled={disabled}
        checked={selected.includes(role.slug)}
        onChange={(event) => onChange(event.target.checked ? [...selected, role.slug] : selected.filter((slug) => slug !== role.slug))}
      />
      <span>{role.name}</span>
    </label>)}
  </fieldset>;
}

/** Nothing when the rules could not load: a guess here would be worse than no line. */
export function CanApprove({ routes, person }: { routes: readonly ApprovalRoute[] | null; person: { role: string; reviewer_roles: readonly string[] } }) {
  if (!routes) return null;
  return <p className="member-approvals-line" aria-live="polite">{canApproveLine(routes, person)}</p>;
}

/** Only slugs that name a workspace role; the server refuses anything else. */
export const knownRoleSlugs = (slugs: readonly string[], roles: readonly Pick<WorkspaceRole, 'slug'>[]): string[] =>
  slugs.filter((slug) => roles.some((role) => role.slug === slug));

/** What the Manage dialog was doing when the server refused. */
export type ManageAction = 'role' | 'roles' | 'remove';

/**
 * One refusal line for everything the Manage dialog writes. Each of these
 * writes needs a recent sign-in on the server (`requireStepUp`), so a stale
 * session gets the step-up sentence and the caller adds "Sign in again".
 */
export function manageErrorMessage(action: ManageAction, error: unknown): string {
  const stale = (error as { reason?: string } | null)?.reason === 'reauth_required';
  switch (action) {
    case 'role': return stale ? 'Changing someone’s role needs a recent sign-in.' : 'Could not change this role. Nothing was changed. Try again.';
    case 'remove': return stale ? 'Removing a member needs a recent sign-in.' : 'Could not remove this member. Their access has not changed. Try again.';
    case 'roles': return memberRolesErrorMessage(error);
  }
}
