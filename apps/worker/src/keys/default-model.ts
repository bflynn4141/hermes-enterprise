// Moving a workspace onto a model it can actually run (decision R13).
//
// The problem this solves is the first five minutes of a workspace's life. A
// fresh workspace's default is a gateway-backed model whose
// catalog row is a placeholder until a key has been verified and the list
// synced; and a workspace created before this deployment narrowed to one gateway
// has a default of `deepseek-flash`, which no longer exists as far as the
// product is concerned. In both cases the person's next action is the same —
// they add their provider key — and the thing they must not then meet is a
// composer that says "Add a deepseek key in Settings to start" about a provider
// the Settings screen no longer offers.
//
// So the sync that follows a successful verification is also the moment the
// workspace is pointed at something runnable. Three properties:
//
//   * It never *downgrades*. A default that is already allowed and enabled is
//     left alone, because it was somebody's choice and a sync is not a reason
//     to overrule it.
//   * It prefers one named model and falls back to the list. DeepSeek V4.1 Flash
//     is what the product is documented around; a workspace whose provider
//     account cannot reach it gets the first tool-capable row rather than
//     nothing, because "no default" is not a state any other code handles.
//   * It repoints the *sessions* too. A session's model is copied from the
//     default when it is created, so a workspace full of sessions naming
//     `deepseek-flash` would still refuse every turn after the default moved.
//     Archived sessions are left: nobody is going to run one, and rewriting
//     them would edit history to no purpose.
//
// The events row is `settings.changed` with `actor_type = 'system'`, because
// that is what happened and because the weekly reverify job has no user to
// name. It carries ids and a kind, like every other audit row.
import { DEFAULT_EFFORT, DEFAULT_MODEL_ID } from '@hermes/shared';
import type { Tx } from '../db/client.js';

/** The model a workspace is moved onto when its own default is unusable. */
export const PREFERRED_DEFAULT_MODEL_ID = DEFAULT_MODEL_ID;

export interface DefaultModelPromotion {
  readonly from: string;
  readonly to: string;
  readonly effort: string | null;
  readonly sessions: number;
}

/**
 * Point this workspace at a runnable default, if its own is not one.
 *
 * Returns null when nothing had to change — which is the ordinary case on every
 * sync after the first, and is why this is safe to call from the weekly job.
 */
export async function promoteDefaultModel(
  tx: Tx,
  workspaceId: string,
  allowed: readonly string[],
): Promise<DefaultModelPromotion | null> {
  const current = await tx.query<{ default_model_id: string; default_effort: string | null }>(
    `SELECT default_model_id, default_effort FROM workspace_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  const settings = current.rows[0];
  if (!settings) return null;

  // "Runnable" is the same three conditions the catalog uses: offered by this
  // deployment, not disabled by the catalog, and able to call a tool.
  const runnable = await tx.query<{ model_id: string; effort_map: Record<string, string> | null; default_effort: string | null }>(
    `SELECT model_id, effort_map, default_effort
       FROM catalog
      WHERE provider = ANY($1::text[])
        AND disabled_reason IS NULL
        AND supports_tools
      ORDER BY (model_id = $2) DESC, model_id
      LIMIT 1`,
    [[...allowed], PREFERRED_DEFAULT_MODEL_ID],
  );
  const pick = runnable.rows[0];
  // Nothing to move to. The sync wrote no usable row, so leaving the default
  // where it is at least keeps the reason visible on the model menu.
  if (!pick) return null;
  if (pick.model_id === settings.default_model_id) return null;

  // Is the current default already fine? Asked separately from the pick above
  // so that a workspace whose Admin chose Gemini keeps Gemini.
  const held = await tx.query<{ ok: boolean }>(
    `SELECT (c.provider = ANY($2::text[]) AND c.disabled_reason IS NULL AND c.supports_tools) AS ok
       FROM catalog c WHERE c.model_id = $1`,
    [settings.default_model_id, [...allowed]],
  );
  if (held.rows[0]?.ok === true) return null;

  // The effort has to move with the model: Anthropic refuses a replayed
  // thinking block when the configuration changed mid-conversation (decision
  // 26), so a workspace default effort the new row does not name is worse than
  // no effort at all.
  const effort = pick.model_id === DEFAULT_MODEL_ID && pick.effort_map?.[DEFAULT_EFFORT] !== undefined
    ? DEFAULT_EFFORT
    : settings.default_effort !== null && pick.effort_map !== null && pick.effort_map[settings.default_effort] !== undefined
      ? settings.default_effort
      : pick.default_effort;

  await tx.query(
    `UPDATE workspace_settings SET default_model_id = $2, default_effort = $3, updated_at = now()
      WHERE workspace_id = $1`,
    [workspaceId, pick.model_id, effort],
  );

  const moved = await tx.query(
    `UPDATE sessions s
        SET model_id = $2, effort = $3
      WHERE s.workspace_id = $1
        AND s.archived = false
        AND EXISTS (
          SELECT 1 FROM catalog c
           WHERE c.model_id = s.model_id
             AND (c.provider <> ALL($4::text[]) OR c.disabled_reason IS NOT NULL OR NOT c.supports_tools)
        )`,
    [workspaceId, pick.model_id, effort, [...allowed]],
  );

  await tx.query(
    `INSERT INTO events (workspace_id, actor_type, kind) VALUES ($1, 'system', 'settings.changed')`,
    [workspaceId],
  );

  return { from: settings.default_model_id, to: pick.model_id, effort, sessions: moved.rowCount ?? 0 };
}
