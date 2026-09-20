// Request audiences are enforced on every human read projection, not only the
// Inbox. This regression uses two mutually private invoice requests so an
// Admin and a Member each prove that workspace membership and Admin setup
// authority do not confer access to the other principal's content.
import { describe, expect, it } from 'vitest';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { fetchReviewBinding, INBOX_HEADERS, invoicePayload, seedRequest } from './m4-fixtures.js';
import { FakeQueue, FakeR2 } from '../stubs/fake-r2.js';

function env() {
  const bucket = new FakeR2();
  const made = makeEnv({ UPLOADS: bucket, RENDERS_QUEUE: new FakeQueue() } as never);
  return { ...made, bucket };
}

async function setAudience(fx: Fixture, requestId: string, userId: string): Promise<void> {
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    await client.query(
      `INSERT INTO request_audiences (workspace_id, request_id, user_id, purpose)
       VALUES ($1, $2, $3, 'owner')`,
      [fx.workspaceId, requestId, userId],
    );
    await client.query('COMMIT');
  });
}

async function saveReadyDocument(
  fx: Fixture,
  requestId: string,
  createdBy: string,
): Promise<{ documentId: string; storageKey: string }> {
  return withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    await client.query(`UPDATE requests SET status = 'created' WHERE id = $1`, [requestId]);
    const storageKey = `w/${fx.workspaceId}/documents/${requestId}/v1.html`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO documents
         (workspace_id, request_id, kind, payload, storage_key, render_status, pdf_status, created_by)
       VALUES ($1, $2, 'invoice', $3::jsonb, $4, 'ready', 'unavailable', $5)
       RETURNING id`,
      [fx.workspaceId, requestId, JSON.stringify(invoicePayload('INV-MEMBER-PRIVATE')), storageKey, createdBy],
    );
    const documentId = rows[0]!.id;
    await client.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, request_id, document_id)
       VALUES ($1, 'user', $2, 'document.created', $3, $4)`,
      [fx.workspaceId, createdBy, requestId, documentId],
    );
    await client.query(
      `INSERT INTO stream_events (workspace_id, kind, payload, trace_id)
       VALUES ($1, 'entity.updated',
               jsonb_build_object('entity_type', 'document', 'entity_id', $2::text,
                                  'ref', jsonb_build_object('section', 'library', 'view', 'documents', 'id', $2::text),
                                  'version', 1),
               'audience-privacy-test')`,
      [fx.workspaceId, documentId],
    );
    await client.query('COMMIT');
    return { documentId, storageKey };
  });
}

async function itemIds(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: { id: string }[] };
  return body.items.map((item) => item.id);
}

