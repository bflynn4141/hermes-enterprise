// KEK rotation, as a function.
//
// Rotating the master secret means re-wrapping every live key's DEK under the
// new version. It never touches the data ciphertext, so no provider key's
// plaintext is decrypted, transported or re-encrypted — the operation that
// sounds the most dangerous is the one that handles the least.
//
// This is a plain function, and the Workflow that runs it in production is a
// thin wrapper: one `step.do` per workspace, so a failure resumes at the
// workspace it failed on rather than starting over. Keeping the logic out of
// the Workflow class is what lets it be tested in Node against Docker Postgres
// instead of only inside workerd.
//
// **The workspace list is injected, and has to be.** No role in this database
// can enumerate across tenants: every tenant table is FORCE ROW LEVEL SECURITY,
// `workspaces` is filtered on `id = app_workspace_id()`, and all three roles are
// NOBYPASSRLS — including `owner`, deliberately (decision 3). So there is no
// query, from any of our roles, that answers "which workspaces hold a key".
// That is the isolation working, not a gap to be patched: widening a role to
// make one maintenance job easier would hand every route the same reach.
//
// Instead the caller supplies the workspace ids — in production from the
// provisioning connection that also applies migrations, which is already inside
// the trust boundary — and `listRotationTargets` runs once per workspace,
// inside that workspace's own transaction, seeing only its own rows. The
// Workflow wrapper is then one `step.do` per workspace.
//
// Old KEK versions stay as secrets until every backup that could hold DEKs
// wrapped under them has expired. Deleting `KEK_V1` the day after a rotation
// makes a restore from last week's dump unreadable.
import type { Tx } from '../db/client.js';
import { currentKekVersion, type KekEnv } from './envelope.js';
import { logError, logEvent } from './redact.js';
import { rewrapProviderKey } from './store.js';
import { rewrapSlackInstallation } from '../integrations/slack/store.js';
import { rewrapCloudCredential, type CloudCredentialKind } from '../hermes-cloud/rotation.js';

type CredentialKind = 'provider_key' | 'slack_installation' | CloudCredentialKind;

export interface RotationTarget {
  readonly workspaceId: string;
  readonly keyId: string;
  readonly kekVersion: number;
  readonly credentialKind?: CredentialKind;
}

export interface RotationDeps {
  /**
   * Every live key not yet on `toVersion`. Injected because it is a
   * cross-tenant read; see the header.
   */
  listTargets(toVersion: number): Promise<readonly RotationTarget[]>;
  /** Run `fn` in a transaction scoped to one workspace. */
  withWorkspace<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface RotationReport {
  readonly toVersion: number;
  readonly examined: number;
  readonly rewrapped: number;
  readonly skipped: number;
  readonly rewrappedByKind: Readonly<Record<CredentialKind, number>>;
  readonly failed: readonly { readonly keyId: string; readonly reason: string }[];
}

/**
 * The rows in *this* transaction's workspace that are not yet on `toVersion`.
 * Three columns, none of them ciphertext: a rotation never reads key material.
 */
export const LIST_TARGETS_SQL = `
  SELECT workspace_id, id AS key_id, kek_version, 'provider_key' AS credential_kind
    FROM workspace_provider_keys WHERE revoked_at IS NULL AND kek_version <> $1
  UNION ALL
  SELECT workspace_id, id AS key_id, kek_version, 'slack_installation' AS credential_kind
    FROM slack_installations
   WHERE (status <> 'revoked' OR remote_revocation_pending) AND kek_version <> $1
  UNION ALL
  SELECT workspace_id, id AS key_id, kek_version, 'cloud_connection' AS credential_kind
    FROM cloud_connections
   WHERE status IN ('verification_required','connected','reconnect_required') AND kek_version <> $1
  UNION ALL
  SELECT workspace_id, id AS key_id, kek_version, 'cloud_connection_attempt' AS credential_kind
    FROM cloud_connection_attempts
   WHERE status='pending' AND expires_at>now() AND kek_version <> $1
   ORDER BY workspace_id, credential_kind, key_id`;

/**
 * Re-wrap every live key onto `toVersion`.
 *
 * One workspace transaction per key rather than one for everything: a rotation
 * across every tenant in one transaction would hold a connection for as long as
 * it took and roll back the whole thing on the last row's failure. Each key is
 * independent, so each one gets to succeed or fail alone, and the report names
 * the ones that failed rather than a single boolean.
 *
 * Re-running is safe: `rewrapProviderKey` returns false for a row already on
 * the target version, and its UPDATE is guarded on the version it read.
 */
export async function runKekRotation(
  env: KekEnv,
  deps: RotationDeps,
  toVersion: number = currentKekVersion(env),
): Promise<RotationReport> {
  const targets = await deps.listTargets(toVersion);
  let rewrapped = 0;
  let skipped = 0;
  const rewrappedByKind = { provider_key: 0, slack_installation: 0, cloud_connection: 0, cloud_connection_attempt: 0 };
  const failed: { keyId: string; reason: string }[] = [];

  for (const target of targets) {
    try {
      const changed = await deps.withWorkspace(target.workspaceId, (tx) =>
        target.credentialKind === 'cloud_connection' || target.credentialKind === 'cloud_connection_attempt'
          ? rewrapCloudCredential(tx, env, target.workspaceId, target.keyId, toVersion, target.credentialKind)
          : target.credentialKind === 'slack_installation'
          ? rewrapSlackInstallation(tx, env, target.workspaceId, target.keyId, toVersion)
          : rewrapProviderKey(tx, env, target.workspaceId, target.keyId, toVersion),
      );
      if (changed) {
        rewrapped += 1;
        rewrappedByKind[target.credentialKind ?? 'provider_key'] += 1;
      }
      else skipped += 1;
    } catch (error) {
      // A failure on one key must not stop the rotation: leaving the other
      // keys on an old KEK is what makes the old secret undeletable.
      logError({ at: 'kek_rotation.key_failed', key_id: target.keyId, to_version: toVersion, error });
      failed.push({ keyId: target.keyId, reason: 'rewrap_failed' });
    }
  }

  const report: RotationReport = { toVersion, examined: targets.length, rewrapped, skipped, rewrappedByKind, failed };
  logEvent({ at: 'kek_rotation.done', ...report, failed: failed.length });
  return report;
}

/** The per-workspace enumeration. Runs inside that workspace's transaction. */
export async function listRotationTargets(tx: Tx, toVersion: number): Promise<RotationTarget[]> {
  const { rows } = await tx.query<{ workspace_id: string; key_id: string; kek_version: number; credential_kind: CredentialKind }>(
    LIST_TARGETS_SQL,
    [toVersion],
  );
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    keyId: row.key_id,
    kekVersion: row.kek_version,
    credentialKind: row.credential_kind,
  }));
}
