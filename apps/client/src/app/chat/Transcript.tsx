// The transcript. The find-in-session highlighting and the message shapes are
// the demo's; the streaming text and the scroll model are not.
//
// The demo's `Reveal` animated text that was already complete. It is deleted:
// `RunSurface` now renders the *actual* accumulator that `message.delta` fills,
// so nothing animates that the server did not send (plan §10b: every animated
// state is driven by a server event). When a turn is between events,
// `LoadingState` shows the active step's own label — no invented duration.
//
// ## The scroll model (decision C38)
//
// Three positions, and only three:
//
//   send      the new user message's top goes to the top of the viewport, and
//             the reply streams into the space beneath it. This is ChatGPT's
//             arrangement, reached the way ChatGPT reaches it: a spacer at the
//             end of the transcript, sized so that "the anchor at the top" and
//             "scrolled to the bottom" are the same scrollTop until the reply
//             outgrows the viewport.
//   streaming pinned to the bottom *only* if the reader was already at the
//             bottom (96 px). A reader who scrolled up keeps their position and
//             gets the Jump to latest chip, which is the convention every chat
//             client in this class has converged on.
//   switch    the remembered scrollTop for the session being opened.
//
// Nothing else moves the viewport. `message.final`, a step row, a receipt and a
// queue row all land wherever they land: they are the tail of a reply the
// reader is already reading, and a client that jumps on each one is a client
// that cannot be read while it works.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { parseBotModeAgentMessage, type Message, type RequestEntity } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch } from '../store-context.js';
import { Block, ReceiptBlock } from './Blocks.js';
import { IrisText } from './IrisText.js';
import { ResponseFooter } from './ResponseFooter.js';
import { ActivityArea } from './ActivityArea.js';
import { RunActivity, RunStream } from './RunSurface.js';
import { canReleaseRunStream, collapseHistoricalMessages, partitionRunMessages } from './message-groups.js';
import { Glass } from '../ui/icons.js';
import { Avatar, Button, Chip, IrisMark } from '../ui/primitives.js';
import { agentName } from '../selectors.js';
import { EMPTY } from '../../model/constants.js';
import type { SessionState } from '../../model/store.js';

/**
 * "At the bottom", in pixels.
 *
 * The demo's number, kept. It is the standard tolerance in this class of UI —
 * `use-stick-to-bottom`, the implementation the AI SDK's `<Conversation>` is
 * built on, discusses the same knob at about 70 px — and it has to be larger
 * than one line so that a reader sitting at the bottom of a streaming reply is
 * not un-pinned by the line that arrives underneath them.
 */
const NEAR_BOTTOM = 96;

/** `CSS.escape`, with a fallback for the attribute-selector case. */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

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

