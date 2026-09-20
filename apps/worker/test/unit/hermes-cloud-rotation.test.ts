import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '../../src/db/client.js';
import { openKey, openSecret, sealKey, sealSecret } from '../../src/keys/envelope.js';
import { cloudCredentialIdentity } from '../../src/hermes-cloud/credential-envelope.js';
import { rewrapCloudCredential, type CloudCredentialKind } from '../../src/hermes-cloud/rotation.js';
import { listRotationTargets, runKekRotation } from '../../src/keys/rotation.js';

const env = { KEK_V1: Buffer.alloc(32, 1).toString('base64'), KEK_V2: Buffer.alloc(32, 2).toString('base64') };
const identity = { workspaceId: 'workspace-fixture', keyId: 'key-fixture' };
describe('Cloud grant KEK rotation', () => {
  it.each<CloudCredentialKind>(['cloud_connection', 'cloud_connection_attempt'])('rewraps %s with unchanged payload and identity', async kind => {
    const namespacedIdentity = cloudCredentialIdentity(kind, identity.workspaceId, identity.keyId);
    const sealed = await sealSecret(env, namespacedIdentity, 'fixture credential');
    let update: unknown[] = [];
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT')) {
        expect(sql).toContain('FOR UPDATE');
        expect(sql).not.toContain('ciphertext');
        if (kind === 'cloud_connection_attempt') expect(sql).toContain("status='pending' AND expires_at>now()");
        return { rows: [{ wrapped_dek: sealed.wrappedDek, wrap_iv: sealed.wrapIv, kek_version: 1 }], rowCount: 1 };
      }
      expect(sql).toContain('kek_version=$6');
      expect(sql).not.toContain('ciphertext');
      update = values;
      return { rows: [], rowCount: 1 };
    });
    expect(await rewrapCloudCredential({ query } as unknown as Tx, env, identity.workspaceId, identity.keyId, 2, kind)).toBe(true);
    expect(update.slice(0, 2)).toEqual([identity.workspaceId, identity.keyId]);
    expect(update.slice(4)).toEqual([2, 1]);
    const rotated = { ...sealed, wrappedDek: update[2] as Uint8Array, wrapIv: update[3] as Uint8Array, kekVersion: 2 };
    const rotatedEnv = { KEK_CURRENT: '2', KEK_V2: env.KEK_V2 };
    await expect(openSecret(rotatedEnv, namespacedIdentity, rotated)).resolves.toBe('fixture credential');
    await expect(openSecret(env, { ...namespacedIdentity, workspaceId: 'other-workspace' }, rotated)).rejects.toThrow();
  });
  it.each([{ rows: [] }, { rows: [{ kek_version: 2 }] }])('skips consumed/missing or already rotated envelopes', async ({ rows }) => {
    const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
    expect(await rewrapCloudCredential({ query } as unknown as Tx, env, identity.workspaceId, identity.keyId, 2, 'cloud_connection_attempt')).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('reports a version-guard miss as skipped', async () => {
    const sealed = await sealSecret(env, cloudCredentialIdentity('cloud_connection', identity.workspaceId, identity.keyId), 'fixture');
    const query = vi.fn(async (sql: string) => sql.startsWith('SELECT')
      ? { rows: [{ wrapped_dek: sealed.wrappedDek, wrap_iv: sealed.wrapIv, kek_version: 1 }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    expect(await rewrapCloudCredential({ query } as unknown as Tx, env, identity.workspaceId, identity.keyId, 2, 'cloud_connection')).toBe(false);
  });
  it('enumerates live Cloud grants and excludes expired or erased attempts', async () => {
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      expect(sql).toContain("status='pending' AND expires_at>now() AND kek_version <> $1");
      expect(sql).toContain("status IN ('verification_required','connected','reconnect_required')");
      expect(sql).toContain("'provider_key' AS credential_kind");
      expect(sql).toContain('remote_revocation_pending');
      expect(values).toEqual([2]);
      return { rows: [{ workspace_id: identity.workspaceId, key_id: identity.keyId, kek_version: 1, credential_kind: 'cloud_connection_attempt' }] };
    });
    expect(await listRotationTargets({ query } as unknown as Tx, 2)).toEqual([
      { ...identity, kekVersion: 1, credentialKind: 'cloud_connection_attempt' },
    ]);
  });
  it('dispatches both Cloud envelope kinds through workspace transactions', async () => {
    const sealed = {
      cloud_connection: await sealSecret(
        env, cloudCredentialIdentity('cloud_connection', identity.workspaceId, identity.keyId), 'grant fixture'),
      cloud_connection_attempt: await sealSecret(
        env, cloudCredentialIdentity('cloud_connection_attempt', identity.workspaceId, identity.keyId), 'attempt fixture'),
    };
    const query = vi.fn(async (sql: string) => {
      if (!sql.startsWith('SELECT')) return { rows: [], rowCount: 1 };
      const row = sql.includes('cloud_connection_attempts') ? sealed.cloud_connection_attempt : sealed.cloud_connection;
      return { rows: [{ wrapped_dek: row.wrappedDek, wrap_iv: row.wrapIv, kek_version: 1 }], rowCount: 1 };
    });
    const report = await runKekRotation(env, {
      listTargets: async () => (['cloud_connection', 'cloud_connection_attempt'] as const).map(credentialKind => ({ ...identity, kekVersion: 1, credentialKind })),
      withWorkspace: async (workspaceId, fn) => { expect(workspaceId).toBe(identity.workspaceId); return fn({ query } as unknown as Tx); },
    }, 2);
    expect(report.rewrappedByKind).toEqual({ provider_key: 0, slack_installation: 0, cloud_connection: 1, cloud_connection_attempt: 1 });
    expect(report.failed).toEqual([]);
  });
  it('rejects Cloud ciphertext across OAuth purposes and as a provider key', async () => {
    const attemptIdentity = cloudCredentialIdentity('cloud_connection_attempt', identity.workspaceId, identity.keyId);
    const grantIdentity = cloudCredentialIdentity('cloud_connection', identity.workspaceId, identity.keyId);
    const attempt = await sealSecret(env, attemptIdentity, 'pkce fixture');
    const grant = await sealSecret(env, grantIdentity, 'management grant fixture');
    const provider = await sealKey(env, identity, 'provider fixture');

    await expect(openSecret(env, attemptIdentity, attempt)).resolves.toBe('pkce fixture');
    await expect(openSecret(env, grantIdentity, grant)).resolves.toBe('management grant fixture');
    await expect(openSecret(env, grantIdentity, attempt)).rejects.toThrow();
    await expect(openSecret(env, attemptIdentity, grant)).rejects.toThrow();
    await expect(openKey(env, identity, attempt)).rejects.toThrow();
    await expect(openSecret(env, grantIdentity, provider)).rejects.toThrow();
  });
});
