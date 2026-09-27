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
// Above the body sit the facts the server checked, in words the reviewer
// uses (docs/DESIGN.md): one trust line, and at most one panel of things to
// check before replying. The words come from each warning's code and the
// stored facts, so older messages read the same way as new ones. Nothing here
// is the agent's opinion: the agent's suggestion is shown separately.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EmailWarning, EmailWarningCode, InboundEmailView, SenderFacts } from '@hermes/shared';
import { Icon } from '../ui/icons.js';
import './email-message.css';

const RELATIONSHIP: Record<SenderFacts['relationship'], string> = {
  internal: 'Someone on your team',
  known_contact: "You've emailed before",
  new_sender: 'First email from this address',
};

/** One line on who sent this: whether their domain confirmed it, and how the team knows them. */
export function trustLine(facts: SenderFacts): { verified: boolean; text: string } {
  const verified = facts.authentication.dmarc === 'pass';
  return {
    verified,
    text: [verified ? 'Verified sender' : 'Sender not confirmed', RELATIONSHIP[facts.relationship]].join(' · '),
  };
}

/** What to check before acting, one sentence per caution, in the reviewer's words. */
export function cautionSentence(code: EmailWarningCode, facts: SenderFacts): string | null {
  switch (code) {
    case 'authentication_failed':
      return `Hermes couldn't confirm this email came from ${facts.domain}. The sender may not be who they say they are.`;
    case 'reply_to_differs':
      return facts.reply_to
        ? `It asks for replies to go to ${facts.reply_to}. Hermes only ever replies to ${facts.address}.`
        : 'It asks for replies to go to a different address. Hermes only ever replies to the sender.';
    case 'lookalike_domain':
      return `${facts.domain} looks like a company your team already emails, but it's a different address.`;
    case 'display_name_impersonation':
      return 'The sender uses the name of someone on your team, but writes from an outside address.';
    case 'payment_details_change':
      return 'It talks about bank or payment details. Confirm any change by phone, using a number you already have.';
    case 'hidden_text_removed':
      return 'It contained hidden text. Hermes removed it before anyone read the email, including the agent.';
    case 'link_text_mismatch':
      return 'A link says one website but opens another. Check where each link goes, below.';
    default:
      return null;
  }
}

/** The cautions on a message, each once, in a stable order. */
export function emailCautions(facts: SenderFacts): { code: EmailWarningCode; text: string }[] {
  const seen = new Set<EmailWarningCode>();
  return facts.warnings
    .filter((warning: EmailWarning) => warning.severity === 'caution')
    .flatMap((warning) => {
      if (seen.has(warning.code)) return [];
      seen.add(warning.code);
      const text = cautionSentence(warning.code, facts);
      return text ? [{ code: warning.code, text }] : [];
    });
}

/**
 * The one panel of things to check, for the top of a reply or hand-off.
 * `second` adds the rule a flagged sender triggers.
 */
export function EmailCautions({ facts, heading = 'Check before replying', second }: {
  facts: SenderFacts;
  heading?: string;
  second?: string | null;
}) {
  const cautions = emailCautions(facts);
  if (cautions.length === 0) return null;
  return <section className="email-cautions" aria-label={heading}>
    <h2><Icon name="shield" size={16} /> {heading}</h2>
    <ul>{cautions.map((caution) => <li key={caution.code}>{caution.text}</li>)}</ul>
    {second && <p>{second}</p>}
  </section>;
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
    .hermes-link-destination{color:#6b6983;font-size:12px;}
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

/** Why an attachment was not opened, in the reviewer's words. */
const UNREAD: Record<NonNullable<InboundEmailView['attachments'][number]['unread_reason']>, string> = {
  type_not_supported: "Not opened: Hermes doesn't read this kind of file",
  too_large: 'Not opened: larger than 5 MB',
  no_text: 'Not opened: no text in the file, it may be a scan',
  unreadable: "Not opened: the file couldn't be read",
  limit_reached: 'Not opened: only the first three files are read',
};

const size = (bytes: number): string => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;

/** Where a link really goes, without the scheme: "northwind.example/recaps". */
export function linkDestination(href: string): string {
  try {
    const url = new URL(href);
    const path = url.pathname === '/' ? '' : url.pathname;
    const shown = `${url.host}${path}`;
    return shown.length > 80 ? `${shown.slice(0, 77)}…` : shown;
  } catch {
    return href.length > 80 ? `${href.slice(0, 77)}…` : href;
  }
}

export function EmailMessageView({ email, agentName, showCautions = true }: {
  email: InboundEmailView;
  /** Who read the email, for the attachment notes. */
  agentName?: string | null;
  /** False when the caller shows `EmailCautions` itself, above a suggestion. */
  showCautions?: boolean;
}) {
  const facts = email.sender;
  const trust = trustLine(facts);
  const from = facts.name ? `${facts.name}` : facts.address;
  const reader = agentName ?? 'The agent';
  const links = email.body.links.filter((link) => !link.href.startsWith('mailto:'));
  const quiet = email.body.remote_images_blocked > 0 ? "Images were blocked, so the sender can't tell you opened this." : null;
  return <article className="email-message" aria-label={`Email from ${from}`}>
    <header className="email-message-head">
      <div className="email-message-from">
        <strong>{from}</strong>
        {facts.name && <span>{facts.address}</span>}
      </div>
      <time dateTime={email.received_at}>{received(email.received_at)}</time>
    </header>
    <p className="email-message-trust" data-tone={trust.verified ? 'good' : 'caution'}>
      <Icon name={trust.verified ? 'check' : 'close'} size={14} />
      <span>{trust.text} · Sent to {email.inbox.label}</span>
    </p>
    {showCautions && <EmailCautions facts={facts} heading="Check before acting on this" />}
    <h3 className="email-message-subject">{email.subject || '(no subject)'}</h3>
    {email.body.html
      ? <EmailFrame html={email.body.html} title={`Email from ${from}: ${email.subject}`} />
      : <div className="email-plain">{email.body.text || 'This email has no text to show.'}</div>}
    {quiet && <p className="email-message-quiet">{quiet}</p>}
    {(links.length > 0 || email.attachments.length > 0) && <div className="email-message-extras">
      {links.length > 0 && <section>
        <h4>Links in this email</h4>
        <ul>{links.slice(0, 20).map((link, index) => <li key={`${link.href}:${index}`} data-mismatch={link.mismatch ? 'true' : undefined}>
          <span>{link.text || 'Link'}</span>
          <span className="email-link-destination">{link.mismatch ? 'Actually opens ' : 'Opens '}{linkDestination(link.href)}</span>
        </li>)}</ul>
      </section>}
      {email.attachments.length > 0 && <section>
        <h4>Attachments</h4>
        <ul>{email.attachments.map((file, index) => <li key={`${file.filename}:${index}`} className="email-attachment">
          <span className="email-attachment-name"><Icon name="doc" size={14} /> <span>{file.filename}</span> <small>{size(file.size)}</small></span>
          <small className="email-attachment-state">{file.text !== null ? `${reader} read this file` : UNREAD[file.unread_reason ?? 'type_not_supported']}</small>
          {file.text !== null && <details className="email-attachment-text">
            <summary>See what {agentName ?? 'the agent'} read</summary>
            <pre>{file.text}</pre>
          </details>}
        </li>)}</ul>
      </section>}
    </div>}
  </article>;
}
