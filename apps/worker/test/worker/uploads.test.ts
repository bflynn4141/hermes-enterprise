// The storage layer against Miniflare's local R2, in workerd.
//
// The `db` project runs the upload *routes* against real Postgres with R2 in a
// Map (decision 8: node-postgres needs `node:net`, which the Workers pool
// cannot hand to workerd). That proves the routes, the transaction and the
// tenant rules. What it cannot prove is that the R2 calls themselves are the
// ones R2 actually has — a Map will happily implement a method that does not
// exist — and that is what this file is for: the same helpers, against the real
// binding, in the real runtime.
//
// It also covers the one thing only workerd has: `crypto.DigestStream`, which
// is how a 20 MB object is hashed a chunk at a time instead of buffered.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deletePrefix, getObject, headObject, listPrefix, putObject } from '../../src/storage/r2.js';
import { deleteWorkspacePrefix } from '../../src/storage/erasure.js';
import { getDocumentText, putExtractedText, readExtractedText } from '../../src/storage/text.js';
import { textKey, uploadKey } from '../../src/storage/keys.js';
import { extractBytes, ExtractionFailure } from '../../src/queues/extract.js';
import { presign } from '../../src/storage/sigv4.js';

const workspace = '11111111-1111-4111-8111-111111111111';

/**
 * A one-page PDF with a text object, written out by hand rather than committed
 * as a binary: a fixture a reader can check is a fixture that can be trusted.
 */
const PDF_FIXTURE = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 52>>stream
BT /F1 12 Tf 20 100 Td (Hermes upload probe) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
`;


describe('R2 through the binding, in workerd', () => {
  it('binds the uploads bucket the code expects', () => {
    expect(env.UPLOADS).toBeDefined();
    // The backup bucket is bound only where it exists; `backup_uploads` logs
    // that it did nothing rather than failing forever.
    expect(env.BACKUP_UPLOADS).toBeUndefined();
    // The bucket name a presigned URL needs, which a binding cannot supply.
    expect(env.R2_BUCKET).toBe('hermes-uploads');
  });

  it('puts, heads, gets and deletes an object under a workspace key', async () => {
    const key = uploadKey(workspace, '22222222-2222-4222-8222-222222222222');
    await putObject(env, key, 'policy text', { httpMetadata: { contentType: 'text/plain' } });

    const head = await headObject(env, key);
    expect(head?.size).toBe('policy text'.length);

    const object = await getObject(env, key);
    expect(await object?.text()).toBe('policy text');

    await deletePrefix(env, `w/${workspace}/`);
    expect(await headObject(env, key)).toBeNull();
  });

  it('lists and deletes by prefix, and leaves another tenant alone', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    await putObject(env, uploadKey(workspace, 'a'), 'mine');
    await putObject(env, uploadKey(workspace, 'b'), 'mine too');
    await putObject(env, uploadKey(other, 'c'), 'someone else');

    expect(await listPrefix(env, `w/${workspace}/`)).toHaveLength(2);
    const deleted = await deleteWorkspacePrefix(env, workspace);
    expect(deleted).toBe(2);
    expect(await listPrefix(env, `w/${other}/`)).toHaveLength(1);
    await deletePrefix(env, `w/${other}/`);
  });

  it('stores extracted text next to its object and reads it back', async () => {
    const key = uploadKey(workspace, '44444444-4444-4444-8444-444444444444');
    await putObject(env, key, '# Policy');
    const counters = await putExtractedText(env, key, '# Policy');
    expect(counters).toEqual({ textLength: 8, tokenEstimate: 2 });
    expect(await readExtractedText(env, key)).toBe('# Policy');
    // Always `{key}.txt`, which is what makes deleting the pair one call.
    expect(await headObject(env, textKey(key))).not.toBeNull();
    await deletePrefix(env, `w/${workspace}/`);
  });
});

describe('extraction in workerd', () => {
  it('decodes text and markdown', async () => {
    const bytes = new TextEncoder().encode('Leah Martínez — 2026 ✓');
    expect(await extractBytes('text/plain', bytes)).toBe('Leah Martínez — 2026 ✓');
    expect(await extractBytes('text/markdown', bytes)).toBe('Leah Martínez — 2026 ✓');
  });

  // This is the plan's pdfjs-under-workerd spike, kept as a test. Section 4
  // marked it **unverified**; it is verified here, in the runtime that has to
  // run it, so a future runtime or library upgrade that breaks it fails CI
  // rather than quietly producing empty documents.
  it('parses a real PDF with unpdf, in the Workers runtime', async () => {
    const text = await extractBytes('application/pdf', new TextEncoder().encode(PDF_FIXTURE));
    expect(text).toContain('Hermes upload probe');
  });

  it('fails with a reason rather than an empty document when a PDF is unreadable', async () => {
    // `complete` lets this through — it begins `%PDF-` — and the consumer is
    // where it becomes an honest `failed` with a reason on the row.
    await expect(extractBytes('application/pdf', new TextEncoder().encode('%PDF-1.7\ntruncated'))).rejects.toBeInstanceOf(
      ExtractionFailure,
    );
  });

  it('refuses an object over the 20 MB cutoff without decoding it', async () => {
    await expect(extractBytes('text/plain', new Uint8Array(21 * 1024 * 1024))).rejects.toThrow(/cutoff/);
  });
});

describe('the pieces the Node projects cannot reach', () => {
  it('has the streaming digest a 20 MB hash depends on', () => {
    // The buffered fallback in attachments/service.ts exists for Node; workerd
    // is where the streaming path actually runs.
    expect((crypto as { DigestStream?: unknown }).DigestStream).toBeDefined();
  });

  it('signs a presigned URL with the runtime s own Web Crypto', async () => {
    const { url, expiresAt } = await presign({
      accountId: 'acct',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      bucket: 'hermes-uploads',
      key: uploadKey(workspace, 'abc'),
      method: 'PUT',
      expiresIn: 900,
      now: new Date('2026-09-14T12:00:00.000Z'),
    });
    expect(new URL(url).searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt.toISOString()).toBe('2026-09-14T12:15:00.000Z');
  });

  it('refuses to hand the engine text for a document that does not exist', async () => {
    // Reaches Postgres through Hyperdrive; what is asserted is that it refuses
    // rather than returning an empty page, whatever the database says.
    await expect(getDocumentText(env, workspace, '55555555-5555-4555-8555-555555555555')).rejects.toThrow();
  });
});
