// Admin-owned factual notes. Explicit agent ownership and optimistic revisions
// prevent cross-agent changes and lost edits; existing context answers stay separate.
import type { Context } from 'hono';
import { contextNoteInputSchema, contextNoteUpdateSchema, MAX_CONTEXT_NOTES } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin } from '../auth.js';
import { inWorkspace, jsonBody, pathUuid, RouteError, type TenantWork } from './tenant.js';

async function agent(work: TenantWork, id: string): Promise<void> {
  const result = await work.tx.query('SELECT id FROM agents WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
    work.workspaceId,
    id,
  ]);
  if (!result.rows[0]) throw new RouteError('No such agent', 'not_found', 404);
}
const projection = `n.id,n.agent_id,n.title,n.text,n.revision,n.author_id,u.name AS author_name,n.created_at,n.updated_at,'human' AS origin,'future' AS scope`;
export async function listContextNotes(c: Context<{ Bindings: Env }>): Promise<Response> {
  const id = pathUuid(c, 'agentId');
  const items = await inWorkspace(c, async (work) => {
    await agent(work, id);
    return (
      await work.tx.query(
        `SELECT ${projection} FROM agent_context_notes n LEFT JOIN users u ON u.id=n.author_id WHERE n.workspace_id=$1 AND n.agent_id=$2 ORDER BY n.created_at,n.id`,
        [work.workspaceId, id],
      )
    ).rows;
  });
  return c.json({ items, cursor: null, total: items.length });
}
export async function writeContextNote(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const id = pathUuid(c, 'agentId'),
    editing = c.req.method === 'PATCH';
  const raw = await jsonBody(c);
  const parsed = contextNoteInputSchema.safeParse(
    editing ? { title: (raw as Record<string, unknown>)?.title, text: (raw as Record<string, unknown>)?.text } : raw,
  );
  const revision = editing ? contextNoteUpdateSchema.safeParse(raw) : null;
  if (!parsed.success || (editing && !revision?.success))
    throw new RouteError('Provide a title and note within the size limits', 'invalid_context_note', 422);
  const noteId = editing ? pathUuid(c, 'noteId') : crypto.randomUUID();
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('Changing context notes');
    await agent(work, id);
    if (editing) {
      const changed = await work.tx.query(
        `UPDATE agent_context_notes SET title=$4,text=$5,revision=revision+1,author_id=$6,updated_at=now() WHERE workspace_id=$1 AND agent_id=$2 AND id=$3 AND revision=$7 RETURNING id`,
        [
          work.workspaceId,
          id,
          noteId,
          parsed.data.title,
          parsed.data.text,
          work.userId,
          revision?.success ? revision.data.expected_revision : 0,
        ],
      );
      if (!changed.rows[0])
        throw new RouteError('The note changed. Reload before saving.', 'context_revision_conflict', 409);
    } else {
      const count = await work.tx.query<{ count: string }>(
        'SELECT count(*) FROM agent_context_notes WHERE workspace_id=$1 AND agent_id=$2',
        [work.workspaceId, id],
      );
      if (Number(count.rows[0]?.count) >= MAX_CONTEXT_NOTES)
        throw new RouteError('Remove a note before adding another', 'context_note_limit', 422);
      await work.tx.query(
        'INSERT INTO agent_context_notes(id,workspace_id,agent_id,title,text,author_id) VALUES($1,$2,$3,$4,$5,$6)',
        [noteId, work.workspaceId, id, parsed.data.title, parsed.data.text, work.userId],
      );
    }
    await work.tx.query(
      `INSERT INTO events(workspace_id,actor_type,actor_user_id,kind,subject_id) VALUES($1,'user',$2,'context.set',$3)`,
      [work.workspaceId, work.userId, noteId],
    );
    return (
      await work.tx.query(
        `SELECT ${projection} FROM agent_context_notes n LEFT JOIN users u ON u.id=n.author_id WHERE n.id=$1`,
        [noteId],
      )
    ).rows[0];
  });
  return c.json(result, editing ? 200 : 201);
}
export async function deleteContextNote(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const id = pathUuid(c, 'agentId'),
    noteId = pathUuid(c, 'noteId');
  const body = await jsonBody<{ expected_revision?: number }>(c);
  if (!Number.isInteger(body.expected_revision) || Number(body.expected_revision) < 1)
    throw new RouteError('A revision is required', 'invalid_context_note', 422);
  await inWorkspace(c, async (work) => {
    work.requireAdmin('Removing context notes');
    await agent(work, id);
    const result = await work.tx.query(
      'DELETE FROM agent_context_notes WHERE workspace_id=$1 AND agent_id=$2 AND id=$3 AND revision=$4 RETURNING id',
      [work.workspaceId, id, noteId, body.expected_revision],
    );
    if (!result.rows[0])
      throw new RouteError('The note changed. Reload before removing.', 'context_revision_conflict', 409);
    await work.tx.query(
      `INSERT INTO events(workspace_id,actor_type,actor_user_id,kind,subject_id) VALUES($1,'user',$2,'context.set',$3)`,
      [work.workspaceId, work.userId, noteId],
    );
  });
  return c.body(null, 204);
}