describe('request audience privacy projections', () => {
  it('keeps scoped requests, documents, effects, history, counts, renders and streams private', async () => {
    const fx = await seedWorkspace();
    const e = env();
    const legacyRequestId = await seedRequest(fx, 'invoice', { label: 'Legacy workspace invoice' });

    const memberRequestId = await seedRequest(fx, 'invoice', { label: 'Member private invoice' });
    await setAudience(fx, memberRequestId, fx.memberId);
    const memberDocument = await saveReadyDocument(fx, memberRequestId, fx.memberId);
    await e.bucket.put(memberDocument.storageKey, '<html>member private invoice</html>', {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });

    const adminRequestId = await seedRequest(fx, 'invoice', { label: 'Admin private invoice' });
    await setAudience(fx, adminRequestId, fx.adminId);
    const approved = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${adminRequestId}/decisions`, {
      method: 'POST',
      headers: INBOX_HEADERS,
      body: { decision: 'approve', ...await fetchReviewBinding(e.env, fx, adminRequestId) },
    });
    expect(approved.status).toBe(201);

    const adminPrivate = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const document = await client.query<{ id: string }>(
        `SELECT id FROM documents WHERE request_id = $1 ORDER BY version DESC LIMIT 1`,
        [adminRequestId],
      );
      const effects = await client.query<{ id: string }>(`SELECT id FROM effects WHERE request_id = $1 ORDER BY id`, [adminRequestId]);
      return { documentId: document.rows[0]!.id, effectIds: effects.rows.map((row) => row.id) };
    });

    const adminLibrary = await itemIds(await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/documents`));
    expect(adminLibrary).toContain(legacyRequestId);
    expect(adminLibrary).toContain(adminPrivate.documentId);
    expect(adminLibrary).not.toContain(memberDocument.documentId);
    expect(adminLibrary).not.toContain(memberRequestId);

    const memberLibrary = await itemIds(await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/documents`));
    expect(memberLibrary).toContain(legacyRequestId);
    expect(memberLibrary).toContain(memberDocument.documentId);
    expect(memberLibrary).not.toContain(adminPrivate.documentId);
    expect(memberLibrary).not.toContain(adminRequestId);

    for (const suffix of ['', '/versions', '/render']) {
      const hidden = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/documents/${memberDocument.documentId}${suffix}`);
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toMatchObject({ reason: 'unknown_document' });
    }
    const hiddenVersionWrite = await asUser(
      e.env,
      fx.adminId,
      `/w/${fx.workspaceId}/documents/${memberDocument.documentId}/versions`,
      { method: 'POST', body: { payload: invoicePayload('INV-HIDDEN-REVISION') } },
    );
    expect(hiddenVersionWrite.status).toBe(404);
    expect(await hiddenVersionWrite.json()).toMatchObject({ reason: 'unknown_document' });

    const visibleRender = await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/documents/${memberDocument.documentId}/render`);
    expect(visibleRender.status).toBe(200);
    expect(await visibleRender.text()).toContain('member private invoice');
    expect(visibleRender.headers.get('cache-control')).toBe('private, no-store');

    const hiddenRequestDocuments = await asUser(
      e.env,
      fx.adminId,
      `/w/${fx.workspaceId}/requests/${memberRequestId}/documents`,
    );
    expect(hiddenRequestDocuments.status).toBe(404);
    const hiddenPresentationWrite = await asUser(
      e.env,
      fx.adminId,
      `/w/${fx.workspaceId}/requests/${memberRequestId}/presentation`,
      { method: 'PATCH', body: { hidden: true, reason: 'Must not organize another audience request.' } },
    );
    expect(hiddenPresentationWrite.status).toBe(404);
    expect(await hiddenPresentationWrite.json()).toMatchObject({ reason: 'unknown_request' });
    const visibleRequestDocuments = await itemIds(await asUser(
      e.env,
      fx.memberId,
      `/w/${fx.workspaceId}/requests/${memberRequestId}/documents`,
    ));
    expect(visibleRequestDocuments).toEqual([memberDocument.documentId]);

    const adminEffects = await itemIds(await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/effects`));
    expect(adminEffects).toEqual(expect.arrayContaining(adminPrivate.effectIds));
    const memberEffects = await itemIds(await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/effects`));
    expect(memberEffects).not.toEqual(expect.arrayContaining(adminPrivate.effectIds));
    const hiddenEffect = await asUser(
      e.env,
      fx.memberId,
      `/w/${fx.workspaceId}/effects/${adminPrivate.effectIds[0]}/execute`,
      { method: 'POST', body: {} },
    );
    expect(hiddenEffect.status).toBe(404);
    expect(await hiddenEffect.json()).toMatchObject({ reason: 'unknown_effect' });

    const adminHistory = await itemIds(await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/history`));
    const memberHistory = await itemIds(await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/history`));
    const eventRequests = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const { rows } = await client.query<{ id: string; request_id: string }>(
        `SELECT id, request_id FROM events WHERE request_id IN ($1, $2)`,
        [memberRequestId, adminRequestId],
      );
      return rows;
    });
    const memberEventIds = eventRequests.filter((row) => row.request_id === memberRequestId).map((row) => row.id);
    const adminEventIds = eventRequests.filter((row) => row.request_id === adminRequestId).map((row) => row.id);
    expect(adminHistory).not.toEqual(expect.arrayContaining(memberEventIds));
    expect(memberHistory).not.toEqual(expect.arrayContaining(adminEventIds));

    const adminCounts = await (await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/history/counts`)).json() as Record<string, number>;
    const memberCounts = await (await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/history/counts`)).json() as Record<string, number>;
    expect(adminCounts).toMatchObject({ decisions: 1, documents: 1, inbox: 1 });
    expect(memberCounts).toMatchObject({ decisions: 0, documents: 1, inbox: 1 });

    const adminBootstrap = await (await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/bootstrap`)).json() as {
      counts: Record<string, number>;
      requests: { id: string }[];
    };
    const memberBootstrap = await (await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/bootstrap`)).json() as {
      counts: Record<string, number>;
      requests: { id: string }[];
    };
    expect(adminBootstrap.counts).toMatchObject({ decisions: 1, created_documents: 1, inbox: 1 });
    expect(memberBootstrap.counts).toMatchObject({ decisions: 0, created_documents: 1, inbox: 1 });
    expect(adminBootstrap.requests.map((row) => row.id)).not.toContain(memberRequestId);
    expect(memberBootstrap.requests.map((row) => row.id)).not.toContain(adminRequestId);

    const adminStream = await (await asUser(
      e.env,
      fx.adminId,
      `/w/${fx.workspaceId}/events?stream=workspace&after=0`,
    )).json() as { events: unknown[] };
    const memberStream = await (await asUser(
      e.env,
      fx.memberId,
      `/w/${fx.workspaceId}/events?stream=workspace&after=0`,
    )).json() as { events: unknown[] };
    expect(JSON.stringify(adminStream.events)).not.toContain(memberDocument.documentId);
    expect(JSON.stringify(adminStream.events)).not.toContain(memberRequestId);
    expect(JSON.stringify(memberStream.events)).not.toContain(adminPrivate.documentId);
    expect(JSON.stringify(memberStream.events)).not.toContain(adminRequestId);
    for (const effectId of adminPrivate.effectIds) expect(JSON.stringify(memberStream.events)).not.toContain(effectId);

    const published = e.hubCalls
      .filter((call) => call.namespace === 'workspace' && call.method === 'publish')
      .flatMap((call) => call.argument as { audience_user_ids?: string[] }[]);
    const privatePublished = published.filter((event) => JSON.stringify(event).includes(adminRequestId));
    expect(privatePublished.length).toBeGreaterThan(0);
    expect(privatePublished.every((event) => event.audience_user_ids?.includes(fx.adminId))).toBe(true);
  });
});
