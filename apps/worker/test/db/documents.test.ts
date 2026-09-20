// The Library: drafts, saved documents, and the render.
import { describe, expect, it } from 'vitest';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, type Fixture } from './helpers.js';
import { FakeQueue, FakeR2, fakeBatch } from '../stubs/fake-r2.js';
import { fetchReviewBinding, INBOX_HEADERS, seedRequest } from './m4-fixtures.js';
import { rendersBatch } from '../../src/queues/renders.js';
import { PDF_UNAVAILABLE_REASON } from '../../src/documents/render.js';

function env() {
  const bucket = new FakeR2();
  const queue = new FakeQueue();
  const made = makeEnv({ UPLOADS: bucket, RENDERS_QUEUE: queue, R2_BUCKET: 'hermes-uploads' } as never);
  return { ...made, bucket, queue };
}

const approve = async (e: ReturnType<typeof env>, fx: Fixture, requestId: string) =>
  asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
    method: 'POST',
    headers: INBOX_HEADERS,
    body: { decision: 'approve', ...await fetchReviewBinding(e.env, fx, requestId) },
  });

describe('GET /w/:ws/documents', () => {
  it('lists a pending invoice as a draft awaiting review, and the decision saves it', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'invoice');

    const before = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/documents`);
    const draftList = (await before.json()) as { items: { id: string; status: string; version: number }[] };
    expect(draftList.items).toHaveLength(1);
    expect(draftList.items[0]).toMatchObject({ id: requestId, status: 'Draft · Awaiting review', version: 0 });

    expect((await approve(e, fx, requestId)).status).toBe(201);

    const after = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/documents`);
    const savedList = (await after.json()) as { items: { status: string; version: number; kind: string }[] };
    expect(savedList.items).toHaveLength(1);
    expect(savedList.items[0]?.version).toBe(1);
    // The sentence the demo put under every saved document.
    expect(savedList.items[0]?.status).toContain('Not sent');
    expect(savedList.items[0]?.status).toContain('No money moved');
  });
});

describe('the renders consumer', () => {
  it('renders the payload to HTML, marks the row ready, and says there is no PDF', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'invoice');
    await approve(e, fx, requestId);

    // The decision wrote the job; the job sent the message.
    expect(e.queue.sent).toHaveLength(1);
    const message = e.queue.sent[0] as { document_id: string; version: number };

    const { batch, acked } = fakeBatch('hermes-renders', [message]);
    await rendersBatch(batch, e.env);
    expect(acked).toHaveLength(1);

    const row = await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      const { rows } = await c.query<{
        render_status: string;
        pdf_status: string;
        pdf_error: string;
        storage_key: string;
      }>(`SELECT render_status, pdf_status, pdf_error, storage_key FROM documents WHERE id = $1`, [
        message.document_id,
      ]);
      return rows[0]!;
    });
    expect(row.render_status).toBe('ready');
    // Two statuses because they have two different answers, and saying so is
    // better than one column that would have to lie about one of them.
    expect(row.pdf_status).toBe('unavailable');
    expect(row.pdf_error).toBe(PDF_UNAVAILABLE_REASON);
    expect(row.storage_key).toBe(`w/${fx.workspaceId}/documents/${message.document_id}/v1.html`);

    const object = e.bucket.objects.get(row.storage_key);
    const html = new TextDecoder().decode(object!.bytes);
    expect(html).toContain('Invoice INV-2026-014');
    expect(html).toContain('Robin Ellis');
    // Intl puts a non-breaking space between the code and the amount.
    expect(html).toMatch(/USD\s900\.00/);
    expect(html).toContain('Not sent · No money moved');

    // A second delivery of the same message renders nothing again: queues are
    // at-least-once and `(document_id, version)` is the dedupe key.
    const second = fakeBatch('hermes-renders', [message]);
    await rendersBatch(second.batch, e.env);
    expect(second.acked).toHaveLength(1);
    expect(e.bucket.objects.size).toBe(1);
  });

  it('serves the render through the route, and refuses one that is not ready', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'agreement');
    await approve(e, fx, requestId);
    const message = e.queue.sent[0] as { document_id: string; version: number };

    const early = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/documents/${message.document_id}/render`);
    expect(early.status).toBe(404);
    expect(((await early.json()) as { reason: string }).reason).toBe('render_pending');

    const { batch } = fakeBatch('hermes-renders', [message]);
    await rendersBatch(batch, e.env);

    // No R2 credentials in this environment, so the object is streamed through
    // the binding rather than redirected to a presigned URL.
    const response = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/documents/${message.document_id}/render`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('Agreement AGR-2026-004');
    expect(html).toContain('Not sent · Unsigned');
  });

  it('writes a reason on the row when the payload no longer validates', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const requestId = await seedRequest(fx, 'invoice', {
      // Passes the decision (which does not re-validate) and fails the render.
      payload: { kind: 'invoice', number: 'INV-BROKEN' },
    });
    await approve(e, fx, requestId);
    const message = e.queue.sent[0] as { document_id: string };

    const { batch, acked, retried } = fakeBatch('hermes-renders', [message]);
    await rendersBatch(batch, e.env);
    // Permanent, so it is acked with a reason rather than retried into the DLQ.
    expect(acked).toHaveLength(1);
    expect(retried).toHaveLength(0);

    const row = await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      const { rows } = await c.query<{ render_status: string; render_error: string }>(
        `SELECT render_status, render_error FROM documents WHERE id = $1`,
        [message.document_id],
      );
      return rows[0]!;
    });
    expect(row.render_status).toBe('failed');
    expect(row.render_error).toMatch(/does not match the invoice schema/);
  });
});
