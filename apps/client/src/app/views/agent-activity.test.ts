import { describe, expect, it } from 'vitest';
import type { TraceEntity } from '@hermes/shared';
import { initialState, type AppState, type SessionState } from '../../model/store.js';
import { agentActivity } from './agent-activity.js';

const AGENT = '00000000-0000-4000-8000-000000000002';
const SESSION = '00000000-0000-4000-8000-000000000003';
const RUN = '00000000-0000-4000-8000-000000000004';

function session(patch: Partial<SessionState> = {}): SessionState {
  return {
    id: SESSION,
    agentId: AGENT,
    title: 'Partner applications',
    subtitle: null,
    mode: 'work',
    model: 'model',
    effort: null,
    runtime: 'cloud',
    pinned: false,
    archived: false,
    status: 'idle',
    messages: [],
    oldestSeq: null,
    hasEarlier: false,
    draft: { text: '', attachments: [] },
    run: null,
    stream: null,
    focus: null,
    context: null,
    scrollTop: null,
    share: null,
    unread: false,
    pending: false,
    lastActivity: 1,
    carried: null,
    titleSource: 'auto',
    ...patch,
  };
}

function state(value: SessionState): AppState {
  return {
    ...initialState(),
    agent: { id: AGENT, name: 'Iris', email: 'iris@example.com', summary: 'Partner Program', setupStep: null },
    sessions: { [value.id]: value },
    sessionOrder: [value.id],
    activeSessionId: value.id,
  };
}

function trace(patch: Partial<TraceEntity> = {}): TraceEntity {
  return {
    id: RUN,
    run_id: RUN,
    agent_id: AGENT,
    name: 'Screen an application',
    type: 'Hermes Agent · work',
    status: 'completed',
    sub: '2s worked',
    needs_you: false,
    ref: null,
    steps: [],
    allowed_tools: [],
    version: 1,
    ...patch,
  };
}

describe('agent activity', () => {
  it('shows the active run and translates its exact tool name', () => {
    const value = session({
      status: 'working',
      run: {
        id: RUN,
        session_id: SESSION,
        agent_id: AGENT,
        status: 'working',
        attempt: 1,
        title: 'Screen the application',
        steps: [{ id: 'call-1', label: 'get_document_text', state: 'active', tool_call_id: 'call-1' }],
        queue: [],
      },
    });

    expect(agentActivity(state(value), [])).toMatchObject({
      state: 'working',
      status: 'Working now',
      task: 'Screen the application',
      traceId: RUN,
      tool: { name: 'get_document_text', summary: 'Reading a source document', state: 'active' },
    });
  });

  it('makes a parked run explicit and does not animate it as work', () => {
    const value = session({
      status: 'waiting',
      run: {
        id: RUN,
        session_id: SESSION,
        agent_id: AGENT,
        status: 'waiting',
        attempt: 1,
        title: 'Draft partner reply',
        steps: [{ id: 'call-1', label: 'ask_for_context', state: 'active', tool_call_id: 'call-1' }],
        queue: [],
        waiting_for: 'destination',
        waiting_label: 'Feedback destination',
      },
    });

    expect(agentActivity(state(value), [])).toMatchObject({
      state: 'waiting',
      status: 'Waiting for you',
      label: 'Blocked on',
      task: 'Feedback destination',
    });
  });

  it('uses the newest trace as recent activity when no run is live', () => {
    const activity = agentActivity(state(session()), [
      trace({
        steps: [{ id: 'call-1', label: 'propose_request', state: 'done', tool_call_id: 'call-1' }],
      }),
    ]);

    expect(activity).toMatchObject({
      state: 'idle',
      status: 'Idle',
      label: 'Last task',
      task: 'Screen an application',
      tool: { name: 'propose_request', summary: 'Prepared a review request', state: 'complete' },
    });
  });

  it('surfaces review work as waiting instead of pretending the agent is active', () => {
    const activity = agentActivity(state(session()), [trace({ status: 'Awaiting review', needs_you: true, steps: [{ id: 'wait', label: 'Waiting for a human decision', state: 'active' }] })]);
    expect(activity).toMatchObject({ state: 'waiting', status: 'Waiting for you', task: 'Waiting for a human decision' });
  });
});
