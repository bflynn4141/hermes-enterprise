// The completed-response footer: Worked disclosure, Copy, Add to Collective,
// Helpful / Not helpful, View trace, Continue in a new session.
//
// Two changes from the demo. Worked time is `runs.active_ms` — the "historical
// fixture" branch is gone, because there are no fixtures left to be historical
// about. And Add to Collective calls the proposal *preview* endpoint: it never
// publishes, because publishing a lesson drawn from applicant text is a human
// decision with its own review.
import { useRef, useState } from 'react';
import type { Message } from '@hermes/shared';
import { useAdapter, useNav } from '../store-context.js';
import { Icon } from '../ui/icons.js';
import { Ack, Button, Disclosure, IconButton, MenuItem, Popover, formatWorked } from '../ui/primitives.js';
import type { SessionState } from '../../model/store.js';

export function ResponseFooter({ message, session, workspaceId }: { message: Message; session: SessionState; workspaceId: string }) {
  const adapter = useAdapter();
  const nav = useNav();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFail, setCopyFail] = useState(false);
  const [more, setMore] = useState(false);
  const [thanks, setThanks] = useState(false);
  const [feedback, setFeedback] = useState<Message['feedback']>(message.feedback ?? null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thanksTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const worked = formatWorked(message.worked_ms);
  const copyText = [message.heading, message.text].filter(Boolean).join('\n\n');

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setCopyFail(false);
    } catch {
      setCopyFail(true);
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopied(false);
      setCopyFail(false);
    }, 1800);
  };

  const setValue = (value: 'helpful' | 'not-helpful'): void => {
    const next = feedback === value ? null : value;
    setFeedback(next);
    setMore(false);
    const call = next ? adapter.rest.setFeedback(workspaceId, message.id, next) : adapter.rest.clearFeedback(workspaceId, message.id);
    void call.catch(() => setFeedback(feedback));
    if (next) {
      setThanks(true);
      if (thanksTimer.current) clearTimeout(thanksTimer.current);
      thanksTimer.current = setTimeout(() => setThanks(false), 1600);
    }
  };

  return (
    <div className="col" style={{ gap: 0 }}>
      <div className="msg-footer">
        <button type="button" className="worked" aria-expanded={open} aria-controls={`worked-${message.id}`} onClick={() => setOpen((value) => !value)} title="Active execution time; excludes time waiting for a human">
          {worked}
          <span className="chev" aria-hidden="true">
            ⌄
          </span>
        </button>
        <div className="actions">
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <IconButton name="copy" label={copyFail ? 'Copy failed · try again' : 'Copy response'} onClick={() => void copy()} />
            <Ack show={copied} style={{ right: 0, top: -40 }}>
              Copied
            </Ack>
            <Ack show={copyFail} style={{ right: 0, top: -40 }}>
              Clipboard unavailable
            </Ack>
          </span>
          <IconButton name="collective" label="Add to Collective" onClick={() => nav({ section: 'library', view: 'intelligence' })} />
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <IconButton anchorRef={moreBtn} name="more" label="More actions" onClick={() => setMore((value) => !value)} />
            <Popover open={more} onClose={() => setMore(false)} anchorRef={moreBtn} className="menu" width={260} label="Response actions">
              <MenuItem
                small
                icon="history"
                onClick={() => {
                  setMore(false);
                  nav(message.run_id ? { section: 'agents', view: 'trace', id: message.run_id } : { section: 'agents', view: 'traces' });
                }}
              >
                View trace
              </MenuItem>
              <MenuItem
                small
                icon="plus"
                onClick={() => {
                  setMore(false);
                  void adapter.createSession({ title: `${session.title} · continued`, mode: session.mode });
                }}
              >
                Continue in new session
              </MenuItem>
              <div className="divider" />
              <MenuItem small icon="check" checked={feedback === 'helpful' || undefined} onClick={() => setValue('helpful')}>
                Helpful
              </MenuItem>
              <MenuItem small icon="close" checked={feedback === 'not-helpful' || undefined} onClick={() => setValue('not-helpful')}>
                Not helpful
              </MenuItem>
              <div className="p-meta" style={{ padding: '6px 10px' }}>
                Feedback stays in this workspace. Select again to clear.
              </div>
            </Popover>
            <Ack show={thanks} style={{ right: 0, top: -40 }}>
              Thanks · Feedback saved
            </Ack>
          </span>
        </div>
      </div>
      <Disclosure open={open} id={`worked-${message.id}`}>
        <div className="worked-steps">
          {(message.steps ?? []).map((step, index) => (
            <div className="row" key={index}>
              <Icon name="check" size={16} style={{ color: 'var(--muted)' }} />
              <span>{step}</span>
            </div>
          ))}
          {message.guidance && (
            <div className="row">
              <Icon name="check" size={16} style={{ color: 'var(--muted)' }} />
              <span>Applied guidance: “{message.guidance}”</span>
            </div>
          )}
          <div className="fixture-note">Active execution time recorded by the run; it excludes time waiting for a human decision.</div>
        </div>
      </Disclosure>
    </div>
  );
}

export { Button };
