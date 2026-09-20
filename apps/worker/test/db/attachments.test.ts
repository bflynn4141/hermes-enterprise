// Uploads, end to end against the real Worker, the real routes and real
// Postgres, with R2 in a Map (test/stubs/fake-r2.ts).
//
// What these prove, in order of how much they would cost to get wrong:
//
//   * a file that lies about what it is does not become a document. A renamed
//     executable declared as text is refused, the row says why, and the object
//     is deleted rather than left for the sweep;
//   * a size that disagrees with the declaration is refused the same way;
//   * the sha256 on the row is the sha256 of the bytes, not of what was
//     declared about them;
//   * ten uploads a minute, per user;
//   * an exhausted extraction writes `failed` with a reason, so a row never
//     says "preparing" forever;
//   * the extracted text is capped at 6,000 tokens per read.
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import worker from '../../src/index.js';
import { ALLOWED_ORIGIN, asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, type Fixture, withClient } from './helpers.js';
import { FakeQueue, FakeR2, fakeBatch } from '../stubs/fake-r2.js';
import { handleQueue } from '../../src/queues/index.js';
import { DLQ_REASON } from '../../src/queues/dlq.js';
import { getDocumentText } from '../../src/storage/text.js';
import { sweepOrphanedUploads } from '../../src/storage/lifecycle.js';
import { deleteAttachment, deleteWorkspacePrefix } from '../../src/storage/erasure.js';
import { uploadKey, textKey } from '../../src/storage/keys.js';

let env: Env;
let bucket: FakeR2;
let queue: FakeQueue;
let fx: Fixture;

beforeEach(async () => {
  bucket = new FakeR2();
  queue = new FakeQueue();
  env = makeEnv({ UPLOADS: bucket as unknown as R2Bucket, EXTRACT_QUEUE: queue as unknown as Queue } as Partial<Env>)
    .env;
  fx = await seedWorkspace();
});

