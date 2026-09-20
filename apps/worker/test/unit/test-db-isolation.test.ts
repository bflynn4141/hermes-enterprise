import { describe, expect, it, vi } from 'vitest';
import {
  cleanupOwnedTestTarget,
  hyperdriveStrings,
  isolatedTestEnvironment,
  resolveVitestTarget,
  type InspectedTestContainer,
  type OwnedTestTarget,
} from '../../../../scripts/test-db.mjs';

const target: OwnedTestTarget = {
  ownerToken: 'worktree-123-owned',
  containerId: 'a'.repeat(64),
  containerName: 'hermes-test-worktree-123',
  host: '127.0.0.1',
  port: '55123',
  database: 'hermes_test_worktree_123',
};

const inspection = (overrides: Partial<InspectedTestContainer> = {}): InspectedTestContainer => ({
  id: target.containerId,
  name: target.containerName,
  ownerToken: target.ownerToken,
  running: true,
  database: target.database,
  host: target.host,
  port: target.port,
  ...overrides,
});

const environment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PGHOST: target.host,
  PGPORT: target.port,
  PGDATABASE: target.database,
  HERMES_TEST_DB_OWNER_TOKEN: target.ownerToken,
  HERMES_TEST_DB_CONTAINER_ID: target.containerId,
  HERMES_TEST_DB_CONTAINER_NAME: target.containerName,
  ...overrides,
});

describe('automated test database ownership', () => {
  it('honors the explicit verified local target and rebuilds inherited Hyperdrive URLs from it', () => {
    const resolved = resolveVitestTarget(environment({
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP:
        'postgres://app:secret@127.0.0.1:5433/hermes',
    }), { inspect: () => inspection() });

    expect(resolved).toMatchObject({
      host: '127.0.0.1',
      port: '55123',
      database: 'hermes_test_worktree_123',
      github: false,
    });
    expect(hyperdriveStrings(resolved.database, environment())).toEqual({
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP:
        'postgres://app:localdev@127.0.0.1:55123/hermes_test_worktree_123',
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_AGENT:
        'postgres://agent:localdev@127.0.0.1:55123/hermes_test_worktree_123',
    });
    const isolated = isolatedTestEnvironment(environment({
      DATABASE_URL_OWNER: 'postgres://owner:secret@remote.example.com/hermes',
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP:
        'postgres://app:secret@127.0.0.1:5433/hermes',
    }));
    expect(isolated.DATABASE_URL_OWNER).toBeUndefined();
    expect(isolated.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP)
      .toBe('postgres://app:localdev@127.0.0.1:55123/hermes_test_worktree_123');
  });

  it('does not let CI=true or the historical shared defaults bypass ownership', () => {
    expect(() => resolveVitestTarget({
      CI: 'true',
      PGHOST: '127.0.0.1',
      PGPORT: '5433',
      PGDATABASE: 'hermes_test',
    })).toThrow(/owned target manifest/);

    expect(() => resolveVitestTarget(environment({ PGHOST: 'db.example.com' }), {
      inspect: () => inspection({ host: 'db.example.com' }),
    })).toThrow(/must be loopback/);

    expect(resolveVitestTarget({ GITHUB_ACTIONS: 'true' }, { needsDatabase: false })).toEqual({
      host: '127.0.0.1', port: '1', database: 'hermes_test_unowned', github: false,
    });

    expect(resolveVitestTarget({
      GITHUB_ACTIONS: 'true', CI: 'true', GITHUB_RUN_ID: '12345',
      PGHOST: '127.0.0.1', PGPORT: '5433', PGDATABASE: 'hermes',
    })).toEqual({ host: '127.0.0.1', port: '5433', database: 'hermes', github: true });
    expect(() => resolveVitestTarget({ GITHUB_ACTIONS: 'true', CI: 'true' })).toThrow(/requires GITHUB_RUN_ID/);
  });

  it('stops only the exact running container with the matching owner label', () => {
    const stop = vi.fn();
    expect(() => cleanupOwnedTestTarget(target, {
      inspect: () => inspection({ ownerToken: 'somebody-else' }),
      stop,
    })).toThrow(/ownerToken/);
    expect(stop).not.toHaveBeenCalled();

    expect(cleanupOwnedTestTarget(target, { inspect: () => inspection(), stop })).toEqual({
      removed: true,
      alreadyAbsent: false,
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(target.containerId);
  });
});
