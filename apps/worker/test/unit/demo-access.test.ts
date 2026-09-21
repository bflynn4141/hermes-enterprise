import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  demoAccessConfig,
  domainAllowed,
  parseAllowedDomains,
} from '../../src/routes/demo-access.js';
import type { Env } from '../../src/env.js';

const env = (overrides: Partial<Env> = {}): Env =>
  ({
    DEMO_ACCESS_PASSCODE: 'secret-pass',
    DEMO_ACCESS_WORKSPACE_ID: '8cb93c4c-6af3-41cd-bae5-94f849b4976b',
    DEMO_ACCESS_ALLOWED_DOMAINS: 'nousresearch.com',
    ...overrides,
  }) as Env;

describe('demo access helpers', () => {
  it('requires both a passcode and a workspace UUID before inviting anyone', () => {
    expect(demoAccessConfig(env({ DEMO_ACCESS_PASSCODE: '' }))).toBeNull();
    expect(demoAccessConfig(env({ DEMO_ACCESS_WORKSPACE_ID: 'not-a-uuid' }))).toBeNull();
    expect(demoAccessConfig(env())?.workspaceId).toBe('8cb93c4c-6af3-41cd-bae5-94f849b4976b');
  });

  it('parses an optional domain allowlist and matches exact hosts only', () => {
    expect(parseAllowedDomains(' NousResearch.com , @example.com ')).toEqual([
      'nousresearch.com',
      'example.com',
    ]);
    expect(domainAllowed('a@nousresearch.com', ['nousresearch.com'])).toBe(true);
    expect(domainAllowed('a@mail.nousresearch.com', ['nousresearch.com'])).toBe(false);
    expect(domainAllowed('a@anywhere.test', [])).toBe(true);
  });

  it('compares passcodes in constant time and rejects near-misses', async () => {
    await expect(constantTimeEqual('secret-pass', 'secret-pass')).resolves.toBe(true);
    await expect(constantTimeEqual('secret-pass', 'secret-pas')).resolves.toBe(false);
    await expect(constantTimeEqual('secret-pass', 'SECRET-PASS')).resolves.toBe(false);
  });
});