afterEach(() => {
  bucket.objects.clear();
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');


/**
 * A PUT with a real body.
 *
 * `harness.call` JSON-encodes whatever it is given, which is right for every
 * other route in this repository and wrong for the one route that carries
 * bytes. This is the same request, built by hand.
 */
function putBytes(path: string, mime: string, body: Uint8Array): Promise<Response> {
  const request = new Request(`${ALLOWED_ORIGIN}${path}`, {
    method: 'PUT',
    headers: { 'content-type': mime, 'content-length': String(body.byteLength), 'x-dev-user': fx.adminId, origin: ALLOWED_ORIGIN },
    body: body as unknown as BodyInit,
  });
  return Promise.resolve(
    worker.fetch(request, env, {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext),
  );
}

/** Declare, upload through the dev route, complete. The happy path, once. */
async function upload(
  name: string,
  mime: string,
  body: Uint8Array,
  options: { size?: number; skipUpload?: boolean } = {},
): Promise<{ id: string; complete: Response }> {
  const declared = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/attachments`, {
    method: 'POST',
    body: { name, size: options.size ?? body.byteLength, mime },
  });
  expect(declared.status, await declared.clone().text()).toBe(201);
  const { attachment, upload: target } = (await declared.json()) as {
    attachment: { id: string };
    upload: { url: string; direct: boolean };
  };
  // No S3 credentials in the test env, so the route hands back its own dev-only
  // upload URL rather than a presigned one.
  expect(target.direct).toBe(true);

  if (!options.skipUpload) {
    const put = await putBytes(new URL(target.url).pathname, mime, body);
    expect(put.status, await put.clone().text()).toBe(200);
  }

  const complete = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/attachments/${attachment.id}/complete`, {
    method: 'POST',
  });
  return { id: attachment.id, complete };
}

const rowOf = (id: string): Promise<Record<string, unknown> | undefined> =>
  readTenant(fx.workspaceId, fx.adminId, async (c) => {
    const { rows } = await c.query(`SELECT * FROM attachments WHERE id = $1`, [id]);
    return rows[0];
  });

describe('O7 - the session an attachment names', () => {
  it('must be one the caller owns, not any session in the workspace', async () => {
    // `attachments.session_id` was client-supplied and written unchecked. Row-
    // level security kept it inside the workspace, but inside a workspace it
    // named *any* session — so a member could hang a file off somebody else's
    // conversation, where it renders in their transcript and is read by their
    // runs.
    const response = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/attachments`, {
      method: 'POST',
      // `fx.sessionId` belongs to the Admin (see test/db/helpers.ts).
      body: { name: 'policy.md', size: 120, mime: 'text/markdown', session_id: fx.sessionId },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: 'unknown_session' });
  });

  it('is accepted when it is the caller’s own', async () => {
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/attachments`, {
      method: 'POST',
      body: { name: 'policy.md', size: 120, mime: 'text/markdown', session_id: fx.sessionId },
    });
    expect(response.status).toBe(201);
  });

  it('is accepted when there is none, because a file need not belong to a conversation', async () => {
    const response = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/attachments`, {
      method: 'POST',
      body: { name: 'policy.md', size: 120, mime: 'text/markdown' },
    });
    expect(response.status).toBe(201);
  });
});

describe('declaring an upload', () => {
  it('writes an uploading row and a key inside this workspace', async () => {
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/attachments`, {
      method: 'POST',
      body: { name: 'policy.md', size: 120, mime: 'text/markdown' },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { attachment: { id: string; status: string } };
    const row = await rowOf(body.attachment.id);
    expect(row?.status).toBe('uploading');
    // The workspace is the first segment of the key, which is what makes
    // erasure a prefix delete and the orphan sweep tenant-safe.
    expect(row?.storage_key).toBe(uploadKey(fx.workspaceId, body.attachment.id));
  });

  it('refuses a file over 20 MB before a byte is uploaded', async () => {
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/attachments`, {
      method: 'POST',
      body: { name: 'huge.pdf', size: 21 * 1024 * 1024, mime: 'application/pdf' },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ reason: 'too_large' });
  });

  it('refuses a type with no extraction path', async () => {
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/attachments`, {
      method: 'POST',
      body: { name: 'photo.png', size: 10, mime: 'image/png' },
    });
    expect(response.status).toBe(400);
  });

  it('limits one person to ten uploads a minute', async () => {
    const declare = (): Promise<Response> =>
      asUser(env, fx.adminId, `/w/${fx.workspaceId}/attachments`, {
        method: 'POST',
        body: { name: 'notes.txt', size: 10, mime: 'text/plain' },
      });

    // Seed both the active bucket and the next one. This keeps the boundary
    // assertion deterministic even when CI happens to cross a minute between
    // arranging the counter and issuing the request.
    const setNearbyCounts = (count: number): Promise<void> =>
      withClient('owner', async (client) => {
        await client.query(
          `INSERT INTO rate_counters (user_id, workspace_id, action, window_start, count)
           SELECT $1, $2, 'attachment.create',
                  to_timestamp(floor(extract(epoch FROM now()) / 60) * 60) + bucket_offset * interval '60 seconds',
                  $3
             FROM generate_series(0, 1) AS bucket_offset
           ON CONFLICT (user_id, action, window_start, workspace_id)
             DO UPDATE SET count = EXCLUDED.count`,
          [fx.adminId, fx.workspaceId, count],
        );
      });

    await setNearbyCounts(9);
    expect((await declare()).status).toBe(201);
    await setNearbyCounts(10);
    const refused = await declare();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ reason: 'rate_limited' });
    // Per user, not per workspace: the Member has their own budget.
    const other = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/attachments`, {
      method: 'POST',
      body: { name: 'notes.txt', size: 10, mime: 'text/plain' },
    });
    expect(other.status).toBe(201);
  });

  it('refuses a non-member, without saying the workspace exists', async () => {
    const stranger = randomUUID();
    const response = await asUser(env, stranger, `/w/${fx.workspaceId}/attachments`, {
      method: 'POST',
      body: { name: 'notes.txt', size: 10, mime: 'text/plain' },
    });
    expect([401, 404]).toContain(response.status);
  });
});

describe('completing an upload', () => {
  it('hashes the bytes and marks the row ready', async () => {
    const bytes = new TextEncoder().encode('# Admissions policy\n\nOne per cohort.\n');
    const { id, complete } = await upload('policy.md', 'text/markdown', bytes);
    expect(complete.status).toBe(200);
    expect(await complete.json()).toMatchObject({ status: 'ready', sha256: sha256(bytes) });

    const row = await rowOf(id);
    expect(row?.status).toBe('ready');
    expect(row?.sha256).toBe(sha256(bytes));
    expect(row?.completed_at).not.toBeNull();
  });

  it('enqueues exactly one extraction, after the commit', async () => {
    await upload('notes.txt', 'text/plain', new TextEncoder().encode('hello'));
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toMatchObject({ kind: 'attachment', workspace_id: fx.workspaceId, mime: 'text/plain' });
  });

  it('refuses a renamed executable and deletes the object', async () => {
    // A Mach-O binary called notes.txt, declared as text/plain. The named case
    // in the plan.
    const macho = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01, 0x03, 0x00]);
    const { id, complete } = await upload('notes.txt', 'text/plain', macho);
    expect(complete.status).toBe(422);
    expect(await complete.json()).toMatchObject({ reason: 'magic_mismatch' });

    const row = await rowOf(id);
    expect(row?.status).toBe('failed');
    expect(String(row?.status_reason)).toContain('magic_mismatch');
    // The bytes go with the refusal: leaving them for the sweep means a binary
    // sits in the workspace's store for a day.
    expect(bucket.objects.has(uploadKey(fx.workspaceId, id))).toBe(false);
    expect(queue.sent).toHaveLength(0);
  });

  it('refuses a PDF that is not a PDF', async () => {
    const { complete } = await upload('offer.pdf', 'application/pdf', new TextEncoder().encode('Dear Leah,'));
    expect(complete.status).toBe(422);
    expect(await complete.json()).toMatchObject({ reason: 'magic_mismatch' });
  });

  it('refuses bytes whose size disagrees with the declaration', async () => {
    const bytes = new TextEncoder().encode('four');
    const { id, complete } = await upload('notes.txt', 'text/plain', bytes, { size: 4000 });
    expect(complete.status).toBe(422);
    expect(await complete.json()).toMatchObject({ reason: 'size_mismatch' });
    expect((await rowOf(id))?.status).toBe('failed');
  });

  it('refuses to complete an upload whose bytes never arrived', async () => {
    const { complete } = await upload('notes.txt', 'text/plain', new TextEncoder().encode('hi'), {
      skipUpload: true,
    });
    expect(complete.status).toBe(409);
    expect(await complete.json()).toMatchObject({ reason: 'no_object' });
  });

  it('is idempotent, because two tabs finishing one upload is one completion', async () => {
    const bytes = new TextEncoder().encode('hello');
    const { id } = await upload('notes.txt', 'text/plain', bytes);
    const again = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/attachments/${id}/complete`, {
      method: 'POST',
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: 'ready', sha256: sha256(bytes) });
  });
});

