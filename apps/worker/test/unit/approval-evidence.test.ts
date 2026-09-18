import { describe, expect, it } from 'vitest';
import { approvalEvidenceSourceUrl, partnerSourceFacts } from '../../src/domain/approval-evidence.js';

describe('approval evidence public links', () => {
  it('preserves a valid YouTube video identity and strips tracking/fragment data', () => {
    expect(approvalEvidenceSourceUrl('https://www.youtube.com/watch?v=abcdefghijk&utm_source=tracker#part', 'agentcash_creators'))
      .toBe('https://www.youtube.com/watch?v=abcdefghijk');
    expect(approvalEvidenceSourceUrl('https://www.linkedin.com/in/researcher?tracking=private#about', 'agentcash_people'))
      .toBe('https://www.linkedin.com/in/researcher');
    expect(approvalEvidenceSourceUrl('https://api.github.com/search/repositories?q=hermes&per_page=10&secret=ignore', 'github'))
      .toBe('https://api.github.com/search/repositories?q=hermes&per_page=10');
  });

  it.each([
    'javascript:alert(1)', 'http://www.linkedin.com/in/person',
    'https://www.linkedin.com.evil.test/in/person', 'https://user:password@www.linkedin.com/in/person',
    'https://www.linkedin.com:8443/in/person', 'https://127.0.0.1/in/person',
    'https://www.linkedin.com/redirect?url=https://evil.test', 'https://www.linkedin.com\\@evil.test/in/person',
    'https://www.linkedin.com/in/person\n', 'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=invalid', 'https://www.youtube.com/redirect?q=https://evil.test',
  ])('rejects unsafe or unresolved source %s', (url) => {
    expect(approvalEvidenceSourceUrl(url, 'agentcash_creators')).toBeNull();
  });

  it('does not accept a trusted host for an unrelated source', () => {
    expect(approvalEvidenceSourceUrl('https://github.com/org/repo', 'agentcash_people')).toBeNull();
    expect(approvalEvidenceSourceUrl('https://www.linkedin.com/in/person', 'unknown')).toBeNull();
  });
});

describe('approval evidence fact projection', () => {
  it('projects bounded professional facts without raw nested data or extra contacts', () => {
    const facts = partnerSourceFacts('agentcash_people', {
      full_name: 'Alex Researcher', headline: 'Hermes consultant', description: 'x'.repeat(4000),
      skills: ['Agents', { private: true }],
      current_employment: { title: 'Engineer', description: 'Builds agent workflows', private: 'hidden' },
      company: { name: 'Research Studio', secret: 'hidden' },
      professional_emails: ['extra@example.test'], private_data: 'hidden', runtime_run_id: 'hidden',
    });
    expect(facts).toContainEqual({ label: 'Current role', value: 'Engineer' });
    expect(facts).toContainEqual({ label: 'Skills', value: 'Agents' });
    expect(facts.find((fact) => fact.label === 'Professional background')?.value).toHaveLength(2000);
    expect(JSON.stringify(facts)).not.toMatch(/hidden|extra@example/);
  });

  it('shows stored creator excerpts without arbitrary links or raw metadata', () => {
    expect(partnerSourceFacts('agentcash_creators', {
      title: 'Hermes tutorial', excerpt: 'A practical setup guide', highlights: ['Uses tools'],
      result_url: 'javascript:alert(1)', raw_provider_response: { key: 'secret' },
    })).toEqual([
      { label: 'Title', value: 'Hermes tutorial' },
      { label: 'Excerpt', value: 'A practical setup guide' },
      { label: 'Highlight', value: 'Uses tools' },
    ]);
  });
});
