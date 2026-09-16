import { describe, expect, it } from 'vitest';
import type { InvitationEntity, MemberEntity } from '@hermes/shared';
import { initialState } from '../model/store.js';
import { LIST_KEYS, memberCounts } from './selectors.js';

const joined = (id: string, email: string): MemberEntity => ({
  id,
  user_id: id,
  name: email.split('@')[0]!,
  email,
  role: 'member',
  status: 'active',
  reviewer_roles: [],
  joined_at: '2026-09-15T18:00:00.000Z',
  version: 1,
});

describe('memberCounts', () => {
  it('counts one pending person once when both the invitation and mirror row are present', () => {
    const state = initialState();
    const active = [
      joined('00000000-0000-4000-8000-000000000001', 'maya@example.com'),
      joined('00000000-0000-4000-8000-000000000002', 'alex@example.com'),
    ];
    const pending: MemberEntity = {
      id: '00000000-0000-4000-8000-000000000003',
      user_id: null,
      name: 'Lena Fischer',
      email: 'Lena@Example.com',
      role: 'member',
      status: 'invited',
      reviewer_roles: [],
      joined_at: null,
      version: 1,
    };
    const invitation: InvitationEntity = {
      id: '00000000-0000-4000-8000-000000000004',
      email: 'lena@example.com',
      role: 'member',
      status: 'pending',
      invited_at: '2026-09-15T18:00:00.000Z',
      version: 1,
    };

    for (const member of [...active, pending]) {
      state.entities.member[member.id] = { data: member, version: member.version, fetchedAt: 0, state: 'ready' };
    }
    state.entities.invitation[invitation.id] = { data: invitation, version: invitation.version, fetchedAt: 0, state: 'ready' };
    state.entities.lists[LIST_KEYS.members] = { ids: [...active, pending].map((member) => member.id), cursor: null, total: 3, state: 'ready' };
    state.entities.lists[LIST_KEYS.invitations] = { ids: [invitation.id], cursor: null, total: 1, state: 'ready' };

    expect(memberCounts(state)).toEqual({ joined: 2, invited: 1 });
  });
});
