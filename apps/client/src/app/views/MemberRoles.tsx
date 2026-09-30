// The Roles checklist and "Can approve" line shared by the Invite member and
// Manage dialogs (decision C93). The line is computed with the shared
// `approvalsFor`, from the draft, so an Admin sees what a choice grants before
// saving it.
import { useId } from 'react';
import type { ApprovalRoute, MemberRoleTemplate, WorkspaceRole } from '@hermes/shared';
import { sortRoles } from './AdminRoles.js';
import { canApproveLine, memberRolesErrorMessage } from './approval-routes.js';
import './admin-approvals.css';

/** A role the person gets whatever the Admin ticks, and why. */
export interface LockedRole { readonly slug: string; readonly note: string }

/**
 * The built-in role that comes with an invitation's job (decision C97). The
 * server grants it when the person joins: a Finance job binds them to the
 * Finance lane, and every accepted invitation grants its job's role (C92).
 * A legacy invitation has no job picker and is always a Partnerships job.
 */
export function jobLockedRole(roles: readonly Pick<WorkspaceRole, 'slug' | 'name' | 'builtin' | 'agent_template'>[], job: MemberRoleTemplate | null): LockedRole | null {
  const role = job ? roles.find((row) => row.builtin && row.agent_template === job) : undefined;
  return role ? { slug: role.slug, note: `Comes with the ${role.name} job` } : null;
}

export function RoleChecklist({ roles, selected, onChange, disabled = false, locked = null }: {
  roles: readonly WorkspaceRole[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Shown ticked and not editable, with its note; never part of `selected`. */
  locked?: LockedRole | null;
}) {
  const id = useId();
  return <fieldset className="member-approvals-roles">
    <legend>Roles</legend>
    {sortRoles(roles).map((role) => {
      const isLocked = locked?.slug === role.slug;
      return <label key={role.id} className="member-approvals-role">
        <input
          type="checkbox"
          disabled={disabled || isLocked}
          checked={isLocked || selected.includes(role.slug)}
          onChange={(event) => onChange(event.target.checked ? [...selected, role.slug] : selected.filter((slug) => slug !== role.slug))}
          {...(isLocked ? { 'aria-labelledby': `${id}-name`, 'aria-describedby': `${id}-note` } : {})}
        />
        <span id={isLocked ? `${id}-name` : undefined}>{role.name}</span>
        {isLocked && <span id={`${id}-note`} className="admin-roles-person-note">{locked.note}</span>}
      </label>;
    })}
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
  if ((error as { reason?: string } | null)?.reason === 'wallet_owner_transfer_required') return 'This member owns the workspace wallets. Transfer wallet ownership before changing their workspace access.';
  if ((error as { reason?: string } | null)?.reason === 'wallet_payment_permission_required') return 'This change affects payment review. The wallet owner must approve payment permissions before these roles can change.';
  const stale = (error as { reason?: string } | null)?.reason === 'reauth_required';
  switch (action) {
    case 'role': return stale ? 'Changing someone’s role needs a recent sign-in.' : 'Could not change this role. Nothing was changed. Try again.';
    case 'remove': return stale ? 'Removing a member needs a recent sign-in.' : 'Could not remove this member. Their access has not changed. Try again.';
    case 'roles': return memberRolesErrorMessage(error);
  }
}
