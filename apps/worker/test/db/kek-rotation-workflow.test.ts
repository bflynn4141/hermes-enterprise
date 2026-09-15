// The KEK rotation Workflow wrapper.
//
// The rotation logic itself is tested in `provider-keys.test.ts`; what is under
// test here is the wrapper's two properties, both of which only matter when
// something goes wrong halfway:
//
//   one step per workspace, named by the workspace id, so a resumed instance
//   skips exactly the workspaces it finished;
//
//   the workspace list comes from `workspace_directory` — the one platform
//   table a cross-tenant question may be asked of — and every key read happens
//   inside that workspace's own transaction.
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../src/env.js';
import { listWorkspaceIds, runKekRotationWorkflow, type RotationStep } from '../../src/workflows-long/kek-rotation.js';
import { makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

/** A KEK a test can rotate against. Two versions, so there is somewhere to go. */
const kekEnv = (): Env =>
  makeEnv({
    KEK_V1: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
    KEK_V2: Buffer.from(new Uint8Array(32).fill(2)).toString('base64'),
  } as Partial<Env>).env;

async function asTenant<T>(f: Fixture, fn: (c: import('pg').Client) => Promise<T>): Promise<T> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    try {
      await setTenant(c, f.workspaceId, f.adminId);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

function recordingStep(): RotationStep & { names: string[] } {
  const names: string[] = [];
  return {
    names,
    do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      names.push(name);
      return fn();
    },
  };
}

describe('listWorkspaceIds', () => {
  it('reads the one platform table a cross-tenant question may be asked of', async () => {
    const local = await seedWorkspace();
    await withClient('owner', (c) =>
      c.query(`INSERT INTO workspace_directory (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
        local.workspaceId,
      ]),
    );
    const ids = await listWorkspaceIds(makeEnv().env);
    expect(ids).toContain(local.workspaceId);
  });
});

describe('the KekRotation Workflow body', () => {
  it('takes one step per workspace, named by its id, so a resume skips the finished ones', async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    const step = recordingStep();

    const outcome = await runKekRotationWorkflow(kekEnv(), { toVersion: 2 }, step, {
      listWorkspaces: () => Promise.resolve([a.workspaceId, b.workspaceId]),
    });

    expect(outcome.toVersion).toBe(2);
    expect(outcome.workspaces).toBe(2);
    // The checkpoint key is the workspace id, not an index: an index would
    // change if the list changed between attempts, which is precisely when a
    // stable name matters.
    expect(step.names).toEqual(['list-workspaces', `rotate-${a.workspaceId}`, `rotate-${b.workspaceId}`]);
  });

  it('examines nothing and writes no audit row when there are no keys to move', async () => {
    const local = await seedWorkspace();
    const step = recordingStep();
    const outcome = await runKekRotationWorkflow(kekEnv(), { toVersion: 2 }, step, {
      listWorkspaces: () => Promise.resolve([local.workspaceId]),
    });
    expect(outcome.examined).toBe(0);
    expect(outcome.rewrapped).toBe(0);
    expect(outcome.failed).toBe(0);
    // No `audit-...` step: an audit row saying key material was touched, when
    // none was, is a row that makes History less true rather than more.
    expect(step.names.some((name) => name.startsWith('audit-'))).toBe(false);
  });

  it('is safe to re-run: a key already on the target version is skipped', async () => {
    const local = await seedWorkspace();
    // A row already at version 2. `rewrapProviderKey` returns false for it, and
    // the report counts it as skipped rather than failing the rotation.
    await asTenant(local, (c) =>
      c.query(
        `INSERT INTO workspace_provider_keys
           (id, workspace_id, provider, label, ciphertext, iv, wrapped_dek, wrap_iv, kek_version,
            fingerprint, last4, status)
         VALUES ($1, $2, 'deepseek', 'k', '\\x00', '\\x00', '\\x00', '\\x00', 2, $3, 'abcd', 'verified')`,
        [randomUUID(), local.workspaceId, randomUUID()],
      ),
    );

    const step = recordingStep();
    const outcome = await runKekRotationWorkflow(kekEnv(), { toVersion: 2 }, step, {
      listWorkspaces: () => Promise.resolve([local.workspaceId]),
    });
    // The per-workspace enumeration filters on `kek_version <> $1`, so a row
    // already on the target is not even a target.
    expect(outcome.examined).toBe(0);
    expect(outcome.rewrapped).toBe(0);
  });

  it('leaves a revoked key alone, because a revoked key is not live material', async () => {
    const local = await seedWorkspace();
    await asTenant(local, (c) =>
      c.query(
        `INSERT INTO workspace_provider_keys
           (id, workspace_id, provider, label, ciphertext, iv, wrapped_dek, wrap_iv, kek_version,
            fingerprint, last4, status, revoked_at)
         VALUES ($1, $2, 'deepseek', 'k', '\\x00', '\\x00', '\\x00', '\\x00', 1, $3, 'abcd', 'revoked', now())`,
        [randomUUID(), local.workspaceId, randomUUID()],
      ),
    );
    const outcome = await runKekRotationWorkflow(kekEnv(), { toVersion: 2 }, recordingStep(), {
      listWorkspaces: () => Promise.resolve([local.workspaceId]),
    });
    expect(outcome.examined).toBe(0);
  });
});
