// `/shared/:token` — the read-only viewer.
//
// Polling only: a share holder gets no socket (plan §7), so this polls every
// 10 s while visible and every 60 s while hidden, with `ETag`/`If-None-Match`
// so an unchanged transcript costs a 304. There is no composer, no Send, no
// Stop, no decision control and no context edit — not disabled versions of
// them, absent ones.
import { useEffect, useRef, useState } from 'react';
import type { Message, SharedSession } from '@hermes/shared';
import { createRest, type FetchLike } from '../../model/rest.js';
import { createAuth } from '../../model/auth.js';
import { Glass } from '../ui/icons.js';
import { EmptyState, Skeleton } from '../ui/primitives.js';
import { EMPTY } from '../../model/constants.js';

const VISIBLE_MS = 10_000;
const HIDDEN_MS = 60_000;

export function SharedViewer({ token, fetchImpl }: { token: string; fetchImpl?: FetchLike }) {
  const [data, setData] = useState<SharedSession | null>(null);
  const [gone, setGone] = useState(false);
  const etag = useRef<string | null>(null);
  const rest = useRef(createRest({ auth: createAuth(), ...(fetchImpl ? { fetchImpl } : {}) }));

  useEffect(() => {
    let cancelled = false;
    let handle: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      try {
        const next = await rest.current.sharedSession(token, etag.current);
        if (cancelled) return;
        if (next.revoked) {
          setGone(true);
          return;
        }
        setData(next);
      } catch (error) {
        const status = (error as { status?: number }).status;
        // 404 and 410 are the revoked/expired answers; anything else is
        // transient and the next tick tries again.
        if (status === 404 || status === 410) {
          if (!cancelled) setGone(true);
          return;
        }
      }
      if (!cancelled) handle = setTimeout(() => void poll(), document.hidden ? HIDDEN_MS : VISIBLE_MS);
    };

    void poll();
    const onVisibility = (): void => {
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      if (handle) clearTimeout(handle);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [token]);

  if (gone) {
    return (
      <div className="shared-viewer">
        <EmptyState icon="context" title={EMPTY.shareGone} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="shared-viewer">
        <Skeleton rows={4} label="Loading the shared session" />
      </div>
    );
  }

  return (
    <div className="shared-viewer">
      <header className="shared-header">
        <Glass name="iris" size={28} />
        <div className="col" style={{ gap: 2 }}>
          <span className="p-title">{data.session.title}</span>
          <span className="p-meta">
            {data.session.workspace_name} · Read only · {data.messages.length} message{data.messages.length === 1 ? '' : 's'}
          </span>
        </div>
      </header>
      <div className="scroll">
        <div className="transcript" role="log" aria-label={`Shared session: ${data.session.title}`}>
          {data.messages.map((message: Message) =>
            message.role === 'user' ? (
              <div key={message.id} className="msg-user">
                {message.text}
              </div>
            ) : (
              <div key={message.id} className="msg-iris">
                <div className="lead">
                  <Glass name="iris" size={26} className="mark" />
                  <div className="grow col" style={{ gap: 8 }}>
                    {message.heading && <div className="heading">{message.heading}</div>}
                    <span className="lead-text">{message.text}</span>
                  </div>
                </div>
              </div>
            ),
          )}
        </div>
      </div>
      <footer className="shared-footer">
        <span className="meta">This is a read-only view. Referenced objects open only for signed-in members.</span>
      </footer>
    </div>
  );
}
