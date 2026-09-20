// Settings, the data-and-privacy page, the attestation, and workspace deletion.
//
// The deletion tests are the interesting half: they run the Workflow body
// against a fake `step` whose `sleep` returns immediately, which is the only way
// a seven-day sleep is testable at all. Everything the seven days protect —
// access revoked now, the cancel check after the sleep, the order of the three
// destructive steps — is asserted here.
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../src/env.js';
import {
  DEEPSEEK_WARNING,
  ERASURE_TIMING,
} from '../../src/routes/settings.js';
import {
  DELETION_SLEEP,
  runWorkspaceDeletion,
  type DeletionStep,
} from '../../src/workflows-long/workspace-deletion.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

let fx: Fixture;

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

beforeAll(async () => {
  fx = await seedWorkspace();
});

describe('GET/PATCH /w/:ws/settings', () => {
  it('reads the defaults, the caps and the allowlist', async () => {
    const { env } = makeEnv();
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/settings`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      defaults: { model_id: string };
      caps: { max_concurrent_runs: number };
      fetch_url_allowlist: string[];
      notifications: { blocked: boolean };
      role: string;
    };
    expect(body.defaults.model_id).toBe('nous:anthropic/claude-sonnet-5');
    expect(body.caps.max_concurrent_runs).toBe(3);
    // Decision E2: empty means nothing is reachable, not everything.
    expect(body.fetch_url_allowlist).toEqual([]);
    expect(body.notifications.blocked).toBe(true);
    expect(body.role).toBe('admin');
  });

  it('needs an Admin for the workspace half, and writes one audit row', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();

    const refused = await asUser(env, local.memberId, `/w/${local.workspaceId}/settings`, {
      method: 'PATCH',
      body: { daily_token_cap: 5000 },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: 'admin_required' });

    const allowed = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings`, {
      method: 'PATCH',
      body: { daily_token_cap: 5000, max_concurrent_runs: 5 },
    });
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { caps: { daily_token_cap: number; max_concurrent_runs: number } };
    expect(body.caps.daily_token_cap).toBe(5000);
    expect(body.caps.max_concurrent_runs).toBe(5);

    const events = await asTenant(local, (c) =>
      c.query<{ kind: string }>(`SELECT kind FROM events WHERE workspace_id = $1 AND kind = 'settings.changed'`, [
        local.workspaceId,
      ]),
    );
    expect(events.rows).toHaveLength(1);
  });

  it('lets a Member change their own notifications without an Admin check', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();
    const response = await asUser(env, local.memberId, `/w/${local.workspaceId}/settings`, {
      method: 'PATCH',
      body: { notifications: { digest: true, blocked: false } },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { notifications: { digest: boolean; blocked: boolean } };
    expect(body.notifications.digest).toBe(true);
    expect(body.notifications.blocked).toBe(false);

    // Not audited: a trail of who muted their own email is surveillance.
    const events = await asTenant(local, (c) =>
      c.query(`SELECT 1 FROM events WHERE workspace_id = $1 AND kind = 'settings.changed'`, [local.workspaceId]),
    );
    expect(events.rows).toHaveLength(0);
  });

  it('keeps member defaults, caps and notifications while withholding Admin configuration state', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();
    await asTenant(local, async (c) => {
      await c.query(
        `UPDATE workspace_settings
            SET flags=$2::jsonb,daily_token_cap=1200,max_concurrent_runs=2
          WHERE workspace_id=$1`,
        [local.workspaceId, JSON.stringify({ feature_preview: true, fetch_url_allowlist: ['private.example'] })],
      );
      await c.query(
        `UPDATE workspaces SET deletion_requested_at=now(),deletion_scheduled_at=now()+interval '7 days'
          WHERE id=$1`,
        [local.workspaceId],
      );
    });

    const member = await asUser(env, local.memberId, `/w/${local.workspaceId}/settings`);
    expect(member.status).toBe(200);
    expect(await member.json()).toMatchObject({
      role: 'member',
      defaults: { model_id: 'nous:anthropic/claude-sonnet-5' },
      caps: { daily_token_cap: 1200, max_concurrent_runs: 2 },
      flags: {},
      fetch_url_allowlist: [],
      notifications: { approvals: true, blocked: true, digest: false },
      deletion: { requested_at: null, scheduled_at: null },
    });

    const admin = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings`);
    expect(await admin.json()).toMatchObject({
      flags: { feature_preview: true, fetch_url_allowlist: ['private.example'] },
      fetch_url_allowlist: ['private.example'],
      deletion: { requested_at: expect.any(String), scheduled_at: expect.any(String) },
    });
  });

  it('normalises the fetch_url allowlist and refuses something that is not a hostname', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();

    const ok = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings`, {
      method: 'PATCH',
      body: { fetch_url_allowlist: ['https://Example.com/path', 'example.com', 'docs.internal'] },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { fetch_url_allowlist: string[] };
    // Scheme and path stripped, lowercased, de-duplicated.
    expect(body.fetch_url_allowlist).toEqual(['example.com', 'docs.internal']);

    const bad = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings`, {
      method: 'PATCH',
      body: { fetch_url_allowlist: ['not a host name'] },
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ reason: 'bad_allowlist' });
  });

  it('refuses a cap, a concurrency, a model and a timezone it cannot honour', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();
    const cases: [Record<string, unknown>, string][] = [
      [{ daily_token_cap: -1 }, 'bad_cap'],
      [{ max_concurrent_runs: 0 }, 'bad_concurrency'],
      [{ default_model_id: 'no-such-model' }, 'unknown_model'],
      [{ timezone: 'Mars/Olympus' }, 'bad_timezone'],
      [{ default_effort: 'extreme' }, 'bad_effort'],
    ];
    for (const [body, reason] of cases) {
      const response = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings`, {
        method: 'PATCH',
        body,
      });
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await response.json(), JSON.stringify(body)).toMatchObject({ reason });
    }
  });

  it('merges flags rather than replacing them, so two tabs do not erase each other', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();
    await asUser(env, local.adminId, `/w/${local.workspaceId}/settings`, {
      method: 'PATCH',
      body: { flags: { alpha: true } },
    });
    const second = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings`, {
      method: 'PATCH',
      body: { flags: { beta: true } },
    });
    const body = (await second.json()) as { flags: Record<string, unknown> };
    expect(body.flags.alpha).toBe(true);
    expect(body.flags.beta).toBe(true);
  });
});

describe('Settings > Data and privacy', () => {
  it('carries the retention facts, the erasure timing and no comfortable lie', async () => {
    const { env } = makeEnv();
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/settings/data-privacy`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      retention: { store: string }[];
      erasure: typeof ERASURE_TIMING;
      residency: Record<string, string>;
    };
    expect(body.retention.length).toBeGreaterThanOrEqual(8);
    // Plan section 6: erasure completes only after Neon's 7-day window and the
    // 30-day backup rule have passed, and the copy says so.
    expect(body.erasure.point_in_time_history_days).toBe(7);
    expect(body.erasure.backup_retention_days).toBe(30);
    expect(body.erasure.complete_after_days).toBe(30);
    expect(body.erasure.copy).toContain('30 days');
    expect(body.residency.identity_provider).toContain('Standard Contractual Clauses');
  });

  it('warns about DeepSeek by name, and does not warn about a provider that needs none', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();
    const deepseekKey = randomUUID();
    const anthropicKey = randomUUID();
    await asTenant(local, async (c) => {
      for (const [id, provider] of [
        [deepseekKey, 'deepseek'],
        [anthropicKey, 'anthropic'],
      ] as const) {
        await c.query(
          `INSERT INTO workspace_provider_keys
             (id, workspace_id, provider, label, ciphertext, iv, wrapped_dek, wrap_iv, kek_version,
              fingerprint, last4, status)
           VALUES ($1, $2, $3, 'k', '\\x00', '\\x00', '\\x00', '\\x00', 1, $4, 'abcd', 'verified')`,
          [id, local.workspaceId, provider, randomUUID()],
        );
      }
    });

    const response = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings/data-privacy`);
    const body = (await response.json()) as {
      keys: { key_id: string; warnings: string[]; attested: boolean; real_data_allowed: boolean }[];
    };
    const deepseek = body.keys.find((k) => k.key_id === deepseekKey);
    const anthropic = body.keys.find((k) => k.key_id === anthropicKey);

    expect(deepseek?.warnings).toEqual([DEEPSEEK_WARNING]);
    expect(DEEPSEEK_WARNING).toContain('People’s Republic of China');
    expect(anthropic?.warnings).toEqual([]);
    // No attestation yet, so neither may carry real applicant data.
    expect(deepseek?.attested).toBe(false);
    expect(anthropic?.real_data_allowed).toBe(false);
  });

  it('gives a Member processor policy without credential inventory metadata', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();
    const keyId = randomUUID();
    await asTenant(local, (c) => c.query(
      `INSERT INTO workspace_provider_keys
         (id,workspace_id,provider,label,ciphertext,iv,wrapped_dek,wrap_iv,kek_version,
          fingerprint,last4,status,verified_at,attestation)
       VALUES ($1,$2,'anthropic','Finance production key','\\x00','\\x00','\\x00','\\x00',1,
          $3,'s3cr','verified',now(),$4::jsonb)`,
      [keyId, local.workspaceId, randomUUID(), JSON.stringify({ kind: 'zdr', reference: 'private-contract' })],
    ));

    const member = await asUser(env, local.memberId, `/w/${local.workspaceId}/settings/data-privacy`);
    expect(member.status).toBe(200);
    const body = await member.json() as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toEqual([expect.objectContaining({
      provider: 'anthropic', label: 'anthropic', last4: '', status: 'configured',
      verified_at: null, attestation: null, attested: true, real_data_allowed: true,
    })]);
    expect(body.keys[0]?.key_id).not.toBe(keyId);
    expect(JSON.stringify(body)).not.toContain('Finance production key');
    expect(JSON.stringify(body)).not.toContain('s3cr');
    expect(JSON.stringify(body)).not.toContain('private-contract');

    const admin = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings/data-privacy`);
    expect(await admin.json()).toMatchObject({ keys: [expect.objectContaining({
      key_id: keyId, label: 'Finance production key', last4: 's3cr', status: 'verified',
      attestation: expect.objectContaining({ reference: 'private-contract' }),
    })] });
  });

  it('does not treat synthetic-only or no-attestation policy as permission for real data', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();
    await asTenant(local, async (c) => {
      for (const [provider, kind] of [['anthropic', 'synthetic_only'], ['openrouter', 'none']] as const) {
        await c.query(
          `INSERT INTO workspace_provider_keys
             (workspace_id,provider,label,ciphertext,iv,wrapped_dek,wrap_iv,kek_version,
              fingerprint,last4,status,attestation)
           VALUES($1,$2,$3,'\\x00','\\x00','\\x00','\\x00',1,$4,'abcd','verified',$5::jsonb)`,
          [local.workspaceId, provider, `${provider} key`, randomUUID(), JSON.stringify({ kind })],
        );
      }
    });
    for (const userId of [local.adminId, local.memberId]) {
      const response = await asUser(env, userId, `/w/${local.workspaceId}/settings/data-privacy`);
      const body = await response.json() as { keys: Array<{ provider: string; real_data_allowed: boolean }> };
      expect(body.keys.find((row) => row.provider === 'anthropic')?.real_data_allowed).toBe(false);
      expect(body.keys.find((row) => row.provider === 'openrouter')?.real_data_allowed).toBe(false);
    }
  });
});

