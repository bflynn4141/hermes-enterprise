// What the server can say about who sent a message, before any model reads it.
//
// Two lessons from the research behind decision C98 shape this file. First,
// passing SPF, DKIM and DMARC proves a domain signed the mail, not that the
// person is trustworthy: a hijacked vendor mailbox passes all three. So
// authentication is one fact among several, and nothing here ever lowers the
// bar for an action. Second, business email compromise is mostly lookalike
// domains, a Reply-To that points somewhere else, a display name borrowed
// from a colleague, and "our bank details have changed". Each of those is a
// cheap string check, and each becomes a `caution` that routes a suggestion
// to the stricter approval policy.
//
// Only the Authentication-Results header written by our own receiver counts.
// Anyone can put an `Authentication-Results: …dmarc=pass` header in a message;
// the receiving MTA prepends its own above whatever the sender wrote, so we
// take the first header whose authserv-id is the one we configured and ignore
// the rest.
import {
  CAUTION_WARNING_CODES,
  type EmailAuthResult,
  type EmailWarning,
  type EmailWarningCode,
  type SenderAuthentication,
  type SenderFacts,
  type SenderRelationship,
} from '@hermes/shared';

export const DEFAULT_AUTHSERV_ID = 'mx.cloudflare.net';

const RESULT_WORDS = new Set<EmailAuthResult>(['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'policy']);

/** Parse the trusted Authentication-Results header (RFC 8601). */
export function parseAuthenticationResults(
  headers: readonly string[],
  trustedAuthservId: string = DEFAULT_AUTHSERV_ID,
): SenderAuthentication {
  const unknown: SenderAuthentication = { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', authserv_id: null };
  const trusted = trustedAuthservId.trim().toLowerCase();
  for (const header of headers) {
    const unfolded = header.replace(/\r?\n[\t ]+/gu, ' ').replace(/\([^)]*\)/gu, ' ');
    const [first, ...methods] = unfolded.split(';');
    const authservId = first?.trim().split(/\s+/u)[0]?.toLowerCase() ?? '';
    if (authservId !== trusted) continue;
    const result: SenderAuthentication = { spf: 'none', dkim: 'none', dmarc: 'none', authserv_id: authservId };
    const found: Record<'spf' | 'dkim' | 'dmarc', EmailAuthResult[]> = { spf: [], dkim: [], dmarc: [] };
    for (const method of methods) {
      const match = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)/iu.exec(method);
      if (!match) continue;
      const key = match[1]!.toLowerCase() as 'spf' | 'dkim' | 'dmarc';
      const word = match[2]!.toLowerCase() as EmailAuthResult;
      if (RESULT_WORDS.has(word)) found[key].push(word);
    }
    // A message can carry several DKIM signatures; one passing is what DMARC
    // alignment needs, so report the best result for each method.
    for (const key of ['spf', 'dkim', 'dmarc'] as const) {
      if (found[key].length === 0) continue;
      result[key] = found[key].includes('pass') ? 'pass' : found[key][0]!;
    }
    return result;
  }
  return unknown;
}

export const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/** The registrable-ish part used for comparisons: `mail.acme.co.uk` → `acme.co.uk`. */
export function organizationalDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/u, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const secondLevel = labels[labels.length - 2]!;
  const twoPartSuffix = ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu'].includes(secondLevel) && labels[labels.length - 1]!.length === 2;
  return labels.slice(twoPartSuffix ? -3 : -2).join('.');
}

/** Characters attackers swap in for lookalikes, folded to what they imitate. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  '0': 'o', '1': 'l', '3': 'e', '5': 's', '7': 't', '8': 'b', 'і': 'i', 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p',
  'с': 'c', 'у': 'y', 'х': 'x', 'ԁ': 'd', 'ɡ': 'g', 'ӏ': 'l', 'ո': 'n',
};

const skeleton = (domain: string): string =>
  [...domain.toLowerCase()].map((char) => CONFUSABLES[char] ?? char).join('')
    .replace(/rn/gu, 'm').replace(/vv/gu, 'w').replace(/-/gu, '');

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j]!;
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = saved;
    }
  }
  return previous[b.length]!;
}

/**
 * The known domain this one imitates, if any: same skeleton after folding
 * confusable characters, or one or two edits away from a domain the workspace
 * already trusts. An exact match is not a lookalike.
 */
export function lookalikeOf(domain: string, knownDomains: Iterable<string>): string | null {
  const candidate = organizationalDomain(domain);
  const candidateSkeleton = skeleton(candidate);
  for (const known of knownDomains) {
    const trusted = organizationalDomain(known);
    if (!trusted || trusted === candidate) continue;
    if (skeleton(trusted) === candidateSkeleton) return trusted;
    const label = (value: string): string => value.split('.')[0] ?? value;
    const distance = editDistance(label(candidate), label(trusted));
    if (label(trusted).length >= 5 && distance >= 1 && distance <= (label(trusted).length >= 8 ? 2 : 1)) return trusted;
  }
  return null;
}

/**
 * "Our bank details have changed." The single most expensive sentence in
 * business email; one of these phrases plus an account word is enough to ask
 * a person to verify by phone before anyone pays.
 */
const PAYMENT_CHANGE = /\b(new|updated?|changed?|change of|different)\b[^.\n]{0,60}\b(bank|banking|account|remittance|payment|wire|ach|iban|routing|sort code|swift)\b[^.\n]{0,40}\b(details?|information|info|number|instructions?|account)\b|\b(bank|banking|remittance|payment|wire) (details?|information|instructions?)\b[^.\n]{0,40}\b(have|has) (changed|been updated)\b|\biban\b|\brouting number\b|\bswift( code)?\b/iu;

