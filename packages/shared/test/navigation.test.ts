import { describe, expect, it } from 'vitest';
import { FOCUS_VIEWS, INBOX, refSchema, sameRef, setFocusInputSchema, viewFocusRef, viewFocusSchema } from '../src/refs.js';

describe('prompt navigation contract', () => {
  it.each(FOCUS_VIEWS)('maps %s to an existing, valid app ref', (view) => {
    expect(refSchema.safeParse(viewFocusRef({ view })).success).toBe(true);
  });

  it('resets omitted Inbox filters rather than inheriting an old search', () => {
    expect(viewFocusRef({ view: 'inbox' })).toEqual({
      ...INBOX, filters: { status: 'pending', kind: 'all', reviewer: 'for_me', query: '', sort: 'priority' },
    });
  });

  it.each([
    { view: 'https://example.com' },
    { view: 'members', filters: { kind: 'application' } },
    { view: 'inbox', filters: { status: 'approved' } },
    { view: 'inbox', filters: { query: 'x'.repeat(201) } },
    { view: 'inbox', filters: { workspace_id: 'elsewhere' } },
    { view: 'inbox', html: '<h1>anything</h1>' },
  ])('rejects an unsupported view or filter: %j', (input) => {
    expect(viewFocusSchema.safeParse(input).success).toBe(false);
  });

  it('accepts legacy entity calls but refuses ambiguous or invalid calls', () => {
    expect(setFocusInputSchema.parse({ entity_type: 'request', entity_id: 'r1' })).toEqual({ entity_type: 'request', entity_id: 'r1' });
    for (const input of [{}, { entity_type: 'anything', entity_id: 'r1' }, { entity_type: 'request', entity_id: ' ' }, { view: 'members', entity_type: 'member', entity_id: 'm1' }]) {
      expect(setFocusInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it('compares filter values, not object identity, including default values', () => {
    expect(sameRef(INBOX, viewFocusRef({ view: 'inbox' }))).toBe(true);
    const filtered = viewFocusRef({ view: 'inbox', filters: { kind: 'application', query: 'Ada' } });
    expect(sameRef(filtered, structuredClone(filtered))).toBe(true);
    expect(sameRef(filtered, INBOX)).toBe(false);
    expect(sameRef(filtered, { ...filtered, filters: { ...filtered.filters, status: 'resolved' } })).toBe(false);
  });
});
