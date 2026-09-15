// The document render: one self-contained HTML file per version.
//
// It renders the same fields the demo's viewer showed, because those fields are
// what the human approved: an invoice's number, its two parties, its dates, its
// line items and its total; an agreement's number, version label, parties,
// effective dates and numbered sections. A render that showed less than the
// review pane would be a document nobody had actually read.
//
// Two rules the markup follows and the tests pin:
//
//   * Every value is escaped. The payload is model-authored text that passed a
//     zod schema, which checks shape and length, not innocence; an agreement
//     section body is up to 20,000 characters of free text and the render is
//     served from the same origin as the app.
//   * The footer says what the document is not. "Not sent · No money moved" is
//     on the page itself, so a PDF that leaves this system carrying an invoice
//     still says nobody was paid. The demo put that line under every saved
//     document and it is the most load-bearing sentence in the product.
//
// The CSS is inline for the same reason the file is self-contained: a render in
// object storage has no stylesheet host, and a document that depends on one is
// a document that renders differently in a year.
import type { AgreementPayload, InvoicePayload } from '@hermes/shared';

/** The sentence every rendered document carries, by kind. */
export const INVOICE_FOOTER = 'Not sent · No money moved';
export const AGREEMENT_FOOTER = 'Not sent · Unsigned';

const escape = (value: unknown): string =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * Minor units to a readable amount.
 *
 * Money is stored as an integer number of cents (docs/DECISIONS.md, 13) and is
 * divided exactly once, here, at the last possible moment. Doing it earlier is
 * how 1200.00 and 1199.999999 become the same approval.
 */
export function formatMoney(minor: number, currency: string): string {
  const amount = minor / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code' }).format(amount);
  } catch {
    // An unknown currency code is not a reason to fail a render.
    return `${currency} ${amount.toFixed(2)}`;
  }
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px; font: 14px/1.55 "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
         color: #11161f; background: #fff; }
  .doc { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 26px; letter-spacing: -0.01em; margin: 0 0 4px; }
  .meta { color: #5c6673; font-size: 13px; }
  .parties { display: flex; gap: 32px; flex-wrap: wrap; margin: 28px 0; }
  .party { min-width: 220px; }
  .k { display: block; text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; color: #7b8593; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid #e6e9ee; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #7b8593; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tfoot td { font-weight: 600; border-bottom: none; border-top: 2px solid #11161f; }
  section.clause { margin-top: 22px; }
  section.clause h2 { font-size: 15px; margin: 0 0 6px; }
  section.clause p { margin: 0; white-space: pre-wrap; }
  footer { margin-top: 36px; padding-top: 14px; border-top: 1px solid #e6e9ee; color: #5c6673; font-size: 12px; }
`;

const shell = (title: string, body: string, footer: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>${escape(title)}</title><style>${STYLE}</style></head>` +
  `<body><div class="doc">${body}<footer>${escape(footer)}</footer></div></body></html>`;

const party = (label: string, value: { name: string; email?: string; address?: string }): string =>
  `<div class="party"><span class="k">${escape(label)}</span>` +
  `<div>${escape(value.name)}</div>` +
  (value.email ? `<div class="meta">${escape(value.email)}</div>` : '') +
  (value.address ? `<div class="meta">${escape(value.address)}</div>` : '') +
  `</div>`;

export function renderInvoiceHtml(payload: InvoicePayload): string {
  const lines = payload.lines
    .map(
      (line) =>
        `<tr><td>${escape(line.label)}${line.date ? `<div class="meta">${escape(line.date)}</div>` : ''}</td>` +
        `<td class="num">${escape(line.qty)}</td>` +
        `<td class="num">${escape(formatMoney(line.amount_minor, payload.currency))}</td>` +
        `<td class="num">${escape(formatMoney(line.qty * line.amount_minor, payload.currency))}</td></tr>`,
    )
    .join('');

  const body =
    `<h1>Invoice ${escape(payload.number)}</h1>` +
    `<div class="meta">Issued ${escape(payload.issue_date)} · Due ${escape(payload.due_date)}` +
    (payload.work_period
      ? ` · Work ${escape(payload.work_period.from)} to ${escape(payload.work_period.to)}`
      : '') +
    `</div>` +
    `<div class="parties">${party('From', payload.payee)}${party('To', payload.payer)}</div>` +
    `<table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th>` +
    `<th class="num">Amount</th></tr></thead><tbody>${lines}</tbody>` +
    `<tfoot><tr><td colspan="3">Total</td>` +
    `<td class="num">${escape(formatMoney(payload.total_minor, payload.currency))}</td></tr></tfoot></table>` +
    (payload.notes ? `<section class="clause"><h2>Notes</h2><p>${escape(payload.notes)}</p></section>` : '');

  return shell(`Invoice ${payload.number}`, body, INVOICE_FOOTER);
}

export function renderAgreementHtml(payload: AgreementPayload): string {
  const parties = payload.parties.map((p, index) => party(`Party ${index + 1}`, p)).join('');
  const sections = payload.sections
    .map(
      (section, index) =>
        `<section class="clause"><h2>${index + 1}. ${escape(section.heading)}</h2>` +
        `<p>${escape(section.body)}</p></section>`,
    )
    .join('');

  const body =
    `<h1>Agreement ${escape(payload.number)}</h1>` +
    `<div class="meta">${escape(payload.version_label)}` +
    (payload.effective_dates
      ? ` · Effective ${escape(payload.effective_dates.from)} to ${escape(payload.effective_dates.to)}`
      : '') +
    (payload.total_minor !== undefined && payload.currency
      ? ` · ${escape(formatMoney(payload.total_minor, payload.currency))}`
      : '') +
    `</div>` +
    `<div class="parties">${parties}</div>${sections}`;

  return shell(`Agreement ${payload.number}`, body, AGREEMENT_FOOTER);
}
