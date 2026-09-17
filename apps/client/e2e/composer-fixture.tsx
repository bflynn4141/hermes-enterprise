// An isolated browser fixture using the real Composer and store. Its adapter
// records calls so waiting controls can be tested without a Worker or database.
import { createRoot } from 'react-dom/client';
import { HermesMotionProvider } from '@hermes/motion-components';
import { Composer } from '../src/app/chat/Composer.js';
import { ConnectionBanner } from '../src/app/Banners.js';
import { StoreProvider, useAppState } from '../src/app/store-context.js';
import { createStore, initialState } from '../src/model/store.js';
import type { Adapter } from '../src/model/adapter.js';
import type { Run } from '@hermes/shared';

export interface ComposerFixtureOptions {
  status?: 'waiting' | 'working' | 'none';
  waitingFor?: string | null;
  keysLocked?: boolean;
  keyStatus?: 'verified' | 'invalid' | 'none';
  failAnswer?: boolean;
}

const sessionId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';

declare global {
  interface Window {
    composerFixture: {
      calls: { method: string; args: string[] }[];
      mount(options: ComposerFixtureOptions): void;
    };
  }
}

function View() {
  const state = useAppState();
  return <><ConnectionBanner /><Composer session={state.sessions[sessionId]!} /></>;
}

const root = createRoot(document.getElementById('root')!);
window.composerFixture = {
  calls: [],
  mount(options) {
    this.calls = [];
    const state = initialState();
    state.ready = true;
    state.ui.providerKeysLocked = options.keysLocked ?? false;
    const store = createStore(state);
    store.dispatch({ type: 'session/create', id: sessionId, mode: 'work', model: 'deepseek-flash', runtime: 'local', pending: false });
    store.dispatch({
      type: 'entity/upsert',
      kind: 'catalog',
      id: 'deepseek-flash',
      data: {
        model_id: 'deepseek-flash',
        provider: 'deepseek',
        label: 'DeepSeek Flash',
        effort: ['low', 'high'],
        default_effort: 'high',
        enabled: true,
        disabled_reason: null,
      },
    });
    if (options.status !== 'none') {
      const run: Run = {
        id: runId, session_id: sessionId, agent_id: '11111111-1111-4111-8111-111111111111', status: options.status ?? 'waiting', attempt: 1,
        waiting_for: options.waitingFor === undefined ? 'destination' : options.waitingFor,
        waiting_label: 'Where should the reply go?', steps: [], queue: [], title: null,
      };
      store.dispatch({ type: 'run/start', sessionId, run });
    }
    const keyStatus = options.keyStatus ?? 'verified';
    if (keyStatus !== 'none') {
      store.dispatch({ type: 'entity/upsert', kind: 'provider_key', id: 'key-1', data: { id: 'key-1', provider: 'openrouter', status: keyStatus } });
      store.dispatch({ type: 'list/set', key: 'provider-keys', ids: ['key-1'], cursor: null, total: 1 });
    }
    const record = (method: string, args: string[]) => { window.composerFixture.calls.push({ method, args }); };
    const adapter = {
      send: async (...args: string[]) => { record('send', args); store.dispatch({ type: 'session/draft-clear', id: sessionId }); },
      guide: async (...args: string[]) => { record('guide', args); },
      queue: async (...args: string[]) => { record('queue', args); },
      answerContext: async (...args: string[]) => {
        record('answerContext', args);
        if (options.failAnswer) throw { reason: 'context_changed', message: 'This question changed. Check your answer and try again.' };
      },
      stop: async (...args: string[]) => { record('stop', args); },
      rest: { patchSession: async () => undefined },
    } as unknown as Adapter;
    root.render(<StoreProvider store={store} adapter={adapter}><HermesMotionProvider reducedMotion><View /></HermesMotionProvider></StoreProvider>);
  },
};
