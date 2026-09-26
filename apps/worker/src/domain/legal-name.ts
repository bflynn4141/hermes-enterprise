import type { Tx } from '../db/client.js';

/**
 * The name documents use for this workspace as a party: the Admin-set legal
 * name, or the workspace name when none is set.
 */
export async function workspaceLegalName(tx: Tx, workspaceId: string): Promise<string> {
  const { rows } = await tx.query<{ name: string }>(
    `SELECT COALESCE(s.legal_name, w.name) AS name
       FROM workspaces w
       LEFT JOIN workspace_settings s ON s.workspace_id = w.id
      WHERE w.id = $1`,
    [workspaceId],
  );
  return rows[0]?.name ?? 'This workspace';
}
