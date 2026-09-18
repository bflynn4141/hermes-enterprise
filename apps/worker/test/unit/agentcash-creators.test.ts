import { describe, expect, it } from 'vitest';
import {
  AGENTCASH_CREATOR_SEARCH_ARGUMENTS,
  AGENTCASH_X_CREATOR_SEARCH_ARGUMENTS,
  governedCreatorSearchInput,
  parseAgentCashCreatorSearch,
  parseAgentCashXCreatorSearch,
  requestedCreatorSearchKinds,
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

  it('uses one fixed read-only X post search and injects only explicit channel tests', () => {
    expect(AGENTCASH_X_CREATOR_SEARCH_ARGUMENTS).toEqual({
      url: 'https://fetcher.sh/api/twitter/search?query=%22Hermes%20Agent%22&sort=Top',
      method: 'GET',
      maxAmount: 0.005,
    });
    const prompt = 'Run a Hermes creator test for LinkedIn, YouTube, and X.';
    expect(requestedCreatorSearchKinds(prompt)).toEqual(['linkedin_youtube', 'x']);
    const governed = governedCreatorSearchInput(prompt);
    expect(governed).toContain(JSON.stringify(AGENTCASH_CREATOR_SEARCH_ARGUMENTS));
    expect(governed).toContain(JSON.stringify(AGENTCASH_X_CREATOR_SEARCH_ARGUMENTS));
    expect(governed).toContain('exactly once');
    expect(governedCreatorSearchInput('Explain whether X search exists.')).toBe('Explain whether X search exists.');
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

  it('imports bounded X creator evidence with public metrics and strips contact data', () => {
    const parsed = parseAgentCashXCreatorSearch({
      success: true,
      data: {
        status: 200,
        message: 'OK',
        data: {
          tweets: [{
            id: '2101069073878507707',
            url: 'https://x.com/HermesAgentTips/status/2101069073878507707?ref=feed',
            fullText: 'Hermes Agent tutorial for consultants. creator@example.com +1 555 222 3333',
            createdAt: 'Fri Sep 18 22:01:17 +0000 2026',
            likeCount: 12,
            viewCount: 200,
            author: {
              userName: 'HermesAgentTips',
              url: 'https://twitter.com/HermesAgentTips',
              name: 'Hermes Agent Tips',
              description: 'Covering Nous Research Hermes Agent and building practical guides.',
              followers: 9506,
              following: 1056,
              isBlueVerified: true,
              professional: { professional_type: 'Creator', category: [{ name: 'Content Creator' }] },
            },
          }],
        },
      },
      metadata: { payment: { transactionHash: 'must-not-persist' } },
    }, new Date('2026-09-18T22:35:00Z'));
    expect(parsed).toMatchObject({ apiRequestsUsed: 1, monetaryCostUsd: 0.005 });
    expect(parsed.candidates).toEqual([expect.objectContaining({
      displayName: 'Hermes Agent Tips',
      profileUrl: 'https://x.com/HermesAgentTips',
    })]);
    expect(parsed.artifacts[0]?.url).toBe('https://x.com/HermesAgentTips/status/2101069073878507707');
    expect(parsed.artifacts[0]?.content).toMatchObject({
      platform: 'x', followers: 9506, is_verified: true,
      public_engagement: { likes: 12, views: 200 },
    });
    const stored = JSON.stringify(parsed.artifacts);
    expect(stored).not.toContain('creator@example.com');
    expect(stored).not.toContain('+1 555 222 3333');
    expect(stored).not.toContain('must-not-persist');
  });
});
