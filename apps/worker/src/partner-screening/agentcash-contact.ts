import { z } from 'zod';

export const AGENTCASH_CONTACT_ENRICH_URL = 'https://stableenrich.dev/api/minerva/enrich' as const;
export const AGENTCASH_EMAIL_VERIFY_URL = 'https://stableenrich.dev/api/hunter/email-verifier' as const;

export type ContactCallKind = 'enrichment' | 'verification' | 'verification_poll';
export type VerificationStatus = 'valid' | 'invalid' | 'accept_all' | 'webmail' | 'disposable' | 'unknown';

export interface SanitizedPhone {
  readonly number: string;
  readonly type: string | null;
}

export interface SanitizedSocialProfile {
  readonly network: 'linkedin' | 'twitter' | 'facebook';
  readonly url: string;
}

export interface ContactEnrichmentResult {
  readonly professionalEmails: readonly string[];
  readonly phones: readonly SanitizedPhone[];
  readonly socialProfiles: readonly SanitizedSocialProfile[];
}

export interface EmailVerificationResult {
  readonly pending: boolean;
  readonly jobId: string | null;
  readonly pollUrl: string | null;
  readonly retryAfterSeconds: number | null;
  readonly email: string | null;
  readonly status: VerificationStatus | null;
  readonly score: number | null;
  readonly draftEligible: boolean;
  readonly checks: Readonly<Record<string, boolean | null>>;
}

export function agentCashContactEnrichmentArguments(candidateId: string, linkedInUrl: string) {
  return {
    url: AGENTCASH_CONTACT_ENRICH_URL,
    method: 'POST' as const,
    maxAmount: 0.05 as const,
    body: {
      records: [{ record_id: candidateId, linkedin_url: linkedInUrl }],
      return_fields: ['full_name', 'linkedin_url', 'professional_emails', 'phones', 'twitter_url', 'facebook_url'],
    },
  };
}

export function agentCashEmailVerificationArguments(email: string) {
  return {
    url: AGENTCASH_EMAIL_VERIFY_URL,
    method: 'POST' as const,
    maxAmount: 0.03 as const,
    body: { email: email.toLowerCase() },
  };
}

export function agentCashEmailVerificationPollArguments(pollUrl: string) {
  return { url: pollUrl, method: 'GET' as const, maxAmount: 0.03 as const };
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasContactShape(value: unknown): boolean {
  if (!object(value)) return false;
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  return Array.isArray(value.records)
    || Array.isArray(value.results)
    || 'professional_emails' in value
    || 'phones' in value
    || ['valid', 'invalid', 'accept_all', 'webmail', 'disposable', 'unknown', 'pending'].includes(status)
    || 'jobId' in value
    || 'pollUrl' in value;
}

function unwrap(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') {
    try { return unwrap(JSON.parse(value), depth + 1); } catch {
      for (const line of value.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        try {
          const candidate = unwrap(JSON.parse(line), depth + 1);
          if (hasContactShape(candidate)) return candidate;
        } catch { /* Ignore non-JSON MCP text blocks. */ }
      }
      return value;
    }
  }
  if (!object(value)) return value;
  if (hasContactShape(value)) return value;
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (object(item) && typeof item.text === 'string') {
        const candidate = unwrap(item.text, depth + 1);
        if (hasContactShape(candidate)) return candidate;
      }
    }
  }
  for (const key of ['data', 'body', 'result', 'response']) {
    if (key in value) {
      const candidate = unwrap(value[key], depth + 1);
      if (hasContactShape(candidate)) return candidate;
    }
  }
  return value;
}

const emailSchema = z.string().trim().toLowerCase().email().max(320);

function professionalEmailValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const raw = typeof item === 'string'
      ? item
      : object(item) && typeof item.email === 'string'
        ? item.email
        : object(item) && typeof item.address === 'string' ? item.address : null;
    const parsed = emailSchema.safeParse(raw);
    if (parsed.success && !result.includes(parsed.data)) result.push(parsed.data);
    if (result.length >= 5) break;
  }
  return result;
}

function phoneValues(value: unknown): SanitizedPhone[] {
  if (!Array.isArray(value)) return [];
  const result: SanitizedPhone[] = [];
  for (const item of value) {
    const raw = typeof item === 'string'
      ? item
      : object(item) && typeof item.number === 'string'
        ? item.number
        : object(item) && typeof item.phone === 'string' ? item.phone : null;
    if (!raw) continue;
    const normalized = raw.trim().replace(/[^0-9+().\- x]/gi, '').replace(/\s+/g, ' ').slice(0, 40);
    const digits = normalized.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15 || result.some((entry) => entry.number === normalized)) continue;
    const rawType = object(item) && typeof (item.phone_type ?? item.type) === 'string'
      ? String(item.phone_type ?? item.type).trim().toLowerCase().slice(0, 40)
      : null;
    result.push({ number: normalized, type: rawType || null });
    if (result.length >= 5) break;
  }
  return result;
}

