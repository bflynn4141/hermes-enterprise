import { describe, expect, it } from 'vitest';
import {
  agentCashContactEnrichmentArguments,
  agentCashEmailVerificationArguments,
  parseAgentCashContactEnrichment,
  parseAgentCashEmailVerification,
} from '../../src/partner-screening/agentcash-contact.js';

const candidateId = '123e4567-e89b-12d3-a456-426614174000';

describe('AgentCash contact enrichment', () => {
  it('builds a candidate-bound allowlisted request', () => {
    expect(agentCashContactEnrichmentArguments(candidateId, 'https://www.linkedin.com/in/example')).toEqual({
      url: 'https://stableenrich.dev/api/minerva/enrich', method: 'POST', maxAmount: 0.05,
      body: {
        records: [{ record_id: candidateId, linkedin_url: 'https://www.linkedin.com/in/example' }],
        return_fields: ['full_name', 'linkedin_url', 'professional_emails', 'phones', 'twitter_url', 'facebook_url'],
      },
    });
  });

  it('keeps only professional contact fields and trusted social URLs', () => {
    const parsed = parseAgentCashContactEnrichment({ records: [{
      record_id: candidateId,
      professional_emails: [{ email: 'WORK@EXAMPLE.COM' }],
      personal_emails: ['private@example.net'],
      phones: [{ number: '+1 (415) 555-0100', phone_type: 'mobile' }],
      linkedin_url: 'https://www.linkedin.com/in/example?trk=secret',
      twitter_url: 'https://x.com/example?ref=secret',
      facebook_url: 'https://evil.example/profile',
      home_address: 'must not persist', relatives: ['must not persist'], net_worth: 'must not persist',
    }] }, candidateId);
    expect(parsed).toEqual({
      professionalEmails: ['work@example.com'],
      phones: [{ number: '+1 (415) 555-0100', type: 'mobile' }],
      socialProfiles: [
        { network: 'linkedin', url: 'https://www.linkedin.com/in/example' },
        { network: 'twitter', url: 'https://x.com/example' },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain('private');
    expect(JSON.stringify(parsed)).not.toContain('must not persist');
  });

  it('unwraps transport envelopes without treating an HTTP status as a provider result', () => {
    const parsed = parseAgentCashContactEnrichment({
      status: 200,
      data: { records: [{ record_id: candidateId, professional_emails: ['work@example.com'] }] },
    }, candidateId);
    expect(parsed.professionalEmails).toEqual(['work@example.com']);
  });
});

describe('AgentCash email verification', () => {
  it('requires a valid SMTP result before a draft can use the address', () => {
    const parsed = parseAgentCashEmailVerification({
      email: 'work@example.com', status: 'valid', score: 98, regexp: true,
      mx_records: true, smtp_server: true, smtp_check: true,
      disposable: false, block: false, accept_all: false,
    }, 'work@example.com');
    expect(parsed).toMatchObject({ status: 'valid', score: 98, draftEligible: true, pending: false });
    expect(agentCashEmailVerificationArguments('WORK@EXAMPLE.COM').body.email).toBe('work@example.com');
  });

  it('does not treat accept-all or a weak SMTP result as draft eligible', () => {
    expect(parseAgentCashEmailVerification({
      email: 'work@example.com', status: 'accept_all', regexp: true,
      mx_records: true, smtp_server: true, smtp_check: true,
    }, 'work@example.com').draftEligible).toBe(false);
    expect(parseAgentCashEmailVerification({
      email: 'work@example.com', status: 'valid', regexp: true,
      mx_records: true, smtp_server: true, smtp_check: false,
    }, 'work@example.com').draftEligible).toBe(false);
  });

  it('accepts only a trusted asynchronous poll URL', () => {
    expect(parseAgentCashEmailVerification({
      jobId: 'hunter_job_1', status: 'pending',
      pollUrl: 'https://stableenrich.dev/api/hunter/email-verifier/jobs/hunter_job_1',
      retryAfterSeconds: 3,
    }, 'work@example.com')).toMatchObject({ pending: true, jobId: 'hunter_job_1', retryAfterSeconds: 3 });
    expect(() => parseAgentCashEmailVerification({
      jobId: 'hunter_job_1', status: 'pending', pollUrl: 'https://evil.example/jobs/hunter_job_1',
    }, 'work@example.com')).toThrow(/trusted/i);
  });
});
