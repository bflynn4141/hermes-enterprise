// Bind factual context once at admission. Retries read this immutable copy,
// never a subsequently edited setting or a replaced/deleted storage object.
import { MAX_CONTEXT_SOURCE_CHARS, selectedSourcesSchema } from '@hermes/shared';
import type { Env } from './env.js';
import { RouteError, type TenantWork } from './routes/tenant.js';
import { textKey } from './storage/keys.js';
import { requireAgentContextAccess } from './domain/agent-context-access.js';
export async function captureContext(
  work: TenantWork,
  env: Env,
  agentId: string | null,
  selection: unknown,
): Promise<unknown> {
  const parsed = selectedSourcesSchema.safeParse(selection ?? []);
  if (!parsed.success) throw new RouteError('Select up to five ready context sources', 'invalid_context_sources', 422);
  // Do not break legacy chat with no context to disclose. As soon as notes or
  // selected sources exist, the actor must pass the content boundary.
  if (parsed.data.length === 0) {
    const notes = agentId ? await work.tx.query('SELECT 1 FROM agent_context_notes WHERE workspace_id=$1 AND agent_id=$2 LIMIT 1', [work.workspaceId, agentId]) : null;
    if (!notes?.rows[0]) return { notes: [], sources: [] };
  }
  if (agentId) await requireAgentContextAccess(work, agentId);
  const notes = agentId
    ? (
        await work.tx.query(
          'SELECT id,title,text,revision,author_id FROM agent_context_notes WHERE workspace_id=$1 AND agent_id=$2 ORDER BY created_at,id',
          [work.workspaceId, agentId],
        )
      ).rows
    : [];
  const sources = [];
  let remaining = MAX_CONTEXT_SOURCE_CHARS;
  for (const source of parsed.data) {
    if (source.kind === 'library_source') {
      const result = await work.tx.query<{
        id: string;
        name: string;
        sha256: string;
        text: string;
      }>(
        `SELECT s.id,s.title AS name,v.sha256,v.content_markdown AS text
           FROM library_sources s
           JOIN library_source_versions v
             ON v.workspace_id=s.workspace_id AND v.source_id=s.id AND v.sha256=$4
          WHERE s.workspace_id=$1 AND s.id=$3
            AND v.version=(SELECT max(latest.version) FROM library_source_versions latest
                            WHERE latest.workspace_id=s.workspace_id AND latest.source_id=s.id)
            AND EXISTS (
              SELECT 1
                FROM library_source_team_grants access_grant
                JOIN enterprise_team_agents eta
                  ON eta.workspace_id=access_grant.workspace_id AND eta.team_id=access_grant.team_id
                JOIN members m
                  ON m.workspace_id=eta.workspace_id AND m.user_id=eta.principal_user_id
               WHERE access_grant.workspace_id=s.workspace_id AND access_grant.source_id=s.id
                 AND eta.agent_id=$2 AND eta.principal_user_id=$5 AND m.status='active'
            )
          `,
        [work.workspaceId, agentId, source.id, source.sha256, work.userId],
      );
      const row = result.rows[0];
      if (!row) throw new RouteError('This Library source is no longer available for this agent', 'context_source_missing', 422);
      if (row.text.length > remaining)
        throw new RouteError('Select fewer or smaller sources (6,000 estimated tokens maximum)', 'context_source_budget', 422);
      remaining -= row.text.length;
      sources.push({ id: row.id, name: row.name, sha256: row.sha256, kind: 'library_source', text: row.text });
      continue;
    }
    const result = await work.tx.query<{
      id: string;
      name: string;
      sha256: string;
      storage_key: string;
      extraction_status: string;
      text_length: number | null;
    }>(
      'SELECT id,name,sha256,storage_key,extraction_status,text_length FROM agent_files WHERE workspace_id=$1 AND agent_id=$2 AND id=$3 FOR SHARE',
      [work.workspaceId, agentId, source.id],
    );
    const row = result.rows[0];
    if (!row) throw new RouteError('This source is no longer available for this agent', 'context_source_missing', 422);
    if (row.sha256 !== source.sha256)
      throw new RouteError('The source changed; select it again', 'context_source_changed', 409);
    if (row.extraction_status !== 'ready' || row.text_length === null)
      throw new RouteError('Wait for source processing or replace the failed source', 'context_source_unready', 422);
    if (row.text_length > remaining)
      throw new RouteError(
        'Select fewer or smaller sources (6,000 estimated tokens maximum)',
        'context_source_budget',
        422,
      );
    const object = await env.UPLOADS.get(textKey(row.storage_key));
    if (!object)
      throw new RouteError('Extracted source text is unavailable; replace the source', 'context_source_unready', 422);
    if (object.size > remaining * 4)
      throw new RouteError('Selected sources exceed the context budget', 'context_source_budget', 422);
    const text = await object.text();
    if (text.length > remaining) throw new RouteError('Select fewer or smaller sources', 'context_source_budget', 422);
    remaining -= text.length;
    sources.push({ id: row.id, name: row.name, sha256: row.sha256, kind: 'agent_file', text });
  }
  return { notes, sources };
}
