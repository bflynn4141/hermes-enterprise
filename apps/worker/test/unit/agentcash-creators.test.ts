import { describe, expect, it } from 'vitest';
import {
  AGENTCASH_CREATOR_SEARCH_ARGUMENTS,
  parseAgentCashCreatorSearch,
  trustedLinkedInProfileUrl,
} from '../../src/partner-screening/agentcash-creators.js';

describe('AgentCash creator consultant discovery', () => {
  it('uses one fixed low-cost search across LinkedIn and YouTube', () => {
    expect(AGENTCASH_CREATOR_SEARCH_ARGUMENTS).toMatchObject({
      url: 'https://stableenrich.dev/api/exa/search',
      method: 'POST',
      maxAmount: 0.01,
      body: {
        numResults: 10,
        includeDomains: expect.arrayContaining(['linkedin.com', 'youtube.com']),
      },
    });
  });

  it('stores bounded public evidence while preserving influence and consent gaps', () => {
    const parsed = parseAgentCashCreatorSearch({
      results: [{
        id: 'result-1',
        title: 'Alex Example - AI automation consultant',
        url: 'https://www.linkedin.com/posts/alex-example_hermes-agent-guide-activity-123?trk=feed',
        author: 'Alex Example',
        publishedDate: '2026-09-01T12:00:00Z',
        summary: 'Alex publishes a Hermes Agent implementation guide and offers AI automation consulting.',
        highlights: ['Hermes Agent tutorial and deployment consulting.'],
        text: 'Public professional post only. private@example.com +1 555 222 3333',
        extras: { links: ['https://www.linkedin.com/in/alex-example?trk=post'] },
      }, {
        title: 'Hermes Agent tutorial',
        url: 'https://www.youtube.com/watch?v=abc123&feature=share',
        author: 'Creator Channel',
        summary: 'A Nous Research Hermes Agent tutorial for consultants implementing agent workflows.',
        extras: { links: ['https://www.youtube.com/@creatorchannel'] },
      }],
    }, new Date('2026-09-17T20:00:00Z'));

    expect(parsed).toMatchObject({ apiRequestsUsed: 1, monetaryCostUsd: 0.01 });
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0]).toMatchObject({
      displayName: 'Alex Example',
      profileUrl: 'https://www.linkedin.com/in/alex-example',
    });
    expect(parsed.candidates[0]?.priority.gaps.join(' ')).toMatch(/audience size/i);
    expect(parsed.candidates[1]?.profileUrl).toBe('https://www.youtube.com/@creatorchannel');
    expect(JSON.stringify(parsed.artifacts)).not.toContain('private@example.com');
    expect(JSON.stringify(parsed.artifacts)).not.toContain('+1 555 222 3333');
  });

  it('rejects unrelated Hermès results and untrusted profile URLs', () => {
    const parsed = parseAgentCashCreatorSearch({
      results: [{
        title: 'Hermès fashion creator',
        url: 'https://www.youtube.com/@fashion',
        summary: 'Luxury handbag tutorial and creator guide.',
      }, {
        title: 'Hermes Agent consultant',
        url: 'https://attacker.example/profile',
        summary: 'Nous Research Hermes Agent consulting.',
      }],
    });
    expect(parsed.candidates).toHaveLength(0);
    expect(trustedLinkedInProfileUrl('https://www.linkedin.com/in/example?trk=feed')).toBe('https://www.linkedin.com/in/example');
    expect(trustedLinkedInProfileUrl('https://www.linkedin.com/posts/example')).toBeNull();
    expect(trustedLinkedInProfileUrl('https://attacker.example/in/example')).toBeNull();
  });

  it('unwraps Hermes MCP text plus payment metadata', () => {
    const response = JSON.stringify({ results: [{
      title: 'Hermes Agent implementation consultant',
      url: 'https://www.linkedin.com/in/consultant',
      author: 'Consultant',
      summary: 'Nous Research Hermes Agent implementation consulting and tutorials.',
    }] });
    const payment = JSON.stringify({ paymentInfo: { price: '$0.01', transaction: '0xreceipt' } });
    const parsed = parseAgentCashCreatorSearch(`${response}\n${payment}`);
    expect(parsed.candidates).toHaveLength(1);
    expect(JSON.stringify(parsed.artifacts)).not.toContain('0xreceipt');
  });
});
