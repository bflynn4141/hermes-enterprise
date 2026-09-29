// A rotated OAuth refresh token must survive whatever happens to the caller.
//
// Slack, Microsoft and Nous answer a refresh with a new refresh token. The fake
// provider here is strict, as Nous (reuse detection) and Slack are: a refresh
// token works once. Microsoft keeps old refresh tokens valid, but says to
// discard them, so the same rule holds for its replacement.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '../../src/db/client.js';
import type { Env } from '../../src/env.js';
import { storeSlackInstallation, resolveSlackAccessToken, type SlackInstallationRow } from '../../src/integrations/slack/store.js';
import { withWorkspaceTransaction } from '../../src/jobs.js';
import { addProviderOAuthConnection, resolveKey } from '../../src/keys/store.js';
import type { OwnTransaction } from '../../src/keys/token-refresh.js';
import { resolveSendingAccessToken, storeSendingAccount } from '../../src/outbound-email/gmail-store.js';
import { makeEnv } from './harness.js';
import { seedWorkspace, type Fixture } from './helpers.js';

/** A provider whose refresh tokens are single-use. */
class RotatingProvider {
  readonly live = new Set<string>();
  readonly spent: string[] = [];
  private issued = 0;
  exchanges = 0;

  issue(): { access: string; refresh: string } {
    this.issued += 1;
    const refresh = `refresh-${this.issued}`;
    this.live.add(refresh);
    return { access: `access-${this.issued}`, refresh };
  }

  /** Spend `refresh` and mint the next pair, or null when it is no longer valid. */
  exchange(refresh: string | null): { access: string; refresh: string } | null {
    this.exchanges += 1;
    if (!refresh || !this.live.delete(refresh)) return null;
    this.spent.push(refresh);
    return this.issue();
  }

  /** Answers Slack, Microsoft identity and Nous Portal token requests. */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === 'slack.com' && url.pathname === '/api/oauth.v2.access') {
      const next = this.exchange(new URLSearchParams(await request.text()).get('refresh_token'));
      return Response.json(next
        ? { ok: true, access_token: next.access, refresh_token: next.refresh, token_type: 'bot', expires_in: 43_200 }
        : { ok: false, error: 'invalid_refresh_token' });
    }
    if (url.hostname === 'login.microsoftonline.com') {
      const next = this.exchange(new URLSearchParams(await request.text()).get('refresh_token'));
      return next
        ? Response.json({ access_token: next.access, refresh_token: next.refresh, expires_in: 3600, scope: 'Mail.Send User.Read', token_type: 'Bearer' })
        : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    if (url.hostname === 'portal.nousresearch.com' && url.pathname === '/api/oauth/token') {
      const next = this.exchange(request.headers.get('x-nous-refresh-token'));
      return next
        ? Response.json({ access_token: next.access, refresh_token: next.refresh, expires_in: 3600, token_type: 'Bearer', scope: 'inference:invoke' })
        : Response.json({ error: 'refresh_token_reused' }, { status: 400 });
    }
    throw new Error(`unexpected request to ${request.url}`);
  }
}

let provider = new RotatingProvider();
const env: Env = makeEnv({
  KEK_V1: Buffer.alloc(32, 41).toString('base64'),
  SLACK_ENABLED: '1',
  SLACK_CLIENT_ID: 'slack-client', SLACK_CLIENT_SECRET: 'slack-secret',
  SLACK_SIGNING_SECRET: 'slack-signing-secret', SLACK_STATE_SECRET: 'slack-state-secret',
  SLACK_REDIRECT_URI: 'https://hermes.test/integrations/slack/oauth/callback',
  MICROSOFT_MAIL_ENABLED: '1',
  MICROSOFT_CLIENT_ID: 'ms-client', MICROSOFT_CLIENT_SECRET: 'ms-secret',
  MICROSOFT_STATE_SECRET: 'microsoft-state-secret-at-least-thirty-two-chars',
  MICROSOFT_REDIRECT_URI: 'https://hermes.test/integrations/microsoft/oauth/callback',
  MICROSOFT_FETCHER: { fetch: (request: Request) => provider.fetch(request) } as Fetcher,
} as unknown as Partial<Env>).env;

