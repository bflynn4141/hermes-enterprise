// A received email, the way a reviewer should see it (decision C98).
//
// The server already rebuilt the HTML from an allowlist: no scripts, no
// styles blocks, no remote images and no link targets. This view adds the
// second wall. The body renders inside an iframe with an empty sandbox (no
// scripts, no forms, no navigation, no popups) and a Content Security Policy
// that allows no network request at all, only inline images the server
// embedded. `allow-same-origin` is granted only so the page can measure the
// document's height; without `allow-scripts` nothing inside can use it.
//
// Above the body sit the facts the server checked, in words. Nothing here is
// the agent's opinion: the agent's suggestion is shown separately, below.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EmailWarning, InboundEmailView, SenderFacts } from '@hermes/shared';
import { Icon } from '../ui/icons.js';
import './email-message.css';

const RELATIONSHIP: Record<SenderFacts['relationship'], string> = {
  internal: 'Member of this workspace',
  known_contact: 'Known contact',
  new_sender: 'First email from this sender',
};

/** One line on whether the sender's domain vouched for this message. */
export function authenticationLine(facts: SenderFacts): { verified: boolean; text: string } {
  const { dmarc, spf, dkim } = facts.authentication;
  if (dmarc === 'pass') return { verified: true, text: `Sent from ${facts.domain}, verified by the domain` };
  if (dmarc === 'unknown') return { verified: false, text: 'Sender not verified: no result from our mail server' };
  return { verified: false, text: `Sender not verified (DMARC ${dmarc}, SPF ${spf}, DKIM ${dkim})` };
}

/** Caution first, then information; each kind once. */
export function orderedWarnings(warnings: readonly EmailWarning[]): EmailWarning[] {
  return [...warnings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'caution' ? -1 : 1));
}

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; form-action 'none'; base-uri 'none'";

/** The document the frame renders. The body is server-sanitized HTML; nothing here adds behaviour. */
export function emailDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>
    html,body{margin:0;padding:0;background:#fff;color:#1d1b2e;}
    body{padding:20px 22px;font:14px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere;}
    img{max-width:100%;height:auto;}
    table{max-width:100%;border-collapse:collapse;}
    blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #d8d6e8;color:#55536b;}
    pre{white-space:pre-wrap;}
    .hermes-link{color:#2a24b8;text-decoration:underline;text-underline-offset:2px;}
    .hermes-link-destination{color:#6b6983;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
    .hermes-image-blocked{display:inline-block;margin:2px 0;padding:2px 8px;border:1px dashed #c9c6dc;border-radius:6px;color:#6b6983;font-size:12px;}
  </style></head><body>${html}</body></html>`;
}

function EmailFrame({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const doc = useMemo(() => emailDocument(html), [html]);
  useEffect(() => {
    const element = frame.current;
    if (!element) return undefined;
    let observer: ResizeObserver | null = null;
    const measure = (): void => {
      const body = element.contentDocument?.documentElement;
      if (body) setHeight(Math.min(Math.max(body.scrollHeight, 80), 4000));
    };
    const onLoad = (): void => {
      measure();
      const body = element.contentDocument?.body;
      if (body && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
    };
    element.addEventListener('load', onLoad);
    return () => { element.removeEventListener('load', onLoad); observer?.disconnect(); };
  }, [doc]);
  return <iframe
    ref={frame}
    className="email-frame"
    title={title}
    sandbox="allow-same-origin"
    referrerPolicy="no-referrer"
    srcDoc={doc}
    style={{ height }}
  />;
}

const received = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/** Why the agent did not read an attachment, in the reviewer's words. */
const UNREAD: Record<NonNullable<InboundEmailView['attachments'][number]['unread_reason']>, string> = {
  type_not_supported: 'Not read: this file type is not read',
  too_large: 'Not read: larger than 5 MB',
  no_text: 'Not read: no text in the file (a scan?)',
  unreadable: 'Not read: the file could not be parsed',
  limit_reached: 'Not read: only the first three files are read',
};

const size = (bytes: number): string => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;

export function EmailMessageView({ email }: { email: InboundEmailView }) {
  const facts = email.sender;
  const auth = authenticationLine(facts);
  const warnings = orderedWarnings(facts.warnings);
  const from = facts.name ? `${facts.name}` : facts.address;
  const links = email.body.links.filter((link) => !link.href.startsWith('mailto:'));
  return <article className="email-message" aria-label={`Email from ${from}`}>
    <header className="email-message-head">
      <div className="email-message-from">
        <strong>{from}</strong>
        {facts.name && <span>{facts.address}</span>}
      </div>
      <time dateTime={email.received_at}>{received(email.received_at)}</time>
    </header>
    <div className="email-message-checks" aria-label="What Hermes checked">
      <span data-tone={auth.verified ? 'good' : 'caution'}><Icon name={auth.verified ? 'check' : 'close'} size={14} /> {auth.text}</span>
      <span data-tone="neutral">{RELATIONSHIP[facts.relationship]}</span>
      <span data-tone="neutral">To {email.inbox.label}</span>
    </div>
    {warnings.length > 0 && <ul className="email-message-warnings" aria-label="Warnings">
      {warnings.map((warning) => <li key={warning.code} data-severity={warning.severity}>{warning.detail}</li>)}
    </ul>}
    <h3 className="email-message-subject">{email.subject || '(no subject)'}</h3>
    {email.body.html
      ? <EmailFrame html={email.body.html} title={`Email from ${from}: ${email.subject}`} />
      : <div className="email-plain">{email.body.text || 'This email has no readable text.'}</div>}
    {(links.length > 0 || email.attachments.length > 0) && <div className="email-message-extras">
      {links.length > 0 && <section>
        <h4>Links in this email</h4>
        <ul>{links.slice(0, 20).map((link, index) => <li key={`${link.href}:${index}`} data-mismatch={link.mismatch ? 'true' : undefined}>
          <span>{link.text || 'Link'}</span>
          <code>{link.href}</code>
          {link.mismatch && <em>The words show a different address</em>}
        </li>)}</ul>
      </section>}
      {email.attachments.length > 0 && <section>
        <h4>Attachments</h4>
        <ul>{email.attachments.map((file, index) => <li key={`${file.filename}:${index}`} className="email-attachment">
          <span className="email-attachment-name"><Icon name="doc" size={14} /> <span>{file.filename}</span> <small>{size(file.size)}</small></span>
          <small className="email-attachment-state">{file.text !== null ? 'Read by the agent as text' : UNREAD[file.unread_reason ?? 'type_not_supported']}</small>
          {file.text !== null && <details className="email-attachment-text">
            <summary>Show the text the agent read</summary>
            <pre>{file.text}</pre>
          </details>}
        </li>)}</ul>
      </section>}
    </div>}
  </article>;
}
