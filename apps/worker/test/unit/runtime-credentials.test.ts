import { describe, expect, it } from 'vitest';
import {
  constantTimeDigestEqual,
  newRuntimeBearer,
  requireDigestBearer,
  runtimeCredentialDigest,
} from '../../src/runtime/credentials.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';

describe('runtime discovery credentials', () => {
  it('generates a 32-byte bearer and stores only its tenant-and-identity scoped digest', async () => {
    const token = newRuntimeBearer();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const digest = await runtimeCredentialDigest(WORKSPACE, AGENT, token);
    expect(digest).toHaveLength(32);
    expect(Buffer.from(digest).toString('hex')).not.toBe(token);
    expect(constantTimeDigestEqual(digest, await runtimeCredentialDigest(WORKSPACE, AGENT, token))).toBe(true);
    expect(constantTimeDigestEqual(
      digest,
      await runtimeCredentialDigest('33333333-3333-4333-8333-333333333333', AGENT, token),
    )).toBe(false);
    expect(constantTimeDigestEqual(
      digest,
      await runtimeCredentialDigest(WORKSPACE, '44444444-4444-4444-8444-444444444444', token),
    )).toBe(false);
  });

  it('rejects malformed, replayed, and cross-tenant bearer values', async () => {
    const token = newRuntimeBearer();
    const digest = await runtimeCredentialDigest(WORKSPACE, AGENT, token);
    await expect(requireDigestBearer(digest, WORKSPACE, AGENT, `Bearer ${token}`)).resolves.toBeUndefined();
    await expect(requireDigestBearer(
      digest,
      '33333333-3333-4333-8333-333333333333',
      AGENT,
      `Bearer ${token}`,
    )).rejects.toMatchObject({ reason: 'runtime_unauthorized' });
    await expect(requireDigestBearer(digest, WORKSPACE, AGENT, 'Bearer short'))
      .rejects.toMatchObject({ reason: 'runtime_unauthorized' });
    await expect(requireDigestBearer(digest, WORKSPACE, AGENT, null))
      .rejects.toMatchObject({ reason: 'runtime_unauthorized' });
  });
});
