// The presigned URL: shape, expiry, and the two things a signature must bind.
//
// There is no R2 here and no network. What is checked is that the URL carries
// every parameter S3 requires, that the expiry is the plan's fifteen minutes,
// and that the signature actually changes when the method or the key changes —
// because a signature that did not would mean a URL minted for a PUT could be
// replayed as a DELETE, and a URL for one object pointed at another.
import { describe, expect, it } from 'vitest';
import { amzDates, encodeRfc3986, presign } from '../../src/storage/sigv4.js';
import { ATTACHMENT_PRESIGN_SECONDS, ATTACHMENT_VIEW_SECONDS } from '@hermes/shared';

const credentials = {
  accountId: 'acct1234567890',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'not-a-real-secret',
  bucket: 'hermes-uploads',
} as const;

const at = new Date('2026-09-14T12:00:00.000Z');

describe('presigned URLs', () => {
  it('addresses the object through R2 s S3 endpoint, bucket in the path', async () => {
    const { url } = await presign({
      ...credentials,
      key: 'w/11111111-1111-4111-8111-111111111111/uploads/abc',
      method: 'PUT',
      expiresIn: ATTACHMENT_PRESIGN_SECONDS,
      now: at,
    });
    expect(url.startsWith('https://acct1234567890.r2.cloudflarestorage.com/hermes-uploads/')).toBe(true);
    expect(url).toContain('/w/11111111-1111-4111-8111-111111111111/uploads/abc?');
  });

  it('carries every parameter SigV4 requires, in sorted order', async () => {
    const { url } = await presign({ ...credentials, key: 'k', method: 'PUT', expiresIn: 900, now: at });
    const query = new URL(url).searchParams;
    expect(query.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(query.get('X-Amz-Credential')).toBe('AKIAEXAMPLE/20260914/auto/s3/aws4_request');
    expect(query.get('X-Amz-Date')).toBe('20260914T120000Z');
    expect(query.get('X-Amz-Expires')).toBe('900');
    expect(query.get('X-Amz-SignedHeaders')).toBe('host');
    expect(query.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);

    // S3 rejects a canonical query that is not byte-sorted, and the failure is
    // a 403 that looks like a bad credential.
    const names = [...new URL(url).searchParams.keys()].filter((n) => n !== 'X-Amz-Signature');
    expect(names).toEqual([...names].sort());
  });

  it('expires fifteen minutes after it was minted, and a viewer URL in five', async () => {
    const put = await presign({ ...credentials, key: 'k', method: 'PUT', expiresIn: ATTACHMENT_PRESIGN_SECONDS, now: at });
    expect(put.expiresAt.getTime() - at.getTime()).toBe(15 * 60 * 1000);
    expect(ATTACHMENT_PRESIGN_SECONDS).toBe(900);

    const get = await presign({ ...credentials, key: 'k', method: 'GET', expiresIn: ATTACHMENT_VIEW_SECONDS, now: at });
    expect(get.expiresAt.getTime() - at.getTime()).toBe(5 * 60 * 1000);
  });

  it('binds the method, so a PUT URL is not also a DELETE URL', async () => {
    const put = await presign({ ...credentials, key: 'k', method: 'PUT', expiresIn: 900, now: at });
    const del = await presign({ ...credentials, key: 'k', method: 'DELETE', expiresIn: 900, now: at });
    expect(signatureOf(put.url)).not.toBe(signatureOf(del.url));
  });

  it('binds the key, so a URL for one object cannot be pointed at another', async () => {
    const mine = await presign({ ...credentials, key: 'w/a/uploads/1', method: 'PUT', expiresIn: 900, now: at });
    const yours = await presign({ ...credentials, key: 'w/b/uploads/1', method: 'PUT', expiresIn: 900, now: at });
    expect(signatureOf(mine.url)).not.toBe(signatureOf(yours.url));
  });

  it('binds the extra parameters a viewer URL carries', async () => {
    const plain = await presign({ ...credentials, key: 'k', method: 'GET', expiresIn: 300, now: at });
    const named = await presign({
      ...credentials,
      key: 'k',
      method: 'GET',
      expiresIn: 300,
      now: at,
      query: { 'response-content-disposition': 'inline; filename="policy.pdf"' },
    });
    expect(signatureOf(plain.url)).not.toBe(signatureOf(named.url));
  });

  it('is deterministic for the same inputs, which is what makes it testable at all', async () => {
    const one = await presign({ ...credentials, key: 'k', method: 'PUT', expiresIn: 900, now: at });
    const two = await presign({ ...credentials, key: 'k', method: 'PUT', expiresIn: 900, now: at });
    expect(one.url).toBe(two.url);
  });

  it('encodes the characters encodeURIComponent leaves alone', () => {
    // A filename with an apostrophe would otherwise sign one string and be sent
    // as another: a 403 only some files get.
    expect(encodeRfc3986("it's (a) file*")).toBe('it%27s%20%28a%29%20file%2A');
    expect(encodeRfc3986('a/b')).toBe('a%2Fb');
  });

  it('formats both date forms the signature needs', () => {
    expect(amzDates(at)).toEqual({ amzDate: '20260914T120000Z', dateStamp: '20260914' });
  });
});

const signatureOf = (url: string): string => new URL(url).searchParams.get('X-Amz-Signature') ?? '';
