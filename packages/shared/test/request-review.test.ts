import { describe, expect, it } from 'vitest';
import { requestReviewBinding, type ReviewableRequest } from '../src/index.js';

const request: ReviewableRequest = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'invoice',
  version: 1789776000,
  payload: { payee: { name: 'Renée', email: 'renee@example.test' }, lines: [{ amount_minor: 90000, label: 'Work' }] },
};

describe('the request a document reviewer read', () => {
  it('returns the version unchanged and a deterministic SHA-256 digest', async () => {
    const binding = await requestReviewBinding(request);
    expect(binding.expected_version).toBe(request.version);
    expect(binding.expected_payload_hash).toBe('sha256:c9ff0e82f58583c68ce86450c1e0572bdc43218c1b98568c075427fff30ca9ba');
    expect(await requestReviewBinding(request)).toEqual(binding);
  });

  it('ignores object key order at every level', async () => {
    expect(await requestReviewBinding({
      ...request,
      payload: { lines: [{ label: 'Work', amount_minor: 90000 }], payee: { email: 'renee@example.test', name: 'Renée' } },
    })).toEqual(await requestReviewBinding(request));
  });

  it('catches payload edits even when the timestamp version is unchanged', async () => {
    const before = await requestReviewBinding(request);
    const after = await requestReviewBinding({ ...request, payload: { amount_minor: 100000 } });
    expect(after.expected_version).toBe(before.expected_version);
    expect(after.expected_payload_hash).not.toBe(before.expected_payload_hash);
  });

  it('binds the request identity and kind, but returns the version separately', async () => {
    const before = await requestReviewBinding(request);
    expect((await requestReviewBinding({ ...request, id: 'another-request' })).expected_payload_hash)
      .not.toBe(before.expected_payload_hash);
    expect((await requestReviewBinding({ ...request, kind: 'agreement' })).expected_payload_hash)
      .not.toBe(before.expected_payload_hash);
    expect(await requestReviewBinding({ ...request, version: request.version + 1 }))
      .toEqual({ ...before, expected_version: request.version + 1 });
  });

  it('preserves array order and JSON value types', async () => {
    const digest = async (payload: unknown) => (await requestReviewBinding({ ...request, payload })).expected_payload_hash;
    expect(await digest(['first', 'second'])).not.toBe(await digest(['second', 'first']));
    expect(await digest({ amount: '90000' })).not.toBe(await digest({ amount: 90000 }));
    expect(await digest({ value: null })).not.toBe(await digest({ value: false }));
  });

  it('rejects values that cannot arrive in a JSON request payload', async () => {
    for (const payload of [undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(), { missing: undefined }]) {
      await expect(requestReviewBinding({ ...request, payload })).rejects.toThrow('requires JSON data');
    }
  });
});
