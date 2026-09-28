import type { Env } from '../env.js';

// Where a deployment may send approved email (C100). Staging sends only to
// the people testing it; a missing or empty list sends to nobody, so a
// deploy that forgot the secret fails closed rather than open.

export function recipientAllowed(
  env: Pick<Env, 'AGENT_EMAIL_RECIPIENT_MODE' | 'AGENT_EMAIL_ALLOWED_RECIPIENTS'>,
  address: string,
): boolean {
  if (env.AGENT_EMAIL_RECIPIENT_MODE !== 'allowlist') return true;
  const target = address.trim().toLowerCase();
  const domain = target.slice(target.lastIndexOf('@'));
  return (env.AGENT_EMAIL_ALLOWED_RECIPIENTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => entry.startsWith('@') ? entry === domain : entry === target);
}
