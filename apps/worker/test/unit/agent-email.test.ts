// Pieces of an agent's own email address (C100) that need no database.
import { describe, expect, it } from 'vitest';
import { agentLocalPart, intakeDomain } from '../../src/inbound-email/agent-address.js';
import { AgentSendError, referencesHeader, sendAsAgent } from '../../src/outbound-email/agent-send.js';

describe('agent addresses', () => {
  it('names the address after the agent, in letters, digits and hyphens', () => {
    expect(agentLocalPart('Iris')).toBe('iris');
    expect(agentLocalPart('Finance Iris')).toBe('finance-iris');
    expect(agentLocalPart('Zoë  (Ops)')).toBe('zoe-ops');
    expect(agentLocalPart('  ')).toBe('agent');
    expect(agentLocalPart('日本')).toBe('agent');
    expect(agentLocalPart('a'.repeat(80))).toHaveLength(30);
  });

  it('uses only a plausible receiving domain', () => {
    expect(intakeDomain(' In.Hermes.Test ')).toBe('in.hermes.test');
    expect(intakeDomain('')).toBeNull();
    expect(intakeDomain('bad domain')).toBeNull();
  });
});

describe('sending as an agent', () => {
  const input = { fromName: 'Iris', fromAddress: 'iris-abc234@in.hermes.test', toName: 'Priya', toAddress: 'priya@northwind.example', subject: 'Re: Hi', body: 'Thanks.' };

  it('keeps only well-formed message ids and fits References in 2 KB, newest kept', () => {
    const ids = Array.from({ length: 60 }, (_, index) => `<${'x'.repeat(40)}-${index}@example.com>`).join(' ');
    const header = referencesHeader(ids)!;
    expect(header.length).toBeLessThanOrEqual(2000);
    expect(header.endsWith('-59@example.com>')).toBe(true);
    expect(referencesHeader('<ok@a.b> bad\r\nInjected: yes')).toBe('<ok@a.b>');
  });

  it('passes the approved text and threading as API fields and headers', async () => {
    const calls: unknown[] = [];
    const binding = { send: async (message: unknown) => { calls.push(message); return { messageId: 'cf-1' }; } } as unknown as SendEmail;
    expect(await sendAsAgent(binding, { ...input, inReplyTo: '<m1@northwind.example>', references: '<r0@x.y> <m1@northwind.example>' })).toEqual({ id: 'cf-1' });
    expect(calls[0]).toEqual({
      from: { name: 'Iris', email: input.fromAddress }, to: { name: 'Priya', email: input.toAddress },
      subject: 'Re: Hi', text: 'Thanks.', headers: { 'In-Reply-To': '<m1@northwind.example>', References: '<r0@x.y> <m1@northwind.example>' },
    });
  });

  it.each([
    ['E_RATE_LIMIT_EXCEEDED', true, false],
    ['E_SENDER_NOT_VERIFIED', false, false],
    ['E_HEADER_NOT_ALLOWED', false, false],
    ['E_INTERNAL_SERVER_ERROR', false, true],
    ['network down', false, true],
  ])('classifies %s: retryable %s, may have sent %s', async (code, retryable, ambiguous) => {
    const binding = { send: async () => { throw Object.assign(new Error(code), code.startsWith('E_') ? { code } : {}); } } as unknown as SendEmail;
    const error = await sendAsAgent(binding, input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentSendError);
    expect(error).toMatchObject({ retryable, ambiguous });
  });
});