beforeEach(() => {
  provider = new RotatingProvider();
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => provider.fetch(input, init));
});
afterEach(() => vi.unstubAllGlobals());

const expired = () => new Date(Date.now() - 60_000).toISOString();

/** A caller whose own transaction fails after the token was resolved, e.g. its commit. */
class CallerFailed extends Error {}

/** Each workspace's refresh runs on its own committed connection, as production wires it. */
const ownFor = (workspaceId: string, role: 'app' | 'agent' = 'app'): OwnTransaction =>
  (fn) => withWorkspaceTransaction(env, workspaceId, fn, role);

/** An own transaction whose first `failures` attempts do all their work and then roll back. */
function flakyOwn(workspaceId: string, failures: number, role: 'app' | 'agent' = 'app'): OwnTransaction & { attempts: number } {
  const own = (async <T>(fn: (tx: Tx) => Promise<T>) => {
    own.attempts += 1;
    if (own.attempts > failures) return withWorkspaceTransaction(env, workspaceId, fn, role);
    return withWorkspaceTransaction(env, workspaceId, async (tx) => {
      await fn(tx);
      throw new Error('connection lost before COMMIT');
    }, role);
  }) as OwnTransaction & { attempts: number };
  own.attempts = 0;
  return own;
}

interface Connection {
  readonly fx: Fixture;
  readonly role: 'app' | 'agent';
  /** Take the lock a foreign-key check on this credential row takes. */
  keyShare(tx: Tx): Promise<unknown>;
  /** Resolve an access token inside the caller's transaction `tx`. */
  resolve(tx: Tx, own: OwnTransaction): Promise<string>;
}

async function slackConnection(): Promise<Connection> {
  const fx = await seedWorkspace();
  const first = provider.issue();
  const installation = await withWorkspaceTransaction(env, fx.workspaceId, async (tx) => (await storeSlackInstallation(tx, env, {
    workspaceId: fx.workspaceId,
    installedBy: fx.adminId,
    grant: {
      app_id: 'A-FIXTURE', enterprise: null, team: { id: `T-${fx.workspaceId}`, name: 'Fixture Slack' },
      is_enterprise_install: false, bot_user_id: 'U-BOT', authed_user_id: 'U-ADMIN',
      scope: ['app_mentions:read', 'chat:write'],
      token: { access_token: first.access, refresh_token: first.refresh, token_type: 'bot', expires_at: expired() },
    },
  })).installation);
  return {
    fx, role: 'app',
    keyShare: (tx) => tx.query('SELECT 1 FROM slack_installations WHERE id=$1 FOR KEY SHARE', [installation.id]),
    resolve: (tx, own) => resolveSlackAccessToken(tx, env, installation as SlackInstallationRow, own),
  };
}

async function microsoftConnection(): Promise<Connection> {
  const fx = await seedWorkspace();
  const first = provider.issue();
  const account = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => storeSendingAccount(tx, env, {
    workspaceId: fx.workspaceId, connectedBy: fx.adminId, address: `ops-${fx.workspaceId}@contoso.example`, provider: 'microsoft',
    token: { access_token: first.access, refresh_token: first.refresh, expires_at: expired(), scope: 'Mail.Send', token_type: 'Bearer' },
  }));
  return {
    fx, role: 'app',
    keyShare: (tx) => tx.query('SELECT 1 FROM outbound_email_accounts WHERE id=$1 FOR KEY SHARE', [account.id]),
    resolve: async (tx, own) => (await resolveSendingAccessToken(tx, env, account.id, own)).token,
  };
}

async function nousConnection(): Promise<Connection> {
  const fx = await seedWorkspace();
  const first = provider.issue();
  const key = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => addProviderOAuthConnection(tx, env, {
    workspaceId: fx.workspaceId, addedBy: fx.adminId,
    credential: {
      access_token: first.access, refresh_token: first.refresh, client_id: 'enterprise-hermes',
      scope: 'inference:invoke', token_type: 'Bearer', portal_base_url: 'https://portal.nousresearch.com',
      inference_base_url: 'https://inference-api.nousresearch.com/v1', expires_at: expired(),
    },
  }));
  return {
    fx, role: 'agent',
    keyShare: (tx) => tx.query('SELECT 1 FROM workspace_provider_keys WHERE id=$1 FOR KEY SHARE', [key.id]),
    resolve: async (tx, own) => {
      const resolved = await resolveKey(tx, env, fx.workspaceId, 'nous_portal', own);
      if (resolved.status === 'invalid' || !resolved.apiKey) throw new Error('nous_oauth_quarantined');
      return resolved.apiKey;
    },
  };
}

