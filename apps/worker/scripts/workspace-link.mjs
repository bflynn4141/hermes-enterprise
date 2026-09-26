// Link one workspace to its WorkOS organization, and optionally rename it.
//
// Staging's demo workspace was seeded without a WorkOS organization, and the
// invitation delivery job fails closed without one. There is no route for this
// on purpose: the organization link is the trust boundary between the tenant
// and WorkOS, so it is written by the `owner` role, from the deploy pipeline,
// with the ids spelled out in a workflow run that leaves a log.
//
// Dry run by default. `LINK_APPLY=true` writes, in one transaction, and only
// when neither existing organization column already names a *different*
// organization; an existing equal value is left alone. Output is ids and names
// only; connection details never reach the log.
import pg from 'pg';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG = /^org_[0-9A-Z]{20,40}$/;

export function validateInputs(env) {
  const workspaceId = (env.LINK_WORKSPACE_ID ?? '').trim().toLowerCase();
  const organizationId = (env.LINK_ORGANIZATION_ID ?? '').trim();
  const name = (env.LINK_WORKSPACE_NAME ?? '').trim();
  if (!UUID.test(workspaceId)) throw new Error('workspace link: LINK_WORKSPACE_ID must be a uuid');
  if (!ORG.test(organizationId)) throw new Error('workspace link: LINK_ORGANIZATION_ID must be a WorkOS organization id');
  if (name.length > 120) throw new Error('workspace link: LINK_WORKSPACE_NAME is too long');
  return { workspaceId, organizationId, name: name || null, apply: env.LINK_APPLY === 'true' };
}

async function readState(client, workspaceId) {
  const { rows } = await client.query(
    `SELECT w.id, w.name, w.workos_organization_id, d.workos_organization_id AS directory_organization_id,
            (d.workspace_id IS NOT NULL) AS has_directory_row
       FROM workspaces w LEFT JOIN workspace_directory d ON d.workspace_id = w.id
      WHERE w.id = $1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

/** Returns `{ before, after, changed }`; throws (and rolls back) on a conflict. */
export async function linkWorkspace(client, input) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SET LOCAL search_path=public,pg_catalog");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [input.workspaceId]);
    const before = await readState(client, input.workspaceId);
    if (!before) throw new Error('workspace link: target workspace missing or inaccessible');
    for (const existing of [before.workos_organization_id, before.directory_organization_id]) {
      if (existing && existing !== input.organizationId) {
        throw new Error('workspace link: the workspace is already linked to a different organization; refusing to overwrite');
      }
    }
    const taken = await client.query(
      `SELECT workspace_id FROM workspace_directory WHERE workos_organization_id = $1 AND workspace_id <> $2
       UNION SELECT id FROM workspaces WHERE workos_organization_id = $1 AND id <> $2`,
      [input.organizationId, input.workspaceId],
    );
    if (taken.rows.length > 0) throw new Error('workspace link: that organization already belongs to another workspace');

    if (!input.apply) {
      await client.query('ROLLBACK');
      return { before, after: null, changed: false };
    }
    await client.query(
      `UPDATE workspaces
          SET workos_organization_id = COALESCE(workos_organization_id, $2),
              name = COALESCE($3, name)
        WHERE id = $1`,
      [input.workspaceId, input.organizationId, input.name],
    );
    await client.query(
      `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1, $2)
       ON CONFLICT (workspace_id) DO UPDATE
         SET workos_organization_id = COALESCE(workspace_directory.workos_organization_id, EXCLUDED.workos_organization_id)`,
      [input.workspaceId, input.organizationId],
    );
    const after = await readState(client, input.workspaceId);
    await client.query('COMMIT');
    return { before, after, changed: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let client;
  try {
    const input = validateInputs(process.env);
    if (!process.env.DATABASE_URL_OWNER) throw new Error('missing credential');
    client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER, connectionTimeoutMillis: 10000 });
    await client.connect();
    const result = await linkWorkspace(client, input);
    console.log(JSON.stringify({ mode: input.apply ? 'apply' : 'dry-run', ...result }, null, 2));
  } catch (error) {
    // Driver errors may include hosts or usernames; print only our own messages.
    const message = error instanceof Error && error.message.startsWith('workspace link:') ? error.message : 'workspace link failed';
    console.error(message);
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}