describe('reading and removing', () => {
  it('answers metadata, with no URL where none can be signed', async () => {
    const { id } = await upload('policy.md', 'text/markdown', new TextEncoder().encode('# hi\n'));
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/attachments/${id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id,
      kind: 'attachment',
      status: 'ready',
      extraction_status: 'pending',
      // No S3 credentials in this environment, so no viewer URL. The client
      // renders the row; it does not get a broken link.
      url: null,
    });
  });

  it('soft-deletes the row and removes both objects', async () => {
    const { id } = await upload('policy.md', 'text/markdown', new TextEncoder().encode('# hi\n'));
    const key = uploadKey(fx.workspaceId, id);
    await bucket.put(textKey(key), '# hi');

    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/attachments/${id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);

    const row = await rowOf(id);
    // Soft: a message may still reference it, and History has to keep rendering.
    expect(row?.status).toBe('deleted');
    expect(row?.deleted_at).not.toBeNull();
    expect(bucket.objects.has(key)).toBe(false);
    expect(bucket.objects.has(textKey(key))).toBe(false);

    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/attachments/${id}`)).status).toBe(404);
  });

  it('hides one workspace s attachment from another', async () => {
    const { id } = await upload('policy.md', 'text/markdown', new TextEncoder().encode('# hi\n'));
    const other = await seedWorkspace();
    const response = await asUser(env, other.adminId, `/w/${other.workspaceId}/attachments/${id}`);
    expect(response.status).toBe(404);
  });
});

describe('the extract consumer', () => {
  it('turns markdown into text, records both counters, and reads back paged', async () => {
    const source = `# Policy\n\n${'One applicant per cohort. '.repeat(2000)}`;
    const { id } = await upload('policy.md', 'text/markdown', new TextEncoder().encode(source));
    const { batch, acked } = fakeBatch('hermes-extract', queue.sent);
    await handleQueue(batch, env);
    expect(acked).toHaveLength(1);

    const row = await rowOf(id);
    expect(row?.extraction_status).toBe('ready');
    expect(Number(row?.text_length)).toBe(source.length);
    expect(Number(row?.token_estimate)).toBe(Math.ceil(source.length / 4));

    const page = await getDocumentText(env, fx.workspaceId, id);
    // The cap the engine's tool relies on: at most 6,000 estimated tokens per
    // call, plus the offset to ask for next.
    expect(page.token_estimate).toBeLessThanOrEqual(6000);
    expect(page.truncated).toBe(true);
    expect(page.next_offset).toBeGreaterThan(0);
    expect(page.total_length).toBe(source.length);

    const second = await getDocumentText(env, fx.workspaceId, id, page.next_offset ?? 0);
    expect(second.offset).toBe(page.next_offset);
  });

  it('records a reason rather than an empty document when a PDF cannot be parsed', async () => {
    // It begins `%PDF-`, so `complete` accepts it; the consumer is where it
    // becomes an honest `failed` the reviewer can read. A row that said `ready`
    // with no text is the failure this test exists to prevent.
    const pdf = new TextEncoder().encode('%PDF-1.7\nnot really a pdf\n%%EOF');
    const { id } = await upload('offer.pdf', 'application/pdf', pdf);
    const { batch } = fakeBatch('hermes-extract', queue.sent);
    await handleQueue(batch, env);

    const row = await rowOf(id);
    expect(row?.extraction_status).toBe('failed');
    expect(String(row?.extraction_error).length).toBeGreaterThan(0);
  });

  it('refuses to hand the engine text that is not ready', async () => {
    const { id } = await upload('offer.pdf', 'application/pdf', new TextEncoder().encode('%PDF-1.7\n'));
    await expect(getDocumentText(env, fx.workspaceId, id)).rejects.toThrow();
  });
});

