// Whether this workspace can actually run a model, asked once.
//
// A model is chosen in three places: a session's model (PATCH /sessions/:id),
// the workspace default (PATCH /settings) and an agent's own model (PATCH
// /admin/agents/:id, decision C96). All three used to carry their own copy of
// the question, and the copies had already drifted. This is the one copy:
//
//   * the catalog has the row, because every model column is a foreign key and
//     a 23503 would surface as a 500;
//   * this deployment offers its provider (decision R12), asked through
//     `requireAllowedProvider` so the sentence and reason stay the same;
//   * the catalog does not disable it and it can call a tool, which every run
//     needs;
//   * the workspace holds a verified key for the provider, except under
//     `MODEL_SCRIPTED`, where no key exists and refusing would make a working
//     local stack look broken;
//   * and, for an agent that runs on a Hermes runtime, the model is one the
//     runtime model proxy routes (`runtimeModelRouteSql`), since that
//     proxy refuses anything else at the first inference call.
import { USABLE_KEY_STATUSES } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { RouteError } from '../routes/errors.js';
import { requireAllowedProvider, type AllowedProvidersEnv } from './allowed.js';

/**
 * The provider transports a Hermes runtime's model proxy serves. Shared with
 * `RuntimeDb.allowedRuntimeModels` so the proxy and this check cannot drift.
 */
export function runtimeModelRouteSql(alias?: string): string {
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  return `(${column('provider')}, ${column('transport')}) IN (('openrouter', 'openrouter_chat'), ('nous_portal', 'nous_chat'))`;
}

export interface RunnableModelEnv extends AllowedProvidersEnv {
  readonly MODEL_SCRIPTED?: string | undefined;
}

export interface RunnableModel {
  readonly model_id: string;
  readonly provider: string;
  readonly label: string;
  readonly effort_map: Record<string, unknown> | null;
  readonly default_effort: string | null;
}

export interface RunnableModelOptions {
  /** The agent runs on a Hermes runtime: only proxy-routed models qualify. */
  readonly runtime?: boolean;
}

/** Refuse, with `unknown_model` or `provider_not_allowed`, a model this workspace cannot run. */
export async function requireRunnableModel(
  env: RunnableModelEnv,
  tx: Tx,
  workspaceId: string,
  modelId: string,
  options: RunnableModelOptions = {},
): Promise<RunnableModel> {
  const { rows } = await tx.query<RunnableModel & { enabled: boolean; offered: boolean; routed: boolean }>(
    `SELECT c.model_id, c.provider, c.label, c.effort_map, c.default_effort,
            (c.disabled_reason IS NULL AND c.supports_tools) AS enabled,
            ${runtimeModelRouteSql('c')} AS routed,
            EXISTS (
              SELECT 1 FROM workspace_provider_keys k
               WHERE k.workspace_id = $1 AND k.provider = c.provider
                 AND k.status = ANY($3::text[]) AND k.revoked_at IS NULL
            ) AS offered
       FROM catalog c WHERE c.model_id = $2`,
    [workspaceId, modelId, [...USABLE_KEY_STATUSES]],
  );
  const row = rows[0];
  if (!row) throw new RouteError('the catalog does not have that model', 'unknown_model', 422);
  // A provider this deployment does not offer is its own answer, given even
  // under `MODEL_SCRIPTED`: the catalog route never listed the row.
  requireAllowedProvider(env, row.provider);
  if (!row.enabled || (!row.offered && env.MODEL_SCRIPTED !== '1')) {
    throw new RouteError('that model is not available to this workspace', 'unknown_model', 422);
  }
  if (options.runtime && !row.routed) {
    throw new RouteError('this agent’s runtime cannot use that model', 'unknown_model', 422);
  }
  return {
    model_id: row.model_id,
    provider: row.provider,
    label: row.label,
    effort_map: row.effort_map,
    default_effort: row.default_effort,
  };
}
