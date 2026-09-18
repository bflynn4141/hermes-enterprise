import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StoredEvidence, evidenceSourceUrl } from './ApprovalEvidence.js';

it('shows projected facts and dates without turning unsafe URLs into links', () => {
  const html = renderToStaticMarkup(<StoredEvidence evidence={{
    id: '00000000-0000-4000-8000-000000000001', kind: 'partner_source', label: 'Source', note: 'Iris thinks this is useful',
    source_url: 'javascript:alert(1)', fetched_at: '2026-09-18T12:00:00Z', source_updated_at: null, verified_at: null,
    sha256: null, facts: [{ label: 'Organization', value: 'Example cooperative' }],
  }} />);
  expect(html).toContain('Stored source facts');
  expect(html).toContain('Example cooperative');
  expect(html).toContain('dateTime="2026-09-18T12:00:00Z"');
  expect(html).not.toContain('Iris thinks this is useful');
  expect(html).not.toContain('href=');
  expect(evidenceSourceUrl('https://example.com/source')).toBe('https://example.com/source');
  expect(evidenceSourceUrl('file:///private/source')).toBeNull();
});
