import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mockUuid } from '@hermes/shared';
import { createStore, initialState, sessionFrom } from '../../model/store.js';
import type { Adapter } from '../../model/adapter.js';
import { StoreProvider } from '../store-context.js';
import { ChatPane } from './ChatPane.js';
import { Transcript } from './Transcript.js';

const session = () => sessionFrom({
  id: mockUuid(2), agent_id: mockUuid(4), title: 'New session', mode: 'work', model_id: 'deepseek-flash',
  effort: null, runtime: 'cloud', pinned: false, archived: false, focus_ref: null,
  status: 'Ready', last_activity_at: null, share: null, context: null, version: 1,
});
const render = (node: React.ReactNode) => renderToStaticMarkup(
  <StoreProvider store={createStore(initialState())} adapter={{} as Adapter}>{node}</StoreProvider>,
);

describe('Iris welcome', () => {
  it('uses one centered prompt with the icon above it in an empty conversation', () => {
    const html = render(<Transcript session={session()} find={null} />);
    expect(html).toContain('transcript-empty');
    expect(html).toContain('chat-welcome');
    expect(html.match(/What do you need help with\?/g)).toHaveLength(1);
    expect(html.indexOf('iris-motion')).toBeLessThan(html.indexOf('What do you need help with?'));
    expect(html).not.toContain('Open a conversation or start a new one.');
    expect(html).not.toContain('Describe what you need');
  });

  it('uses the same copy before a session exists and preserves Start', () => {
    const html = render(<ChatPane narrow={false} active />);
    expect(html).toContain('chat-welcome-standalone');
    expect(html).toContain('What do you need help with?');
    expect(html).toContain('Start');
  });

  it('keeps carried-context information separate from the welcome state', () => {
    const html = render(<Transcript session={{ ...session(), carried: { from: 'Review', context: 'Pending evidence' } }} find={null} />);
    expect(html).toContain('Pending evidence');
    expect(html).toContain('No completed actions were replayed.');
    expect(html).not.toContain('chat-welcome');
  });
});
