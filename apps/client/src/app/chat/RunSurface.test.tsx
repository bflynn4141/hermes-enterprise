import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Message, Run } from '@hermes/shared';
import type { Adapter } from '../../model/adapter.js';
import type { SessionState, Store } from '../../model/store.js';
import { StoreProvider } from '../store-context.js';
import { RunActivity } from './RunSurface.js';

const sessionId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const agentId = '11111111-1111-4111-8111-111111111111';

function session(run: Run, streamText = ''): SessionState {
  return {
    id: sessionId,
    agentId,
    title: 'Session',
    subtitle: null,
    mode: 'work',
    model: 'deepseek-flash',
    effort: 'high',
    runtime: 'cloud',
    pinned: false,
    archived: false,
    status: 'Working',
    messages: [],
    oldestSeq: null,
    hasEarlier: false,
    draft: { text: '', attachments: [] },
    pendingTurn: null,
    run,
    stream: { runId, turn: 0, stepAttempt: 1, text: streamText, durableText: streamText, blocks: [], status: 'streaming' },
    focus: null,
    context: null,
    scrollTop: null,
    share: null,
    unread: false,
    pending: false,
    lastActivity: 0,
    carried: null,
    titleSource: 'auto',
  };
}

function run(): Run {
  return {
    id: runId,
    session_id: sessionId,
    agent_id: agentId,
    status: 'working',
    attempt: 1,
    title: null,
    steps: [{ id: 'provider', label: 'Thinking', state: 'active' }],
    queue: [],
    started_at: '2026-09-17T19:00:00.000Z',
  };
}

function progress(text: string): Message {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    session_id: sessionId,
    seq: 1,
    role: 'iris',
    kind: null,
    text,
    blocks: [],
    status: 'complete',
    run_id: runId,
  };
}

function render(activity: React.ReactNode): string {
  return renderToStaticMarkup(
    <StoreProvider store={{} as Store} adapter={{} as Adapter}>
      {activity}
    </StoreProvider>,
  );
}

describe('live run activity', () => {
  it('shows one thinking state before response text arrives', () => {
    const html = render(<RunActivity session={session(run())} />);
    expect(html.match(/Reasoning through the request/g)).toHaveLength(1);
    expect(html).not.toContain('Thinking…');
  });

  it('derives elapsed time from the run start after the activity remounts', () => {
    const timedRun = { ...run(), id: '77777777-7777-4777-8777-777777777777' };
    const firstMount = render(<RunActivity session={session(timedRun)} now={() => Date.parse('2026-09-17T19:00:03.700Z')} />);
    const remount = render(<RunActivity session={session(timedRun)} now={() => Date.parse('2026-09-17T19:00:24.100Z')} />);

    expect(firstMount).toContain('3.7s');
    expect(remount).toContain('24.1s');
    expect(remount).toContain('live-run-status--authoritative');
  });

  it('uses the latest visible progress in that same state', () => {
    const html = render(<RunActivity session={session(run())} progress={[progress('Let me check the workspace.')]}/>);
    expect(html.match(/Let me check the workspace\./g)).toHaveLength(1);
    expect(html).not.toContain('Thinking…');
  });

  it('moves the same activity row into writing while the answer streams', () => {
    const html = render(<RunActivity session={session(run(), 'The answer is arriving.')} />);
    expect(html.match(/Writing response/g)).toHaveLength(1);
    expect(html).not.toContain('Thinking…');
  });

  it('shows exact tool calls with human wording as their lifecycle advances', () => {
    const value = session({
      ...run(),
      steps: [
        { id: 'provider', label: 'Thinking', state: 'active' },
        { id: 'tool-1', label: 'list_partner_candidates', state: 'done', tool_call_id: 'tool-1' },
        { id: 'tool-2', label: 'get_partner_candidate', state: 'active', tool_call_id: 'tool-2' },
      ],
    });
    const html = render(<RunActivity session={value} />);
    expect(html).toContain('get_partner_candidate');
    expect(html).toContain('Reviewing a partner candidate');
    expect(html).toContain('list_partner_candidates');
    expect(html).toContain('Checked partner candidates');
  });
});
