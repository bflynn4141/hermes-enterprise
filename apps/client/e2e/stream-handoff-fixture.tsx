// Isolate event ordering with the real transcript and reducer, without claiming
// Worker/provider coverage. The test decides when each authoritative event lands.
import { createRoot } from 'react-dom/client';
import { HermesMotionProvider } from '@hermes/motion-components';
import { SCHEMA_VERSION, type Message, type Run } from '@hermes/shared';
import { Transcript } from '../src/app/chat/Transcript.js';
import { StoreProvider, useAppState } from '../src/app/store-context.js';
import { actionsFor, createStore, initialState } from '../src/model/store.js';
import { createAdapter, type Adapter } from '../src/model/adapter.js';

const sessionId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const workspaceId = '44444444-4444-4444-8444-444444444444';
const agentId = '55555555-5555-4555-8555-555555555555';

declare global {
  interface Window {
    streamHandoffFixture: {
      mount(options: { text: string; reducedMotion: boolean }): void;
      finalize(text: string, blocks?: Message['blocks']): void;
      terminal(status?: 'completed' | 'stopped' | 'error'): void;
      nextTurn(text: string): void;
      sendAgain(text: string): Promise<void>;
      remount(): void;
      snapshot(): { status: Run['status'] | undefined; stream: string | null; messages: string[] };
    };
  }
}

function View() {
  const state = useAppState();
  return <div style={{ height: 800, display: 'flex', flexDirection: 'column' }}><Transcript session={state.sessions[sessionId]!} find={null} /></div>;
}

const root = createRoot(document.getElementById('root')!);
let store = createStore(initialState());
let turn = 1;
let activeRunId = runId;
let adapter: Adapter;
let viewKey = 0;

function render() {
  root.render(<StoreProvider store={store} adapter={adapter}><HermesMotionProvider reducedMotion={store.getState().ui.reduceMotion}><View key={viewKey} /></HermesMotionProvider></StoreProvider>);
}

function delta(text: string) {
  store.dispatch({ type: 'stream/reset', sessionId, runId: activeRunId, turn, stepAttempt: 1 });
  store.dispatch({ type: 'stream/delta', sessionId, runId: activeRunId, turn, stepAttempt: 1, delta: text });
}

window.streamHandoffFixture = {
  mount({ text, reducedMotion }) {
    const state = initialState();
    state.ready = true;
    state.agent.id = agentId;
    state.ui.reduceMotion = reducedMotion;
    store = createStore(state);
    turn = 1;
    activeRunId = runId;
    store.dispatch({ type: 'session/create', id: sessionId, title: 'Streaming regression fixture', mode: 'work', model: 'deepseek-flash', runtime: 'cloud', pending: false });
    store.dispatch({
      type: 'message/add', sessionId,
      message: { id: '11111111-1111-4111-8111-111111111111', session_id: sessionId, seq: 1, role: 'user', kind: null, run_id: null, text: 'again', blocks: [], status: 'complete' },
    });
    store.dispatch({
      type: 'run/start', sessionId,
      run: { id: runId, session_id: sessionId, agent_id: '11111111-1111-4111-8111-111111111111', status: 'working', attempt: 1, steps: [], queue: [], title: null },
    });
    delta(text);
    // Real admission logic, synthetic HTTP only. No live server or model calls.
    adapter = createAdapter({ store, workspaceId, fetchImpl: async (input) => {
      if (String(input).endsWith('/turns')) return new Response(JSON.stringify({ run_id: activeRunId, status: 'working', attempt: 1 }), {
        headers: { 'content-type': 'application/json' },
      });
      throw new Error(`Unexpected fixture request: ${String(input)}`);
    } });
    render();
  },
  finalize(text, blocks = []) {
    // Use the wire action mapping: message.final deliberately has no session
    // sequence, which is the condition that poisoned the following send.
    for (const action of actionsFor({
      id: '1', workspace_id: workspaceId, session_id: sessionId, schema_version: SCHEMA_VERSION,
      trace_id: 'handoff-fixture', at: new Date().toISOString(), kind: 'message.final',
      payload: { message_id: crypto.randomUUID(), session_id: sessionId, run_id: activeRunId,
        turn, attempt: 1, text, blocks, incomplete: false, worked_ms: 1_000 },
    }, store.getState())) store.dispatch(action);
  },
  terminal(status = 'completed') {
    store.dispatch({ type: 'run/status', sessionId, runId: activeRunId, status });
  },
  nextTurn(text) {
    store.dispatch({ type: 'run/step', sessionId, stepId: 'lookup', state: 'done', label: 'Checked the workspace', toolCallId: 'tool-1' });
    turn += 1;
    delta(text);
  },
  async sendAgain(text) {
    activeRunId = crypto.randomUUID();
    turn = 1;
    await adapter.send(sessionId, 'again');
    const clientTurnId = store.getState().sessions[sessionId]!.pendingTurn!.clientTurnId;
    for (const action of actionsFor({
      id: '2', workspace_id: workspaceId, session_id: sessionId, schema_version: SCHEMA_VERSION,
      trace_id: 'handoff-fixture', at: new Date().toISOString(), kind: 'message.appended',
      payload: { message_id: crypto.randomUUID(), session_id: sessionId, seq: 3,
        role: 'user', kind: null, text: 'again', blocks: [], status: 'complete',
        run_id: activeRunId, client_turn_id: clientTurnId },
    }, store.getState())) store.dispatch(action);
    delta(text);
  },
  remount() { viewKey += 1; render(); },
  snapshot() {
    const session = store.getState().sessions[sessionId]!;
    return { status: session.run?.status, stream: session.stream?.text ?? null, messages: session.messages.map((message) => message.text) };
  },
};
