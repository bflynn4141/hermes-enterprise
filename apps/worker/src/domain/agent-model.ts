// Where a new session's model comes from (decision C96).
//
// An Admin may choose a model for an agent. It is a default, not a lock:
//
//   * a new session for the agent starts from `agents.model_id`, falling back
//     to `workspace_settings.default_model_id` when the agent has none or when
//     its own is no longer runnable (disabled in the catalog, or without tool
//     calling), because a session that cannot take a turn is worse than one on
//     the workspace default;
//   * the session's owner may still change their session's model as before;
//   * an existing session is never rewritten when the agent's model changes.
//
// Every place that creates a session calls `sessionModelDefaults`, so the rule
// has one copy. The Admin directory shows the same answer through
// `AGENT_MODEL_USABLE`.
import type { Tx } from '../db/client.js';

/** The catalog condition under which an agent's own model is used (alias `c`). */
export const AGENT_MODEL_USABLE = (alias: string): string =>
  `${alias}.disabled_reason IS NULL AND ${alias}.supports_tools`;

export interface SessionModelDefaults {
  readonly model_id: string;
  readonly effort: string | null;
  readonly runtime: string;
  readonly source: 'agent' | 'workspace_default';
}

interface DefaultsRow {
  default_model_id: string;
  default_effort: string | null;
  default_runtime: string;
  agent_model_id: string | null;
  agent_effort_map: Record<string, unknown> | null;
  agent_default_effort: string | null;
}

/**
 * The model, effort and runtime a new session for `agentId` starts with.
 * Null when the workspace has no settings row; callers keep their existing
 * fallback for that case.
 */
export async function sessionModelDefaults(
  tx: Tx,
  workspaceId: string,
  agentId: string | null,
): Promise<SessionModelDefaults | null> {
  const { rows } = await tx.query<DefaultsRow>(
    `SELECT ws.default_model_id, ws.default_effort, ws.default_runtime,
            c.model_id AS agent_model_id, c.effort_map AS agent_effort_map,
            c.default_effort AS agent_default_effort
       FROM workspace_settings ws
       LEFT JOIN agents a ON a.workspace_id = ws.workspace_id AND a.id = $2::uuid
       LEFT JOIN catalog c ON c.model_id = a.model_id AND ${AGENT_MODEL_USABLE('c')}
      WHERE ws.workspace_id = $1`,
    [workspaceId, agentId],
  );
  const row = rows[0];
  if (!row) return null;
  if (!row.agent_model_id) {
    return { model_id: row.default_model_id, effort: row.default_effort, runtime: row.default_runtime, source: 'workspace_default' };
  }
  // The effort moves with the model: the workspace default effort applies only
  // when the agent's model names it, as `promoteDefaultModel` does.
  const effort = row.agent_model_id === row.default_model_id
    || (row.default_effort !== null && row.agent_effort_map?.[row.default_effort] !== undefined)
    ? row.default_effort
    : row.agent_default_effort;
  return { model_id: row.agent_model_id, effort, runtime: row.default_runtime, source: 'agent' };
}
