// Real navigation, transcript, REST validation and hub/reducer behavior. Only
// HTTP/socket transport is synthetic; the Playwright host owns durable state
// across a full browser reload. This fixture is never in the product bundle.
import { createRoot } from 'react-dom/client';
import { HermesMotionProvider } from '@hermes/motion-components';
import { Sidebar } from '../src/app/Sidebar.js';
import { ChatPane } from '../src/app/chat/ChatPane.js';
import { StoreProvider } from '../src/app/store-context.js';
import { createAdapter } from '../src/model/adapter.js';
import { createAuth } from '../src/model/auth.js';
import { createMockBackend } from '../src/model/mock.js';
import { createStore, initialState } from '../src/model/store.js';
import type { SocketLike } from '../src/model/hub.js';

class FixtureSocket implements SocketLike {
  static all: FixtureSocket[] = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed = false;
  constructor(readonly url: string) {
    FixtureSocket.all.push(this);
    setTimeout(() => { if (!this.closed) this.onopen?.({}); }, 0);
  }
  send(data: string) { if (data === 'ping') this.onmessage?.({ data: 'pong' }); }
  close() { this.closed = true; }
}

declare global {
  interface Window {
    sessionReliabilityFixture: {
      ready: boolean;
      deliver(sessionId: string, frame: unknown): void;
      connections(): string[];
    };
  }
}

window.sessionReliabilityFixture = {
  ready: false,
  deliver(sessionId, frame) {
    for (const socket of FixtureSocket.all) {
      if (!socket.closed && socket.url.includes(`/hub/session/${sessionId}`)) {
        socket.onmessage?.({ data: JSON.stringify(frame) });
      }
    }
  },
  connections: () => FixtureSocket.all.filter((socket) => !socket.closed).map((socket) => socket.url),
};

async function mount() {
  const backend = createMockBackend({ providerKey: 'verified' });
  const config = await (await fetch('/fixture/config')).json();
  const store = createStore(initialState());
  const adapter = createAdapter({
    store, workspaceId: backend.workspaceId, auth: createAuth('fake'),
    socketFactory: (url) => new FixtureSocket(url),
    fetchImpl: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
      if (url.pathname.endsWith('/bootstrap')) {
        const baseline = await (await backend.fetchImpl(input, init)).json();
        return Response.json({ ...baseline, sessions: config.sessions.map(({ version: _version, ...session }: { version?: number }) => session), heads: { workspace: '0', session: config.head } });
      }
      if (/\/sessions(?:\/|$)|\/events$/.test(url.pathname)) return fetch(url, init);
      return backend.fetchImpl(input, init);
    },
  });
  await adapter.start();
  store.dispatch({ type: 'ui/set', patch: { reduceMotion: true } });
  if (config.activeSessionId && store.getState().activeSessionId !== config.activeSessionId) {
    store.dispatch({ type: 'session/select', id: config.activeSessionId });
    adapter.openSession(config.activeSessionId);
  }
  createRoot(document.getElementById('root')!).render(
    <StoreProvider store={store} adapter={adapter}>
      <HermesMotionProvider reducedMotion>
        <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0, 900px)', height: '100vh' }}>
          <Sidebar />
          <ChatPane narrow={false} active />
        </div>
      </HermesMotionProvider>
    </StoreProvider>,
  );
  window.sessionReliabilityFixture.ready = true;
}

void mount();
