// Queued follow-ups for the current run, with Edit and Remove.
//
// The rows re-render from `run.queue.updated`: an edit or a remove is a REST
// call, and the authoritative list arrives on the socket. The optimistic local
// change is what keeps the interaction instant; the event is what makes it true.
//
// TODO(plan §10b, M3): replace these rows with `TaskRows` from
// `@hermes/motion-components` once the run engine emits per-step rows —
// `rows` from `run.queue.updated`, `blocked` from `run.status waiting`,
// `failed` from `run.status error`, `onRetry(key)` → the retry endpoint.
import { useState } from 'react';
import { useAdapter, useAppState, useDispatch } from '../store-context.js';
import { Glass, Icon } from '../ui/icons.js';
import { Button } from '../ui/primitives.js';
import type { SessionState } from '../../model/store.js';

export function ActivityArea({ session, cancellationOnly = false }: { session: SessionState; cancellationOnly?: boolean }) {
  const dispatch = useDispatch();
  const adapter = useAdapter();
  const state = useAppState();
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const run = session.run;
  const queue = run?.queue ?? [];
  if (!run || queue.length === 0 || run.status === 'completed') return null;
  void state;

  const commitEdit = (id: string): void => {
    dispatch({ type: 'run/queue-edit', sessionId: session.id, id, text });
    void adapter.editQueued(session.id, id, text).catch(() => undefined);
    setEditing(null);
  };

  return (
    <div className="col" style={{ gap: 4, paddingLeft: 40 }}>
      {queue.map((item) => (
        <div className="queue-row" key={item.id}>
          <Glass name="invoice" size={24} className="q-icon" />
          {!cancellationOnly && editing === item.id ? (
            <input
              className="grow"
              aria-label="Edit queued follow-up"
              value={text}
              autoFocus
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitEdit(item.id);
                if (event.key === 'Escape') setEditing(null);
              }}
              style={{ background: 'transparent', border: '1px solid var(--line)', borderRadius: 6, padding: '6px 10px', color: 'inherit' }}
            />
          ) : (
            <div className="q-body">
              <span>{item.text}</span>
              <span className="meta">{item.status === 'paused' ? 'Queue paused · Not started' : 'After this · Queued'}</span>
            </div>
          )}
          {!cancellationOnly && (
            <Button
              link
              onClick={() => {
                setEditing(item.id);
                setText(item.text);
              }}
            >
              Edit
            </Button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label={`Remove queued: ${item.text}`}
            onClick={() => {
              dispatch({ type: 'run/queue-remove', sessionId: session.id, id: item.id });
              void adapter.removeQueued(session.id, item.id).catch(() => undefined);
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
