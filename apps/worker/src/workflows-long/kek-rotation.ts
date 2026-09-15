// KekRotation: one step per workspace over the existing rewrap function.
//
// The rotation logic is already a plain function (`src/keys/rotation.ts`) and
// stays there. This is the wrapper that gives it durability: one `step.do` per
// workspace, so a rotation that fails on the fortieth of two hundred tenants
// resumes at the fortieth rather than re-wrapping the thirty-nine that already
// moved. Re-wrapping them again would be harmless — `rewrapProviderKey` is a
// no-op on a row already at the target version — but "harmless to repeat" and
// "does not repeat" are different guarantees, and the second is the one that
// makes a half-finished rotation safe to resume during an incident.
//
// **The workspace list.** No role in this database can enumerate across
// tenants, so the list has to come from a platform table. `workspace_directory`
// (migration 0008) is the one that exists and holds ids and nothing else; the
// rotation reads it, then opens one tenant transaction per workspace and sees
// only that workspace's key rows. The isolation is intact: the rotation learns
// which workspaces exist, which the Cron already knows, and nothing about any
// of them.
//
// **Two deploys, not one.** Decision 22: add `KEK_V2` and deploy; run this;
// then set `KEK_CURRENT=2` and deploy. Between the first two, an instance
// holding the new secret but not the new setting still writes v1, which every
// instance can read. The runbook spells the sequence out.
import type { Env } from '../env.js';
import { connect } from '../db/client.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { currentKekVersion } from '../keys/envelope.js';
import { listRotationTargets, runKekRotation, type RotationReport, type RotationTarget } from '../keys/rotation.js';
import { logEvent } from '../keys/redact.js';

export interface KekRotationParams {
  /** Omitted means `KEK_CURRENT`, or the highest `KEK_V{n}` present. */
  readonly toVersion?: number;
}

export interface RotationStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Every workspace, from the one platform table that may be asked.
 *
 * Read as `app` on a connection with no tenant key set, which is legal only
 * because `workspace_directory` opts out of row-level security and holds ids
 * only (0008). Every other statement in this file runs inside a tenant
 * transaction.
 */
export async function listWorkspaceIds(env: Env): Promise<string[]> {
  const client = await connect(env, 'app');
  try {
    const { rows } = await client.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_directory ORDER BY workspace_id`,
    );
    return rows.map((row) => row.workspace_id);
  } finally {
    await client.end();
  }
}

export interface KekRotationOutcome {
  readonly toVersion: number;
  readonly workspaces: number;
  readonly examined: number;
  readonly rewrapped: number;
  readonly skipped: number;
  readonly failed: number;
}

/**
 * The body.
 *
 * One step per workspace, named by the workspace id so the checkpoint key is
 * stable across attempts and a resumed instance skips exactly the workspaces it
 * finished. The per-workspace report is returned from the step, which means it
 * is checkpointed: ids and counts, no key material, which is what a step return
 * is allowed to carry (plan section 6, erasure inventory).
 */
export async function runKekRotationWorkflow(
  env: Env,
  params: KekRotationParams,
  step: RotationStep,
  deps: {
    listWorkspaces(): Promise<readonly string[]>;
  } = { listWorkspaces: () => listWorkspaceIds(env) },
): Promise<KekRotationOutcome> {
  const toVersion = params.toVersion ?? currentKekVersion(env);

  const workspaces = await step.do('list-workspaces', () => deps.listWorkspaces().then((ids) => [...ids]));

  const totals = { examined: 0, rewrapped: 0, skipped: 0, failed: 0 };

  for (const workspaceId of workspaces) {
    const report: RotationReport = await step.do(`rotate-${workspaceId}`, async () =>
      runKekRotation(
        env,
        {
          // The targets for *this* workspace, read inside its own transaction.
          // `runKekRotation` takes the list as an injected dependency precisely
          // so that the cross-tenant question is never asked.
          listTargets: async (version: number): Promise<readonly RotationTarget[]> =>
            withWorkspaceTransaction(env, workspaceId, (tx) => listRotationTargets(tx, version)),
          withWorkspace: (id, fn) => withWorkspaceTransaction(env, id, fn),
        },
        toVersion,
      ),
    );

    totals.examined += report.examined;
    totals.rewrapped += report.rewrapped;
    totals.skipped += report.skipped;
    totals.failed += report.failed.length;

    if (report.rewrapped > 0) {
      // One audit row per workspace that actually moved. An Admin looking at
      // History after a rotation should be able to see that their key material
      // was touched, even though nothing about the key itself changed.
      await step.do(`audit-${workspaceId}`, async () => {
        await withWorkspaceTransaction(env, workspaceId, async (tx) => {
          await tx.query(
            `INSERT INTO events (workspace_id, actor_type, kind) VALUES ($1, 'system', 'provider_key.rewrapped')`,
            [workspaceId],
          );
        });
        return true;
      });
    }
  }

  const outcome: KekRotationOutcome = { toVersion, workspaces: workspaces.length, ...totals };
  logEvent({ at: 'kek_rotation.workflow', ...outcome });
  return outcome;
}
