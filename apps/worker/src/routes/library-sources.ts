import { librarySourceSchema } from '@hermes/shared';
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { requireAgentContextAccess } from '../domain/agent-context-access.js';
import { inWorkspace } from './tenant.js';
import { RouteError } from './errors.js';

interface LibrarySourceRow {
  id: string;
  version_id: string;
  slug: string;
  title: string;
  summary: string;
  version: number;
  version_label: string;
  sha256: string;
  content_markdown: string;
  audiences: ('Partnerships' | 'Finance')[];
  created_at: Date | string;
  updated_at: Date | string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Lists only sources granted to the caller's explicit Enterprise team.
 * `agent_id` further binds the result to that team's assigned agent so the
 * composer cannot offer a source that admission will later refuse.
 */
export async function listLibrarySources(c: Context<{ Bindings: Env }>): Promise<Response> {
  const agentId = c.req.query('agent_id') ?? null;
  if (agentId && !uuid.test(agentId)) throw new RouteError('Select an agent', 'bad_id', 400);

  const rows = await inWorkspace(c, async (work) => {
    if (agentId) await requireAgentContextAccess(work, agentId);
    return (
      await work.tx.query<LibrarySourceRow>(
        `SELECT s.id,v.id AS version_id,s.slug,s.title,s.summary,
                v.version,v.version_label,v.sha256,v.content_markdown,
                (SELECT array_agg(t.name ORDER BY t.name)
                   FROM library_source_team_grants all_grants
                   JOIN enterprise_teams t
                     ON t.workspace_id=all_grants.workspace_id AND t.id=all_grants.team_id
                  WHERE all_grants.workspace_id=s.workspace_id AND all_grants.source_id=s.id) AS audiences,
                s.created_at,s.updated_at
           FROM library_sources s
           JOIN LATERAL (
             SELECT id,version,version_label,sha256,content_markdown
               FROM library_source_versions
              WHERE workspace_id=s.workspace_id AND source_id=s.id
              ORDER BY version DESC LIMIT 1
           ) v ON true
          WHERE s.workspace_id=$1
            AND EXISTS (
              SELECT 1
                FROM library_source_team_grants access_grant
                JOIN enterprise_team_agents eta
                  ON eta.workspace_id=access_grant.workspace_id AND eta.team_id=access_grant.team_id
                JOIN members m
                  ON m.workspace_id=eta.workspace_id AND m.user_id=eta.principal_user_id
               WHERE access_grant.workspace_id=s.workspace_id AND access_grant.source_id=s.id
                 AND eta.principal_user_id=$2 AND m.status='active'
                 AND ($3::uuid IS NULL OR eta.agent_id=$3::uuid)
            )
          ORDER BY s.title,s.id`,
        [work.workspaceId, work.userId, agentId],
      )
    ).rows;
  });

  return c.json({
    items: rows.map((row) => librarySourceSchema.parse({
      ...row,
      kind: 'library_source',
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    })),
    cursor: null,
    total: rows.length,
  });
}