describe('the dead-letter consumer', () => {
  it('writes failed with a reason, so a row never says preparing forever', async () => {
    const { id } = await upload('notes.txt', 'text/plain', new TextEncoder().encode('hello'));
    const { batch, acked, retried } = fakeBatch('hermes-extract-dlq', queue.sent);
    await handleQueue(batch, env);

    // The end of the line: everything is acked, nothing is retried.
    expect(acked).toHaveLength(1);
    expect(retried).toHaveLength(0);

    const row = await rowOf(id);
    expect(row?.extraction_status).toBe('failed');
    expect(row?.extraction_error).toBe(DLQ_REASON);
  });

  it('acks a message it cannot parse rather than letting it come back', async () => {
    const { batch, acked } = fakeBatch('hermes-extract-dlq', [{ nonsense: true }]);
    await handleQueue(batch, env);
    expect(acked).toHaveLength(1);
  });
});

describe('lifecycle and erasure', () => {
  it('deletes an object with no completed row after 24 hours, and spares a fresh one', async () => {
    const { id: abandoned } = await upload('notes.txt', 'text/plain', new TextEncoder().encode('hello'), {
      skipUpload: true,
    });
    // The bytes landed; `complete` never ran, which is exactly the case the
    // sweep exists for.
    const orphanKey = uploadKey(fx.workspaceId, abandoned);
    bucket.now = () => new Date(Date.now() - 48 * 60 * 60 * 1000);
    await bucket.put(orphanKey, 'hello');
    bucket.now = () => new Date();

    const { id: kept } = await upload('policy.md', 'text/markdown', new TextEncoder().encode('# hi\n'));

    const result = await sweepOrphanedUploads(env);
    expect(result.deleted).toBe(1);
    expect(bucket.objects.has(orphanKey)).toBe(false);
    // A completed row is accounted for; a recent object is too young to judge.
    expect(bucket.objects.has(uploadKey(fx.workspaceId, kept))).toBe(true);
  });

  it('deletes one attachment s object and its extracted text together', async () => {
    const { id } = await upload('policy.md', 'text/markdown', new TextEncoder().encode('# hi\n'));
    const key = uploadKey(fx.workspaceId, id);
    await bucket.put(textKey(key), '# hi');

    await deleteAttachment(env, fx.workspaceId, id);
    expect(bucket.objects.has(key)).toBe(false);
    // Leaving the .txt behind would leave the document's contents in the store
    // under a key derived from the one we just deleted.
    expect(bucket.objects.has(textKey(key))).toBe(false);
  });

  it('deletes a whole workspace prefix and touches no other tenant', async () => {
    await upload('policy.md', 'text/markdown', new TextEncoder().encode('# hi\n'));
    await bucket.put(`w/${randomUUID()}/uploads/${randomUUID()}`, 'someone else');
    const before = bucket.objects.size;

    const deleted = await deleteWorkspacePrefix(env, fx.workspaceId);
    expect(deleted).toBeGreaterThan(0);
    expect(bucket.objects.size).toBe(before - deleted);
    expect([...bucket.objects.keys()].some((key) => key.startsWith(`w/${fx.workspaceId}/`))).toBe(false);
  });
});

