import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '../../src/db/client.js';
import type { HubEvent } from '../../src/hubs.js';
import { scopeWorkspaceHubEvents } from '../../src/domain/audience.js';

const workspaceEvent = (id: string): HubEvent => ({
  id,
  workspace_id: 'workspace-a',
  session_id: null,
  kind: 'entity.updated',
});

function txReturning(rows: readonly Record<string, unknown>[]): {
  tx: Tx;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn().mockResolvedValue({ rows });
  return { tx: { query } as unknown as Tx, query };
}

describe('workspace hub audience scoping', () => {
  it('keeps a private event deny-all after its only audience member becomes inactive', async () => {
    const { tx, query } = txReturning([{ id: '21', has_audience: true, audience_user_ids: null }]);

    const [scoped] = await scopeWorkspaceHubEvents(tx, [workspaceEvent('21')]);

    expect(scoped?.audience_user_ids).toEqual([]);
    expect(query).toHaveBeenCalledOnce();
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('JOIN members active_member');
    expect(sql).toContain("active_member.status = 'active'");
    expect(sql).toContain('active_member.workspace_id = stream_audience.workspace_id');
  });

  it('keeps historical events without request audiences workspace-public', async () => {
    const { tx } = txReturning([{ id: '22', has_audience: false, audience_user_ids: null }]);

    const [scoped] = await scopeWorkspaceHubEvents(tx, [workspaceEvent('22')]);

    expect(scoped).not.toHaveProperty('audience_user_ids');
  });

  it('attaches only active audience members to a private event', async () => {
    const { tx } = txReturning([{
      id: '23',
      has_audience: true,
      audience_user_ids: ['active-finance-user'],
    }]);

    const [scoped] = await scopeWorkspaceHubEvents(tx, [workspaceEvent('23')]);

    expect(scoped?.audience_user_ids).toEqual(['active-finance-user']);
  });

  it('fails closed when a numeric workspace event cannot be resolved in the scoped query', async () => {
    const { tx } = txReturning([]);

    const [scoped] = await scopeWorkspaceHubEvents(tx, [workspaceEvent('24')]);

    expect(scoped?.audience_user_ids).toEqual([]);
  });
});
