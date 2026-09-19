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
  it.each([
    { status: 'streaming' as const, runId: mockUuid(3), label: 'Guidance queued' },
    { status: 'complete' as const, runId: mockUuid(3), label: 'Guidance applied' },
    { status: 'streaming' as const, runId: null, label: 'Queued for next message' },
  ])('renders the durable guidance state: $label', ({ status, runId, label }) => {
    const current = session();
    const html = render(<Transcript session={{ ...current, messages: [{
      id: mockUuid(90), session_id: current.id, seq: 0, role: 'user', kind: 'guidance',
      text: 'Use the newer source', blocks: [], status, run_id: runId,
    }] }} find={null} />);
    expect(html).toContain(`data-message-id="${mockUuid(90)}"`);
    expect(html.match(/Use the newer source/g)).toHaveLength(1);
    expect(html).toContain(`<div class="meta">${label}</div>`);
    if (status === 'streaming') expect(html).not.toContain('Guidance applied');
  });

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

  it('renders a Hermes Bot Mode handoff as an agent notice instead of a human bubble', () => {
    const current = session();
    const html = render(<Transcript session={{
      ...current,
      messages: [{
        id: mockUuid(90), session_id: current.id, seq: 0, role: 'user', kind: null,
        text: 'Message from 🤖 Iris (@agent-partnerships): Review the Finance handoff.',
        blocks: [], status: 'complete', run_id: null,
      }],
    }} find={null} />);
    expect(html).toContain('msg-agent-handoff');
    expect(html).toContain('Message from');
    expect(html).toContain('@agent-partnerships');
    expect(html).toContain('Review the Finance handoff.');
    expect(html).not.toContain('class="msg-user"');
  });
});