describe('agent files reuse the same path', () => {
  /** The Context pane's upload, which is the same three calls with a different table. */
  async function uploadFile(name: string, mime: string, body: Uint8Array, as = fx.adminId): Promise<Response> {
    const declared = await asUser(env, as, `/w/${fx.workspaceId}/files`, {
      method: 'POST',
      body: { name, size: body.byteLength, mime, agent_id: fx.agentId },
    });
    if (declared.status !== 201) return declared;
    const { attachment, upload: target } = (await declared.json()) as {
      attachment: { id: string };
      upload: { url: string };
    };
    await putBytes(new URL(target.url).pathname, mime, body);
    return asUser(env, as, `/w/${fx.workspaceId}/files/${attachment.id}/complete`, { method: 'POST' });
  }

  it('sniffs, hashes and extracts a Context source exactly as it does an attachment', async () => {
    const bytes = new TextEncoder().encode('# Rubric\n\nOne per cohort.\n');
    const completed = await uploadFile('rubric.md', 'text/markdown', bytes);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ status: 'ready', sha256: sha256(bytes) });

    const { batch } = fakeBatch('hermes-extract', queue.sent);
    await handleQueue(batch, env);

    const listed = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/files?agent_id=${fx.agentId}`);
    const body = (await listed.json()) as { items: { kind: string; extraction_status: string; url: string | null }[] };
    expect(body.items[0]).toMatchObject({ kind: 'agent_file', extraction_status: 'ready' });
    // A presigned GET is a bearer credential; a list does not mint two hundred
    // of them nobody asked for.
    expect(body.items[0]?.url).toBeNull();
  });

  it('refuses a renamed executable here too', async () => {
    const macho = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]);
    const completed = await uploadFile('rubric.md', 'text/markdown', macho);
    expect(completed.status).toBe(422);
    expect(await completed.json()).toMatchObject({ reason: 'magic_mismatch' });
  });

  it('is an Admin s to change, because Context governs every future run', async () => {
    const response = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/files`, {
      method: 'POST',
      body: { name: 'rubric.md', size: 10, mime: 'text/markdown' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: 'admin_required' });
  });

  it('lets any member read an explicitly workspace-shared Context list', async () => {
    expect((await asUser(env, fx.memberId, `/w/${fx.workspaceId}/files?agent_id=${fx.agentId}`)).status).toBe(200);
  });
});
