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
    pendingTurn: null,
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
    agent: { id: AGENT, name: 'Iris', email: 'iris@example.com', summary: 'Partner Program', setupStep: null, provisioningStatus: null },
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

  it('shows the completed task instead of the runtime Thinking step while idle', () => {
    const activity = agentActivity(state(session()), [trace({
      steps: [{ id: 'hermes', label: 'Thinking', state: 'done', tool_call_id: null }],
    })]);
    expect(activity).toMatchObject({
      state: 'idle', task: 'Screen an application', action: 'Response completed · No tool calls', tool: null,
    });
  });

  it('keeps the last real tool visible after a terminal Thinking step', () => {
    const activity = agentActivity(state(session()), [trace({ steps: [
      { id: 'call-1', label: 'get_document_text', state: 'done', tool_call_id: 'call-1' },
      { id: 'hermes', label: 'Thinking', state: 'done' },
    ] })]);
    expect(activity).toMatchObject({
      state: 'idle', task: 'Screen an application',
      tool: { name: 'get_document_text', summary: 'Read a source document', state: 'complete' },
    });
  });

  it('does not claim an unfinished tool succeeded or is still running after a stopped run', () => {
    const activity = agentActivity(state(session()), [trace({ status: 'stopped', steps: [
      { id: 'call-1', label: 'get_document_text', state: 'active', tool_call_id: 'call-1' },
    ] })]);
    expect(activity.tool).toMatchObject({ state: 'interrupted', summary: 'Stopped before completion' });
  });

  it('reports a failed tool as failed rather than describing a successful action', () => {
    const activity = agentActivity(state(session()), [trace({ status: 'error', steps: [
      { id: 'call-1', label: 'get_document_text', state: 'failed', tool_call_id: 'call-1' },
    ] })]);
    expect(activity.tool).toMatchObject({ state: 'failed', summary: 'Tool failed' });
  });

  it('does not call a tool active when its run is waiting for a person', () => {
    const activity = agentActivity(state(session()), [trace({ status: 'waiting', steps: [
      { id: 'call-1', label: 'ask_for_context', state: 'active', tool_call_id: 'call-1' },
    ] })]);
    expect(activity.tool).toMatchObject({ state: 'waiting', summary: 'Waiting for a response' });
  });

  it('distinguishes a runtime failure from an explicit stop', () => {
    const noTool = agentActivity(state(session()), [trace({ status: 'error', steps: [
      { id: 'hermes', label: 'Thinking', state: 'active' },
    ] })]);
    expect(noTool).toMatchObject({ state: 'stopped', task: 'Screen an application', action: 'Run failed' });
    const unfinishedTool = agentActivity(state(session()), [trace({ status: 'error', steps: [
      { id: 'call-1', label: 'get_document_text', state: 'active', tool_call_id: 'call-1' },
    ] })]);
    expect(unfinishedTool.tool).toMatchObject({ state: 'interrupted', summary: 'Completion not recorded' });
  });

  it('uses the last actual call rather than an older unfinished step after completion', () => {
    const activity = agentActivity(state(session()), [trace({ steps: [
      { id: 'old', label: 'get_request', state: 'active', tool_call_id: 'old' },
      { id: 'latest', label: 'get_document_text', state: 'done', tool_call_id: 'latest' },
    ] })]);
    expect(activity.tool).toMatchObject({ name: 'get_document_text', state: 'complete' });
  });
});