/** An account or routing number written out: the word, then at least six digits. */
const ACCOUNT_NUMBER = /\b(account|acct|routing|aba|sort code)\b\s*(number|no\.?|#)?\s*[:#]?\s*\d[\d\s-]{5,}/iu;
/** Money going somewhere, and a new or different account, in one sentence ("wire the deposit to our new account"). */
const MONEY_MOVES = /\b(wire|transfer|send|pay|remit|deposit)\w*\b/iu;
const OTHER_ACCOUNT = /\b(new|different|updated|changed|another|other)\s+(\w+\s+)?account\b/iu;

export function mentionsPaymentChange(text: string): boolean {
  return PAYMENT_CHANGE.test(text)
    || ACCOUNT_NUMBER.test(text)
    || text.split(/[.!?\n]+/u).some((sentence) => MONEY_MOVES.test(sentence) && OTHER_ACCOUNT.test(sentence));
}

export interface SenderFactsInput {
  readonly fromAddress: string;
  readonly fromName: string | null;
  readonly replyTo: string | null;
  readonly authentication: SenderAuthentication;
  /** Active member addresses and names in this workspace. */
  readonly members: readonly { readonly email: string; readonly name: string | null }[];
  /** Addresses the workspace has received from or sent approved mail to. */
  readonly knownAddresses: ReadonlySet<string>;
  readonly visibleText: string;
  readonly hiddenTextRemovedChars: number;
  readonly remoteImagesBlocked: number;
  readonly mismatchedLinks: number;
  readonly attachmentsRead: number;
  readonly attachmentsUnread: number;
}

const warning = (code: EmailWarningCode, detail: string): EmailWarning => ({
  code,
  severity: CAUTION_WARNING_CODES.has(code) ? 'caution' : 'info',
  detail,
});

const normalizeName = (value: string): string => value.toLowerCase().replace(/["'`]/gu, '').replace(/\s+/gu, ' ').trim();

export function senderFacts(input: SenderFactsInput): SenderFacts {
  const address = input.fromAddress.toLowerCase();
  const domain = domainOf(address);
  const memberAddresses = new Set(input.members.map((member) => member.email.toLowerCase()));
  const memberDomains = new Set(input.members.map((member) => domainOf(member.email)));
  const knownDomains = new Set([...memberDomains, ...[...input.knownAddresses].map(domainOf)]);
  // Free-mail domains are shared by strangers; they never make a sender "internal".
  const authenticated = input.authentication.dmarc === 'pass';
  const relationship: SenderRelationship = memberAddresses.has(address) && authenticated
    ? 'internal'
    : input.knownAddresses.has(address) ? 'known_contact' : 'new_sender';

  const warnings: EmailWarning[] = [];
  const { dmarc, spf, dkim } = input.authentication;
  if (dmarc !== 'pass') {
    warnings.push(warning('authentication_failed', input.authentication.authserv_id
      ? `${domain} did not confirm that it sent this email, so the sender may not be who they say they are.`
      : 'Hermes could not confirm who sent this email, so the sender may not be who they say they are.'));
  }
  const replyTo = input.replyTo?.toLowerCase() ?? null;
  if (replyTo && replyTo !== address && organizationalDomain(domainOf(replyTo)) !== organizationalDomain(domain)) {
    warnings.push(warning('reply_to_differs', `The email asks for replies to go to ${replyTo}, a different address from the sender's. Hermes only ever replies to ${address}.`));
  }
  const imitated = lookalikeOf(domain, knownDomains);
  if (imitated) {
    warnings.push(warning('lookalike_domain', `${domain} looks like ${imitated}, which your team already emails, but it is a different address.`));
  }
  if (input.fromName && !memberAddresses.has(address)) {
    const shown = normalizeName(input.fromName);
    const borrowed = input.members.find((member) => member.name && normalizeName(member.name) === shown);
    if (borrowed) {
      warnings.push(warning('display_name_impersonation', `The sender uses the name of ${borrowed.name}, who is on your team, but writes from an outside address.`));
    }
  }
  if (mentionsPaymentChange(input.visibleText)) {
    warnings.push(warning('payment_details_change', 'The email talks about bank or payment details. Confirm any change by calling a number you already have, never one in this email.'));
  }
  if (input.hiddenTextRemovedChars >= 20) {
    warnings.push(warning('hidden_text_removed', 'The email contained hidden text. Hermes removed it before anyone read the email, including the agent.'));
  }
  if (input.mismatchedLinks > 0) {
    warnings.push(warning('link_text_mismatch', `${input.mismatchedLinks === 1 ? 'A link says one website but opens' : `${input.mismatchedLinks} links say one website but open`} another.`));
  }
  if (input.remoteImagesBlocked > 0) {
    warnings.push(warning('remote_images_blocked', `Images from the sender's server were blocked, so they can't tell the email was opened.`));
  }
  if (input.attachmentsRead > 0) {
    warnings.push(warning('attachments_read', `The agent read ${input.attachmentsRead === 1 ? 'the attachment' : `${input.attachmentsRead} attachments`} with the same care as the email itself.`));
  }
  if (input.attachmentsUnread > 0) {
    warnings.push(warning('attachments_not_opened', `${input.attachmentsUnread === 1 ? 'One attachment was' : `${input.attachmentsUnread} attachments were`} not opened because of their type or size.`));
  }
  return {
    address,
    name: input.fromName?.slice(0, 200) ?? null,
    domain,
    relationship,
    authentication: input.authentication,
    reply_to: replyTo,
    warnings,
  };
}
