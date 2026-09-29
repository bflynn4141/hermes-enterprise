// Every outside connection on one list (docs/CONNECTORS.md). Read-only: it
// reports what Hermes's own records say and never calls a provider.
import type { Context } from 'hono';
import { connectorListSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { listConnectorStatuses } from '../connectors/status.js';
import { inWorkspace } from './tenant.js';

export async function getConnections(c: Context<{ Bindings: Env }>): Promise<Response> {
  const list = await inWorkspace(c, (work) =>
    listConnectorStatuses(work.tx, c.env, { workspaceId: work.workspaceId, admin: work.role === 'admin' }));
  return c.json(connectorListSchema.parse(list));
}
