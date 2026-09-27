import { describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '@hermes/shared';
import { RestError } from '../../model/rest.js';
import { jobLockedRole, manageErrorMessage } from './MemberRoles.js';

const roles: Pick<WorkspaceRole, 'slug' | 'name' | 'builtin' | 'agent_template'>[] = [
  { slug: 'partnerships', name: 'Partnerships', builtin: true, agent_template: 'partnerships-agent' },
  { slug: 'finance', name: 'Finance', builtin: true, agent_template: 'finance-agent' },
  { slug: 'legal', name: 'Legal', builtin: true, agent_template: null },
  // A custom role can never borrow a job's template.
  { slug: 'fake-finance', name: 'Fake Finance', builtin: false, agent_template: 'finance-agent' },
];

describe('the role that comes with a job (C97)', () => {
  it('is the built-in role whose agents use the job’s template', () => {
    expect(jobLockedRole(roles, 'finance-agent')).toEqual({ slug: 'finance', note: 'Comes with the Finance job' });
    expect(jobLockedRole(roles, 'partnerships-agent')).toEqual({ slug: 'partnerships', note: 'Comes with the Partnerships job' });
  });

  it('is nothing when there is no job or no such role', () => {
    expect(jobLockedRole(roles, null)).toBeNull();
    expect(jobLockedRole([], 'finance-agent')).toBeNull();
  });
});

describe('Manage dialog refusals', () => {
  const stale = new RestError(401, 'reauth_required', 'this action needs a recent sign-in');
  const broken = new RestError(503, 'fixture_write_failed', 'no');
  it('ask for a recent sign-in in words that name the action', () => {
    expect(manageErrorMessage('role', stale)).toBe('Changing someone’s role needs a recent sign-in.');
    expect(manageErrorMessage('remove', stale)).toBe('Removing a member needs a recent sign-in.');
    expect(manageErrorMessage('roles', stale)).toBe('Changing roles needs a recent sign-in.');
  });
  it('say nothing changed otherwise', () => {
    expect(manageErrorMessage('role', broken)).toBe('Could not change this role. Nothing was changed. Try again.');
    expect(manageErrorMessage('remove', broken)).toBe('Could not remove this member. Their access has not changed. Try again.');
    expect(manageErrorMessage('roles', broken)).toBe('Could not change these roles. Nothing was changed. Try again.');
  });
});
