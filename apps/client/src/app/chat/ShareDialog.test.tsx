import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SHARE_AUDIENCE, mockUuid } from '@hermes/shared';
import type { Adapter } from '../../model/adapter.js';
import { createStore, initialState, sessionFrom, type SessionState } from '../../model/store.js';
import { StoreProvider } from '../store-context.js';
import { revokeSharedSession, ShareDialog } from './ChatPane.js';

function session(share: SessionState['share'] = null): SessionState {
  return {
    ...sessionFrom({
      id: mockUuid(2),
      agent_id: mockUuid(4),
      title: 'Partner applications',
      mode: 'work',
      model_id: 'deepseek-flash',
      effort: null,
      runtime: 'cloud',
      pinned: false,
      archived: false,
      focus_ref: null,
      status: 'Ready',
      last_activity_at: null,
      share: null,
      context: null,
      version: 1,
    }),
    share,
  };
}

function renderShareDialog(value: SessionState): string {
  const base = initialState();
  const store = createStore({
    ...base,
    workspace: { id: mockUuid(1), name: 'Nous', role: 'admin', jurisdiction: null },
    sessions: { [value.id]: value },
    sessionOrder: [value.id],
    activeSessionId: value.id,
  });
  return renderToStaticMarkup(
    <StoreProvider store={store} adapter={{} as Adapter}>
      <ShareDialog open session={value} onClose={() => undefined} />
    </StoreProvider>,
  );
}

describe('session sharing', () => {
  it('offers only a truthful bearer link, with no workspace or named-member promise', () => {
    const html = renderShareDialog(session());
    expect(html).toContain('read-only bearer link');
    expect(html).toContain('Anyone who has the link');
    expect(html).not.toContain('Named member');
    expect(html).not.toContain('Everyone in Nous');
    expect(html).not.toContain('Nothing is sent outside the workspace');
  });

  it('corrects a legacy audience label when presenting an active share', () => {
    const html = renderShareDialog(
      session({ id: mockUuid(8), url: 'https://hermes.example/shared/token', audience: 'Workspace' }),
    );
    expect(html).toContain(SHARE_AUDIENCE);
    expect(html).toContain('Possession of the link grants access');
    expect(html).not.toContain('Shared with Workspace');
  });

  it('marks a share revoked only after the server confirms it', async () => {
    const markRevoked = vi.fn();
    await expect(revokeSharedSession(() => Promise.reject(new Error('server unavailable')), markRevoked)).rejects.toThrow(
      'server unavailable',
    );
    expect(markRevoked).not.toHaveBeenCalled();

    await revokeSharedSession(() => Promise.resolve(), markRevoked);
    expect(markRevoked).toHaveBeenCalledTimes(1);
  });
});