const CONNECTIONS: [string, () => Promise<Connection>][] = [
  ['Slack', slackConnection],
  ['Microsoft', microsoftConnection],
  ['Nous Portal', nousConnection],
];

describe.each(CONNECTIONS)('%s token refresh', (_name, connect) => {
  it('keeps the rotated token when the caller\'s transaction fails after the refresh', async () => {
    const connection = await connect();
    const { fx, role } = connection;
    await expect(withWorkspaceTransaction(env, fx.workspaceId, async (tx) => {
      expect(await connection.resolve(tx, ownFor(fx.workspaceId, role))).toBe('access-2');
      throw new CallerFailed('the caller\'s commit failed');
    }, role)).rejects.toBeInstanceOf(CallerFailed);
    expect(provider.spent).toEqual(['refresh-1']);

    // The next request finds the rotated token stored and fresh; it does not
    // replay the spent refresh token.
    const next = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => connection.resolve(tx, ownFor(fx.workspaceId, role)), role);
    expect(next).toBe('access-2');
    expect(provider.exchanges).toBe(1);
  });

  it('writes the rotated token again when its own transaction fails after the provider answered', async () => {
    const connection = await connect();
    const { fx, role } = connection;
    const own = flakyOwn(fx.workspaceId, 1, role);
    const token = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => connection.resolve(tx, own), role);
    expect(token).toBe('access-2');
    expect(own.attempts).toBe(2);
    expect(provider.exchanges).toBe(1);

    const next = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => connection.resolve(tx, ownFor(fx.workspaceId, role)), role);
    expect(next).toBe('access-2');
    expect(provider.exchanges).toBe(1);
  });

  it('does not wait on a caller that references the credential row', async () => {
    // Inserting a row with a foreign key to the credential (a model call, a
    // Slack delivery, an outbox row) takes this lock in the caller's transaction.
    const connection = await connect();
    const { fx, role } = connection;
    const token = await withWorkspaceTransaction(env, fx.workspaceId, async (tx) => {
      await connection.keyShare(tx);
      return connection.resolve(tx, ownFor(fx.workspaceId, role));
    }, role);
    expect(token).toBe('access-2');
  });

  it('spends the refresh token once when two requests refresh at the same time', async () => {
    const connection = await connect();
    const { fx, role } = connection;
    const tokens = await Promise.all([1, 2].map(() => withWorkspaceTransaction(
      env, fx.workspaceId, (tx) => connection.resolve(tx, ownFor(fx.workspaceId, role)), role,
    )));
    expect(tokens).toEqual(['access-2', 'access-2']);
    expect(provider.exchanges).toBe(1);
  });
});

describe('Nous Portal refresh refusal', () => {
  it('quarantines a spent grant even when the caller\'s transaction fails', async () => {
    const connection = await nousConnection();
    const { fx } = connection;
    provider.live.clear(); // The Portal already retired this grant.
    await expect(withWorkspaceTransaction(env, fx.workspaceId, async (tx) => {
      await connection.resolve(tx, ownFor(fx.workspaceId, 'agent')).catch(() => undefined);
      throw new CallerFailed('the caller\'s commit failed');
    }, 'agent')).rejects.toBeInstanceOf(CallerFailed);
    const status = await withWorkspaceTransaction(env, fx.workspaceId, async (tx) => (await tx.query<{ status: string }>(
      `SELECT status FROM workspace_provider_keys WHERE workspace_id=$1 AND provider='nous_portal' AND revoked_at IS NULL`,
      [fx.workspaceId],
    )).rows[0]?.status);
    expect(status).toBe('invalid');
    // The quarantined grant is never replayed.
    await expect(withWorkspaceTransaction(env, fx.workspaceId, (tx) => connection.resolve(tx, ownFor(fx.workspaceId, 'agent')), 'agent'))
      .rejects.toThrow();
    expect(provider.exchanges).toBe(1);
  });
});
