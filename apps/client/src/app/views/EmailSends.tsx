// An approved email whose send Hermes could not confirm (Quest audit H1). The
// provider may or may not have delivered it, so Hermes never retries by
// itself. A reviewer checks the mailbox and says what happened: "It was sent"
// records it; "It wasn't sent" reopens the email for a fresh approval, and
// nothing goes out until that lands.
import { useEffect, useState } from 'react';
import type { EmailSend, EmailSendList } from '@hermes/shared';
import { useAdapter, useAppState } from '../store-context.js';
import { Button, Item, StatusDot } from '../ui/primitives.js';
import { RestError } from '../../model/rest.js';

const when = (value: string): string =>
  new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function settledLine(send: EmailSend): string | null {
  if (!send.settled) return null;
  const who = send.settled.by_name ?? 'A reviewer';
  return send.settled.outcome === 'sent'
    ? `${who} confirmed it was sent · ${when(send.settled.at)}`
    : `${who} confirmed it wasn’t sent · ${when(send.settled.at)}`;
}

function settleError(caught: unknown): string {
  const reason = (caught as { reason?: string }).reason;
  if (reason === 'reauth_required') return 'Sign in again, then answer. Nothing was recorded.';
  if (reason === 'email_send_settle_forbidden') return 'Only a reviewer of this email or an Admin can answer this.';
  if (reason === 'email_send_not_uncertain') return 'Someone already answered this. Showing the latest.';
  return 'Could not record your answer. Try again.';
}

/**
 * Renders nothing unless this approval has a send a person settled or must
 * settle. `version` re-reads the list when the approval changes.
 */
export function EmailSends({ requestId, version, onSettled }: { requestId: string; version: string; onSettled: () => Promise<void> }) {
  const adapter = useAdapter();
  const state = useAppState();
  const [list, setList] = useState<EmailSendList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void adapter.rest.getEmailSends(state.workspace.id, requestId).then(
      (loaded) => { if (live) setList(loaded); },
      () => undefined,
    );
    return () => { live = false; };
  }, [adapter, state.workspace.id, requestId, version]);

  const shown = list?.sends.filter((send) => send.state === 'ambiguous' || send.settled !== null) ?? [];
  if (!list || shown.length === 0) return null;

  const settle = async (send: EmailSend, outcome: 'sent' | 'not_sent'): Promise<void> => {
    setBusy(send.id);
    setError(null);
    try {
      setList(await adapter.rest.settleEmailSend(state.workspace.id, requestId, send.id, {
        outcome, idempotency_key: `settle:${send.id}:${crypto.randomUUID()}`,
      }));
      await onSettled();
    } catch (caught) {
      setError(settleError(caught));
      if (!(caught instanceof RestError && caught.reauthRequired)) {
        await adapter.rest.getEmailSends(state.workspace.id, requestId).then(setList, () => undefined);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="email-sends" aria-labelledby="email-sends-heading">
      <h2 className="section-title" id="email-sends-heading">Did the email go out?</h2>
      {shown.map((send) => {
        const uncertain = send.state === 'ambiguous';
        return (
          <Item
            key={send.id}
            media={<StatusDot tone={uncertain ? 'warn' : send.settled?.outcome === 'sent' ? 'ok' : 'muted'} hint={uncertain ? 'Not confirmed' : 'Settled'} />}
            title={uncertain ? `${send.recipient_name || send.recipient_address} may or may not have received it` : send.recipient_name || send.recipient_address}
            description={uncertain
              ? (list.can_settle
                ? `The send was interrupted before the provider answered. Check the Sent folder of ${send.sender_address}. “It wasn’t sent” sends nothing: the email goes back for approval first.`
                : `The send was interrupted before the provider answered. Waiting for a reviewer to check the Sent folder of ${send.sender_address}.`)
              : settledLine(send)}
            actions={uncertain && list.can_settle ? <>
              <Button disabled={busy !== null} onClick={() => void settle(send, 'not_sent')}>It wasn’t sent</Button>
              <Button primary disabled={busy !== null} onClick={() => void settle(send, 'sent')}>{busy === send.id ? 'Recording…' : 'It was sent'}</Button>
            </> : undefined}
          />
        );
      })}
      {error && <p className="meta" role="alert">{error}</p>}
    </section>
  );
}
