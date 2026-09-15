// The transcript. Scroll behaviour, the find-in-session highlighting and the
// message shapes are the demo's; the streaming text is not.
//
// The demo's `Reveal` animated text that was already complete. It is deleted:
// `StreamingText` from `@hermes/motion-components` now renders the *actual*
// accumulator that `message.delta` fills, with `loop={false}` so nothing
// animates that the server did not send (plan §10b: every animated state is
// driven by a server event). When a turn is between events, `LoadingState`
// shows the active step's own label — no invented duration.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { StreamingText } from '@hermes/motion-components';
import type { Message } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch } from '../store-context.js';
import { Block } from './Blocks.js';
import { ResponseFooter } from './ResponseFooter.js';
import { ActivityArea } from './ActivityArea.js';
import { RunSurface } from './RunSurface.js';
import { Glass } from '../ui/icons.js';
import { Avatar, Button, Chip, IrisMark } from '../ui/primitives.js';
import { agentName } from '../selectors.js';
import { EMPTY } from '../../model/constants.js';
import type { SessionState } from '../../model/store.js';

interface FindSpec {
  query: string;
  index: number;
  onCount: (n: number) => void;
}

/**
 * Find-in-session paints matches with the CSS Custom Highlight API rather than
 * rewriting the DOM, so a match inside a streaming message does not fight the
 * stream. Browsers without the API still get the current message marked.
 */
function useFind(ref: React.RefObject<HTMLDivElement | null>, find: FindSpec | null, reduce: boolean, deps: unknown[]): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const api = typeof CSS !== 'undefined' && 'highlights' in CSS ? (CSS as unknown as { highlights: Map<string, unknown> & { set(k: string, v: unknown): void; delete(k: string): void } }).highlights : null;
    root.querySelectorAll('[data-find]').forEach((el) => el.removeAttribute('data-find'));
    if (!find?.query) {
      api?.delete('find-match');
      api?.delete('find-current');
      return;
    }
    const query = find.query.toLowerCase();
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement?.closest('.suggestions, [aria-hidden="true"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let node = walker.nextNode() as Text | null;
    while (node) {
      const text = node.data.toLowerCase();
      let index = text.indexOf(query);
      while (index !== -1) {
        const range = new Range();
        range.setStart(node, index);
        range.setEnd(node, index + query.length);
        ranges.push(range);
        index = text.indexOf(query, index + query.length);
      }
      node = walker.nextNode() as Text | null;
    }
    find.onCount(ranges.length);
    const current = ranges.length ? ranges[((find.index % ranges.length) + ranges.length) % ranges.length]! : null;
    const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (api && HighlightCtor) {
      api.set('find-match', new HighlightCtor(...ranges));
      api.set('find-current', current ? new HighlightCtor(current) : new HighlightCtor());
    }
    if (current) {
      const el = current.startContainer.parentElement;
      el?.closest('[data-message-id]')?.setAttribute('data-find', 'current');
      el?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    }
    return () => {
      api?.delete('find-match');
      api?.delete('find-current');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find?.query, find?.index, ...deps]);
}

