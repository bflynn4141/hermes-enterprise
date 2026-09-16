import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldEmitSourceMaps } from '../scripts/build-policy.mjs';
import { removePrivateTempFile, writePrivateTempFile } from '../scripts/private-temp-file.mjs';

describe('client build policy', () => {
  it('omits production maps and preserves maps for local development and tests', () => {
    expect(shouldEmitSourceMaps({ watch: false, mock: false, authMode: 'workos' })).toBe(false);
    expect(shouldEmitSourceMaps({ watch: true, mock: false, authMode: 'workos' })).toBe(true);
    expect(shouldEmitSourceMaps({ watch: false, mock: true, authMode: 'workos' })).toBe(true);
    expect(shouldEmitSourceMaps({ watch: false, mock: false, authMode: 'fake' })).toBe(true);
  });
});

describe('secret-bearing temporary files', () => {
  it('replace a stale file as mode 0600 and remove it idempotently', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'hermes-private-file-'));
    const file = path.join(directory, '.dev.vars.test');
    try {
      writePrivateTempFile(file, 'SECRET="first"\n');
      expect(statSync(file).mode & 0o777).toBe(0o600);

      writePrivateTempFile(file, 'SECRET="second"\n');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, 'utf8')).toBe('SECRET="second"\n');

      removePrivateTempFile(file);
      removePrivateTempFile(file);
      expect(() => statSync(file)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
