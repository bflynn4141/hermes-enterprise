import { describe, expect, it } from 'vitest';
import { safeReturnPath } from '../../src/routes/auth.js';

describe('safeReturnPath (open redirect guard)', () => {
  it('keeps same-origin paths with query and hash', () => {
    expect(safeReturnPath('/w/abc/inbox?tab=resolved#r1')).toBe('/w/abc/inbox?tab=resolved#r1');
    expect(safeReturnPath('/')).toBe('/');
  });
  it('collapses anything that could leave the origin', () => {
    for (const bad of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'evil.example', '', undefined, null, '/\u0000']) {
      expect(safeReturnPath(bad as string)).toBe('/');
    }
  });
});