export function Transcript({ session, find }: { session: SessionState; find: FindSpec | null }) {
  const state = useAppState();
  const dispatch = useDispatch();
  const adapter = useAdapter();
  const reduce = useReducedMotion() ?? false;
  const agent = agentName(state);
  const ref = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const lastCount = useRef(session.messages.length);
  const nearBottom = useRef(true);

  const measure = (): boolean => {
    const el = ref.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = session.scrollTop ?? el.scrollHeight;
    nearBottom.current = measure();
    setAway(!nearBottom.current);
    lastCount.current = session.messages.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (session.messages.length !== lastCount.current) {
      const last = session.messages[session.messages.length - 1];
      if (last?.role === 'user' || nearBottom.current) {
        el.scrollTop = el.scrollHeight;
        nearBottom.current = true;
        setAway(false);
      } else setAway(true);
      lastCount.current = session.messages.length;
    }
  }, [session.messages.length]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    nearBottom.current = measure();
    if (nearBottom.current) setAway(false);
    dispatch({ type: 'session/scroll', id: session.id, scrollTop: el.scrollTop });
  }, [dispatch, session.id]);

  useFind(ref, find, reduce, [session.messages.length, session.stream?.text]);

  const lastIris = [...session.messages].reverse().find((m) => m.role === 'iris' && m.status !== 'streaming');
  const followUps = lastIris?.follow_ups ?? [];
  const showChips = !session.run || session.run.status === 'completed';
  const fill = (text: string): void => {
    dispatch({ type: 'session/draft', id: session.id, text });
    document.getElementById(`composer-${session.id}`)?.focus();
  };

  return (
    <div className="transcript-wrap">
      <div className="scroll" ref={ref} onScroll={onScroll} aria-live="polite" aria-relevant="additions">
        <div className="transcript" role="log" aria-label={`Conversation with ${agent}`}>
          {session.hasEarlier && session.messages.length > 0 && (
            <div className="row" style={{ justifyContent: 'center', padding: '8px 0' }}>
              <Button small onClick={() => void adapter.loadEarlier(session.id)}>
                Load earlier
              </Button>
            </div>
          )}

          {session.messages.length === 0 && !session.stream && (
            <div className="empty-session">
              <div className="lead">
                <IrisMark size={26} className="mark" />
                <span>
                  {session.carried
                    ? `Continuing from “${session.carried.from}”. Reviewed context carried: ${session.carried.context}.`
                    : EMPTY.chatReady(agent)}
                </span>
              </div>
              <div className="meta" style={{ paddingLeft: 40 }}>
                {session.carried ? 'No completed actions were replayed.' : 'Open a conversation or start a new one.'}
              </div>
            </div>
          )}

          {session.messages.map((message) =>
            message.role === 'user' ? (
              <div key={message.id} className="msg-user" data-message-id={message.id}>
                {message.text}
                {message.attachments?.length ? (
                  <span className="att">
                    {message.attachments.map((a) => (
                      <Chip key={a.id}>{a.label}</Chip>
                    ))}
                  </span>
                ) : null}
              </div>
            ) : message.role === 'human' ? (
              <div key={message.id} className="msg-human" data-message-id={message.id}>
                <Avatar person={{ name: state.user.name }} size={24} />
                <span>{message.text}</span>
              </div>
            ) : (
              <IrisMessage key={message.id} message={message} session={session} />
            ),
          )}

          {/* Every live state of a run, in one place: LoadingState before the
              first delta, ThinkingState over the step rows, ToolChips per tool
              call, StreamingText for the deltas, TaskRows for the queue. */}
          <RunSurface session={session} />

          {/* The queue's own Edit and Remove. TaskRows renders the rows; it has
              no affordance for changing one, and a queued follow-up a person
              cannot correct is a queued follow-up they will not use. */}
          <ActivityArea session={session} />

          {showChips && followUps.length > 0 && (
            <div className="suggestions" aria-label="Suggested prompts">
              {followUps.map((prompt) => (
                <button type="button" key={prompt} className="suggestion" onClick={() => fill(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {away && (
        <div className="jump-latest">
          <Button
            small
            onClick={() => {
              const el = ref.current;
              if (!el) return;
              el.scrollTop = el.scrollHeight;
              nearBottom.current = true;
              setAway(false);
            }}
          >
            Jump to latest ↓
          </Button>
        </div>
      )}
    </div>
  );
}

function IrisMessage({ message, session }: { message: Message; session: SessionState }) {
  const adapter = useAdapter();
  const state = useAppState();
  const small = message.kind === 'ack' || message.kind === 'progress' || (!message.worked_ms && !message.heading && message.blocks.length === 0);
  const statusOnly = message.kind === 'guidance' || (message.kind === 'steps' && !message.text);
  if (statusOnly) {
    return (
      <div className="msg-iris msg-status" data-message-id={message.id}>
        <div className="blocks" style={{ paddingLeft: 40 }}>
          {message.blocks.map((block, index) => (
            <Block key={index} block={block} sessionId={session.id} message={message} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="msg-iris" data-message-id={message.id}>
      <div className="lead">
        <Glass name="iris" size={26} className="mark" />
        <div className="grow col" style={{ gap: 8 }}>
          {message.heading && <div className="heading">{message.heading}</div>}
          <span className={`lead-text ${small ? 'small' : ''}`}>{message.text}</span>
        </div>
      </div>
      {message.blocks.length > 0 && (
        <div className="blocks" style={{ paddingLeft: 40 }}>
          {message.blocks.map((block, index) => (
            <Block key={index} block={block} sessionId={session.id} message={message} />
          ))}
        </div>
      )}
      {message.incomplete && (
        <div className="incomplete-footer" role="status" style={{ paddingLeft: 40 }}>
          <span>{EMPTY.incomplete}</span>
          <Button
            small
            onClick={() => {
              if (message.run_id) void adapter.retry(session.id, message.run_id);
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {message.worked_ms != null && <ResponseFooter message={message} session={session} workspaceId={state.workspace.id} />}
    </div>
  );
}
