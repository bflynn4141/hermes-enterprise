import { describe, expect, it } from 'vitest';
import { assertSeedTargetAllowed, inspectSeedTarget } from '../../scripts/seed-guard.mjs';

describe('the development seed target guard', () => {
  it('allows loopback databases and prints no credentials or query parameters', () => {
    const target = assertSeedTargetAllowed(
      'postgres://owner:super-secret@127.0.0.1:5433/hermes?sslmode=disable',
      undefined,
    );
    expect(target).toMatchObject({ local: true, test: false, exceptionalOverride: false });
    expect(target.display).toBe('postgres://127.0.0.1:5433/hermes');
    expect(target.display).not.toContain('owner');
    expect(target.display).not.toContain('super-secret');
    expect(target.display).not.toContain('sslmode');
  });

  it('allows a clearly test-named database even when it is remote', () => {
    expect(inspectSeedTarget('postgresql://owner:secret@db.example.com/hermes_test')).toMatchObject({
      local: false,
      test: true,
    });
  });

  it('refuses a remote non-test database without echoing its credential', () => {
    const url = 'postgres://owner:do-not-print@primary.example.com/hermes';
    expect(() => assertSeedTargetAllowed(url, undefined)).toThrow(
      'Refusing to seed non-local, non-test database postgres://primary.example.com/hermes',
    );
    try {
      assertSeedTargetAllowed(url, undefined);
    } catch (error) {
      expect(String(error)).not.toContain('do-not-print');
      expect(String(error)).toContain('HERMES_SEED_ALLOW_NONLOCAL=1');
    }
  });

  it('requires the exact exceptional override value', () => {
    const url = 'postgres://owner:secret@primary.example.com/hermes';
    expect(() => assertSeedTargetAllowed(url, 'true')).toThrow(/Refusing to seed/);
    expect(assertSeedTargetAllowed(url, '1')).toMatchObject({ exceptionalOverride: true });
  });
});
