import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { resolveSlackAgent } from '../../src/integrations/slack/principal.js';
import { runSlackRevokeJob } from '../../src/integrations/slack/revoke.js';
import { storeSlackInstallation } from '../../src/integrations/slack/store.js';
import { listRotationTargets } from '../../src/keys/rotation.js';
import { makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

async function insertInstallation(fx: Fixture, target: string): Promise<string> {
  const id = randomUUID();
  await withClient('app', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    await c.query(
      `INSERT INTO slack_installations
         (id, workspace_id, installed_by, slack_install_key, slack_app_id, slack_team_id,
          is_enterprise_install, slack_bot_user_id, slack_authed_user_id, granted_scopes,
          ciphertext, iv, wrapped_dek, wrap_iv, kek_version)
       VALUES ($1,$2,$3,$4,'A-FIXTURE',$5,false,'U-BOT','U-ADMIN',
               ARRAY['app_mentions:read','chat:write','im:history'],
               '\\x01'::bytea,'\\x02'::bytea,'\\x03'::bytea,'\\x04'::bytea,1)`,
      [id, fx.workspaceId, fx.adminId, `team:${target}`, target],
    );
    await c.query('COMMIT');
  });
  return id;
}

describe('Slack database boundaries', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses main\'s private setup session as the agent binding when no ownership row exists', async () => {
    const fx = await seedWorkspace();
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      expect(await resolveSlackAgent(c, fx.workspaceId, fx.adminId)).toEqual({
        user_id: fx.adminId,
        agent_id: fx.agentId,
        agent_name: 'Iris',
      });
      const owners = await c.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM agent_owners WHERE workspace_id=$1',
        [fx.workspaceId],
      );
      expect(owners.rows[0]?.count).toBe('0');
      await c.query('COMMIT');
    });
  });

  it('binds one active Slack target to one Hermes workspace', async () => {
    const first = await seedWorkspace();
    const second = await seedWorkspace();
    const target = `T-SHARED-${first.workspaceId}`;
    await insertInstallation(first, target);
    await expect(insertInstallation(second, target)).rejects.toMatchObject({ code: '23505' });
  });

  it('deduplicates Slack event ids globally, including across installations', async () => {
    const first = await seedWorkspace();
    const second = await seedWorkspace();
    const firstInstall = await insertInstallation(first, `T-FIRST-${first.workspaceId}`);
    const secondInstall = await insertInstallation(second, `T-SECOND-${second.workspaceId}`);
    const eventId = `Ev-${randomUUID()}`;

    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, first.workspaceId, first.adminId);
      await c.query(
        `INSERT INTO slack_events
           (workspace_id, installation_id, slack_event_id, event_type, payload_sha256)
         VALUES ($1,$2,$3,'app_mention',$4)`,
        [first.workspaceId, firstInstall, eventId, 'a'.repeat(64)],
      );
      await c.query('COMMIT');
    });

    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, second.workspaceId, second.adminId);
      await expect(c.query(
        `INSERT INTO slack_events
           (workspace_id, installation_id, slack_event_id, event_type, payload_sha256)
         VALUES ($1,$2,$3,'app_mention',$4)`,
        [second.workspaceId, secondInstall, eventId, 'b'.repeat(64)],
      )).rejects.toMatchObject({ code: '23505' });
      await c.query('ROLLBACK');
    });
  });

  it('keeps a revoked token encrypted until durable Slack uninstall succeeds, then erases it', async () => {
    const fx = await seedWorkspace();
    const env = makeEnv({
      KEK_V1: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
      SLACK_ENABLED: '1',
      SLACK_CLIENT_ID: 'fixture-client',
      SLACK_CLIENT_SECRET: 'fixture-client-secret',
      SLACK_SIGNING_SECRET: 'fixture-signing-secret',
      SLACK_STATE_SECRET: 'fixture-state-secret',
      SLACK_REDIRECT_URI: 'https://hermes.example/integrations/slack/oauth/callback',
    } as Partial<Env>).env;
    const stored = await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const result = await storeSlackInstallation(c, env, {
        workspaceId: fx.workspaceId,
        installedBy: fx.adminId,
        grant: {
          app_id: 'A-FIXTURE',
          enterprise: null,
          team: { id: `T-REVOKE-${fx.workspaceId}`, name: 'Fixture Slack' },
          is_enterprise_install: false,
          bot_user_id: 'U-BOT',
          authed_user_id: 'U-ADMIN',
          scope: ['app_mentions:read', 'chat:write', 'im:history'],
          token: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'bot', expires_at: null },
        },
      });
      await c.query(
        `UPDATE slack_installations
            SET status='revoked', revoked_at=now(), remote_revocation_pending=true
          WHERE workspace_id=$1 AND id=$2`,
        [fx.workspaceId, result.installation.id],
      );
      await c.query('COMMIT');
      return result.installation;
    });

    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      expect(await listRotationTargets(c, 2)).toEqual([
        expect.objectContaining({ keyId: stored.id, credentialKind: 'slack_installation', kekVersion: 1 }),
      ]);
      await c.query('COMMIT');
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await runSlackRevokeJob(env, {
      id: randomUUID(),
      workspace_id: fx.workspaceId,
      kind: 'slack_revoke',
      key: `slack-revoke:${stored.id}`,
      payload: { installation_id: stored.id },
      attempts: 1,
    });

    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const { rows } = await c.query<{
        remote_revocation_pending: boolean;
        ciphertext: Buffer;
        wrapped_dek: Buffer;
      }>(
        `SELECT remote_revocation_pending, ciphertext, wrapped_dek
           FROM slack_installations WHERE workspace_id=$1 AND id=$2`,
        [fx.workspaceId, stored.id],
      );
      expect(rows[0]?.remote_revocation_pending).toBe(false);
      expect(Array.from(rows[0]?.ciphertext ?? [])).toEqual([0]);
      expect(Array.from(rows[0]?.wrapped_dek ?? [])).toEqual([0]);
      await c.query('COMMIT');
    });
  });
});