export function Transcript({ session, find, readOnly = false }: { session: SessionState; find: FindSpec | null; readOnly?: boolean }) {
  const state = useAppState();
  const dispatch = useDispatch();
  const adapter = useAdapter();
  const reduce = useReducedMotion() ?? false;
  const agent = readOnly ? 'Session history' : agentName(state);
  const messages = session.pendingTurn ? [...session.messages, session.pendingTurn.message] : session.messages;
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const lastCount = useRef(messages.length);
  const lastMessageId = messages.at(-1)?.id ?? null;
  const nearBottom = useRef(true);
  /** The user message the send-scroll parked at the top, while it is still the last one. */
  const anchorId = useRef<string | null>(null);

  const measure = (): boolean => {
    const el = ref.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
  };

  /**
   * Size the tail spacer so the anchor can reach the top of the viewport.
   *
   * The spacer is exactly the shortfall: the viewport height less everything
   * that comes after the anchor's top edge. While a reply is short that makes
   * the bottom of the scroll range the position where the anchor sits at the
   * top — one position, not two — so "pinned to the bottom" and "the question
   * at the top" are the same thing and neither fights the other. Once the reply
   * is taller than the viewport the shortfall is zero, the spacer disappears,
   * and a pinned reader follows the text down exactly as before.
   *
   * Written to the DOM rather than to state on purpose: this runs on every
   * delta, and a state round trip would mean one frame rendered at the old
   * height — a flicker on every token.
   */
  const sizeSpacer = useCallback((): void => {
    const el = ref.current;
    const spacer = spacerRef.current;
    const content = contentRef.current;
    if (!el || !spacer || !content) return;
    const id = anchorId.current;
    const anchor = id ? content.querySelector<HTMLElement>(`[data-message-id="${cssEscape(id)}"]`) : null;
    if (!anchor) {
      spacer.style.height = '0px';
      return;
    }
    // Twice, and the second pass is not superstition. The first pass measures
    // `scrollHeight` while React is still committing the rest of the turn — the
    // run surface's own first frame lands in the same commit — so its answer is
    // one layout behind, and the first *painted* frame is short by exactly the
    // transcript's top padding. The second pass measures the layout the first
    // one produced, which is the one that is about to be painted. It is a fixed
    // point, so a third pass would change nothing.
    // "The top of the viewport" is the top of the transcript's own content
    // inset, not the scroll container's border edge. The first message of a
    // session cannot reach the border — the padding is above it — so anchoring
    // later ones flush against it would put the same message in two different
    // places depending on where it was in the conversation, and the flush one
    // reads as clipped by the subheader, which is the screenshot this began
    // with. One inset, every time.
    const inset = Number.parseFloat(getComputedStyle(content).paddingTop) || 0;
    for (let pass = 0; pass < 2; pass += 1) {
      const current = spacer.offsetHeight;
      const anchorTop = anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const target = Math.max(0, anchorTop - inset);
      const after = el.scrollHeight - current - target;
      spacer.style.height = `${Math.max(0, Math.round(el.clientHeight - after))}px`;
    }
  }, []);

  const toBottom = useCallback((): void => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    nearBottom.current = true;
    setAway(false);
  }, []);

  // Session switch: the remembered position, exactly as the demo restored it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    anchorId.current = null;
    sizeSpacer();
    el.scrollTop = session.scrollTop ?? el.scrollHeight;
    nearBottom.current = measure();
    setAway(!nearBottom.current);
    lastCount.current = messages.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // A new message. A *user* message is a send, and a send re-anchors; anything
  // else only moves the viewport if the reader was already at the bottom.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    if (messages.length === lastCount.current) {
      // Admission replaces the local message id with the durable one without
      // changing the list length. Keep the send anchor attached to that same
      // question instead of letting the tail spacer lose its target.
      if (last?.role === 'user' && anchorId.current && anchorId.current !== last.id) {
        anchorId.current = last.id;
        sizeSpacer();
        toBottom();
      }
      return;
    }
    lastCount.current = messages.length;
    if (last?.role === 'user') {
      anchorId.current = last.id;
      sizeSpacer();
      toBottom();
      return;
    }
    if (nearBottom.current) {
      sizeSpacer();
      toBottom();
    } else setAway(true);
  }, [messages.length, lastMessageId, sizeSpacer, toBottom]);

  // Every delta, every step row, every queue row: re-size the spacer, and
  // follow only if the reader is at the bottom. `run` and `stream` are named in
  // the dependency list rather than the whole session, so a rename or a draft
  // keystroke does not re-run it.
  useLayoutEffect(() => {
    sizeSpacer();
    if (nearBottom.current) {
      const el = ref.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [session.stream?.text, session.run?.steps, session.run?.status, session.run?.queue, sizeSpacer]);

  // The composer autosizes to 132 px, the pane resizes, and a reply's own
  // images and tables settle a frame late. Any of those changes what "the
  // bottom" is, so the spacer is re-measured from the elements themselves
  // rather than from a render.
  useEffect(() => {
    const el = ref.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      sizeSpacer();
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, [sizeSpacer]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    nearBottom.current = measure();
    if (nearBottom.current) setAway(false);
    else setAway(true);
    dispatch({ type: 'session/scroll', id: session.id, scrollTop: el.scrollTop });
  }, [dispatch, session.id]);

  useFind(ref, find, reduce, [messages.length, session.stream?.text]);

  // The messages this run produced are rendered *after* the activity block and
  // the rest before it, so a finished turn reads trace-then-answer exactly as a
  // streaming one does. With no run in progress `during` is empty and the split
  // costs a filter over a list that is already in memory.
  //
  // "This run's messages" means the *trailing* ones, not every message carrying
  // the id. A completed run's replies stop being the tail the moment the next
  // question is typed, and a filter over the whole list would then lift them
  // below the new question — which is history reordering itself, and it carried
  // the reader past their own question because everything it moved counted as
  // "after the anchor".
  const runId = session.run?.id ?? null;
  const split = ((): number => {
    if (!runId) return messages.length;
    let index = messages.length;
    while (index > 0 && messages[index - 1]!.run_id === runId && messages[index - 1]!.role === 'iris') index -= 1;
    return index;
  })();
  const before = collapseHistoricalMessages(split === messages.length ? messages : messages.slice(0, split));
  const during = split === messages.length ? [] : messages.slice(split);
  const settled = Boolean(session.run && ['completed', 'stopped', 'error'].includes(session.run.status));
  const currentRunMessages = partitionRunMessages(during, settled, settled ? session.run?.active_ms : null);
  const streamOwnsAnswer = Boolean(currentRunMessages.answer && session.stream?.runId === currentRunMessages.answer.run_id);
  const streamCanRelease = canReleaseRunStream(
    session.stream,
    currentRunMessages.answer ? [...before, currentRunMessages.answer] : before,
  );

  const lastIris = [...messages].reverse().find((m) => m.role === 'iris' && m.status !== 'streaming');
  const followUps = lastIris?.follow_ups ?? [];
  const showChips = !readOnly && (!session.run || session.run.status === 'completed');
  const showWelcome = messages.length === 0 && !session.stream && !session.carried;
  const fill = (text: string): void => {
    dispatch({ type: 'session/draft', id: session.id, text });
    document.getElementById(`composer-${session.id}`)?.focus();
  };

  return (
    <div className="transcript-wrap">
      <div className="scroll" ref={ref} onScroll={onScroll} aria-live="polite" aria-relevant="additions">
        <div className={`transcript${showWelcome ? ' transcript-empty' : ''}`} role="log" aria-label={readOnly ? 'Historical session messages' : `Conversation with ${agent}`} ref={contentRef}>
          {session.hasEarlier && messages.length > 0 && (
            <div className="row" style={{ justifyContent: 'center', padding: '8px 0' }}>
              <Button small onClick={() => void adapter.loadEarlier(session.id)}>
                Load earlier
              </Button>
            </div>
          )}

          {showWelcome && (
            <div className="chat-welcome">
              {readOnly ? <Glass name="loop" size={48} className="mark" /> : <IrisMark size={48} className="mark" />}
              <p>{readOnly ? 'No messages were stored for this session.' : EMPTY.chatReady(agent)}</p>
            </div>
          )}

          {messages.length === 0 && !session.stream && session.carried && (
            <div className="empty-session">
              <div className="lead">
                <IrisMark size={26} className="mark" />
                <span>
                  {`Continuing from “${session.carried.from}”. Reviewed context carried: ${session.carried.context}.`}
                </span>
              </div>
              <div className="meta" style={{ paddingLeft: 40 }}>
                No completed actions were replayed.
              </div>
            </div>
          )}

          {before.map((message) =>
            message.role === 'user' ? (
              <UserMessage key={message.id} message={message} />
            ) : message.role === 'human' ? (
              <div key={message.id} className="msg-human" data-message-id={message.id}>
                <Avatar person={{ name: state.user.name }} size={24} />
                <span>{message.text}</span>
              </div>
            ) : (
              <IrisMessage key={message.id} message={message} session={session} />
            ),
          )}

          {/* One activity surface owns every internal provider turn. Model
              progress and tool work never become duplicate answer bubbles. */}
          <RunActivity session={session} progress={currentRunMessages.progress} readOnly={readOnly} />

          {/* A run has one answer, even when tools required several provider
              turns to produce it. */}
          {currentRunMessages.answer && !streamOwnsAnswer && <IrisMessage message={currentRunMessages.answer} session={session} />}

          {/* And the text that has not finalised yet. */}
          <RunStream session={session} canRelease={streamCanRelease} />

          {/* The queue's own Edit and Remove. TaskRows renders the rows; it has
              no affordance for changing one, and a queued follow-up a person
              cannot correct is a queued follow-up they will not use. */}
          <ActivityArea session={session} cancellationOnly={readOnly} />

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
        {/* The tail spacer. Sized by `sizeSpacer`, never by a style prop, and
            outside `.transcript` so the flex gap does not add 24 px to a
            measurement the arithmetic above depends on. `aria-hidden` because
            it is geometry, and `role="log"` above would otherwise announce it. */}
        <div className="transcript-spacer" ref={spacerRef} aria-hidden="true" />
      </div>
      {readOnly && session.run && (session.run.status === 'working' || session.run.status === 'waiting') && (
        <div className="status-bar session-history-controls" role="status">
          <span>{session.run.status === 'working' ? 'Historical run is still working' : 'Historical run is waiting'}</span>
          <span className="grow" />
          <Button onClick={() => void adapter.stop(session.id).catch(() => undefined)} aria-label="Stop work">
            Stop work
          </Button>
        </div>
      )}
      {/* Outside the scroll region, as the demo had it: a chip inside it would
          scroll away from the reader who needs it. */}
      {away && (
        <div className="jump-latest">
          <Button
            small
            onClick={() => {
              const el = ref.current;
              if (!el) return;
              // The one deliberate, human-initiated move in the whole file, so
              // the one place a smooth scroll earns its keep — and the one
              // place `prefers-reduced-motion` has anything to switch off.
              el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
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

function UserMessage({ message }: { message: Message }) {
  const bot = parseBotModeAgentMessage(message.text);
  if (bot) {
    return (
      <details className="msg-agent-handoff" data-message-id={message.id}>
        <summary>
          <span>Message from</span>
          <strong>{bot.display}</strong>
          {bot.profile && <code>@{bot.profile}</code>}
        </summary>
        <div className="msg-agent-handoff-body">{bot.body}</div>
      </details>
    );
  }
  return (
    <div className="msg-user" data-message-id={message.id}>
      {message.text}
      {message.kind === 'guidance' ? <div className="meta">
        {message.status === 'complete' ? 'Guidance applied' : message.status === 'streaming'
          ? message.run_id ? 'Guidance queued' : 'Queued for next message'
          : 'Guidance incomplete'}
      </div> : null}
      {message.attachments?.length ? (
        <span className="att">
          {message.attachments.map((attachment) => <Chip key={attachment.id}>{attachment.label}</Chip>)}
        </span>
      ) : null}
    </div>
  );
}

function IrisMessage({ message, session }: { message: Message; session: SessionState }) {
  const adapter = useAdapter();
  const state = useAppState();
  const [retryError, setRetryError] = useState<string | null>(null);
  const requests = Object.values(state.entities.request)
    .map((record) => record.data as RequestEntity | null)
    .filter((request): request is RequestEntity => request !== null);
  const receipts = receiptIdsForMessage(message, requests);
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
          <IrisText text={message.text} className={`lead-text ${small ? 'small' : ''}`} />
        </div>
      </div>
      {message.blocks.length > 0 && (
        <div className="blocks" style={{ paddingLeft: 40 }}>
          {message.blocks.map((block, index) => (
            <Block key={index} block={block} sessionId={session.id} message={message} />
          ))}
        </div>
      )}
      {receipts.length > 0 && (
        <div className="blocks" style={{ paddingLeft: 40 }} aria-label="Requests prepared by this response">
          {receipts.map((requestId) => <ReceiptBlock key={requestId} requestId={requestId} />)}
        </div>
      )}
      {(message.incomplete || message.status === 'incomplete') && (
        <div className="incomplete-footer" role="status" style={{ paddingLeft: 40 }}>
          <span>{EMPTY.incomplete}</span>
          {(session.run?.id !== message.run_id || (session.run.status !== 'working' && session.run.status !== 'completed' && session.run.error?.retryable !== false)) && <Button
            small
            onClick={() => {
              setRetryError(null);
              if (message.run_id) void adapter.retry(session.id, message.run_id).catch(() => setRetryError('Could not retry this response. Check the selected model and try again.'));
            }}
          >
            Retry
          </Button>}
          {retryError && <span role="alert">{retryError}</span>}
        </div>
      )}
      {message.worked_ms != null && <ResponseFooter message={message} session={session} workspaceId={state.workspace.id} />}
    </div>
  );
}

/** A created request belongs beside the answer that prepared it. */
export function receiptIdsForMessage(message: Message, requests: readonly RequestEntity[]): string[] {
  if (!message.run_id) return [];
  const explicit = new Set(
    message.blocks
      .filter((block) => block.type === 'receipt')
      .map((block) => String((block as { requestId?: string; request_id?: string }).requestId ?? (block as { request_id?: string }).request_id ?? block.command?.id ?? '')),
  );
  return requests
    .filter((request) => request.run_id === message.run_id && !explicit.has(request.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((request) => request.id);
}
