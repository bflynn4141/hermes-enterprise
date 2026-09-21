// The Library.
//
//   GET  /w/:ws/documents                 drafts awaiting review, plus saved ones
//   GET  /w/:ws/documents/:id             one document (or one pending draft)
//   GET  /w/:ws/documents/:id/versions    every version of it, newest first
//   GET  /w/:ws/documents/:id/render      the rendered file
//   POST /w/:ws/documents/:id/versions    a new version: Admin, step-up
//
// ## The new version, and why it is a guarded human command
//
// Once a human has decided, the approved content is fixed. A new version after
// the decision would mean the signature, the payment or the send applied to
// text the approver never read, so the trigger in migration 0005 refuses one
// from the `agent` role outright: a tool may write a document version only
// while its request is still `pending`. After that the only way to a new
// version is this route — Admin, step-up, Origin, CSRF — and it does two things
// beyond writing the row, both of which are the point:
//
//   * it **cancels the request's pending effects**, because they were implied
//     by content that no longer exists. An `email_send` still sitting in
//     `pending` after a re-version would be a person about to send the previous
//     draft;
//   * it **re-renders**, so the file in the store matches the row.
//
// A test asserts the agent role cannot reach the same outcome, and it fails at
// the database rather than at a check in this file.
import type { Context } from 'hono';
import { documentPayloadSchema, documentEntitySchema, paginatedSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { inWorkspace, jsonBody, pathUuid } from './tenant.js';
import { RouteError } from './errors.js';
import { enqueueJob, publishEvents } from '../jobs.js';
import type { Tx } from '../db/client.js';
import { getObject } from '../storage/r2.js';
import { requestAudiencePredicate } from '../domain/audience.js';
import {
  DOCUMENT_SELECT,
  loadDocument,
  loadVersions,
  toDocumentEntity,
  toDraftEntity,
  type DocumentRow,
  type DraftRow,
} from '../documents/service.js';

const documentPage = paginatedSchema(documentEntitySchema);

/**
 * GET /w/:ws/documents
 *
 * Two lists in one response, ordered newest first: the drafts a decision has
 * not been made about (pending invoice and agreement *requests*, version 0) and
 * the documents a decision saved. `?status=drafts` or `?status=saved` narrows
 * to one.
 */
export async function listDocuments(c: Context<{ Bindings: Env }>): Promise<Response> {
  const status = c.req.query('status') ?? 'all';
  const wantDrafts = status === 'all' || status === 'drafts';
  const wantSaved = status === 'all' || status === 'saved';

  const items = await inWorkspace(c, async (work) => {
    const rows: { at: number; entity: Record<string, unknown> }[] = [];

    if (wantDrafts) {
      const drafts = await work.tx.query<DraftRow>(
        `SELECT id, kind, payload, created_at FROM requests
          WHERE status = 'pending' AND kind IN ('invoice', 'agreement')
            AND ${requestAudiencePredicate('requests.id', '$1')}
          ORDER BY created_at DESC LIMIT 100`,
        [work.userId],
      );
      for (const row of drafts.rows) rows.push({ at: row.created_at.getTime(), entity: toDraftEntity(row) });
    }

    if (wantSaved) {
      const saved = await work.tx.query<DocumentRow>(
        `${DOCUMENT_SELECT}
          WHERE ${requestAudiencePredicate('r.id', '$1')}
          ORDER BY d.created_at DESC LIMIT 100`,
        [work.userId],
      );
      for (const row of saved.rows) rows.push({ at: row.created_at.getTime(), entity: toDocumentEntity(row) });
    }

    return rows.sort((a, b) => b.at - a.at).map((row) => row.entity);
  });

  return c.json(documentPage.parse({ items, cursor: null, total: items.length }));
}

/** A pending invoice or agreement request, read as the draft the Library shows. */
async function loadDraft(tx: Tx, id: string, userId: string): Promise<DraftRow | null> {
  const { rows } = await tx.query<DraftRow & Record<string, unknown>>(
    `SELECT id, kind, payload, created_at FROM requests
      WHERE id = $1 AND status = 'pending' AND kind IN ('invoice', 'agreement')
        AND ${requestAudiencePredicate('requests.id', '$2')}`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export async function getDocument(c: Context<{ Bindings: Env }>): Promise<Response> {
  const id = pathUuid(c, 'id');
  const found = await inWorkspace(c, async (work) => {
    const document = await loadDocument(work.tx, id, work.userId);
    if (document) return { document, draft: null };
    // The id may name a pending request, which is what a draft in the Library
    // is: a proposal with no document row, because nobody has decided.
    return { document: null, draft: await loadDraft(work.tx, id, work.userId) };
  });

  if (found.document) {
    return c.json(documentEntitySchema.parse(toDocumentEntity(found.document)));
  }
  if (found.draft) return c.json(documentEntitySchema.parse(toDraftEntity(found.draft)));
  throw new RouteError('no such document', 'unknown_document', 404);
}

export async function listDocumentVersions(c: Context<{ Bindings: Env }>): Promise<Response> {
  const id = pathUuid(c, 'id');
  const rows = await inWorkspace(c, async (work) => {
    const document = await loadDocument(work.tx, id, work.userId);
    if (!document) throw new RouteError('no such document', 'unknown_document', 404);
    return loadVersions(work.tx, document.request_id, work.userId);
  });
  return c.json(
    documentPage.parse({ items: rows.map((row) => toDocumentEntity(row)), cursor: null, total: rows.length }),
  );
}

/**
 * GET /w/:ws/documents/:id/render
 *
 * An authenticated proxy for the rendered object. Every request rechecks the
 * document's audience before any bytes leave storage; private workflow
 * documents never receive a reusable presigned source URL.
 */
export async function getDocumentRender(c: Context<{ Bindings: Env }>): Promise<Response> {
  const id = pathUuid(c, 'id');
  const row = await inWorkspace(c, async (work) => {
    const document = await loadDocument(work.tx, id, work.userId);
    if (!document) throw new RouteError('no such document', 'unknown_document', 404);
    return document;
  });

  if (row.render_status !== 'ready' || !row.storage_key) {
    throw new RouteError(
      row.render_error ?? 'this document has not been rendered yet',
      row.render_status === 'failed' ? 'render_failed' : 'render_pending',
      row.render_status === 'failed' ? 422 : 404,
    );
  }

  const object = await getObject(c.env, row.storage_key);
  if (!object) throw new RouteError('the rendered file is no longer in the store', 'render_missing', 404);
  return new Response(object.body, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}

/** What a cancelled effect says about why. */
export const REVERSION_CANCEL_REASON = 'Superseded by a new document version the approver has not read';

export async function createDocumentVersion(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireCsrf(c);
  const id = pathUuid(c, 'id');
  const input = await jsonBody<{ payload?: unknown }>(c);

  const created = await inWorkspace(c, async (work) => {
    work.requireAdmin('saving a new document version');
    requireStepUp(work.session);

    const current = await loadDocument(work.tx, id, work.userId);
    if (!current) throw new RouteError('no such document', 'unknown_document', 404);

    const parsed = documentPayloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      throw new RouteError(`the payload does not match a document schema`, 'bad_payload', 422);
    }
    if (parsed.data.kind !== current.kind) {
      throw new RouteError(
        `this document is an ${current.kind}; the payload is an ${parsed.data.kind}`,
        'kind_mismatch',
        422,
      );
    }

    const latest = await work.tx.query<{ id: string; version: number }>(
      `SELECT id, version FROM documents WHERE request_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      [current.request_id],
    );
    const previous = latest.rows[0];
    const nextVersion = (previous?.version ?? current.version) + 1;

    const inserted = await work.tx.query<{ id: string; version: number }>(
      `INSERT INTO documents
         (workspace_id, request_id, kind, version, supersedes_id, payload, render_status, pdf_status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', 'preparing', $7)
       RETURNING id, version`,
      [
        work.workspaceId,
        current.request_id,
        current.kind,
        nextVersion,
        previous?.id ?? current.id,
        JSON.stringify(parsed.data),
        work.userId,
      ],
    );
    const document = inserted.rows[0];
    if (!document) throw new RouteError('the version was not written', 'version_failed', 409);

    // The effects the previous content implied. Cancelled, not deleted: the
    // ledger has to show that somebody was once going to send the old draft.
    const cancelled = await work.tx.query<{ id: string; decision_id: string }>(
      `UPDATE effects
          SET status = 'cancelled', cancelled_reason = $2
        WHERE request_id = $1 AND status IN ('pending', 'assigned')
        RETURNING id, decision_id`,
      [current.request_id, REVERSION_CANCEL_REASON],
    );

    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, request_id, document_id)
       VALUES ($1, 'user', $2, 'document.versioned', $3, $4)`,
      [work.workspaceId, work.userId, current.request_id, document.id],
    );
    for (const effect of cancelled.rows) {
      await work.tx.query(
        `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, request_id, decision_id, effect_id)
         VALUES ($1, 'user', $2, 'effect.cancelled', $3, $4, $5)`,
        [work.workspaceId, work.userId, current.request_id, effect.decision_id, effect.id],
      );
    }

    const renderJob = await enqueueJob(
      work.tx,
      work.workspaceId,
      'render',
      `render:${document.id}:${document.version}`,
      { document_id: document.id, version: document.version },
    );
    if (renderJob) work.jobs.push(renderJob);

    work.jobs.push(
      ...(await publishEvents(work.tx, work.workspaceId, [
        {
          kind: 'entity.updated',
          payload: {
            entity_type: 'document',
            entity_id: document.id,
            ref: { section: 'library', view: 'documents', id: document.id },
            version: document.version,
          },
        },
        ...cancelled.rows.map((effect) => ({
          kind: 'entity.updated',
          payload: {
            entity_type: 'effect',
            entity_id: effect.id,
            ref: { section: 'inbox', view: 'request', id: current.request_id },
            version: null,
          },
        })),
      ])),
    );

    const fresh = await loadDocument(work.tx, document.id, work.userId);
    if (!fresh) throw new RouteError('the version was not written', 'version_failed', 409);
    return fresh;
  });

  return c.json(documentEntitySchema.parse(toDocumentEntity(created)), 201);
}