function trustedSocial(network: SanitizedSocialProfile['network'], value: unknown): SanitizedSocialProfile | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowed = network === 'linkedin'
      ? ['linkedin.com', 'www.linkedin.com']
      : network === 'twitter'
        ? ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com']
        : ['facebook.com', 'www.facebook.com'];
    if (url.protocol !== 'https:' || url.username || url.password || !allowed.includes(host)) return null;
    url.search = '';
    url.hash = '';
    return { network, url: url.toString().replace(/\/$/, '') };
  } catch { return null; }
}

function matchingRecord(value: unknown, candidateId: string): Record<string, unknown> {
  const root = unwrap(value);
  if (!object(root) && !Array.isArray(root)) throw new Error('Contact enrichment response was not an object.');
  const rows = Array.isArray(root) ? root : Array.isArray(root.records) ? root.records : Array.isArray(root.results) ? root.results : [root];
  const row = rows.find((item) => object(item) && String(item.record_id ?? item.id ?? '') === candidateId);
  if (!object(row)) throw new Error('Contact enrichment response did not match the selected candidate.');
  return row;
}

export function parseAgentCashContactEnrichment(value: unknown, candidateId: string): ContactEnrichmentResult {
  const row = matchingRecord(value, candidateId);
  const linkedin = trustedSocial('linkedin', row.linkedin_url);
  const twitter = trustedSocial('twitter', row.twitter_url);
  const facebook = trustedSocial('facebook', row.facebook_url);
  return {
    professionalEmails: professionalEmailValues(row.professional_emails),
    phones: phoneValues(row.phones),
    socialProfiles: [linkedin, twitter, facebook].filter((entry): entry is SanitizedSocialProfile => entry !== null),
  };
}

export function trustedHunterPollUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'stableenrich.dev'
      || url.username || url.password || url.search || url.hash
      || !/^\/api\/hunter\/email-verifier\/jobs\/[A-Za-z0-9_-]{1,160}$/.test(url.pathname)) {
    throw new Error('Email verification poll URL is not trusted.');
  }
  return url.toString();
}

function booleanCheck(root: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) if (typeof root[key] === 'boolean') return root[key] as boolean;
  return null;
}

export function parseAgentCashEmailVerification(value: unknown, expectedEmail: string): EmailVerificationResult {
  const unwrapped = unwrap(value);
  if (!object(unwrapped)) throw new Error('Email verification response was not an object.');
  const root = object(unwrapped.data) ? unwrapped.data : unwrapped;
  const pending = String(root.status ?? '').toLowerCase() === 'pending' || typeof root.pollUrl === 'string';
  if (pending) {
    if (typeof root.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(root.jobId) || typeof root.pollUrl !== 'string') {
      throw new Error('Email verification pending response was incomplete.');
    }
    const retry = typeof root.retryAfterSeconds === 'number' && Number.isInteger(root.retryAfterSeconds)
      ? Math.max(1, Math.min(300, root.retryAfterSeconds)) : null;
    return {
      pending: true, jobId: root.jobId, pollUrl: trustedHunterPollUrl(root.pollUrl), retryAfterSeconds: retry,
      email: null, status: null, score: null, draftEligible: false, checks: {},
    };
  }
  const parsedEmail = emailSchema.parse(root.email ?? expectedEmail);
  if (parsedEmail !== expectedEmail.toLowerCase()) throw new Error('Email verification response did not match the requested email.');
  const status = z.enum(['valid', 'invalid', 'accept_all', 'webmail', 'disposable', 'unknown']).parse(String(root.status ?? '').toLowerCase());
  const score = typeof root.score === 'number' && Number.isFinite(root.score) ? Math.max(0, Math.min(100, root.score)) : null;
  const checks = {
    regexp: booleanCheck(root, 'regexp', 'regex'),
    gibberish: booleanCheck(root, 'gibberish'),
    disposable: booleanCheck(root, 'disposable'),
    webmail: booleanCheck(root, 'webmail'),
    mx_records: booleanCheck(root, 'mx_records'),
    smtp_server: booleanCheck(root, 'smtp_server'),
    smtp_check: booleanCheck(root, 'smtp_check'),
    accept_all: booleanCheck(root, 'accept_all'),
    block: booleanCheck(root, 'block'),
  };
  const draftEligible = status === 'valid'
    && checks.regexp === true
    && checks.mx_records === true
    && checks.smtp_server === true
    && checks.smtp_check === true
    && checks.disposable !== true
    && checks.block !== true;
  return { pending: false, jobId: null, pollUrl: null, retryAfterSeconds: null, email: parsedEmail, status, score, draftEligible, checks };
}
