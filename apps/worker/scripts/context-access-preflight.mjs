// Staging-only, read-only compatibility check. Never repairs ownership or scope.
import pg from 'pg';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateWorkspace(value) {
  if (!UUID.test(value ?? '')) throw new Error('context preflight: valid workspace configuration required');
  return value;
}

export function disposition(row) {
  const hasOwner = row.owner_user_id != null;
  const hasPrincipal = row.principal_user_id != null;
  const inUse = Number(row.file_count) > 0 || Number(row.note_count) > 0 || Number(row.session_count) > 0;
  if (!inUse) return 'empty';
  if (hasOwner && row.owner_status !== 'active') return 'inactive_owner';
  if (hasPrincipal && row.principal_status !== 'active') return 'inactive_principal';
  if (hasOwner && hasPrincipal && row.owner_user_id !== row.principal_user_id) return 'conflicting_bindings';
  if (hasOwner || hasPrincipal) {
    // Existing writable sessions must not silently lose access to their context.
    if (row.other_session_owner) return 'incompatible_session_owner';
    return 'bound';
  }
  if (row.context_scope === 'workspace') return 'explicitly_shared';
  return 'unbound_in_use';
}

export async function checkContextAccess(client, workspace) {
  validateWorkspace(workspace);
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SET LOCAL search_path=public,pg_catalog");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspace]);
    const found = await client.query('SELECT id FROM workspaces WHERE id=$1', [workspace]);
    if (found.rows.length !== 1) throw new Error('context preflight: target workspace missing or inaccessible');
    const shape = (await client.query(`SELECT
      to_regclass('public.agent_context_notes') IS NOT NULL AS has_notes,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='agents' AND column_name='context_scope') AS has_scope`)).rows[0];
    const notes = shape.has_notes
      ? '(SELECT count(*) FROM agent_context_notes n WHERE n.workspace_id=a.workspace_id AND n.agent_id=a.id)'
      : '0';
    const scope = shape.has_scope ? 'a.context_scope' : "'private'::text";
    const rows = (await client.query(`SELECT a.id, ${scope} AS context_scope,
      m.user_id AS owner_user_id,m.status AS owner_status,
      ta.principal_user_id,pm.status AS principal_status,
      ${notes} AS note_count,
      (SELECT count(*) FROM agent_files f WHERE f.workspace_id=a.workspace_id AND f.agent_id=a.id) AS file_count,
      (SELECT count(*) FROM sessions s JOIN members sm ON sm.workspace_id=s.workspace_id AND sm.user_id=s.owner_id
        WHERE s.workspace_id=a.workspace_id AND s.agent_id=a.id AND NOT s.archived AND NOT s.read_only AND sm.status='active') AS session_count,
      EXISTS(SELECT 1 FROM sessions s JOIN members sm ON sm.workspace_id=s.workspace_id AND sm.user_id=s.owner_id
        WHERE s.workspace_id=a.workspace_id AND s.agent_id=a.id AND NOT s.archived AND NOT s.read_only AND sm.status='active'
          AND s.owner_id IS DISTINCT FROM COALESCE(m.user_id,ta.principal_user_id)) AS other_session_owner
      FROM agents a
      LEFT JOIN agent_owners ao ON ao.workspace_id=a.workspace_id AND ao.agent_id=a.id
      LEFT JOIN members m ON m.workspace_id=ao.workspace_id AND m.id=ao.member_id
      LEFT JOIN enterprise_team_agents ta ON ta.workspace_id=a.workspace_id AND ta.agent_id=a.id
      LEFT JOIN members pm ON pm.workspace_id=ta.workspace_id AND pm.user_id=ta.principal_user_id
      WHERE a.workspace_id=$1 ORDER BY a.id`, [workspace])).rows;
    const unassigned = Number((await client.query('SELECT count(*) AS count FROM agent_files WHERE workspace_id=$1 AND agent_id IS NULL', [workspace])).rows[0].count);
    const counts = { empty: 0, bound: 0, explicitly_shared: 0, inactive_owner: 0, inactive_principal: 0, conflicting_bindings: 0, incompatible_session_owner: 0, unbound_in_use: 0, unassigned_files: unassigned };
    for (const row of rows) counts[disposition(row)]++;
    const ok = ['inactive_owner','inactive_principal','conflicting_bindings','incompatible_session_owner','unbound_in_use','unassigned_files'].every(key => counts[key] === 0);
    return { ok, counts };
  } finally {
    await client.query('ROLLBACK');
  }
}

// The only mode is a dry run. No fallback to a local/default database URL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let client;
  try {
    const workspace = validateWorkspace(process.env.CONTEXT_PREFLIGHT_WORKSPACE_ID);
    if (!process.env.DATABASE_URL_OWNER) throw new Error('missing credential');
    client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER, connectionTimeoutMillis: 10000 });
    await client.connect();
    const result = await checkContextAccess(client, workspace);
    console.log(JSON.stringify(result)); // Fixed disposition names/counts only.
    if (!result.ok) process.exitCode = 1;
  } catch {
    // Driver errors may include database hosts, usernames or SQL; never print them.
    console.error('Context compatibility preflight failed. Verify configuration/access and resolve incompatible assignments before release.');
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}