describe('PATCH /w/:ws/provider-keys/:id/attestation', () => {
  it('records who claimed what, needs an Admin, and refuses an unknown kind', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();
    const keyId = randomUUID();
    await asTenant(local, (c) =>
      c.query(
        `INSERT INTO workspace_provider_keys
           (id, workspace_id, provider, label, ciphertext, iv, wrapped_dek, wrap_iv, kek_version,
            fingerprint, last4, status)
         VALUES ($1, $2, 'anthropic', 'k', '\\x00', '\\x00', '\\x00', '\\x00', 1, $3, 'abcd', 'verified')`,
        [keyId, local.workspaceId, randomUUID()],
      ),
    );
    const path = `/w/${local.workspaceId}/provider-keys/${keyId}/attestation`;

    const refused = await asUser(env, local.memberId, path, { method: 'PATCH', body: { kind: 'zdr' } });
    expect(refused.status).toBe(403);

    const bad = await asUser(env, local.adminId, path, { method: 'PATCH', body: { kind: 'we-promise' } });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ reason: 'bad_attestation' });

    const ok = await asUser(env, local.adminId, path, {
      method: 'PATCH',
      body: { kind: 'zdr', reference: 'Anthropic ZDR 2026-09', note: 'sales-arranged' },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { attestation: { kind: string; recorded_by: string; recorded_at: string } };
    expect(body.attestation.kind).toBe('zdr');
    // An attestation with no author is a claim nobody made.
    expect(body.attestation.recorded_by).toBe(local.adminId);
    expect(body.attestation.recorded_at).toBeTruthy();

    const events = await asTenant(local, (c) =>
      c.query<{ key_id: string }>(
        `SELECT key_id FROM events WHERE workspace_id = $1 AND kind = 'provider_key.attested'`,
        [local.workspaceId],
      ),
    );
    expect(events.rows[0]?.key_id).toBe(keyId);

    // And the data-privacy page now says real data is allowed on it.
    const privacy = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings/data-privacy`);
    const keys = (await privacy.json()) as { keys: { key_id: string; real_data_allowed: boolean }[] };
    expect(keys.keys.find((k) => k.key_id === keyId)?.real_data_allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Workspace deletion
// ---------------------------------------------------------------------------

/** A `step` whose sleep returns at once, and which records what it was asked. */
function fakeStep(): DeletionStep & { names: string[]; slept: string[] } {
  const names: string[] = [];
  const slept: string[] = [];
  return {
    names,
    slept,
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      names.push(name);
      return fn();
    },
    sleep(name: string, duration: string): Promise<void> {
      slept.push(duration);
      return Promise.resolve();
    },
  };
}

describe('DELETE /w/:ws', () => {
  it('revokes access immediately and schedules the destruction for seven days', async () => {
    const local = await seedWorkspace();
    const created: { id: string }[] = [];
    const { env } = makeEnv({
      WORKSPACE_DELETION: {
        create: (options: { id: string }) => {
          created.push({ id: options.id });
          return Promise.resolve({ id: options.id });
        },
        get: () => ({ terminate: () => Promise.resolve() }),
      },
    } as unknown as Partial<Env>);

    await asTenant(local, (c) =>
      c.query(
        `INSERT INTO session_shares
           (workspace_id, session_id, created_by, token_hash, audience, message_cutoff_seq)
         VALUES ($1, $2, $3, $4, 'viewer', 0)`,
        [local.workspaceId, local.sessionId, local.adminId, randomUUID()],
      ),
    );

    const response = await asUser(env, local.adminId, `/w/${local.workspaceId}`, { method: 'DELETE' });
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      grace_period_days: number;
      members_evicted: number;
      instance_id: string;
      copy: string;
    };
    expect(body.grace_period_days).toBe(7);
    expect(body.members_evicted).toBe(2);
    expect(created).toHaveLength(1);
    expect(created[0]?.id).toBe(body.instance_id);
    expect(body.copy).toContain('30 days');

    const state = await asTenant(local, (c) =>
      c.query<{ requested: Date | null; scheduled: Date | null; shares: string; read_only: boolean }>(
        `SELECT w.deletion_requested_at AS requested, w.deletion_scheduled_at AS scheduled,
                (SELECT count(*)::text FROM session_shares s
                  WHERE s.workspace_id = w.id AND s.revoked_at IS NULL) AS shares,
                (SELECT bool_and(read_only) FROM sessions WHERE workspace_id = w.id) AS read_only
           FROM workspaces w WHERE w.id = $1`,
        [local.workspaceId],
      ),
    );
    const row = state.rows[0];
    expect(row?.requested).toBeTruthy();
    // Seven days out, give or take the second it took to run.
    const gap = (row!.scheduled!.getTime() - row!.requested!.getTime()) / 86_400_000;
    expect(gap).toBeGreaterThan(6.9);
    expect(gap).toBeLessThan(7.1);
    // Access is revoked *now*: the two reasons to delete a workspace are "we
    // are done" and "someone got in", and the second cannot wait a week.
    expect(row?.shares).toBe('0');
    expect(row?.read_only).toBe(true);

    // An evict job per member, so sockets close now rather than in ten minutes.
    const jobs = await asTenant(local, (c) =>
      c.query<{ kind: string }>(`SELECT kind FROM jobs WHERE workspace_id = $1 AND kind = 'evict'`, [
        local.workspaceId,
      ]),
    );
    expect(jobs.rows).toHaveLength(2);
  });

  it('needs an Admin, and refuses a second request', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv({
      WORKSPACE_DELETION: { create: () => Promise.resolve({}), get: () => ({ terminate: () => Promise.resolve() }) },
    } as unknown as Partial<Env>);

    const refused = await asUser(env, local.memberId, `/w/${local.workspaceId}`, { method: 'DELETE' });
    expect(refused.status).toBe(403);

    const first = await asUser(env, local.adminId, `/w/${local.workspaceId}`, { method: 'DELETE' });
    expect(first.status).toBe(202);
    const second = await asUser(env, local.adminId, `/w/${local.workspaceId}`, { method: 'DELETE' });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ reason: 'already_scheduled' });
  });

  it('cancels inside the grace period, and the Workflow stops on its own', async () => {
    const local = await seedWorkspace();
    let terminated = 0;
    const { env } = makeEnv({
      WORKSPACE_DELETION: {
        create: () => Promise.resolve({}),
        get: () => ({
          terminate: () => {
            terminated += 1;
            return Promise.resolve();
          },
        }),
      },
    } as unknown as Partial<Env>);

    await asUser(env, local.adminId, `/w/${local.workspaceId}`, { method: 'DELETE' });
    const cancelled = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings/undelete`, {
      method: 'POST',
      body: {},
    });
    expect(cancelled.status).toBe(200);
    expect(terminated).toBe(1);

    const events = await asTenant(local, (c) =>
      c.query<{ kind: string }>(
        `SELECT kind FROM events WHERE workspace_id = $1 AND kind = 'workspace.deletion_cancelled'`,
        [local.workspaceId],
      ),
    );
    expect(events.rows).toHaveLength(1);

    // The belt to that brace: the Workflow re-reads the row after its sleep and
    // stops even if the terminate call was lost.
    const step = fakeStep();
    const outcome = await runWorkspaceDeletion(
      { workspaceId: local.workspaceId, requestedBy: local.adminId, requestedAt: new Date().toISOString() },
      { env, deleteOrganization: () => Promise.resolve(), deleteObjects: () => Promise.resolve(0) },
      step,
    );
    expect(outcome.deleted).toBe(false);
    expect(outcome.reason).toBe('cancelled');
    // The sleep happened first, then the re-read, and nothing destructive ran.
    expect(step.slept).toEqual([DELETION_SLEEP]);
    expect(step.names).toEqual(['read-workspace']);

    // `workspaces` is filtered on `id = app_workspace_id()` (decision 5), so a
    // read with no tenant key set returns nothing whether the row exists or
    // not. Every existence assertion in this file therefore sets the key.
    const alive = await asTenant(local, (c) =>
      c.query(`SELECT 1 FROM workspaces WHERE id = $1`, [local.workspaceId]),
    );
    expect(alive.rows).toHaveLength(1);
  });

  it('after the sleep, deletes the WorkOS organization, then the rows, then the objects', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv({
      WORKSPACE_DELETION: { create: () => Promise.resolve({}), get: () => ({ terminate: () => Promise.resolve() }) },
    } as unknown as Partial<Env>);

    // A directory row with an organization, so the WorkOS half has something
    // to delete. Written outside RLS, like `POST /workspaces` writes it.
    await withClient('owner', (c) =>
      c.query(
        `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1, $2)
         ON CONFLICT (workspace_id) DO UPDATE SET workos_organization_id = EXCLUDED.workos_organization_id`,
        [local.workspaceId, `org_${randomUUID().slice(0, 12)}`],
      ),
    );
    const organizationId = (
      await withClient('owner', (c) =>
        c.query<{ workos_organization_id: string }>(
          `SELECT workos_organization_id FROM workspace_directory WHERE workspace_id = $1`,
          [local.workspaceId],
        ),
      )
    ).rows[0]!.workos_organization_id;
    await asTenant(local, (c) =>
      c.query(`UPDATE workspaces SET workos_organization_id = $2 WHERE id = $1`, [
        local.workspaceId,
        organizationId,
      ]),
    );

    await asUser(env, local.adminId, `/w/${local.workspaceId}`, { method: 'DELETE' });

    const organizations: string[] = [];
    const objects: string[] = [];
    const step = fakeStep();
    const outcome = await runWorkspaceDeletion(
      { workspaceId: local.workspaceId, requestedBy: local.adminId, requestedAt: new Date().toISOString() },
      {
        env,
        deleteOrganization: (id) => {
          organizations.push(id);
          return Promise.resolve();
        },
        deleteObjects: (id) => {
          objects.push(id);
          return Promise.resolve(3);
        },
      },
      step,
    );

    expect(outcome.deleted).toBe(true);
    expect(outcome.organization).toBe(organizationId);
    expect(outcome.objects).toBe(3);
    expect(organizations).toEqual([organizationId]);
    expect(objects).toEqual([local.workspaceId]);

    // The order is load-bearing: their side first (we cannot retry it against a
    // deleted row), the audit row before the rows it lives in are cascaded away,
    // and the objects last, because an object with no row is garbage the sweep
    // collects while a row with no object is a broken product.
    expect(step.names).toEqual([
      'read-workspace',
      'delete-workos-organization',
      'audit',
      'delete-rows',
      'delete-objects',
    ]);

    const gone = await asTenant(local, (c) =>
      c.query(`SELECT 1 FROM workspaces WHERE id = $1`, [local.workspaceId]),
    );
    expect(gone.rows).toHaveLength(0);
    // ON DELETE CASCADE took the tenant rows with it. The directory row too,
    // which is a platform table and is deleted explicitly by the procedure.
    const sessions = await asTenant(local, (c) =>
      c.query(`SELECT 1 FROM sessions WHERE id = $1`, [local.sessionId]),
    );
    expect(sessions.rows).toHaveLength(0);
    const directory = await withClient('owner', (c) =>
      c.query(`SELECT 1 FROM workspace_directory WHERE workspace_id = $1`, [local.workspaceId]),
    );
    expect(directory.rows).toHaveLength(0);
  });

  it('is a no-op on a workspace nobody asked to delete, even with the grant', async () => {
    const local = await seedWorkspace();
    // The SECURITY DEFINER procedure refuses a workspace with no
    // `deletion_requested_at`, so the grant that lets `app` call it does not
    // widen what a stray call can destroy.
    const result = await withClient('app', (c) =>
      c.query<{ deleted: number }>(`SELECT hermes_delete_workspace($1::uuid) AS deleted`, [local.workspaceId]),
    );
    expect(result.rows[0]?.deleted).toBe(0);
    const alive = await asTenant(local, (c) =>
      c.query(`SELECT 1 FROM workspaces WHERE id = $1`, [local.workspaceId]),
    );
    expect(alive.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// G5 · PATCH /w/:ws/settings refuses a key it does not store
// ---------------------------------------------------------------------------

describe('G5 · unknown settings keys', () => {
  it('answers 422 and names them, instead of a 200 that stored nothing', async () => {
    // Two real client bugs lived behind the old silent no-op for a milestone
    // each: `{ notify_approvals }` (client finding 12) and `{ reduce_motion }`
    // (finding 13). Both matched no field, took no Admin check, wrote no audit
    // row, and answered 200 with a settings view that did not contain them.
    const local = await seedWorkspace();
    const { env } = makeEnv();

    const response = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings`, {
      method: 'PATCH',
      body: { notify_approvals: true, reduce_motion: true },
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { reason: string; error: string };
    expect(body.reason).toBe('unknown_fields');
    expect(body.error).toContain('notify_approvals');
    expect(body.error).toContain('reduce_motion');
  });

  it('refuses the whole patch when one key of several is unknown', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();

    const response = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings`, {
      method: 'PATCH',
      body: { timezone: 'Europe/London', notify_digest: true },
    });

    expect(response.status).toBe(422);
    const stored = await asTenant(local, (c) =>
      c.query<{ timezone: string }>(`SELECT timezone FROM workspace_settings WHERE workspace_id = $1`, [
        local.workspaceId,
      ]),
    );
    expect(stored.rows[0]?.timezone).not.toBe('Europe/London');
  });

  it('still takes every key it does store', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();

    const workspaceHalf = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings`, {
      method: 'PATCH',
      body: { timezone: 'Europe/London', daily_token_cap: 1_000, max_concurrent_runs: 2, flags: { beta: true } },
    });
    expect(workspaceHalf.status).toBe(200);
    expect(await workspaceHalf.json()).toMatchObject({
      timezone: 'Europe/London',
      caps: { daily_token_cap: 1_000, max_concurrent_runs: 2 },
    });

    // The personal half, which a Member may change without an Admin.
    const personalHalf = await asUser(env, local.memberId, `/w/${local.workspaceId}/settings`, {
      method: 'PATCH',
      body: { notifications: { approvals: false, digest: true } },
    });
    expect(personalHalf.status).toBe(200);
    expect(await personalHalf.json()).toMatchObject({ notifications: { approvals: false, digest: true } });
  });

  it('refuses a body that is not an object at all', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();
    const response = await asUser(env, local.adminId, `/w/${local.workspaceId}/settings`, {
      method: 'PATCH',
      body: ['timezone'],
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ reason: 'bad_body' });
  });
});
